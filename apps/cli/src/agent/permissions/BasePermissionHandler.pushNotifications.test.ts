import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  accountSettingsParse,
  SESSION_RPC_METHODS,
  deriveSettingsSecretsKeyV1,
  encryptSecretStringV1,
} from '@happier-dev/protocol';

import { BasePermissionHandler, type PermissionResult } from './BasePermissionHandler';
import { SessionPermissionRpcRouter } from './sessionPermissionRpcRouter';
import type { ApiSessionClient } from '@/api/session/sessionClient';

class FakeRpcHandlerManager {
  handlers = new Map<string, (payload: any) => any>();
  registerHandler(_name: string, handler: any) {
    this.handlers.set(_name, handler);
  }
}

class FakeSession {
  sessionId = 'session-test';
  rpcHandlerManager = new FakeRpcHandlerManager();
  private permissionRpcRouter: SessionPermissionRpcRouter | null = null;
  getOrCreatePermissionRpcRouter(): SessionPermissionRpcRouter {
    return this.permissionRpcRouter ??= new SessionPermissionRpcRouter(this.rpcHandlerManager);
  }
  agentState: any = { requests: {}, completedRequests: {} };
  metadata: any = {
    flavor: 'codex',
    summary: { text: 'Fix checkout bug' },
  };

  getMetadataSnapshot() {
    return this.metadata;
  }

  getAgentStateSnapshot() {
    return this.agentState;
  }

  async updateAgentStateRequestSettlement(updater: Parameters<FakeSession['updateAgentState']>[0]): Promise<void> {

    await this.updateAgentState(updater);

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

  request(toolCallId: string, toolName: string, input: unknown): Promise<PermissionResult> {
    return this.requestPermissionDecision(toolCallId, toolName, input);
  }
}

describe('BasePermissionHandler push notifications', () => {
  it('does not release a current provider waiter for an older notification occurrence', async () => {
    const session = new FakeSession();
    const router = new SessionPermissionRpcRouter(session.rpcHandlerManager);
    Object.assign(session, { getOrCreatePermissionRpcRouter: () => router });
    // The session fixture implements the RPC/state boundary exercised by this handler.
    const handler = new TestPermissionHandler(session as unknown as ApiSessionClient);
    const pending = handler.request('same', 'Write', { path: '/current' });
    const occurrenceId = session.agentState.requests.same.occurrenceId;
    const respond = session.rpcHandlerManager.handlers.get(SESSION_RPC_METHODS.SESSION_PERMISSION_RESPOND_TO_OCCURRENCE_V1);
    await expect(respond?.({ id: 'same', occurrenceId: 'old', approved: true })).resolves.toMatchObject({ ok: false });
    expect(session.agentState.requests.same.occurrenceId).toBe(occurrenceId);
    await expect(respond?.({ id: 'same', occurrenceId, approved: false, decision: 'denied' })).resolves.toEqual({ ok: true });
    await expect(pending).resolves.toMatchObject({ decision: 'denied' });
  });
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
      'Fix checkout bug',
      expect.stringContaining('OpenAI Codex CLI asks permission to use Write'),
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

  it('dedupes pushes when another waiter joins the same request', async () => {
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
    const p2 = handler.request('perm-1', 'Write', input);

    await Promise.resolve();
    await Promise.resolve();
    expect(sendToAllDevicesAsync).toHaveBeenCalledTimes(1);

    const rpc = session.rpcHandlerManager.handlers.get('permission');
    await rpc?.({ id: 'perm-1', approved: false, decision: 'denied' });
    await expect(Promise.all([p1, p2])).resolves.toEqual([
      { decision: 'denied' }, { decision: 'denied' },
    ]);
  });

  it('keeps a reconnected permission answerable with its original occurrence and retries its push', async () => {
    const clock = vi.spyOn(Date, 'now').mockReturnValue(1_000);
    const sendToAllDevicesAsync = vi
      .fn(async () => {})
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValueOnce(undefined);

    const session1 = new FakeSession();
    const session2 = new FakeSession();
    session2.sessionId = 'session-two';
    const router1 = new SessionPermissionRpcRouter(session1.rpcHandlerManager);
    const router2 = new SessionPermissionRpcRouter(session2.rpcHandlerManager);
    Object.assign(session1, { getOrCreatePermissionRpcRouter: () => router1 });
    Object.assign(session2, { getOrCreatePermissionRpcRouter: () => router2 });

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

    const originalRequest = { ...session1.agentState.requests['perm-1'] };
    clock.mockReturnValue(2_000);
    handler.updateSession(session2 as any);
    await Promise.resolve();
    await Promise.resolve();
    expect(sendToAllDevicesAsync).toHaveBeenCalledTimes(2);
    expect(session2.agentState.requests['perm-1']).toEqual(originalRequest);

    const rpc = session2.rpcHandlerManager.handlers.get('permission');
    await rpc?.({ id: 'perm-1', approved: false, decision: 'denied' });
    await expect(promise).resolves.toMatchObject({ decision: 'denied' });
    expect(session2.agentState.requests['perm-1']).toBeUndefined();
    expect(session2.agentState.completedRequests['perm-1']).toMatchObject({
      createdAt: 1_000, status: 'denied',
    });
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
