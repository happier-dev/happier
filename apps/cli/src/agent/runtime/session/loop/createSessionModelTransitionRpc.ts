import { SessionModelTransitionRequestV1Schema, SessionModelTransitionResultV1Schema, projectSessionModelTransitionRequestedSelectionV1 } from '@happier-dev/protocol/sessions/control/modelTransitionV1';

import type { RpcHandler } from '@/api/rpc/types';
import type { StartupSessionPublisherAuthorityClaimResult } from '@/api/session/sessionClient';
import type { createSessionModelTransitionCoordinator } from '@/providers/sessions/sessionModelTransitionCoordinator';

type ModelTransitionCoordinator = ReturnType<typeof createSessionModelTransitionCoordinator>;

/** Accept requests as soon as publisher custody is visible, applying only after startup reconciliation. */
export function createSessionModelTransitionRpc(params: Readonly<{
  signal: AbortSignal;
  readAuthorityPreparation: () => Promise<StartupSessionPublisherAuthorityClaimResult> | null;
}>): Readonly<{
  handler: RpcHandler;
  settle: (coordinator: ModelTransitionCoordinator | null) => void;
}> {
  let resolveOwner!: (owner: ModelTransitionCoordinator | null) => void;
  const ownerReady = new Promise<ModelTransitionCoordinator | null>((resolve) => { resolveOwner = resolve; });
  const abort = () => resolveOwner(null);
  params.signal.addEventListener('abort', abort, { once: true });
  if (params.signal.aborted) abort();

  return {
    settle(coordinator) {
      params.signal.removeEventListener('abort', abort);
      resolveOwner(coordinator);
    },
    handler: async (rawRequest, rpcContext) => {
      const request = SessionModelTransitionRequestV1Schema.parse(rawRequest);
      const coordinator = await ownerReady;
      if (!coordinator) {
        return SessionModelTransitionResultV1Schema.parse({
          ok: false,
          status: 'owner_unavailable',
          activeSelection: null,
          requestedSelection: 'selection' in request ? projectSessionModelTransitionRequestedSelectionV1(request.selection) : null,
          reason: 'session_model_transition_startup_incomplete',
        });
      }
      const authorityPreparation = params.readAuthorityPreparation();
      if (!authorityPreparation) {
        throw new Error('Session model transition refused before claimed-session authority preparation');
      }
      const authority = await authorityPreparation;
      if (authority.status !== 'claimed') {
        throw Object.assign(
          new Error('Session model transition refused because this server does not support exact publisher-authority checks'),
          { code: authority.reason, retryable: false },
        );
      }
      return SessionModelTransitionResultV1Schema.parse(
        'unarm' in request ? await coordinator.unarm(rpcContext?.callerInputConstraints)
          : await coordinator.submit(request.selection, {
            source: 'command',
            ...(request.applyTiming ? { applyTiming: request.applyTiming } : {}),
            ...(request.captureBefore !== undefined ? { captureBefore: request.captureBefore } : {}),
            ...(request.expected ? { expected: request.expected } : {}),
            ...(rpcContext?.callerInputConstraints ? { callerInputConstraints: rpcContext.callerInputConstraints } : {}),
          }),
      );
    },
  };
}
