import { decodeSessionFollowSourceDataEncryptionKeyV1, SESSION_FOLLOW_SOURCE_KEY_PREPARATION_REJECTION_CODE_V1, SessionFollowSourceKeyPrepareAuthorizationV1Schema, SessionFollowSourceKeyPrepareRequestV1Schema, SessionFollowSourceKeyPrepareResponseV1Schema } from '@happier-dev/protocol/sessions/follow/sessionFollowSourceKeyPreparationV1';
import { RPC_METHODS } from '@happier-dev/protocol/rpc/methods';
import { RpcError } from '@happier-dev/protocol/rpcErrors';

import type { RpcHandlerRegistrar } from '@/api/rpc/types';
import type { SessionFollowSourceMaterialController } from '@/agent/runtime/session/follow/sessionFollowSourceMaterialResolver';

/** Installs Lane 09's exact prepared source DEK into the single runtime resolver. */
export function registerRestrictedSessionFollowSourceKeyReceiver(input: Readonly<{
  destinationSessionId: string;
  rpc: RpcHandlerRegistrar;
  sourceMaterial: SessionFollowSourceMaterialController;
  onSourceMaterialInstalled: () => void;
}>): void {
  input.rpc.registerHandler(RPC_METHODS.DAEMON_SESSION_FOLLOW_SOURCE_KEY_PREPARE, async (raw, context) => {
    try {
      const request = SessionFollowSourceKeyPrepareRequestV1Schema.parse(raw);
      const authorization = SessionFollowSourceKeyPrepareAuthorizationV1Schema.parse(context?.authorization);
      if (
        request.destinationSessionId !== input.destinationSessionId
        || authorization.destinationSessionId !== input.destinationSessionId
        || request.sourceSessionId !== authorization.sourceSessionId
        || request.destinationSessionId !== authorization.destinationSessionId
      ) throw new Error('session_follow_source_key_binding_invalid');
      const dataKey = decodeSessionFollowSourceDataEncryptionKeyV1(request.sourceDataEncryptionKeyBase64);
      try {
        input.sourceMaterial.installPreparedDataKey({ sourceSessionId: request.sourceSessionId, dataKey });
      } finally {
        dataKey.fill(0);
      }
      // Installation is not delivery. Wake the incumbent content-free Follow
      // invalidation owner so the destination re-observes current edge/access
      // state and either hydrates the pending source or prunes stale material.
      input.onSourceMaterialInstalled();
      return SessionFollowSourceKeyPrepareResponseV1Schema.parse({ v: 1, outcome: 'installed' });
    } catch {
      throw new RpcError(
        'Session Follow source-key preparation rejected',
        SESSION_FOLLOW_SOURCE_KEY_PREPARATION_REJECTION_CODE_V1,
      );
    }
  });
}
