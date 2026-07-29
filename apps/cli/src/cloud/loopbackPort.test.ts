import { describe, expect, it, vi } from 'vitest'

const httpHarness = vi.hoisted(() => ({
  createServer: null as null | (() => unknown),
}))

vi.mock('node:http', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:http')>()
  return {
    ...actual,
    createServer: (...args: Parameters<typeof actual.createServer>) => (
      httpHarness.createServer?.() as ReturnType<typeof actual.createServer>
      ?? actual.createServer(...args)
    ),
  }
})

import { findAvailableLoopbackPort, isLoopbackPortAvailable } from '@/cloud/loopbackPort'

describe('loopbackPort', () => {
  it('rejects the exact loopback bind error instead of emitting it without a listener', async () => {
    const bindError = new Error('IPv6 loopback is unavailable')
    let errorListener: ((error: Error) => void) | null = null
    const fakeServer = {
      once(event: string, listener: (error: Error) => void) {
        if (event === 'error') errorListener = listener
        return fakeServer
      },
      removeListener(event: string, listener: (error: Error) => void) {
        if (event === 'error' && errorListener === listener) errorListener = null
        return fakeServer
      },
      listen() {
        if (!errorListener) throw new Error('missing loopback bind error listener')
        queueMicrotask(() => errorListener?.(bindError))
        return fakeServer
      },
      close(callback?: (error?: Error) => void) {
        callback?.()
        return fakeServer
      },
    }
    httpHarness.createServer = () => fakeServer

    try {
      await expect(findAvailableLoopbackPort('::1')).rejects.toBe(bindError)
    } finally {
      httpHarness.createServer = null
    }
  })

  it('returns false when a loopback port is already occupied', async () => {
    const occupiedPort = await findAvailableLoopbackPort()
    expect(occupiedPort).toBeGreaterThan(0)

    const net = await import('node:net')
    const server = net.createServer()
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(occupiedPort, '127.0.0.1', () => resolve())
    })

    try {
      const available = await isLoopbackPortAvailable(occupiedPort)
      expect(available).toBe(false)
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()))
      })
    }
  })
})
