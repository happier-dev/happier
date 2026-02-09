import { createServer } from 'node:http'

export async function findAvailableLoopbackPort(): Promise<number> {
  return new Promise((resolve) => {
    const server = createServer()
    server.listen(0, '127.0.0.1', () => {
      const address = server.address() as { port: number } | null
      const port = address?.port ?? 0
      server.close(() => resolve(port))
    })
  })
}

export async function isLoopbackPortAvailable(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const testServer = createServer()
    testServer.once('error', () => {
      testServer.close()
      resolve(false)
    })
    testServer.listen(port, '127.0.0.1', () => {
      testServer.close(() => resolve(true))
    })
  })
}
