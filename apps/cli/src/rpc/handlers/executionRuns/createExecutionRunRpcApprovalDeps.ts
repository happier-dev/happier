import type { StoredCredentials } from '@/persistence';
import { createCliApprovalsArtifactStore } from '@/session/actions/approvals/artifactStore';
import { getSharedBlockingApprovalCoordinator } from '@happier-dev/protocol/actions/blockingApprovalCoordinator';
import { createExecutionRunHostActionApprovalDecision } from '@happier-dev/protocol/actions/executionRunHostActionApprovalDecision';
import { StoredApprovalRequestSchema } from '@happier-dev/protocol/approvals/approvalRequestV1';
import { pluginSourceCustodyV1Equal } from '@happier-dev/protocol/plugins/runtime/sourceCustody';
import type { ReviewCommentPrincipalHeaderV1 } from '@happier-dev/protocol';
import { createCliReviewCommentActionExecutorFromCredentials } from '@/agent/reviews/comments/executor';
import { createExecutionRunHostActionCurrentIntentAdapter } from '@/session/actions/approvals/executionRunHostActionCurrentIntent';
import { createReviewRecordPortV1 } from '@happier-dev/protocol/reviews/reviewArtifactV1';
import { createAcknowledgedAccountArtifactTransport, createCredentialedAccountArtifactStore } from '@/api/artifacts/accountArtifactStore';

import type { ExecutionRunRpcApprovalDeps } from './dispatchExecutionRunRpcAction';
import { observeAccountChanges } from '@/api/observeAccountChanges';
import { resolveServerHttpBaseUrl, runWithServerHttpBaseUrl } from '@/api/client/serverHttpBaseUrl';
import { readCurrentReviewHostPluginAuthority, type ReviewHostPluginAuthorityReader } from '@/agent/executionRuns/profiles/review/pluginAuthority';

function staleReviewHostActionError(): Error & { code: string } {
  return Object.assign(new Error('execution_run_host_action_stale'), {
    code: 'execution_run_host_action_stale',
  });
}

async function assertReviewCommentPrincipalCurrent(
  principal: ReviewCommentPrincipalHeaderV1,
  readCurrentAuthority: ReviewHostPluginAuthorityReader,
): Promise<void> {
  const currentIntent = principal.currentIntent;
  if (!currentIntent || currentIntent.kind !== 'execution_run_host_action') return;
  const sourceCustody = (await readCurrentAuthority(currentIntent.pluginId))?.sourceCustody ?? null;
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
  resolveReviewHostPluginAuthority?: ReviewHostPluginAuthorityReader;
}>): ExecutionRunRpcApprovalDeps {
  const coordinator = getSharedBlockingApprovalCoordinator();
  const resolveReviewHostPluginAuthority = params.resolveReviewHostPluginAuthority ?? readCurrentReviewHostPluginAuthority;

  const resolveStore = async () => {
    const credentials = await params.readCredentials();
    if (!credentials) throw new Error('approval_credentials_unavailable');
    return createCliApprovalsArtifactStore({ credentials });
  };
  const reviewRecords = createReviewRecordPortV1({
    read: async (...args) => (await resolveReviewTransport()).read(...args),
    create: async input => (await resolveReviewTransport()).create(input),
    update: async input => (await resolveReviewTransport()).update(input),
  });
  async function resolveReviewTransport() {
    const credentials = await params.readCredentials();
    if (!credentials) throw Object.assign(new Error('Artifact content is unavailable'), { code: 'artifact_content_unavailable' });
    return createAcknowledgedAccountArtifactTransport(createCredentialedAccountArtifactStore(credentials));
  }

  return {
    reviewRecords: () => reviewRecords,
    executionRunHostActionApprovalReplay: createExecutionRunHostActionApprovalDecision({
      read: async artifactId => (await resolveStore()).executionRunHostActionApprovalsGet({ artifactId }),
      update: async args => (await resolveStore()).executionRunHostActionApprovalsUpdate(args),
    }),
    resolveReviewHostPluginAuthority,
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
          create: (request, onReady) => store.executionRunHostActionApprovalsCreate({ request, onReady }),
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
        assertPrincipalCurrent: principal => assertReviewCommentPrincipalCurrent(principal, resolveReviewHostPluginAuthority),
      });
      return await execute(actionId, input, {
        ...(reviewCommentPrincipal ? { principal: reviewCommentPrincipal } : {}),
      });
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
