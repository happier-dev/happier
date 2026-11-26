import {
  ApprovalRequestV2Schema,
  type ApprovalRequestV2,
} from '@happier-dev/protocol/approvals/approvalRequestV1';
import { buildApprovalRequestArtifactHeaderV1 } from '@happier-dev/protocol/approvals/approvalArtifactHeaderV1';
import type { DecryptedArtifact } from '@/sync/domains/artifacts/artifactTypes';

/**
 * A provider Create or Delete review as a Home stores it when the person asks from the command line
 * (`happier deployments …`): no Session asked, the Account's own automation credential did. Shapes follow the
 * stored requests of the Railway review on QA stack #217 (cut 50), with neutral names; built through the real
 * approval schema and header, never a hand-shaped approval record.
 */
export function createDeploymentApprovalArtifact(
  input: Readonly<{
    id: string;
    kind: 'create' | 'delete';
    scope: Readonly<{ serverId: string; accountId: string }>;
    /** The Account whose command line asked; defaults to the viewer's own Account. */
    requesterAccountId?: string;
    status?: ApprovalRequestV2['status'];
  }>,
): Extract<DecryptedArtifact, { isDecrypted: true }> &
  Readonly<{ body: string; request: ApprovalRequestV2 }> {
  const { id, scope } = input;
  const create = input.kind === 'create';
  const actionId = create ? 'deployments.targets.link' : 'deployments.teardown';
  const summary = create
    ? 'Create service orders-api.'
    : 'Delete this linked resource at its provider. Also removes the Domain orders-api-production.up.railway.app.';
  const deploymentReview = create
    ? {
        summary,
        platformCreate: {
          platformName: 'Railway',
          resourceName: 'orders-api',
          environment: {
            id: 'env-orders-production',
            name: 'Orders API Production',
          },
          repository: 'acme/orders-api',
          productionBranch: 'main',
          followsBranch: true,
        },
      }
    : {
        summary,
        removal: {
          subject: {
            kind: 'platformResource',
            name: 'orders-api',
            platform: 'Railway',
          },
          environment: 'Orders API Production',
          removeEnvironment: false,
          domains: ['orders-api-production.up.railway.app'],
        },
      };
  const request = ApprovalRequestV2Schema.parse({
    v: 2,
    status: input.status ?? 'open',
    createdAtMs: 1,
    updatedAtMs: 1,
    createdBy: { surface: 'cli' },
    requestedSurface: 'cli',
    actionId,
    summary,
    actionArgs: {
      serverId: scope.serverId,
      environmentId: 'env-orders-production',
      targetLinkId: 'target-link-orders',
    },
    preview: create
      ? {
          actionId,
          summary,
          hostReviewedContent: { summary, deploymentReview },
        }
      : { actionId, summary, deploymentReview },
    executionOriginV1: {
      v: 1,
      authority: 'account_automation',
      surface: 'cli',
      caller: { kind: 'host' },
      serverId: scope.serverId,
      serverIdentityId: scope.serverId,
      accountId: input.requesterAccountId ?? scope.accountId,
      machineId: 'machine-orders',
      actionId,
      requestId: `${id}-request`,
    },
  });
  const header = buildApprovalRequestArtifactHeaderV1(request);
  return {
    id,
    header,
    title: header.title ?? null,
    body: JSON.stringify(request),
    request,
    headerVersion: 1,
    bodyVersion: 1,
    seq: 1,
    createdAt: 1,
    updatedAt: 1,
    isDecrypted: true,
  };
}
