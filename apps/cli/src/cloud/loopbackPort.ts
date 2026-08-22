import { createServer } from 'node:http'

export type LoopbackHost = '127.0.0.1' | '::1'

export type LoopbackPortReservation = Readonly<{
  host: LoopbackHost
  port: number
  release(): Promise<void>
}>

export async function reserveLoopbackPort(
  host: LoopbackHost = '127.0.0.1',
  preferredPort?: number,
  signal?: AbortSignal,
): Promise<LoopbackPortReservation> {
  if (signal?.aborted) throw signal.reason
  return await new Promise((resolve, reject) => {
    const server = createServer()
    server.on('connection', (socket) => socket.destroy())
    let releasePromise: Promise<void> | null = null
    const release = (): Promise<void> => {
      signal?.removeEventListener('abort', handleAbort)
      releasePromise ??= new Promise<void>((releaseResolve, releaseReject) => {
        if (!server.listening) {
          releaseResolve()
          return
        }
        server.close((error) => (error ? releaseReject(error) : releaseResolve()))
      })
      return releasePromise
    }
    const handleAbort = () => {
      void release().finally(() => reject(signal?.reason))
    }
    const handleBindError = (error: Error) => {
      signal?.removeEventListener('abort', handleAbort)
      reject(error)
    }
    server.once('error', handleBindError)
    signal?.addEventListener('abort', handleAbort, { once: true })
    server.listen({
      port: preferredPort ?? 0,
      host,
      exclusive: true,
      ...(signal ? { signal } : {}),
    }, () => {
      server.removeListener('error', handleBindError)
      const address = server.address() as { port: number } | null
      const port = address?.port ?? 0
      if (signal?.aborted || port < 1) {
        void release().finally(() => reject(signal?.reason ?? new Error(
          'Loopback port reservation did not produce a usable port',
        )))
        return
      }
      resolve(Object.freeze({ host, port, release }))
    })
  })
}

export async function findAvailableLoopbackPort(
  host: LoopbackHost = '127.0.0.1',
): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer()
    const handleBindError = (error: Error) => reject(error)
    server.once('error', handleBindError)
    server.listen({ port: 0, host, exclusive: true }, () => {
      server.removeListener('error', handleBindError)
      const address = server.address() as { port: number } | null
      const port = address?.port ?? 0
      server.close((error) => (error ? reject(error) : resolve(port)))
    })
  })
}

export async function isLoopbackPortAvailable(
  port: number,
  host: LoopbackHost = '127.0.0.1',
): Promise<boolean> {
  return new Promise((resolve) => {
    const testServer = createServer()
    testServer.once('error', () => {
      resolve(false)
    })
    testServer.listen({ port, host, exclusive: true }, () => {
      testServer.close(() => resolve(true))
    })
  })
}
