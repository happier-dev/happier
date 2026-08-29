import type { StoredCredentials } from '@/persistence';
import { createCliApprovalsArtifactStore } from '@/session/actions/approvals/artifactStore';
import { getSharedBlockingApprovalCoordinator } from '@/session/actions/approvals/blockingApprovalCoordinator';
import {
  ApprovalRequestV1Schema,
  type ReviewCommentPrincipalHeaderV1,
} from '@happier-dev/protocol';
import { createCliReviewCommentActionExecutorFromCredentials } from '@/agent/reviews/comments/executor';
import { createExecutionRunHostActionCurrentIntentAdapter } from '@/session/actions/approvals/executionRunHostActionCurrentIntent';
import { requestReviewCommentDirectWriteGrant } from '@/agent/executionRuns/profiles/review/directWriteGrantRequester';
import { resolveReviewCommentHostPluginAuthority } from '@/agent/executionRuns/profiles/review/hostActionMaterializer';
import type { PluginMachineMaterializationRefV1 } from '@happier-dev/protocol';
import { tryAcquireAuthoritativePluginRuntimeRegistryLease } from '@/plugins/runtime/reload/runtimeLease';

import type { ExecutionRunRpcApprovalDeps } from './dispatchExecutionRunRpcAction';

function normalizePollIntervalMs(raw: unknown): number {
  const parsed = typeof raw === 'number' ? raw : Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) return 250;
  return Math.max(1, Math.min(60_000, Math.floor(parsed)));
}

function staleReviewHostActionError(): Error & { code: string } {
  return Object.assign(new Error('execution_run_host_action_stale'), {
    code: 'execution_run_host_action_stale',
  });
}

function assertReviewCommentPrincipalCurrent(
  principal: ReviewCommentPrincipalHeaderV1,
): void {
  const currentIntent = principal.currentIntent;
  if (!currentIntent) return;
  const lease = tryAcquireAuthoritativePluginRuntimeRegistryLease();
  if (!lease) throw staleReviewHostActionError();
  try {
    const authority = resolveReviewCommentHostPluginAuthority({
      pluginId: currentIntent.pluginId,
      current: lease.registry.pluginFinalPolicyCurrentGenerationsById
        ?.get(currentIntent.pluginId) ?? null,
    });
    if (
      !authority
      || authority.immutableGenerationId !== currentIntent.immutableGenerationId
    ) {
      throw staleReviewHostActionError();
    }
  } finally {
    void lease.release();
  }
}

export function createExecutionRunRpcApprovalDeps(params: Readonly<{
  readCredentials: () => Promise<StoredCredentials | null>;
}>): ExecutionRunRpcApprovalDeps {
  const coordinator = getSharedBlockingApprovalCoordinator();

  const resolveStore = async () => {
    const credentials = await params.readCredentials();
    if (!credentials) throw new Error('approval_credentials_unavailable');
    return createCliApprovalsArtifactStore({ credentials });
  };

  return {
    executionRunHostActionCurrentIntent: createExecutionRunHostActionCurrentIntentAdapter({
      create: async (request) => {
        const store = await resolveStore();
        return await store.executionRunHostActionApprovalsCreate({ request });
      },
      read: async (artifactId) => {
        const store = await resolveStore();
        return await store.executionRunHostActionApprovalsGet({ artifactId });
      },
    }),
    reviewCommentAction: async ({ actionId, input, reviewCommentPrincipal }) => {
      const credentials = await params.readCredentials();
      if (!credentials) throw new Error('review_comment_credentials_unavailable');
      const execute = createCliReviewCommentActionExecutorFromCredentials({
        credentials,
        assertPrincipalCurrent: assertReviewCommentPrincipalCurrent,
      });
      return await execute(actionId, input, {
        ...(reviewCommentPrincipal ? { principal: reviewCommentPrincipal } : {}),
      });
    },
    pluginPermissionGrantRequest: async ({ serverId: _serverId, ...input }) => {
      const credentials = await params.readCredentials();
      if (!credentials) throw new Error('plugin_permission_grant_credentials_unavailable');
      // The exact current materialization provenance is host-resolved here so
      // the server can bind the grant request to the proven caller; a
      // caller-string alone is never admitted.
      let caller: PluginMachineMaterializationRefV1 | undefined;
      const lease = tryAcquireAuthoritativePluginRuntimeRegistryLease();
      try {
        const ref = lease?.registry.resolveCurrentPluginMaterializationRef?.(input.pluginId) ?? null;
        if (ref && ref.pluginId === input.pluginId) caller = ref;
      } finally {
        void lease?.release();
      }
      return await requestReviewCommentDirectWriteGrant({ credentials, input: { ...input, ...(caller ? { caller } : {}) } });
    },
    approvalsList: async (args) => {
      const store = await resolveStore();
      return await store.approvalsList(args);
    },
    approvalsCreate: async (args) => {
      const store = await resolveStore();
      const result = await store.approvalsCreate(args);
      coordinator.notifyApprovalUpdated({
        artifactId: result.artifactId,
        request: args.request,
      });
      return result;
    },
    approvalsGet: async (args) => {
      const store = await resolveStore();
      return await store.approvalsGet(args);
    },
    approvalsUpdate: async (args) => {
      const store = await resolveStore();
      const result = await store.approvalsUpdate(args);
      if (result.ok) {
        coordinator.notifyApprovalUpdated({
          artifactId: args.artifactId,
          request: args.request,
        });
      }
      return result;
    },
    approvalsResolveBlockingDecision: async (args) =>
      await coordinator.resolveBlockingDecision({
        artifactId: args.artifactId,
        request: args.request,
        decision: args.decision,
      }),
    approvalsWaitForDecision: async (args) => {
      const result = await coordinator.waitForDecision({
        artifactId: args.artifactId,
        request: args.request,
        serverId: args.serverId,
        signal: args.signal,
        pollIntervalMs: normalizePollIntervalMs(process.env.HAPPIER_BLOCKING_APPROVAL_POLL_INTERVAL_MS),
        readRequest: async () => {
          const store = await resolveStore();
          return await store.approvalsGet({
            artifactId: args.artifactId,
            serverId: args.serverId ?? null,
          });
        },
      });
      return { ...result, request: ApprovalRequestV1Schema.parse(result.request) };
    },
  };
}
