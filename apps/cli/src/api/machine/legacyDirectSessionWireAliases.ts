import {
  type ActionExecuteResult,
  ExternalSessionFollowPolicySetRequestSchema,
  ExternalSessionTakeoverPersistRequestSchema as DirectSessionTakeoverPersistRequestSchema,
  ExternalSessionTakeoverRequestSchema as DirectSessionTakeoverRequestSchema,
  type ExternalSessionFollowPolicySetResponse,
  type ExternalSessionTakeoverPersistResponse as DirectSessionTakeoverPersistResponse,
  type ExternalSessionTakeoverResponse as DirectSessionTakeoverResponse,
} from '@happier-dev/protocol';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';
import {
  mapExternalSessionsTakeoverPersistToExternalSessionTakeoverInputV1 as mapDirectSessionsTakeoverPersistToExternalSessionTakeoverInputV1,
  mapExternalSessionsTakeoverToExternalSessionTakeoverInputV1 as mapDirectSessionsTakeoverToExternalSessionTakeoverInputV1,
} from '@happier-dev/protocol/sessions';

import {
  externalSessionsError as directSessionsError,
  mapActionFailureToExternalSessionsError as mapActionFailureToDirectSessionsError,
  mapExternalTakeoverResultToDirectTakeoverPersistResponse,
  mapExternalTakeoverResultToDirectTakeoverResponse,
  type ExternalSessionTakeoverActionInput,
} from '@/session/actions/externalSessions';

import type { RpcHandlerManager } from '../rpc/RpcHandlerManager';
import { mapCanonicalExternalSessionResponseToLegacyDirectSession } from './legacyDirectSessionResponseCompatibility';

export type LegacyDirectSessionTakeoverDispatcher = (
  actionInput: ExternalSessionTakeoverActionInput,
) => Promise<ActionExecuteResult>;

export function registerLegacyDirectSessionFollowPolicyWireAlias(params: Readonly<{
  rpcHandlerManager: RpcHandlerManager;
  dispatchExternalSessionFollowPolicyAction: (input: unknown) => Promise<ActionExecuteResult>;
}>): void {
  params.rpcHandlerManager.registerHandler(
    RPC_METHODS.DAEMON_DIRECT_SESSION_FOLLOW_POLICY_SET_LEGACY,
    async (raw: unknown) => {
      const parsed = ExternalSessionFollowPolicySetRequestSchema.safeParse(raw);
      if (!parsed.success) {
        return mapCanonicalExternalSessionResponseToLegacyDirectSession(
          directSessionsError('invalid_request') satisfies ExternalSessionFollowPolicySetResponse,
        );
      }

      // remote-dev@e67f3751 uses transcript-bearing raw deltas while current
      // clients consume content-free invalidation followed by authoritative
      // readAfter. Enabling across that skew would report success without a
      // consumable update plane. Retain this predecessor RPC only so either
      // side can clean up an already-enabled policy; remove it when that
      // predecessor and its persisted policies are unreachable.
      if (parsed.data.enabled) {
        return mapCanonicalExternalSessionResponseToLegacyDirectSession({
          ok: false,
          errorCode: 'agent_unavailable',
          error: 'background_follow_not_supported',
        } satisfies ExternalSessionFollowPolicySetResponse);
      }

      const dispatched = await params.dispatchExternalSessionFollowPolicyAction(parsed.data);
      if (!dispatched.ok) {
        return mapCanonicalExternalSessionResponseToLegacyDirectSession(
          mapActionFailureToDirectSessionsError(dispatched),
        );
      }
      return mapCanonicalExternalSessionResponseToLegacyDirectSession(dispatched.result);
    },
  );
}

export function registerLegacyDirectSessionTakeoverWireAliases(params: Readonly<{
  rpcHandlerManager: RpcHandlerManager;
  dispatchExternalSessionTakeoverAction: LegacyDirectSessionTakeoverDispatcher;
}>): void {
  params.rpcHandlerManager.registerHandler(RPC_METHODS.DAEMON_DIRECT_SESSION_TAKEOVER_LEGACY, async (raw: unknown) => {
    const parsed = DirectSessionTakeoverRequestSchema.safeParse(raw);
    if (!parsed.success) return directSessionsError('invalid_request') satisfies DirectSessionTakeoverResponse;
    const actionInput = {
      ...mapDirectSessionsTakeoverToExternalSessionTakeoverInputV1({
        linkedSessionId: parsed.data.sessionId,
        ...(parsed.data.forceStop === undefined ? {} : { forceStop: parsed.data.forceStop }),
      }),
      machineId: parsed.data.machineId,
    };
    const dispatched = await params.dispatchExternalSessionTakeoverAction(actionInput);
    if (!dispatched.ok) {
      return mapCanonicalExternalSessionResponseToLegacyDirectSession(
        mapActionFailureToDirectSessionsError(dispatched) satisfies DirectSessionTakeoverResponse,
      );
    }
    return mapCanonicalExternalSessionResponseToLegacyDirectSession(
      mapExternalTakeoverResultToDirectTakeoverResponse(dispatched.result),
    );
  });

  params.rpcHandlerManager.registerHandler(RPC_METHODS.DAEMON_DIRECT_SESSION_TAKEOVER_PERSIST_LEGACY, async (raw: unknown) => {
    const parsed = DirectSessionTakeoverPersistRequestSchema.safeParse(raw);
    if (!parsed.success) return directSessionsError('invalid_request') satisfies DirectSessionTakeoverPersistResponse;
    const actionInput = {
      ...mapDirectSessionsTakeoverPersistToExternalSessionTakeoverInputV1({
        linkedSessionId: parsed.data.sessionId,
        ...(parsed.data.forceStop === undefined ? {} : { forceStop: parsed.data.forceStop }),
      }),
      machineId: parsed.data.machineId,
    };
    const dispatched = await params.dispatchExternalSessionTakeoverAction(actionInput);
    if (!dispatched.ok) {
      return mapCanonicalExternalSessionResponseToLegacyDirectSession(
        mapActionFailureToDirectSessionsError(dispatched) satisfies DirectSessionTakeoverPersistResponse,
      );
    }
    return mapCanonicalExternalSessionResponseToLegacyDirectSession(
      mapExternalTakeoverResultToDirectTakeoverPersistResponse(dispatched.result),
    );
  });
}
