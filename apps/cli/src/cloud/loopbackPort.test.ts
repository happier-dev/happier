import { describe, expect, it } from 'vitest'

import { findAvailableLoopbackPort, isLoopbackPortAvailable } from '@/cloud/loopbackPort'

describe('loopbackPort', () => {
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
