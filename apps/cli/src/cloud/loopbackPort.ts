import { createServer } from 'node:http'

export async function findAvailableLoopbackPort(
  host: '127.0.0.1' | '::1' = '127.0.0.1',
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

export async function isLoopbackPortAvailable(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const testServer = createServer()
    testServer.once('error', () => {
      resolve(false)
    })
    testServer.listen({ port, host: '127.0.0.1', exclusive: true }, () => {
      testServer.close(() => resolve(true))
    })
  })
}
