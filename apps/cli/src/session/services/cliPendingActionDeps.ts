import type { CliActionDepsParams } from '../actions/cliActionDeps/types';
import type { withdrawPendingQueueV2Message, updatePendingQueueV2RequestedAction, markPendingQueueV2DeliveryHandled, dismissPendingQueueV2Delivery, sendPendingQueueV2DeliveryAsNew } from '@/api/session/pendingQueueV2Transport';
import type { readProviderAccountUsageHistoryWitnessV4, readProviderAccountUsageQuotaV4 } from '@/daemon/connectedServices/accountUsage/readQuota';
import { evaluatePendingResetStartAdmissionV1, PendingResetStartWaitingReasonV1Schema } from '@happier-dev/protocol/sessions/pending/pendingResetStartReadinessV1';
import { PENDING_INPUT_PROTOCOL_VERSION_V4 } from '@happier-dev/protocol/clientCompatibility/primitives';
import { ActionExecuteFailureSchema } from '@happier-dev/protocol/actions/actionExecutionResult';
import type { ActionExecutorDeps, ActionExecutorContext } from '@happier-dev/protocol';
import { fetchAccountEncryptionCurrentness } from '@/api/client/accountEncryptionCurrentness';
import { SESSION_RPC_METHODS } from '@happier-dev/protocol/rpc/methods';
import type { CliServerFeaturesSnapshot } from '@/features/serverFeaturesClient';
import type { CliProjectAdmission } from '@/session/actions/cliActionDeps/projectAdmission';

type FamilyActionDeps = Pick<ActionExecutorDeps, 'sessionTerminalComposerClear' | 'sessionPendingInputInterruptAndRun' | 'sessionPendingRequeue' | 'sessionPendingActionSet' | 'sessionPendingWithdraw' | 'sessionPendingMarkHandled' | 'sessionPendingDismiss' | 'sessionPendingSendAsNew' | 'sessionPendingResetStartSet' | 'sessionPendingResetStartCancel'>;

export function createCliPendingActionDeps(
  params: CliActionDepsParams,
  { assertProjectRequesterCurrent, callResolvedSessionRpc, executionRunActionFailure, projectHomeAdmission, readServerFeaturesSnapshot, resolveServerRequestHeaders, withProjectHome }: Readonly<{

    assertProjectRequesterCurrent: CliProjectAdmission['assertProjectRequesterCurrent'];
    callResolvedSessionRpc: (sessionId: string, method: string, request: unknown, signal?: AbortSignal) => Promise<unknown>;
    executionRunActionFailure: (code: string, message?: string, details?: unknown) => Readonly<{ ok: false; errorCode: string; error: string; details?: unknown }>;
    projectHomeAdmission: CliProjectAdmission['projectHomeAdmission'];
    readServerFeaturesSnapshot: () => Promise<CliServerFeaturesSnapshot | undefined>;
    resolveServerRequestHeaders: (context: ActionExecutorContext | undefined, effectActionId: string, request: Readonly<{ method: string; path: string; body?: unknown }>) => Readonly<Record<string, string>> | null;
    withProjectHome: CliProjectAdmission['withProjectHome'];
  }>,
): FamilyActionDeps {
  return {

    sessionTerminalComposerClear: async ({ sessionId, expectedStateAtMs }) => {
      return await callResolvedSessionRpc(sessionId, SESSION_RPC_METHODS.SESSION_TERMINAL_COMPOSER_CLEAR, {
        sessionId,
        ...(typeof expectedStateAtMs === 'number' ? { expectedStateAtMs } : {}),
      });
    },

    sessionPendingInputInterruptAndRun: async ({ sessionId, localId, expectedStateAtMs }) => {
      return await callResolvedSessionRpc(sessionId, SESSION_RPC_METHODS.SESSION_PENDING_INPUT_INTERRUPT_AND_RUN, {
        sessionId,
        localId,
        ...(typeof expectedStateAtMs === 'number' ? { expectedStateAtMs } : {}),
      });
    },
    sessionPendingRequeue: async ({ sessionId, localId, serverId, targetExecutionRunId, context }) => {
      const denied = await projectHomeAdmission(serverId, context);
      if (denied) return denied;
      return withProjectHome(async () => {
        const { restoreDiscardedPendingMessage } = await import("@/api/session/pendingQueueV2Transport");
        await restoreDiscardedPendingMessage({ token: params.token, sessionId, localId,
          ...(targetExecutionRunId ? { targetExecutionRunId } : {}), ...(context.signal ? { signal: context.signal } : {}),
          resolveAuthorizationHeaders: request => resolveServerRequestHeaders(context, 'session.pending.requeue', request),
        });
        return { ok: true };
      });
    },
    sessionPendingActionSet: async ({ sessionId, localId, requestedAction, resumeWhenAvailable, serverId, context }) => {
      const denied = await projectHomeAdmission(serverId, context);
      if (denied) return denied;
      const { updatePendingQueueV2RequestedAction } = await import("@/api/session/pendingQueueV2Transport");
      return withProjectHome(() => updatePendingQueueV2RequestedAction({ token: params.token, sessionId, localId, requestedAction,
        ...(resumeWhenAvailable !== undefined ? { resumeWhenAvailable } : {}),
        ...(context.signal ? { signal: context.signal } : {}),
        resolveAuthorizationHeaders: request => resolveServerRequestHeaders(context, 'session.pending.action.set', request),
      }));
    },
    sessionPendingWithdraw: async ({ sessionId, localId, serverId, targetExecutionRunId, context }) => {
      const denied = await projectHomeAdmission(serverId, context);
      if (denied) return denied;
      const { withdrawPendingQueueV2Message } = await import("@/api/session/pendingQueueV2Transport");
      return withProjectHome(() => withdrawPendingQueueV2Message({ token: params.token, sessionId, localId,
        ...(targetExecutionRunId ? { targetExecutionRunId } : {}), ...(context.signal ? { signal: context.signal } : {}),
        resolveAuthorizationHeaders: request => resolveServerRequestHeaders(context, 'session.pending.withdraw', request),
      }));
    },
    sessionPendingMarkHandled: async ({ sessionId, localId, serverId, context }) => {
      const denied = await projectHomeAdmission(serverId, context);
      if (denied) return denied;
      return withProjectHome(async () => {
        const { markPendingQueueV2DeliveryHandled } = await import("@/api/session/pendingQueueV2Transport");
        await markPendingQueueV2DeliveryHandled({ token: params.token, sessionId, localId,
          ...(context.signal ? { signal: context.signal } : {}),
          resolveAuthorizationHeaders: request => resolveServerRequestHeaders(context, 'session.pending.markHandled', request),
        });
        return { ok: true };
      });
    },
    sessionPendingDismiss: async ({ sessionId, localId, serverId, targetExecutionRunId, context }) => {
      const denied = await projectHomeAdmission(serverId, context);
      if (denied) return denied;
      return withProjectHome(async () => {
        const { dismissPendingQueueV2Delivery } = await import("@/api/session/pendingQueueV2Transport");
        await dismissPendingQueueV2Delivery({ token: params.token, sessionId, localId,
          ...(targetExecutionRunId ? { targetExecutionRunId } : {}), ...(context.signal ? { signal: context.signal } : {}),
          resolveAuthorizationHeaders: request => resolveServerRequestHeaders(context, 'session.pending.dismiss', request),
        });
        return { ok: true };
      });
    },
    sessionPendingSendAsNew: async ({ sessionId, localId, serverId, targetExecutionRunId, context }) => {
      const denied = await projectHomeAdmission(serverId, context);
      if (denied) return denied;
      return withProjectHome(async () => {
        const { sendPendingQueueV2DeliveryAsNew } = await import("@/api/session/pendingQueueV2Transport");
        const { newLocalId } = await sendPendingQueueV2DeliveryAsNew({ token: params.token, sessionId, localId,
          ...(targetExecutionRunId ? { targetExecutionRunId } : {}), ...(context.signal ? { signal: context.signal } : {}),
          resolveAuthorizationHeaders: request => resolveServerRequestHeaders(context, 'session.pending.sendAsNew', request),
        });
        return { newLocalId };
      });
    },
    sessionPendingResetStartSet: async ({ sessionId, localId, serverId, reset, initialInput, context }) => {
      const denied = await projectHomeAdmission(serverId, context);
      if (denied) return denied;
      const credentials = params.credentials;
      if (!credentials) return executionRunActionFailure('not_authenticated');
      const assertCurrent = async () => {
        context.signal?.throwIfAborted();
        if (await projectHomeAdmission(serverId, context)) throw Object.assign(new Error('server_scope_mismatch'), { code: 'server_scope_mismatch' });
        await assertProjectRequesterCurrent(context);
      };
      const authorizeRequest = (request: Readonly<{ method: string; path: string; body?: unknown }>) => {
        const headers = resolveServerRequestHeaders(context, 'session.pending.resetStart.set', request);
        if (!headers) throw Object.assign(new Error('reset_start_unavailable'), { code: 'reset_start_unavailable', reason: 'authority_unavailable' });
        return headers;
      };
      try {
        return await withProjectHome(async () => {
          await assertCurrent();
          const snapshot = await readServerFeaturesSnapshot();
          await assertCurrent();
          if (snapshot?.status === 'ready' && (snapshot.features.capabilities.session.pendingInput?.protocolVersion ?? 0) < PENDING_INPUT_PROTOCOL_VERSION_V4) {
            throw Object.assign(new Error('reset_start_unsupported'), { code: 'reset_start_unsupported' });
          }
          const headers = authorizeRequest({ method: 'GET', path: '/v1/account/encryption/currentness' });
          const [{ fetchAccountEncryptionCurrentness }, { readProviderAccountUsageQuotaV4, readProviderAccountUsageHistoryWitnessV4 }, { updatePendingQueueV2RequestedAction }] = await Promise.all([import("@/api/client/connectedServiceCredentialApi"), import("@/daemon/connectedServices/accountUsage/readQuota"), import("@/api/session/pendingQueueV2Transport")]);
          const authority = await fetchAccountEncryptionCurrentness({ credentials: credentials, token: credentials.token, authorizationHeaders: headers,
            ...(context.signal ? { signal: context.signal } : {}) });
          await assertCurrent();
          const options = { credentials, accountMode: authority.mode, assertCurrent, authorizeRequest,
            includePendingWork: false, ...(context.signal ? { signal: context.signal } : {}) };
          const [quota, witness] = await Promise.all([
            readProviderAccountUsageQuotaV4({ source: reset.source }, options),
            readProviderAccountUsageHistoryWitnessV4({ recordId: reset.recordId, witness: reset.witness }, options),
          ]);
          await assertCurrent();
          const admission = evaluatePendingResetStartAdmissionV1({ reset, witness, current: quota.current, nowMs: Date.now(), authorityCurrent: true });
          if (admission.status === 'unavailable') throw Object.assign(new Error('reset_start_unavailable'), {
            code: 'reset_start_unavailable', reason: admission.reason,
          });
          return updatePendingQueueV2RequestedAction({ token: params.token, sessionId, localId,
            requestedAction: { v: 1, kind: 'reset_start', reset }, ...(initialInput ? { initialInput } : {}),
            ...(context.signal ? { signal: context.signal } : {}), resolveAuthorizationHeaders: authorizeRequest,
          });
        });
      } catch (error) {
        if (error instanceof Error && 'code' in error) {
          if (error.code === 'reset_start_unsupported') return executionRunActionFailure('reset_start_unsupported');
          if (error.code === 'reset_start_unavailable' && 'reason' in error) {
            const reason = PendingResetStartWaitingReasonV1Schema.safeParse(error.reason);
            if (reason.success) return ActionExecuteFailureSchema.parse({ ok: false, errorCode: 'reset_start_unavailable',
              error: 'reset_start_unavailable', details: { reason: reason.data } });
          }
        }
        throw error;
      }
    },
    sessionPendingResetStartCancel: async ({ sessionId, localId, serverId, context }) => {
      const denied = await projectHomeAdmission(serverId, context);
      if (denied) return denied;
      const { withdrawPendingQueueV2Message } = await import("@/api/session/pendingQueueV2Transport");
      return withProjectHome(() => withdrawPendingQueueV2Message({ token: params.token, sessionId, localId,
        ...(context.signal ? { signal: context.signal } : {}),
        resolveAuthorizationHeaders: request => resolveServerRequestHeaders(context, 'session.pending.resetStart.cancel', request),
      }));
    },
  };
}
