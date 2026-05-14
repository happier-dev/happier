import type { Credentials } from '@/persistence';
import { createCliApprovalsArtifactStore } from '@/session/actions/approvals/artifactStore';
import { getSharedBlockingApprovalCoordinator } from '@/session/actions/approvals/blockingApprovalCoordinator';
import type { ApprovalRequestV1 } from '@happier-dev/protocol';

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
    approvalsWaitForDecision: async (args) =>
      await coordinator.waitForDecision({
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
      }),
  };
}
