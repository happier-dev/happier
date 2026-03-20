import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  accountSettingsParse,
  deriveSettingsSecretsKeyV1,
  encryptSecretStringV1,
} from '@happier-dev/protocol';

import { BasePermissionHandler, type PermissionResult } from './BasePermissionHandler';

class FakeRpcHandlerManager {
  handlers = new Map<string, (payload: any) => any>();
  registerHandler(_name: string, handler: any) {
    this.handlers.set(_name, handler);
  }
}

class FakeSession {
  sessionId = 'session-test';
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

class TestPermissionHandler extends BasePermissionHandler {
  protected getLogPrefix(): string {
    return '[Test]';
  }

  publishPending(toolCallId: string, toolName: string, input: unknown): void {
    this.addPendingRequestToState(toolCallId, toolName, input);
  }

  request(toolCallId: string, toolName: string, input: unknown): Promise<PermissionResult> {
    return new Promise<PermissionResult>((resolve, reject) => {
      this.pendingRequests.set(toolCallId, { resolve, reject, toolName, input });
      this.addPendingRequestToState(toolCallId, toolName, input);
    });
  }
}

describe('BasePermissionHandler push notifications', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('sends a permission-request push when enabled', async () => {
    const sendToAllDevicesAsync = vi.fn(async () => {});
    const session = new FakeSession();
    const settings = accountSettingsParse({
        notificationsSettingsV1: { v: 1, pushEnabled: true, ready: true, permissionRequest: true },
    });
    const handler = new TestPermissionHandler(session as any, {
      pushSender: { sendToAllDevicesAsync },
      getAccountSettings: () => settings,
    } as any);

    const promise = handler.request('perm-1', 'Write', { path: '/tmp/x', content: 'hi' });

    // Push is fire-and-forget; flush microtasks to observe the async send.
    await Promise.resolve();
    await Promise.resolve();

    expect(sendToAllDevicesAsync).toHaveBeenCalledTimes(1);
    expect(sendToAllDevicesAsync).toHaveBeenCalledWith(
      'Permission Request',
      expect.stringContaining('Write'),
      expect.objectContaining({ sessionId: 'session-test', requestId: 'perm-1' }),
    );

    // Resolve to avoid dangling pending promises.
    const rpc = session.rpcHandlerManager.handlers.get('permission');
    await rpc?.({ id: 'perm-1', approved: false, decision: 'denied' });
    await promise;
  });

  it('does not send when permission-request pushes are disabled', async () => {
    const sendToAllDevicesAsync = vi.fn(async () => {});
    const session = new FakeSession();
    const settings = accountSettingsParse({
        notificationsSettingsV1: { v: 1, pushEnabled: true, ready: true, permissionRequest: false },
    });
    const handler = new TestPermissionHandler(session as any, {
      pushSender: { sendToAllDevicesAsync },
      getAccountSettings: () => settings,
    } as any);

    const promise = handler.request('perm-1', 'Write', { path: '/tmp/x', content: 'hi' });
    await Promise.resolve();
    await Promise.resolve();
    expect(sendToAllDevicesAsync).not.toHaveBeenCalled();

    const rpc = session.rpcHandlerManager.handlers.get('permission');
    await rpc?.({ id: 'perm-1', approved: false, decision: 'denied' });
    await promise;
  });

  it('dedupes repeated pending publications for the same request id', async () => {
    const sendToAllDevicesAsync = vi.fn(async () => {});
    const session = new FakeSession();
    const settings = accountSettingsParse({
        notificationsSettingsV1: { v: 1, pushEnabled: true, ready: true, permissionRequest: true },
    });
    const handler = new TestPermissionHandler(session as any, {
      pushSender: { sendToAllDevicesAsync },
      getAccountSettings: () => settings,
    } as any);

    const input = { path: '/tmp/x', content: 'hi' };
    const p1 = handler.request('perm-1', 'Write', input);
    handler.publishPending('perm-1', 'Write', input);

    await Promise.resolve();
    await Promise.resolve();
    expect(sendToAllDevicesAsync).toHaveBeenCalledTimes(1);

    const rpc = session.rpcHandlerManager.handlers.get('permission');
    await rpc?.({ id: 'perm-1', approved: false, decision: 'denied' });
    await p1;
  });

  it('re-attempts permission-request push after a session swap while still pending', async () => {
    const sendToAllDevicesAsync = vi
      .fn(async () => {})
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValueOnce(undefined);

    const session1 = new FakeSession();
    const session2 = new FakeSession();
    session2.sessionId = 'session-two';

    const settings = accountSettingsParse({
      notificationsSettingsV1: { v: 1, pushEnabled: true, ready: true, permissionRequest: true },
    });
    const handler = new TestPermissionHandler(session1 as any, {
      pushSender: { sendToAllDevicesAsync },
      getAccountSettings: () => settings,
    } as any);

    const promise = handler.request('perm-1', 'Write', { path: '/tmp/x', content: 'hi' });
    await Promise.resolve();
    await Promise.resolve();
    expect(sendToAllDevicesAsync).toHaveBeenCalledTimes(1);

    handler.updateSession(session2 as any);
    await Promise.resolve();
    await Promise.resolve();
    expect(sendToAllDevicesAsync).toHaveBeenCalledTimes(2);

    const rpc = session2.rpcHandlerManager.handlers.get('permission');
    await rpc?.({ id: 'perm-1', approved: false, decision: 'denied' });
    await promise;
  });

  it('signs webhook notifications when account settings secrets read keys are provided', async () => {
    const fetchMock = vi.fn(async () => ({ ok: true, status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    const settingsSecretsKey = deriveSettingsSecretsKeyV1(new Uint8Array(32).fill(9));
    const encryptedSigningSecret = encryptSecretStringV1(
      'qa-signing-secret',
      settingsSecretsKey,
      () => new Uint8Array(24).fill(7),
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
    const handler = new TestPermissionHandler(session as any, {
      pushSender: { sendToAllDevicesAsync: vi.fn(async () => {}) },
      getAccountSettings: () => settings,
      getAccountSettingsSecretsReadKeys: () => [settingsSecretsKey],
    } as any);

    const promise = handler.request('perm-1', 'Write', { path: '/tmp/x', content: 'hi' });

    await Promise.resolve();
    await Promise.resolve();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith(
      'http://127.0.0.1:40123/webhook',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({
          'content-type': 'application/json',
          'x-happier-signature-256': expect.stringMatching(/^sha256=/),
        }),
      }),
    );

    const rpc = session.rpcHandlerManager.handlers.get('permission');
    await rpc?.({ id: 'perm-1', approved: false, decision: 'denied' });
    await promise;
  });
});
