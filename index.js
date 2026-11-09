/**
 * Host half of the workspace plugin manager bundle.
 *
 * Persists the page's per-workspace plugin tables in one JSON file next to the
 * profile, so they survive a cleared browser profile and reach every window.
 * The browser half keeps the table; this file only stores and serves it.
 *
 * Access: loopback only (the Desktop GUI and a local browser reach the Host on
 * 127.0.0.1). It never reads or writes the profile's cordis.patch.yml.
 */
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

/** Where the page reads and writes the catalogue. */
export const STATE_PATH = '/dsh-workspace-plugin-manager/state'

/** Largest state document accepted; a table per workspace is a few KiB. */
const STATE_MAX_BYTES = 2 * 1024 * 1024

export const name = 'workspace-plugin-manager'
export const inject = ['webServer']

/**
 * Resolve the state file beside the profile, falling back to the harness home.
 * @returns the absolute path of the state document.
 */
export function stateFile() {
  const base = process.env.DSH_PROFILE_DIR || process.env.DSH_HOME || join(process.cwd())
  return join(base, 'workspace-plugin-manager.json')
}

/**
 * Whether a request arrived over the loopback interface. The JSON endpoint is
 * a local convenience, not a remote API.
 * @param address - the socket's remote address.
 */
function isLoopback(address) {
  return address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1'
}

/**
 * Read a bounded JSON body.
 * @param req - the incoming request.
 * @returns the parsed value, or undefined when the body is unusable.
 */
async function readBody(req) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > STATE_MAX_BYTES) return undefined
    chunks.push(chunk)
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'))
  } catch {
    return undefined
  }
}

/**
 * Write the state document atomically.
 * @param path - destination file.
 * @param value - JSON-serializable state.
 */
async function writeState(path, value) {
  await mkdir(dirname(path), { recursive: true })
  const temporary = `${path}.${process.pid}.tmp`
  await writeFile(temporary, JSON.stringify(value), 'utf8')
  await rename(temporary, path)
}

export function apply(ctx) {
  const file = stateFile()

  ctx.effect(
    () =>
      ctx.webServer.register({
        kind: 'exact',
        path: STATE_PATH,
        async handler(req, res) {
          const reply = (status, body, headers = {}) => {
            res.writeHead(status, {
              'content-type': 'application/json; charset=utf-8',
              'cache-control': 'no-store',
              'x-content-type-options': 'nosniff',
              ...headers,
            })
            res.end(body === undefined ? '' : JSON.stringify(body))
          }

          if (!isLoopback(req.socket?.remoteAddress)) return reply(403, { error: 'loopback only' })

          if (req.method === 'GET') {
            try {
              const text = await readFile(file, 'utf8')
              res.writeHead(200, {
                'content-type': 'application/json; charset=utf-8',
                'cache-control': 'no-store',
                'x-content-type-options': 'nosniff',
              })
              res.end(text)
            } catch (error) {
              if (error && error.code === 'ENOENT') return reply(404, { error: 'no state yet' })
              return reply(500, { error: 'state unreadable' })
            }
            return
          }

          if (req.method === 'PUT') {
            const body = await readBody(req)
            if (body === undefined || typeof body !== 'object' || body === null || Array.isArray(body)) {
              return reply(400, { error: 'invalid state document' })
            }
            try {
              await writeState(file, body)
            } catch {
              return reply(500, { error: 'state not writable' })
            }
            return reply(200, { ok: true })
          }

          return reply(405, { error: 'method not allowed' }, { allow: 'GET, PUT' })
        },
      }),
    'workspace-plugin-manager: state route',
  )
}
