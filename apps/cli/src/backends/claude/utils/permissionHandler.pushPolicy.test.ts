import { describe, expect, it, vi } from 'vitest';

import { accountSettingsParse } from '@happier-dev/protocol';
import { PushNotificationClient } from '@/api/pushNotifications';

import { PermissionHandler } from './permissionHandler';
import { createPermissionHandlerSessionStubWithMetadata } from './permissionHandler.testkit';

function createSessionStub(sendToAllDevicesAsync: ReturnType<typeof vi.fn>) {
  const { session, client } = createPermissionHandlerSessionStubWithMetadata({
    sessionId: 's1', metadata: { flavor: 'claude', summary: { text: 'Refactor auth flow' } },
  });
  const pushSender = new PushNotificationClient('test-token');
  // Keep permission state, routing, and policy real; replace only external push delivery.
  vi.spyOn(pushSender, 'sendToAllDevicesAsync').mockImplementation(sendToAllDevicesAsync);
  session.pushSender = pushSender;
  return { session, client };
}

describe('Claude PermissionHandler push policy', () => {
  it.each([false, true])('applies permission-request push setting %s to a live request', async (enabled) => {
    const sendToAllDevicesAsync = vi.fn(async () => {});
    const { session, client } = createSessionStub(sendToAllDevicesAsync);
    session.accountSettings = accountSettingsParse({
      notificationsSettingsV1: { v: 1, pushEnabled: true, ready: true, permissionRequest: enabled },
    });
    const handler = new PermissionHandler(session);
    const controller = new AbortController();
    const pending = handler.handleToolCall('Read', { path: 'a' }, { permissionMode: 'default' }, {
      signal: controller.signal,
      toolUseId: 'tool1',
    });
    try {
      expect(client.getAgentStateSnapshot().requests.tool1).toMatchObject({ occurrenceId: expect.any(String) });
      if (enabled) {
        await vi.waitFor(() => expect(sendToAllDevicesAsync).toHaveBeenCalledTimes(1));
        expect(sendToAllDevicesAsync).toHaveBeenCalledWith(
          'Refactor auth flow',
          expect.stringContaining('Claude Code CLI asks permission to use Read'),
          expect.objectContaining({
            sessionId: 's1', requestId: 'tool1',
            occurrenceId: expect.any(String),
          }),
        );
      } else {
        // Drain the publication continuation while the request remains live.
        await new Promise<void>((resolve) => setImmediate(resolve));
        expect(sendToAllDevicesAsync).not.toHaveBeenCalled();
      }
    } finally {
      controller.abort();
      await expect(pending).rejects.toBeTruthy();
      handler.dispose();
    }
  });

  it('sends one permission-request push for duplicate same-id live waiters', async () => {
    const sendToAllDevicesAsync = vi.fn(async () => {});
    const { session } = createSessionStub(sendToAllDevicesAsync);
    session.accountSettings = accountSettingsParse({
      notificationsSettingsV1: { v: 1, pushEnabled: true, ready: true, permissionRequest: true },
    });
    const handler = new PermissionHandler(session);
    const firstController = new AbortController();
    const secondController = new AbortController();
    const input = { path: 'a' };
    const first = handler.handleToolCall('Read', input, { permissionMode: 'default' }, {
      signal: firstController.signal, toolUseId: 'tool1',
    });
    const second = handler.handleToolCall('Read', input, { permissionMode: 'default' }, {
      signal: secondController.signal, toolUseId: 'tool1',
    });
    try {
      await vi.waitFor(() => expect(sendToAllDevicesAsync).toHaveBeenCalledTimes(1));
    } finally {
      firstController.abort();
      secondController.abort();
      await expect(first).rejects.toBeTruthy();
      await expect(second).rejects.toBeTruthy();
      handler.dispose();
    }
  });
});
