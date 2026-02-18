import { describe, expect, it, vi } from 'vitest';

import { accountSettingsParse } from '@happier-dev/protocol';

import { setActiveAccountSettingsSnapshot } from '@/settings/accountSettings/activeAccountSettingsSnapshot';

import type { Session } from '../session';
import { PermissionHandler } from './permissionHandler';

function createSessionStub(sendToAllDevices: ReturnType<typeof vi.fn>): Session {
  const client: any = {
    sessionId: 's1',
    updateAgentState: vi.fn((updater: any) => updater({ requests: {}, completedRequests: {}, capabilities: {} })),
  };
  return {
    client,
    api: { push: () => ({ sendToAllDevices }) },
    setLastPermissionMode: vi.fn(),
    getOrCreatePermissionRpcRouter: () => ({ registerConsumer: () => {}, removeConsumer: () => {} } as any),
  } as any;
}

describe('Claude PermissionHandler push policy', () => {
  it('suppresses permission-request pushes when disabled in account settings', async () => {
    const sendToAllDevices = vi.fn();
    const session = createSessionStub(sendToAllDevices);
    const handler = new PermissionHandler(session);

    setActiveAccountSettingsSnapshot({
      source: 'cache',
      settingsVersion: 1,
      loadedAtMs: Date.now(),
      settings: accountSettingsParse({
        notificationsSettingsV1: { v: 1, pushEnabled: true, ready: true, permissionRequest: false },
      }),
    });

    const controller = new AbortController();
    handler.onMessage({
      type: 'assistant',
      message: {
        content: [{ type: 'tool_use', id: 'tool1', name: 'Read', input: { path: 'a' } }],
      },
    } as any);

    const promise = handler.handleToolCall('Read', { path: 'a' }, { permissionMode: 'default' } as any, { signal: controller.signal });
    controller.abort();
    await expect(promise).rejects.toBeTruthy();

    expect(sendToAllDevices).not.toHaveBeenCalled();
  });
});
