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
  it.each([false, true])('applies permission-request push setting %s to a live request', async (enabled) => {
    const sendToAllDevicesAsync = vi.fn(async () => {});
    const session = createSessionStub(sendToAllDevicesAsync);
    session.accountSettings = accountSettingsParse({
      notificationsSettingsV1: { v: 1, pushEnabled: true, ready: true, permissionRequest: enabled },
    });
    const bridge = new ClaudeLocalPermissionBridge(session, { responseTimeoutMs: 10_000 });
    bridge.activate();
    const pending = bridge.handlePermissionHook({
      tool_use_id: 'tool1', tool_name: 'Read', tool_input: { path: 'a' },
    });
    try {
      if (enabled) {
        await vi.waitFor(() => expect(sendToAllDevicesAsync).toHaveBeenCalledTimes(1));
        expect(sendToAllDevicesAsync).toHaveBeenCalledWith(
          'Refactor auth flow',
          expect.stringContaining('Claude Code CLI asks permission to use Read'),
          expect.objectContaining({ sessionId: 's1', requestId: 'tool1', occurrenceId: expect.any(String) }),
        );
      } else {
        // Drain the publication continuation before retiring the live request.
        await new Promise<void>((resolve) => setImmediate(resolve));
        expect(sendToAllDevicesAsync).not.toHaveBeenCalled();
      }
    } finally {
      bridge.dispose();
      await pending;
    }
  });

  it('does not push a request retired before its publication continuation', async () => {
    const sendToAllDevicesAsync = vi.fn(async () => {});
    const session = createSessionStub(sendToAllDevicesAsync);
    session.accountSettings = accountSettingsParse({
      notificationsSettingsV1: { v: 1, pushEnabled: true, ready: true, permissionRequest: true },
    });
    const bridge = new ClaudeLocalPermissionBridge(session, { responseTimeoutMs: 10_000 });
    bridge.activate();
    const pending = bridge.handlePermissionHook({
      tool_use_id: 'tool1', tool_name: 'Read', tool_input: { path: 'a' },
    });
    bridge.dispose();
    await pending;
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(sendToAllDevicesAsync).not.toHaveBeenCalled();
  });
});
