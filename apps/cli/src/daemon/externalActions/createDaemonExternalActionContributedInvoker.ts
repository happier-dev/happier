import {
  buildQualifiedPluginContributionKey,
  type TargetActionApprovalRequestV1,
  type ActionDefinitionV1,
} from '@happier-dev/protocol';
import {
  formatQualifiedPluginActionId,
  parseQualifiedPluginActionId,
  type ActionExecuteResult,
  type ActionExecutorDeps,
} from '@happier-dev/protocol/actions';

import { configuration } from '@/configuration';
import type { StoredCredentials } from '@/persistence';
import { logger } from '@/ui/logger';
import {
  executeContributedAction,
} from '@/plugins/runtime/invocation/actions/executeContributedAction';
import { createCliApprovalsArtifactStore } from '@/session/actions/approvals/artifactStore';
import { targetActionApprovalMatchesCurrentIntent } from '@/session/actions/approvals/targetActionCurrentIntent';
import {
  acquireAuthoritativePluginRuntimeRegistryLease,
  tryAcquireAuthoritativePluginRuntimeRegistryLease,
} from '@/plugins/runtime/reload/runtimeLease';
import type {
  TargetActionCurrentIntentRequest,
  TargetActionCurrentIntentResult,
} from '@/plugins/runtime/invocation/actionExecutor';
import type {
  ResolvedActionContribution,
  ResolvedActionDefinition,
} from '@/plugins/projection/registry/types';

type TargetActionApprovalStore = Pick<
  ReturnType<typeof createCliApprovalsArtifactStore>,
  'targetActionApprovalsGet' | 'targetActionApprovalsUpdate'
>;

function buildTargetActionApprovalDecisionResult(
  request: TargetActionApprovalRequestV1,
): ActionExecuteResult {
  return {
    ok: true,
    result: {
      ok: true,
      status: request.status,
      ...(request.execution === undefined ? {} : { execution: request.execution }),
    },
  };
}

function targetActionReplayFailure(
  errorCode: string,
  error = errorCode,
): ActionExecuteResult {
  return { ok: false, errorCode, error };
}

/**
 * The committed daemon registry is the only contributor-definition source.
 * Project it explicitly at this public Action catalog boundary so registry
 * implementation fields and undefined runtime slots never become API data.
 */
function projectDaemonExternalActionContributedDefinition(
  definition: ResolvedActionDefinition,
  identity: NonNullable<ResolvedActionContribution['identity']>,
): ActionDefinitionV1 {
  return Object.freeze({
    kindVersion: definition.kindVersion,
    id: formatQualifiedPluginActionId(identity),
    title: definition.title,
    description: definition.description,
    safety: definition.safety,
    placements: definition.placements,
    slash: definition.slash,
    bindings: definition.bindings,
    examples: definition.examples,
    surfaces: definition.surfaces,
    inputHints: definition.inputHints,
    inputSchema: definition.inputSchema,
    ...(definition.approval === undefined ? {} : { approval: definition.approval }),
    ...(definition.toolExposure === undefined ? {} : { toolExposure: definition.toolExposure }),
    ...(definition.outputSchema === undefined ? {} : { outputSchema: definition.outputSchema }),
    ...(definition.execution === undefined ? {} : { execution: definition.execution }),
    ...(definition.sideEffectClass === undefined
      ? {}
      : { sideEffectClass: definition.sideEffectClass }),
    ...(definition.operation === undefined ? {} : { operation: definition.operation }),
  });
}

/**
 * Adapts the public host Action `action.invoke` to the one committed-runtime
 * contributed-Action dispatcher. This adapter translates the public typed
 * contribution identity to the registry's canonical internal key; API caller
 * provenance remains host-owned and is deliberately not fabricated as a
 * plugin caller.
 */
export function createDaemonExternalActionContributedInvoker(input: Readonly<{
  acquireRuntimeRegistryLease?: typeof acquireAuthoritativePluginRuntimeRegistryLease;
  requestCurrentIntent?: (
    request: TargetActionCurrentIntentRequest,
  ) => Promise<TargetActionCurrentIntentResult>;
}> = {}): NonNullable<ActionExecutorDeps['invokeContributedAction']> {
  const acquireRuntimeRegistryLease = input.acquireRuntimeRegistryLease
    ?? acquireAuthoritativePluginRuntimeRegistryLease;

  return async ({ action, input: actionInput, context, signal }) => {
    const invocationSignal = signal ?? context.signal ?? new AbortController().signal;
    invocationSignal.throwIfAborted();
    const lease = await acquireRuntimeRegistryLease({
      happyHomeDir: configuration.happyHomeDir,
    });
    try {
      invocationSignal.throwIfAborted();
      const attempt = await executeContributedAction({
        runtimeRegistry: lease.registry,
        actionId: buildQualifiedPluginContributionKey(action),
        input: actionInput,
        // API deferral is only valid when the canonical target dispatcher has
        // host-stamped the exact daemon that must receive the later decision.
        // This is deliberately not the public execution-origin result contract:
        // a direct successful Action must not be post-vetoed by an origin
        // change after its target handler has already effected.
        captureApprovalReplayPlacement: true,
        ...(input.requestCurrentIntent
          ? { requestCurrentIntent: input.requestCurrentIntent }
          : {}),
        context: {
          surface: 'api',
          invocationSurface: 'api',
          ...(typeof context.defaultSessionId === 'string'
            ? { defaultSessionId: context.defaultSessionId }
            : {}),
          signal: invocationSignal,
        },
      });
      if (attempt.matched) {
        if (attempt.result.ok && attempt.result.deferredApprovalArtifactId !== undefined) {
          return {
            ok: true,
            result: {
              kind: 'approval_request_created',
              artifactId: attempt.result.deferredApprovalArtifactId,
              actionId: 'action.invoke',
            },
          };
        }
        if (attempt.result.ok) {
          // The placement is host-private durable approval evidence. It must
          // not become a public Action result on the non-deferred path.
          const { executionOrigin: _executionOrigin, ...result } = attempt.result;
          return result;
        }
        return attempt.result;
      }
      return {
        ok: false,
        errorCode: 'contributed_action_unavailable',
        error: 'contributed_action_unavailable',
      };
    } finally {
      await lease.release();
    }
  };
}

/**
 * Claims only strict API target-action approval artifacts at the daemon that
 * stamped their durable placement. The generic `approval.request.decide`
 * Action remains the public decision owner; this bridge only rehydrates its
 * target artifact and re-enters the canonical contributed-Action dispatcher.
 */
export function createDaemonExternalActionContributedApprovalReplay(input: Readonly<{
  credentials: StoredCredentials;
  acquireRuntimeRegistryLease?: typeof acquireAuthoritativePluginRuntimeRegistryLease;
  targetActionApprovals?: TargetActionApprovalStore;
  now?: () => number;
}>): NonNullable<ActionExecutorDeps['targetActionApprovalReplay']> {
  const acquireRuntimeRegistryLease = input.acquireRuntimeRegistryLease
    ?? acquireAuthoritativePluginRuntimeRegistryLease;
  const targetActionApprovals = input.targetActionApprovals
    ?? createCliApprovalsArtifactStore({ credentials: input.credentials });
  const now = input.now ?? Date.now;
  const inFlightReplays = new Map<string, Promise<ActionExecuteResult | null>>();

  const replayArtifact = async ({
    artifactId,
    decision,
    signal,
  }: Readonly<{
    artifactId: string;
    decision: 'approve' | 'reject';
    signal?: AbortSignal;
  }>): Promise<ActionExecuteResult | null> => {
    let existing: TargetActionApprovalRequestV1 | null;
    try {
      existing = await targetActionApprovals.targetActionApprovalsGet({ artifactId });
    } catch {
      return targetActionReplayFailure('approval_unavailable');
    }
    // This callback deliberately leaves ordinary ApprovalRequestV1 artifacts
    // on the generic Action owner rather than trying to interpret them here.
    if (!existing) return null;
    if (existing.requestedSurface !== 'api' || existing.replayPlacement === undefined) {
      return targetActionReplayFailure('approval_invalid');
    }

    const nextTimestamp = (request: TargetActionApprovalRequestV1): number => (
      Math.max(now(), request.updatedAtMs)
    );
    const persist = async (
      request: TargetActionApprovalRequestV1,
    ): Promise<ActionExecuteResult | null> => {
      try {
        const updated = await targetActionApprovals.targetActionApprovalsUpdate({ artifactId, request });
        return updated.ok ? null : targetActionReplayFailure(updated.errorCode, updated.error);
      } catch {
        return targetActionReplayFailure('approval_update_failed');
      }
    };

    if (decision === 'reject') {
      if (existing.status === 'rejected' && existing.decision?.kind === 'reject') {
        return buildTargetActionApprovalDecisionResult(existing);
      }
      if (existing.status !== 'open') {
        return targetActionReplayFailure('approval_not_open');
      }
      const rejected: TargetActionApprovalRequestV1 = {
        ...existing,
        status: 'rejected',
        updatedAtMs: nextTimestamp(existing),
        decision: { kind: 'reject', decidedAtMs: nextTimestamp(existing) },
      };
      const persistenceFailure = await persist(rejected);
      return persistenceFailure ?? buildTargetActionApprovalDecisionResult(rejected);
    }

    if ((existing.status === 'executed' || existing.status === 'failed')
      && existing.decision?.kind === 'approve') {
      return buildTargetActionApprovalDecisionResult(existing);
    }
    if (existing.status !== 'open'
      && (existing.status !== 'approved' || existing.decision?.kind !== 'approve')) {
      return targetActionReplayFailure('approval_not_open');
    }

    let approved = existing;
    if (existing.status === 'open') {
      const approvedAtMs = nextTimestamp(existing);
      const nextApproved: TargetActionApprovalRequestV1 = {
        ...existing,
        status: 'approved',
        updatedAtMs: approvedAtMs,
        decision: { kind: 'approve', decidedAtMs: approvedAtMs },
      };
      const persistenceFailure = await persist(nextApproved);
      if (persistenceFailure) return persistenceFailure;
      let reread: TargetActionApprovalRequestV1 | null;
      try {
        reread = await targetActionApprovals.targetActionApprovalsGet({ artifactId });
      } catch {
        return targetActionReplayFailure('approval_unavailable');
      }
      if (!reread) return targetActionReplayFailure('approval_not_found');
      approved = reread;
      if ((approved.status === 'executed' || approved.status === 'failed')
        && approved.decision?.kind === 'approve') {
        return buildTargetActionApprovalDecisionResult(approved);
      }
      if (approved.status !== 'approved' || approved.decision?.kind !== 'approve') {
        return targetActionReplayFailure('approval_not_open');
      }
    }
    if (approved.requestedSurface !== 'api' || approved.replayPlacement === undefined) {
      return targetActionReplayFailure('approval_invalid');
    }

    const action = parseQualifiedPluginActionId(approved.qualifiedActionId);
    if (!action) return targetActionReplayFailure('approval_invalid');
    const invocationSignal = signal ?? new AbortController().signal;
    let executionResult: ActionExecuteResult;
    try {
      invocationSignal.throwIfAborted();
      const lease = await acquireRuntimeRegistryLease({
        happyHomeDir: configuration.happyHomeDir,
      });
      try {
        invocationSignal.throwIfAborted();
        const attempt = await executeContributedAction({
          runtimeRegistry: lease.registry,
          actionId: buildQualifiedPluginContributionKey(action),
          input: approved.input,
          expectedApprovalReplayPlacement: approved.replayPlacement,
          requestCurrentIntent: async (currentIntent) => (
            targetActionApprovalMatchesCurrentIntent(approved, currentIntent)
              ? { status: 'approved', fingerprint: currentIntent.fingerprint }
              : { status: 'unavailable', code: 'plugin_action_current_intent_mismatch' }
          ),
          context: {
            surface: 'api',
            invocationSurface: 'api',
            ...(approved.replayPlacement.defaultSessionId === undefined
              ? {}
              : { defaultSessionId: approved.replayPlacement.defaultSessionId }),
            signal: invocationSignal,
          },
        });
        if (!attempt.matched) {
          executionResult = targetActionReplayFailure('contributed_action_unavailable');
        } else if (attempt.result.ok && attempt.result.deferredApprovalArtifactId !== undefined) {
          executionResult = targetActionReplayFailure('plugin_action_current_intent_mismatch');
        } else {
          executionResult = attempt.result;
        }
      } finally {
        await lease.release();
      }
    } catch {
      executionResult = targetActionReplayFailure('plugin_action_execution_failed');
    }

    const executedAtMs = nextTimestamp(approved);
    const terminal: TargetActionApprovalRequestV1 = executionResult.ok
      ? {
          ...approved,
          status: 'executed',
          updatedAtMs: executedAtMs,
          execution: { executedAtMs, ok: true, result: executionResult.result },
        }
      : {
          ...approved,
          status: 'failed',
          updatedAtMs: executedAtMs,
          execution: {
            executedAtMs,
            ok: false,
            errorCode: executionResult.errorCode,
            error: executionResult.error,
          },
        };
    const persistenceFailure = await persist(terminal);
    if (persistenceFailure) return persistenceFailure;
    return executionResult.ok
      ? buildTargetActionApprovalDecisionResult(terminal)
      : executionResult;
  };

  return async ({ artifactId: rawArtifactId, decision, signal }) => {
    const artifactId = rawArtifactId.trim();
    if (!artifactId) return null;
    signal?.throwIfAborted();

    const inFlightReplay = inFlightReplays.get(artifactId);
    if (inFlightReplay) return await inFlightReplay;

    const replay = Promise.resolve().then(() => replayArtifact({ artifactId, decision, signal }));
    inFlightReplays.set(artifactId, replay);
    try {
      return await replay;
    } finally {
      if (inFlightReplays.get(artifactId) === replay) {
        inFlightReplays.delete(artifactId);
      }
    }
  };
}

/**
 * Reads the current committed runtime's contributed Action declarations for
 * the canonical `action.spec.search` and `action.spec.get` owner. The lease
 * is released after the immutable declaration snapshot is copied; execution
 * keeps its own currentness checks through the committed invoker above.
 */
export function createDaemonExternalActionContributedDefinitionLister(input: Readonly<{
  tryAcquireRuntimeRegistryLease?: typeof tryAcquireAuthoritativePluginRuntimeRegistryLease;
}> = {}): NonNullable<ActionExecutorDeps['listContributedActionDefinitions']> {
  const tryAcquireRuntimeRegistryLease = input.tryAcquireRuntimeRegistryLease
    ?? tryAcquireAuthoritativePluginRuntimeRegistryLease;

  return () => {
    const lease = tryAcquireRuntimeRegistryLease({
      happyHomeDir: configuration.happyHomeDir,
    });
    if (!lease) return [];
    try {
      return Object.freeze(lease.registry.contributes.actions.flatMap((action) => {
        const identity = action.identity;
        // Discovery must use the same settings/invocation identity as the
        // committed Action runtime. A legacy or malformed registry row without
        // that identity cannot be safely projected into the public catalog.
        if (!identity || identity.localId !== action.definition.id) return [];
        return [projectDaemonExternalActionContributedDefinition(action.definition, identity)];
      }));
    } finally {
      void lease.release().catch(() => {
        logger.debug('[ExternalAction] Contributed Action discovery registry lease release failed (non-fatal)', {
          error: 'external_action_catalog_registry_lease_release_failed',
        });
      });
    }
  };
}
