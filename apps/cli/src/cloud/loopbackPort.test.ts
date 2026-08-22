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

import {
  findAvailableLoopbackPort,
  isLoopbackPortAvailable,
  reserveLoopbackPort,
} from '@/cloud/loopbackPort'

describe('loopbackPort', () => {
  it('keeps concurrent loopback allocations distinct until each reservation is released', async () => {
    const first = await reserveLoopbackPort()
    const second = await reserveLoopbackPort()

    try {
      expect(second.port).not.toBe(first.port)
      await expect(isLoopbackPortAvailable(first.port, first.host))
        .resolves.toBe(false)
      await expect(isLoopbackPortAvailable(second.port, second.host))
        .resolves.toBe(false)

      await Promise.all([first.release(), first.release()])
      await expect(isLoopbackPortAvailable(first.port, first.host))
        .resolves.toBe(true)
      await expect(isLoopbackPortAvailable(second.port, second.host))
        .resolves.toBe(false)
    } finally {
      await Promise.all([first.release(), second.release()])
    }
  })

  it('holds a preferred port exclusively and makes it reusable after release', async () => {
    const first = await reserveLoopbackPort()
    const { host, port } = first

    try {
      await expect(reserveLoopbackPort(host, port)).rejects.toMatchObject({
        code: 'EADDRINUSE',
      })
    } finally {
      await first.release()
    }

    const reused = await reserveLoopbackPort(host, port)
    expect(reused.port).toBe(port)
    await reused.release()
  })

  it('releases its listener when reservation authority aborts', async () => {
    const controller = new AbortController()
    const reservation = await reserveLoopbackPort(
      '127.0.0.1',
      undefined,
      controller.signal,
    )

    controller.abort()

    await vi.waitFor(async () => {
      await expect(isLoopbackPortAvailable(reservation.port, reservation.host))
        .resolves.toBe(true)
    })
    await reservation.release()
  })

  it('checks availability on the requested IPv6 loopback host', async () => {
    let listenedHost: string | undefined
    const fakeServer = {
      once() {
        return fakeServer
      },
      listen(options: { host?: string }, listener: () => void) {
        listenedHost = options.host
        queueMicrotask(listener)
        return fakeServer
      },
      close(callback?: (error?: Error) => void) {
        callback?.()
        return fakeServer
      },
    }
    httpHarness.createServer = () => fakeServer

    try {
      await expect(isLoopbackPortAvailable(43_140, '::1'))
        .resolves.toBe(true)
      expect(listenedHost).toBe('::1')
    } finally {
      httpHarness.createServer = null
    }
  })

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
