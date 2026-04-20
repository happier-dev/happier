import { describe, expect, it, vi } from 'vitest';

import { accountSettingsParse } from '@happier-dev/protocol';

import { ClaudeLocalPermissionBridge } from './localPermissionBridge';

function createSessionStub(sendToAllDevicesAsync: ReturnType<typeof vi.fn>): any {
  const client: any = {
    sessionId: 's1',
    updateAgentState: vi.fn((updater: any) => updater({ requests: {}, completedRequests: {}, capabilities: {} })),
    getAgentStateSnapshot: vi.fn(() => ({ requests: {}, completedRequests: {}, capabilities: {} })),
  };
  return {
    client,
    pushSender: { sendToAllDevicesAsync },
    accountSettings: null,
    getOrCreatePermissionRpcRouter: () => ({ registerConsumer: () => {}, removeConsumer: () => {} } as any),
    fetchRecentTranscriptTextItemsForAcpImport: vi.fn(async () => []),
  } as any;
}

describe('ClaudeLocalPermissionBridge push policy', () => {
  it('suppresses permission-request pushes when disabled in account settings', async () => {
    const sendToAllDevicesAsync = vi.fn(async () => {});
    const session = createSessionStub(sendToAllDevicesAsync);
    session.accountSettings = accountSettingsParse({
      notificationsSettingsV1: { v: 1, pushEnabled: true, ready: true, permissionRequest: false },
    });

    const bridge = new ClaudeLocalPermissionBridge(session, { responseTimeoutMs: 10_000 });
    bridge.activate();

    const p = bridge.handlePermissionHook({
      tool_use_id: 'tool1',
      tool_name: 'Read',
      tool_input: { path: 'a' },
    } as any);

    bridge.dispose();
    await p;

    await Promise.resolve();
    await Promise.resolve();
    expect(sendToAllDevicesAsync).not.toHaveBeenCalled();
  });

  it('sends permission-request pushes when enabled in account settings', async () => {
    const sendToAllDevicesAsync = vi.fn(async () => {});
    const session = createSessionStub(sendToAllDevicesAsync);
    session.accountSettings = accountSettingsParse({
      notificationsSettingsV1: { v: 1, pushEnabled: true, ready: true, permissionRequest: true },
    });

    const bridge = new ClaudeLocalPermissionBridge(session, { responseTimeoutMs: 10_000 });
    bridge.activate();

    const p = bridge.handlePermissionHook({
      tool_use_id: 'tool1',
      tool_name: 'Read',
      tool_input: { path: 'a' },
    } as any);

    bridge.dispose();
    await p;

    await Promise.resolve();
    await Promise.resolve();
    expect(sendToAllDevicesAsync).toHaveBeenCalledTimes(1);
    expect(sendToAllDevicesAsync).toHaveBeenCalledWith(
      'Permission Request',
      expect.stringContaining('Read'),
      expect.objectContaining({ sessionId: 's1', requestId: 'tool1' }),
    );
  });
});
