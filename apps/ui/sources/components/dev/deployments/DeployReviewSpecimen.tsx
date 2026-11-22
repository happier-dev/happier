import * as React from 'react';
import {
  ApprovalRequestV2Schema} from '@happier-dev/protocol/approvals/approvalRequestV1';
import {
  buildApprovalRequestArtifactHeaderV1,
} from '@happier-dev/protocol/approvals/approvalArtifactHeaderV1';
import { buildApprovalExecutionOriginV1 } from '@happier-dev/protocol/actions/actionExecutor';
import type { DeploymentApprovalReviewV1, DeploymentMachineReviewV1 } from '@happier-dev/protocol/deployments/deploymentReviewV1';
import { describeDeploymentTargetGitCreateV1 } from '@happier-dev/protocol/plugins/contributions/v2';

import { ApprovalDetailScreen } from '@/components/approvals/ApprovalDetailScreen';
import type { DecryptedArtifact } from '@/sync/domains/artifacts/artifactTypes';
import { storage } from '@/sync/domains/state/storage';
import { useActiveServerAccountScope } from '@/sync/store/hooks';
import { useArtifact } from '@/sync/domains/state/storage';

/**
 * Dev-only specimen of the deploy approval page (lab d3 `review`) drawn by the real ApprovalDetailScreen over a
 * stored approval whose `preview.deploymentReview` has the shape the installed host returns. `?variant=` picks
 * `review` (default), `multi` (two Machines), `promotion`, `desktop` (Docker Desktop), `steps` (the review plus the
 * child steps the host folded into the approval), `steps-plain` (those steps with no review), `plain` (an unstructured deploy)
 * `railway-create` (the branch-following service review) or `vercel-create` (an uploaded project's create review), both
 * carried the way the host's create preparation carries them (`hostReviewedContent.deploymentReview`). `?machine=` names
 * a Machine this Home knows. It proves composition only; the loaded
 * page is judged on a real deploy approval.
 */
const ARTIFACT_ID = 'deploy-review-specimen';
const ACTION_ARGS = {
  serverId: 'specimen', environmentId: 'env-production-api', expectedRevision: 3, requestKey: 'deploy-specimen',
  targetLinkId: 'link-production-api', expectedTargetLinkRevision: 2, contentArtifactId: 'content-specimen',
  contentHeaderVersion: 1, contentBodyVersion: 1,
};
const RAILWAY_CREATE_ARGS = {
  serverId: 'specimen', environmentId: 'env-production-api', expectedRevision: 3, requestKey: 'railway-create-specimen',
  targetId: 'runtime', targetKind: 'railway', role: 'runtime', machines: [],
  source: { kind: 'plugin', contribution: { pluginId: 'happier.deploy.railway', localId: 'runtime' } },
  providerCreate: { resourceName: 'checkout-api', productionBranch: 'release',
    repository: { kind: 'github', deployment: 'https://github.com', repository: 'acme/checkout' },
    providerAccountId: 'project-checkout', providerEnvironment: { kind: 'native', selection: {
      projectId: 'project-checkout', environmentId: 'railway-production',
    } } },
};
const VERCEL_CREATE_ARGS = {
  serverId: 'specimen', environmentId: 'env-production-api', expectedRevision: 3, requestKey: 'vercel-create-specimen',
  targetId: 'runtime', targetKind: 'vercel', role: 'runtime', machines: [],
  source: { kind: 'plugin', contribution: { pluginId: 'happier.deploy.vercel', localId: 'runtime' } },
  providerCreate: { resourceName: 'acme-web', sourceMethod: 'upload', providerAccountId: 'team-acme',
    providerEnvironment: { kind: 'native', selection: { kind: 'production' } } },
};

/** What the host's create preparation attaches (`runtimeTargetCreateForHost`): the summary, then the typed review. */
function buildCreateReview(variant: 'railway-create' | 'vercel-create') {
  if (variant === 'vercel-create') {
    return { deploymentReview: { platformCreate: { platformName: 'Vercel', resourceName: VERCEL_CREATE_ARGS.providerCreate.resourceName } } };
  }
  const { resourceName, productionBranch, repository } = RAILWAY_CREATE_ARGS.providerCreate;
  const summary = describeDeploymentTargetGitCreateV1({ guarantee: 'exactCommit', create: 'branchHead' }, 'Railway', {
    resourceName, productionBranch, repository: repository.repository,
  })!;
  return { summary, deploymentReview: { summary, platformCreate: { platformName: 'Railway', resourceName,
    repository: repository.repository, productionBranch, followsBranch: true as const } } };
}

function machineReview(overrides: Partial<DeploymentMachineReviewV1> = {}): DeploymentMachineReviewV1 {
  const service = (name: string, extra: Partial<DeploymentMachineReviewV1['services'][number]> = {}): DeploymentMachineReviewV1['services'][number] => ({
    name, replicas: 1, resources: { cpus: null, memory: null }, restartPolicy: 'unless-stopped', healthcheck: 'configured',
    ports: [], mounts: [], ...extra,
  });
  return {
    environment: { id: 'env-production-api', name: 'Production API', ingress: { kind: 'edgeCaddy', edgeMachineId: 'machine-edge' } },
    revision: { kind: 'repository', sha: '7f3e2b1a90c4d5e6f708192a3b4c5d6e7f801234' },
    replaces: { deploymentId: 'deployment-38', revision: { kind: 'repository', sha: 'b81e0d4c2f9a1b3c4d5e6f708192a3b4c5d6e7f8' } },
    secretBindingNames: ['DATABASE_URL', 'STRIPE_SECRET_KEY', 'STRIPE_WEBHOOK_SECRET', 'SENTRY_AUTH_TOKEN', 'RESEND_API_KEY'],
    inspection: 'complete',
    services: [
      service('web', { ports: [{ target: 3000, published: 3000, bindAddress: '0.0.0.0', protocol: 'tcp' }] }),
      service('worker', { replicas: 2, healthcheck: 'absent' }),
      service('postgres', { mounts: [{ type: 'volume', source: 'pgdata', target: '/var/lib/postgresql/data', readOnly: false }] }),
    ],
    risks: [{ kind: 'docker_socket', service: 'worker' }, { kind: 'host_network', service: 'web' }, { kind: 'non_loopback_publish', service: 'web' }],
    storage: { warnings: [{ kind: 'concurrent_writers', service: 'worker', target: '/srv/uploads', replicas: 2 }] },
    ownServer: { rollout: 'recreate', autoRestorePreviousRelease: false,
      migration: { service: 'web', argv: ['pnpm', 'db:migrate'] }, backupBeforeMigration: true, migrationFailurePolicy: 'rollbackCodeOnly' },
    target: { engine: 'native', requiresAwakeComputerAndDockerDesktop: false, domains: 'notDetermined' },
    ...overrides,
  };
}

function buildReview(variant: string, machineId: string): DeploymentApprovalReviewV1 | null {
  if (variant === 'plain' || variant === 'steps-plain') return null;
  const own = machineReview();
  const desktop = machineReview({ target: { engine: 'dockerDesktop', requiresAwakeComputerAndDockerDesktop: true, domains: 'unavailableDockerDesktop' } });
  const review = variant === 'desktop' ? desktop : own;
  const aggregate = { ...review, runtimeMachines: [{ machineId, review }] };
  if (variant === 'multi') return { ...own, runtimeMachines: [{ machineId, review: own }, { machineId: 'machine-edge', review: desktop }] };
  if (variant === 'promotion') {
    return { deployment: aggregate, promotion: { artifact: 'image', previousDocument: 'services:\n  web:\n    image: web:38\n', candidateDocument: 'services:\n  web:\n    image: web:39\n' } };
  }
  return aggregate;
}

/**
 * The shape `preview.hostReviewedChildren` carries (each step's Action, role and normalized input, which owns its
 * Machine routing): a build on the Machine before the deploy, the deploy role step whose input comes at deploy time,
 * then the deploy receipt read, which names no Machine.
 */
function buildIncludedSteps(serverId: string, machineId: string) {
  return { children: [
    { action: 'projects.script.run', role: 'build', input: { selection: { kind: 'named', name: 'build' }, choice: { kind: 'primary' },
      workspace: { serverId, machineId, workspaceId: 'workspace-specimen', rootPath: '~/src/production-api' } } },
    { action: { pluginId: 'happier.deploy.supabase', localId: 'deploy' }, role: 'deploy' },
    { action: 'deployments.receipts.get', role: 'observe', input: { serverId, environmentId: 'env-production-api' } },
  ] };
}

export function DeployReviewSpecimen(props: Readonly<{ variant: string; machineId: string }>) {
  const scope = useActiveServerAccountScope();
  const create = props.variant === 'railway-create' || props.variant === 'vercel-create' ? props.variant : null;
  const artifactId = create ? `${ARTIFACT_ID}-${create}` : ARTIFACT_ID;
  const present = useArtifact(artifactId) !== null;
  // The Home's artifact sync can replace the store's rows, so the stored approval is seeded again whenever it is missing.
  React.useEffect(() => {
    if (!scope || present) return;
    const hostReviewedContent = create ? buildCreateReview(create) : null;
    const summary = create ? hostReviewedContent && 'summary' in hostReviewedContent ? hostReviewedContent.summary : 'Link deployment target'
      : props.variant === 'promotion' ? 'Promote Staging to Production API' : 'Deploy 7f3e2b1 to Production API';
    const actionId = create ? 'deployments.targets.link' : props.variant === 'promotion' ? 'deployments.promote' : 'deployments.deploy';
    const args = create === 'railway-create' ? RAILWAY_CREATE_ARGS : create === 'vercel-create' ? VERCEL_CREATE_ARGS : ACTION_ARGS;
    const review = create ? null : buildReview(props.variant, props.machineId);
    const executionOriginV1 = buildApprovalExecutionOriginV1({ actionId, input: args, targetSessionId: null,
      context: { surface: 'agent', authority: 'account_automation', serverId: scope.serverId, runtimeAccountId: scope.accountId,
        actionRequestId: artifactId, actionCaller: { kind: 'host' } } });
    const request = ApprovalRequestV2Schema.parse({ v: 2, status: 'open', createdAtMs: Date.now() - 240_000, updatedAtMs: Date.now() - 240_000,
      createdBy: { surface: 'agent' }, requestedSurface: 'agent', actionId, actionArgs: args, executionOriginV1, summary,
      preview: { actionId, actionArgs: args, summary, ...(review ? { deploymentReview: review } : {}),
        ...(hostReviewedContent ? { hostReviewedContent } : {}),
        ...(props.variant === 'steps' || props.variant === 'steps-plain' ? { hostReviewedChildren: buildIncludedSteps(scope.serverId, props.machineId) } : {}) } });
    storage.getState().updateArtifact({ id: artifactId, header: buildApprovalRequestArtifactHeaderV1(request),
      title: summary, body: JSON.stringify(request), headerVersion: 1, bodyVersion: 1,
      seq: 1, createdAt: 1, updatedAt: Date.now(), isDecrypted: true } satisfies DecryptedArtifact);
  }, [scope, present, props.variant, props.machineId, create, artifactId]);
  return present ? <ApprovalDetailScreen key={`${props.variant}:${props.machineId}`} artifactId={artifactId} /> : null;
}
