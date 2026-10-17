import { describe, expect, it, vi } from 'vitest';

import { accountSettingsParse } from '@happier-dev/protocol';
import { PushNotificationClient } from '@/api/pushNotifications';

import { createPermissionHandlerSessionStubWithMetadata } from '../utils/permissionHandler.testkit';
import { ClaudeLocalPermissionBridge } from './localPermissionBridge';

function createSessionStub(sendToAllDevicesAsync: ReturnType<typeof vi.fn>) {
  const { session } = createPermissionHandlerSessionStubWithMetadata({
    sessionId: 's1', metadata: { flavor: 'claude', summary: { text: 'Refactor auth flow' } },
  });
  const pushSender = new PushNotificationClient('test-token');
  // Keep permission state and policy real; replace only external push delivery.
  vi.spyOn(pushSender, 'sendToAllDevicesAsync').mockImplementation(sendToAllDevicesAsync);
  session.pushSender = pushSender;
  return session;
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
    });

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
    });

    bridge.dispose();
    await p;

    await Promise.resolve();
    await Promise.resolve();
    expect(sendToAllDevicesAsync).toHaveBeenCalledTimes(1);
    expect(sendToAllDevicesAsync).toHaveBeenCalledWith(
      'Refactor auth flow',
      expect.stringContaining('Claude Code CLI asks permission to use Read'),
      expect.objectContaining({ sessionId: 's1', requestId: 'tool1' }),
    );
  });
});
