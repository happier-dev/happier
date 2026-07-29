import type { Credentials } from '@/persistence';
import { createCliApprovalsArtifactStore } from '@/session/actions/approvals/artifactStore';
import { getSharedBlockingApprovalCoordinator } from '@/session/actions/approvals/blockingApprovalCoordinator';
import {
  ApprovalRequestV1Schema,
  type ApprovalRequestV1,
  type ReviewCommentPrincipalHeaderV1,
} from '@happier-dev/protocol';
import { createCliReviewCommentActionExecutorFromCredentials } from '@/agent/reviews/comments/executor';
import { createExecutionRunHostActionCurrentIntentAdapter } from '@/session/actions/approvals/executionRunHostActionCurrentIntent';
import { requestReviewCommentDirectWriteGrant } from '@/agent/executionRuns/profiles/review/directWriteGrantRequester';
import { resolveReviewCommentHostPluginAuthority } from '@/agent/executionRuns/profiles/review/hostActionMaterializer';
import { tryAcquireAuthoritativePluginRuntimeRegistryLease } from '@/plugins/runtime/reload/runtimeLease';

import type { ExecutionRunRpcApprovalDeps } from './dispatchExecutionRunRpcAction';

function normalizePollIntervalMs(raw: unknown): number {
  const parsed = typeof raw === 'number' ? raw : Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) return 250;
  return Math.max(1, Math.min(60_000, Math.floor(parsed)));
}

function shouldNotifyApprovalUpdated(request: ApprovalRequestV1): boolean {
  return request.status === 'rejected'
    || request.status === 'canceled'
    || request.status === 'executed'
    || request.status === 'failed';
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
      || authority.packageDigest !== currentIntent.packageDigest
      || authority.manifestDigest !== currentIntent.manifestDigest
    ) {
      throw staleReviewHostActionError();
    }
  } finally {
    void lease.release();
  }
}

export function createExecutionRunRpcApprovalDeps(params: Readonly<{
  readCredentials: () => Promise<Credentials | null>;
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
      return await requestReviewCommentDirectWriteGrant({ credentials, input });
    },
    approvalsList: async (args) => {
      const store = await resolveStore();
      return await store.approvalsList(args);
    },
    approvalsCreate: async (args) => {
      const store = await resolveStore();
      return await store.approvalsCreate(args);
    },
    approvalsGet: async (args) => {
      const store = await resolveStore();
      return await store.approvalsGet(args);
    },
    approvalsUpdate: async (args) => {
      const store = await resolveStore();
      const result = await store.approvalsUpdate(args);
      if (result.ok && shouldNotifyApprovalUpdated(args.request)) {
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
