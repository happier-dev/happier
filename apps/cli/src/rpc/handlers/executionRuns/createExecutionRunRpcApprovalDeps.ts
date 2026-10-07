import type { StoredCredentials } from '@/persistence';
import { createCliApprovalsArtifactStore } from '@/session/actions/approvals/artifactStore';
import { getSharedBlockingApprovalCoordinator } from '@happier-dev/protocol/actions/blockingApprovalCoordinator';
import { StoredApprovalRequestSchema } from '@happier-dev/protocol/approvals/approvalRequestV1';
import { pluginSourceCustodyV1Equal } from '@happier-dev/protocol/plugins/runtime/sourceCustody';
import type { ReviewCommentPrincipalHeaderV1 } from '@happier-dev/protocol';
import { createCliReviewCommentActionExecutorFromCredentials } from '@/agent/reviews/comments/executor';
import { createExecutionRunHostActionCurrentIntentAdapter } from '@/session/actions/approvals/executionRunHostActionCurrentIntent';
import { requestReviewCommentDirectWriteGrant } from '@/agent/executionRuns/profiles/review/directWriteGrantRequester';
import type { PluginMachineMaterializationRefV1 } from '@happier-dev/protocol';
import {
  readAuthoritativePluginSlotOccurrence,
  tryAcquireAuthoritativePluginRuntimeRegistryLease,
} from '@/plugins/runtime/reload/runtimeLease';

import type { ExecutionRunRpcApprovalDeps } from './dispatchExecutionRunRpcAction';
import { observeAccountChanges } from '@/api/observeAccountChanges';
import { resolveServerHttpBaseUrl, runWithServerHttpBaseUrl } from '@/api/client/serverHttpBaseUrl';

function staleReviewHostActionError(): Error & { code: string } {
  return Object.assign(new Error('execution_run_host_action_stale'), {
    code: 'execution_run_host_action_stale',
  });
}

function assertReviewCommentPrincipalCurrent(
  principal: ReviewCommentPrincipalHeaderV1,
): void {
  const currentIntent = principal.currentIntent;
  if (!currentIntent || currentIntent.kind !== 'execution_run_host_action') return;
  const sourceCustody = readAuthoritativePluginSlotOccurrence(currentIntent.pluginId)?.sourceCustody ?? null;
  if (
    !sourceCustody
    || !pluginSourceCustodyV1Equal(sourceCustody, currentIntent.sourceCustody)
  ) {
    throw staleReviewHostActionError();
  }
}

export function createExecutionRunRpcApprovalDeps(params: Readonly<{
  readCredentials: () => Promise<StoredCredentials | null>;
  isApprovalExecutionOriginCurrent?: ExecutionRunRpcApprovalDeps['isApprovalExecutionOriginCurrent'];
}>): ExecutionRunRpcApprovalDeps {
  const coordinator = getSharedBlockingApprovalCoordinator();

  const resolveStore = async () => {
    const credentials = await params.readCredentials();
    if (!credentials) throw new Error('approval_credentials_unavailable');
    return createCliApprovalsArtifactStore({ credentials });
  };

  return {
    ...(params.isApprovalExecutionOriginCurrent
      ? { isApprovalExecutionOriginCurrent: params.isApprovalExecutionOriginCurrent }
      : {}),
    executionRunHostActionCurrentIntent: async (subject) => {
      try {
        const credentials = await params.readCredentials();
        if (!credentials) return { status: 'unavailable', code: 'execution_run_host_action_current_intent_unavailable' };
        const store = createCliApprovalsArtifactStore({ credentials });
        const serverUrl = resolveServerHttpBaseUrl();
        return await runWithServerHttpBaseUrl(serverUrl, () => createExecutionRunHostActionCurrentIntentAdapter({
          create: (request) => store.executionRunHostActionApprovalsCreate({ request }),
          read: (artifactId) => store.executionRunHostActionApprovalsGet({ artifactId }),
          subscribeChanges: (artifactId, onChange, onError) => observeAccountChanges({
            token: credentials.token,
            serverUrl,
            entityId: artifactId,
          }, { onChange, onError }),
        })(subject));
      } catch {
        return { status: 'unavailable', code: 'execution_run_host_action_current_intent_unavailable' };
      }
    },
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
        decisionAuthority: args.decisionAuthority,
      }),
    approvalsWaitForDecision: async (args) => {
      const credentials = await params.readCredentials();
      if (!credentials) throw new Error('approval_credentials_unavailable');
      const store = createCliApprovalsArtifactStore({ credentials });
      const serverUrl = resolveServerHttpBaseUrl();
      const result = await coordinator.waitForDecision({
        artifactId: args.artifactId,
        request: args.request,
        serverId: args.serverId,
        signal: args.signal,
        subscribeChanges: (onChange, onError) => observeAccountChanges({
          token: credentials.token,
          serverUrl,
          entityId: args.artifactId,
        }, { onChange, onError }),
        readRequest: async () => {
          return await runWithServerHttpBaseUrl(serverUrl, () => store.approvalsGet({
            artifactId: args.artifactId,
            serverId: args.serverId ?? null,
          }));
        },
      });
      return { ...result, request: StoredApprovalRequestSchema.parse(result.request) };
    },
  };
}
