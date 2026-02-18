import { describe, expect, it, vi } from 'vitest';

import { accountSettingsParse } from '@happier-dev/protocol';

import { setActiveAccountSettingsSnapshot } from '@/settings/accountSettings/activeAccountSettingsSnapshot';

import { ClaudeLocalPermissionBridge } from './localPermissionBridge';

function createSessionStub(sendToAllDevices: ReturnType<typeof vi.fn>): any {
  const client: any = {
    sessionId: 's1',
    updateAgentState: vi.fn((updater: any) => updater({ requests: {}, completedRequests: {}, capabilities: {} })),
    getAgentStateSnapshot: vi.fn(() => ({ requests: {}, completedRequests: {}, capabilities: {} })),
  };
  return {
    client,
    api: { push: () => ({ sendToAllDevices }) },
    getOrCreatePermissionRpcRouter: () => ({ registerConsumer: () => {}, removeConsumer: () => {} } as any),
    fetchRecentTranscriptTextItemsForAcpImport: vi.fn(async () => []),
  } as any;
}

describe('ClaudeLocalPermissionBridge push policy', () => {
  it('suppresses permission-request pushes when disabled in account settings', async () => {
    const sendToAllDevices = vi.fn();
    const session = createSessionStub(sendToAllDevices);

    setActiveAccountSettingsSnapshot({
      source: 'cache',
      settingsVersion: 1,
      loadedAtMs: Date.now(),
      settings: accountSettingsParse({
        notificationsSettingsV1: { v: 1, pushEnabled: true, ready: true, permissionRequest: false },
      }),
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

    expect(sendToAllDevices).not.toHaveBeenCalled();
  });
});
