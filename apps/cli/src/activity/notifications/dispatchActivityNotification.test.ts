import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  accountSettingsParse,
  deriveSettingsSecretsKeyV1,
  encryptSecretStringV1,
} from '@happier-dev/protocol';

import { dispatchActivityNotificationAsync } from './dispatchActivityNotification';

describe('dispatchActivityNotificationAsync', () => {
  const fetchSpy = vi.fn();

  beforeEach(() => {
    vi.stubGlobal('fetch', fetchSpy);
    fetchSpy.mockReset();
    fetchSpy.mockResolvedValue({
      ok: true,
      status: 202,
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('falls back to the builtin expo push channel when explicit channels are missing', async () => {
    const sendToAllDevicesAsync = vi.fn(async () => {});
    const settings = accountSettingsParse({
      notificationsSettingsV1: {
        v: 1,
        pushEnabled: true,
        ready: true,
        readyIncludeMessageText: true,
        permissionRequest: true,
        userActionRequest: true,
        foregroundBehavior: 'full',
      },
    });

    await dispatchActivityNotificationAsync({
      settings,
      expoPushSender: { sendToAllDevicesAsync },
      event: {
        topic: 'ready',
        sessionId: 'session-1',
        sessionTitle: 'Review branch',
        waitingForCommandLabel: 'Codex',
        assistantPreviewText: 'The branch is ready to review.',
      },
    });

    expect(sendToAllDevicesAsync).toHaveBeenCalledWith(
      'Review branch',
      'The branch is ready to review.',
      { sessionId: 'session-1' },
    );
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('dispatches only to enabled explicit channels', async () => {
    const sendToAllDevicesAsync = vi.fn(async () => {});
    const settings = accountSettingsParse({
      notificationChannelsV1: [
        {
          v: 1,
          id: 'expo-disabled',
          kind: 'expo_push',
          enabled: false,
          topics: {
            ready: true,
            permissionRequest: true,
            userActionRequest: true,
          },
          readyIncludeMessageText: true,
        },
        {
          v: 1,
          id: 'webhook-primary',
          kind: 'webhook',
          enabled: true,
          url: 'https://hooks.example.test/happier',
          signingSecret: {
            _isSecretValue: true,
            value: 'webhook-secret',
          },
          topics: {
            ready: true,
            permissionRequest: true,
            userActionRequest: true,
          },
          readyIncludeMessageText: false,
        },
      ],
    });

    await dispatchActivityNotificationAsync({
      settings,
      expoPushSender: { sendToAllDevicesAsync },
      event: {
        topic: 'ready',
        sessionId: 'session-2',
        sessionTitle: 'Deploy fix',
        waitingForCommandLabel: 'Gemini',
        assistantPreviewText: 'Deployment is complete.',
      },
    });

    expect(sendToAllDevicesAsync).not.toHaveBeenCalled();
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url, init] = fetchSpy.mock.calls[0] ?? [];
    expect(url).toBe('https://hooks.example.test/happier');
    expect(init).toMatchObject({
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-happier-signature-256': expect.stringMatching(/^sha256=[a-f0-9]{64}$/),
      },
    });
    const payload = JSON.parse(String(init.body));
    expect(payload.content).toEqual({
      title: 'Deploy fix',
      body: 'Gemini is waiting for your command',
    });
  });

  it('sends sanitized request payloads to webhook channels', async () => {
    const sendToAllDevicesAsync = vi.fn(async () => {});
    const settings = accountSettingsParse({
      notificationChannelsV1: [
        {
          v: 1,
          id: 'webhook-primary',
          kind: 'webhook',
          enabled: true,
          url: 'https://hooks.example.test/happier',
          signingSecret: {
            _isSecretValue: true,
            value: 'webhook-secret',
          },
          topics: {
            ready: false,
            permissionRequest: true,
            userActionRequest: true,
          },
          readyIncludeMessageText: false,
        },
      ],
    });

    await dispatchActivityNotificationAsync({
      settings,
      expoPushSender: { sendToAllDevicesAsync },
      event: {
        topic: 'permission_request',
        sessionId: 'session-3',
        sessionTitle: 'Fix prod issue',
        requestId: 'request-9',
        toolName: 'Bash',
        toolInput: { command: 'git status --short && echo secret-token' },
      },
    });

    expect(sendToAllDevicesAsync).not.toHaveBeenCalled();
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [, init] = fetchSpy.mock.calls[0] ?? [];
    const payload = JSON.parse(String(init.body));
    expect(init).toMatchObject({
      headers: {
        'content-type': 'application/json',
        'x-happier-signature-256': expect.stringMatching(/^sha256=[a-f0-9]{64}$/),
      },
    });
    expect(payload.request).toMatchObject({
      requestId: 'request-9',
      kind: 'permission',
      toolName: 'Bash',
      toolDetails: 'Command: git',
    });
    expect(JSON.stringify(payload)).not.toContain('secret-token');
  });

  it('decrypts encrypted webhook signing secrets when settings secret read keys are provided', async () => {
    const sendToAllDevicesAsync = vi.fn(async () => {});
    const settingsSecretsKey = deriveSettingsSecretsKeyV1(new Uint8Array(32).fill(7));
    const settings = accountSettingsParse({
      notificationChannelsV1: [
        {
          v: 1,
          id: 'webhook-primary',
          kind: 'webhook',
          enabled: true,
          url: 'https://hooks.example.test/happier',
          signingSecret: {
            _isSecretValue: true,
            encryptedValue: encryptSecretStringV1(
              'sealed-webhook-secret',
              settingsSecretsKey,
              (length) => new Uint8Array(length).fill(3),
            ),
          },
          topics: {
            ready: true,
            permissionRequest: true,
            userActionRequest: true,
          },
          readyIncludeMessageText: false,
        },
      ],
    });

    await dispatchActivityNotificationAsync({
      settings,
      settingsSecretsReadKeys: [settingsSecretsKey],
      expoPushSender: { sendToAllDevicesAsync },
      event: {
        topic: 'ready',
        sessionId: 'session-4',
        sessionTitle: 'Ship release',
        waitingForCommandLabel: 'Codex',
        assistantPreviewText: 'Release branch is ready.',
      },
    });

    expect(sendToAllDevicesAsync).not.toHaveBeenCalled();
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [, init] = fetchSpy.mock.calls[0] ?? [];
    expect(init).toMatchObject({
      headers: {
        'content-type': 'application/json',
        'x-happier-signature-256': expect.stringMatching(/^sha256=[a-f0-9]{64}$/),
      },
    });
  });
});
