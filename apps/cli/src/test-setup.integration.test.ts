import { afterEach, describe, expect, it, vi } from 'vitest'

const setupMock = vi.hoisted(() => vi.fn(async () => undefined))

vi.mock('./test-setup', () => ({
  setup: setupMock,
}))

import globalSetup from './test-setup.integration'

describe('CLI integration test global setup', () => {
  afterEach(() => {
    vi.clearAllMocks()
  })

  it('uses shared-only setup mode', async () => {
    await globalSetup()

    expect(setupMock).toHaveBeenCalledWith({ buildMode: 'shared-only' })
  })
})
