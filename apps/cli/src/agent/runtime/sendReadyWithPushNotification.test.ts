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

  it('can suppress push notifications while still emitting ready event', () => {
    const sendToAllDevices = vi.fn()
    const session = createSessionStub('session-999')

    sendReadyWithPushNotification({
      session: session as any,
      pushSender: { sendToAllDevices },
      waitingForCommandLabel: 'Codex',
      logPrefix: '[Codex]',
      shouldSendPush: () => false,
    })

    expect(session.sendSessionEvent).toHaveBeenCalledWith({ type: 'ready' })
    expect(sendToAllDevices).not.toHaveBeenCalled()
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

  it('sanitizes axios-shaped errors before logging', () => {
    const session = createSessionStub('session-789')
    const pushError = {
      isAxiosError: true,
      name: 'AxiosError',
      message: 'Request failed with status code 401',
      config: {
        method: 'get',
        url: 'https://api.example.test/v1/push-tokens?token=secret',
        headers: { Authorization: 'Bearer super-secret' },
      },
      response: { status: 401 },
    }
    const sendToAllDevices = vi.fn(() => {
      throw pushError
    })
    const loggerDebug = vi.fn()

    sendReadyWithPushNotification({
      session: session as any,
      pushSender: { sendToAllDevices },
      waitingForCommandLabel: 'Codex',
      logPrefix: '[Codex]',
      loggerDebug,
    })

    const [, logged] = loggerDebug.mock.calls[0] ?? []
    expect(logged).toEqual(expect.objectContaining({
      name: 'AxiosError',
      status: 401,
      method: 'GET',
      url: 'https://api.example.test/v1/push-tokens',
    }))
    expect(JSON.stringify(logged)).not.toContain('Authorization')
    expect(JSON.stringify(logged)).not.toContain('super-secret')
    expect(JSON.stringify(logged)).not.toContain('token=secret')
  })
})
