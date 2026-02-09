import { describe, expect, it, vi } from 'vitest'

import { sendReadyWithPushNotification } from '@/agent/runtime/sendReadyWithPushNotification'

function createSessionStub(sessionId = 'session-1') {
  return {
    sessionId,
    sendSessionEvent: vi.fn(),
  }
}

describe('sendReadyWithPushNotification', () => {
  it('emits ready event and sends push notification', () => {
    const sendToAllDevices = vi.fn()
    const session = createSessionStub('session-123')

    sendReadyWithPushNotification({
      session: session as any,
      pushSender: { sendToAllDevices },
      waitingForCommandLabel: 'Qwen Code',
      logPrefix: '[Qwen]',
    })

    expect(session.sendSessionEvent).toHaveBeenCalledWith({ type: 'ready' })
    expect(sendToAllDevices).toHaveBeenCalledWith(
      "It's ready!",
      'Qwen Code is waiting for your command',
      { sessionId: 'session-123' },
    )
  })

  it('still emits ready event when push notification fails', () => {
    const session = createSessionStub('session-456')
    const pushError = new Error('push unavailable')
    const sendToAllDevices = vi.fn(() => {
      throw pushError
    })
    const loggerDebug = vi.fn()

    sendReadyWithPushNotification({
      session: session as any,
      pushSender: { sendToAllDevices },
      waitingForCommandLabel: 'OpenCode',
      logPrefix: '[OpenCode]',
      loggerDebug,
    })

    expect(session.sendSessionEvent).toHaveBeenCalledWith({ type: 'ready' })
    expect(sendToAllDevices).toHaveBeenCalledTimes(1)
    expect(loggerDebug).toHaveBeenCalledWith('[OpenCode] Failed to send ready push', pushError)
  })
})
