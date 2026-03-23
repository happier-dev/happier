import { createServer } from 'node:net'

export async function reserveEphemeralPort(host = '127.0.0.1'): Promise<number> {
  return await new Promise<number>((resolve, reject) => {
    const server = createServer()

    server.once('error', reject)
    server.listen(0, host, () => {
      const address = server.address()
      const port = typeof address === 'object' && address ? address.port : 0

      server.close((error) => {
        if (error) {
          reject(error)
          return
        }
        resolve(port)
      })
    })
  })
}

export async function waitForHttpReady(
  port: number,
  opts: {
    host?: string
    path?: string
    timeoutMs?: number
    intervalMs?: number
    requestTimeoutMs?: number
    okStatuses?: readonly number[]
  } = {},
): Promise<boolean> {
  const host = opts.host ?? '127.0.0.1'
  const path = opts.path ?? '/'
  const timeoutMs = opts.timeoutMs ?? 5_000
  const intervalMs = opts.intervalMs ?? 50
  const requestTimeoutMs = opts.requestTimeoutMs ?? 250
  const okStatuses = new Set(opts.okStatuses ?? [200, 404])
  const start = Date.now()

  while (Date.now() - start < timeoutMs) {
    try {
      const response = await fetch(`http://${host}:${port}${path}`, {
        method: 'GET',
        signal: AbortSignal.timeout(requestTimeoutMs),
      })
      if (okStatuses.has(response.status)) return true
    } catch {
      // ignore
    }

    await new Promise((resolve) => setTimeout(resolve, intervalMs))
  }

  return false
}
