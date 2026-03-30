import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  accountSettingsParse,
  deriveSettingsSecretsKeyV1,
  encryptSecretStringV1,
} from '@happier-dev/protocol';

import { CodexPermissionHandler } from '@/backends/codex/utils/permissionHandler';
import { createCodexPermissionHandler } from './createCodexPermissionHandler';

class FakeRpcHandlerManager {
  handlers = new Map<string, (payload: any) => any>();
  registerHandler(name: string, handler: any) {
    this.handlers.set(name, handler);
  }
}

class FakeSession {
  sessionId = 'session-codex';
  rpcHandlerManager = new FakeRpcHandlerManager();
  agentState: any = { requests: {}, completedRequests: {} };

  getAgentStateSnapshot() {
    return this.agentState;
  }

  updateAgentState(updater: any) {
    this.agentState = updater(this.agentState);
    return this.agentState;
  }
}

describe('createCodexPermissionHandler', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns a CodexPermissionHandler instance', () => {
    const handler = createCodexPermissionHandler({
      session: new FakeSession() as any,
      onAbortRequested: () => {},
    });

    expect(handler).toBeInstanceOf(CodexPermissionHandler);
  });

  it('passes account settings secret read keys through to signed webhook notifications', async () => {
    const fetchMock = vi.fn(async () => ({ ok: true, status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    const settingsSecretsKey = deriveSettingsSecretsKeyV1(new Uint8Array(32).fill(5));
    const encryptedSigningSecret = encryptSecretStringV1(
      'qa-signing-secret',
      settingsSecretsKey,
      () => new Uint8Array(24).fill(8),
    );
    const session = new FakeSession();
    const settings = accountSettingsParse({
      notificationsSettingsV1: { v: 1, pushEnabled: false, ready: true, permissionRequest: true },
      notificationChannelsV1: [
        {
          v: 1,
          id: 'builtin:expo_push',
          kind: 'expo_push',
          enabled: false,
          topics: { ready: true, permissionRequest: true, userActionRequest: true },
          readyIncludeMessageText: false,
        },
        {
          v: 1,
          id: 'webhook-qa',
          kind: 'webhook',
          enabled: true,
          url: 'http://127.0.0.1:40123/webhook',
          signingSecret: {
            _isSecretValue: true,
            encryptedValue: encryptedSigningSecret,
          },
          topics: { ready: true, permissionRequest: true, userActionRequest: true },
          readyIncludeMessageText: false,
        },
      ],
    });
    const handler = createCodexPermissionHandler({
      session: session as any,
      pushSender: { sendToAllDevicesAsync: vi.fn(async () => {}) },
      getAccountSettings: () => settings,
      getAccountSettingsSecretsReadKeys: () => [settingsSecretsKey],
    } as any);

    const permissionResultPromise = handler.handleToolCall('tool-1', 'Write', { path: '/tmp/x', content: 'hi' });

    await Promise.resolve();
    await Promise.resolve();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith(
      'http://127.0.0.1:40123/webhook',
      expect.objectContaining({
        headers: expect.objectContaining({
          'x-happier-signature-256': expect.stringMatching(/^sha256=/),
        }),
      }),
    );

    const rpc = session.rpcHandlerManager.handlers.get('permission');
    await rpc?.({ id: 'tool-1', approved: false, decision: 'denied' });
    await permissionResultPromise;
  });
});
