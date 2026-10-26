import { PushNotificationTestRequestSchema } from '@happier-dev/protocol';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';
import type { PushNotificationClient } from '../pushNotifications';
import type { RpcHandlerRegistrar } from '../rpc/types';

export function registerMachineNotificationRpcHandlers(params: Readonly<{
  rpcHandlerManager: RpcHandlerRegistrar;
  pushNotifications: PushNotificationClient;
}>): void {
  params.rpcHandlerManager.registerHandler(RPC_METHODS.DAEMON_NOTIFICATIONS_TEST_PUSH, async (raw: unknown) => {
    const request = PushNotificationTestRequestSchema.parse(raw);
    return await params.pushNotifications.sendTestNotificationAsync(request.tokenId);
  });
}
