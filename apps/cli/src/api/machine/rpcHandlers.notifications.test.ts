import { beforeEach, describe, expect, it, vi } from 'vitest';
import axios from 'axios';
import { PushNotificationClient } from '../pushNotifications';
import { RpcHandlerManager } from '../rpc/RpcHandlerManager';
import { registerMachineRpcHandlers } from './rpcHandlers';

// HTTP and Expo are the external boundaries; Account token selection, payload
// construction, machine registration and RPC execution remain real.
const expoSend = vi.hoisted(() => vi.fn(async () => [{ status: 'ok', id: 'ticket' }]));
vi.mock('axios', () => ({ default: { get: vi.fn(), delete: vi.fn(), isAxiosError: () => false } }));
vi.mock('expo-server-sdk', () => ({ Expo: class {
  static isExpoPushToken() { return true; }
  chunkPushNotifications(messages: unknown[]) { return [messages]; }
  sendPushNotificationsAsync = expoSend;
  async getPushNotificationReceiptsAsync() { return {}; }
} }));

describe('machine notification diagnostic RPC', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it('uses the canonical authenticated sender and rejects arbitrary recipients', async () => {
    const manager = new RpcHandlerManager({ scopePrefix: 'machine-a', encryptionKey: null, encryptionVariant: 'plain' });
    const registration = registerMachineRpcHandlers({
      rpcHandlerManager: manager,
      handlers: { spawnSession: async () => ({ type: 'success', sessionId: 'session' }), stopSession: async () => true, requestShutdown: () => {} },
      deps: { pushNotifications: new PushNotificationClient('account-a', 'https://home-a.test') },
    });
    try {
      vi.mocked(axios.get).mockResolvedValue({ data: { tokens: [{ id: 'registered', token: 'ExponentPushToken[a]' }] } });
      await expect(manager.invokeLocal('daemon.notifications.testPush', { tokenId: 'registered' })).resolves.toEqual({ status: 'accepted' });
      await expect(manager.invokeLocal('daemon.notifications.testPush', { tokenId: 'foreign' })).resolves.toEqual({ status: 'not_registered' });
      await expect(manager.invokeLocal('daemon.notifications.testPush', { tokenId: 'registered', to: 'ExponentPushToken[foreign]' })).rejects.toThrow();
      expect(expoSend).toHaveBeenCalledTimes(1);
    } finally {
      await registration.dispose();
    }
  });
});
