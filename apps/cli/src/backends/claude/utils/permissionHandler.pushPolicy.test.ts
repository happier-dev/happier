import { describe, expect, it, vi } from 'vitest';

import { accountSettingsParse } from '@happier-dev/protocol';

import type { Session } from '../session';
import { PermissionHandler } from './permissionHandler';

function createSessionStub(sendToAllDevicesAsync: ReturnType<typeof vi.fn>): Session {
  const client: any = {
    sessionId: 's1',
    updateAgentState: vi.fn((updater: any) => updater({ requests: {}, completedRequests: {}, capabilities: {} })),
  };
  return {
    client,
    pushSender: { sendToAllDevicesAsync },
    accountSettings: null,
    setLastPermissionMode: vi.fn(),
    getOrCreatePermissionRpcRouter: () => ({ registerConsumer: () => {}, removeConsumer: () => {} } as any),
  } as any;
}

describe('Claude PermissionHandler push policy', () => {
  it('suppresses permission-request pushes when disabled in account settings', async () => {
    const sendToAllDevicesAsync = vi.fn(async () => {});
    const session = createSessionStub(sendToAllDevicesAsync);
    session.accountSettings = accountSettingsParse({
      notificationsSettingsV1: { v: 1, pushEnabled: true, ready: true, permissionRequest: false },
    });
    const handler = new PermissionHandler(session);

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
    const handler = new PermissionHandler(session);

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
