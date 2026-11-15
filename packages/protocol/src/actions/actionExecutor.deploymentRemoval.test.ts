import { expect, it } from 'vitest';
import { createActionExecutor, type ActionExecutorDeps } from './actionExecutor.js';
import { ApprovalRequestV1Schema, type ApprovalRequest } from '../approvals/approvalRequestV1.js';
import { listArtifactHeadersV1 } from '../artifacts/artifactListSelectionV1.js';
import { deriveArtifactStoredKindV1, decodeArtifactKindV1 } from '../artifacts/artifactKindV1.js';
import { listApprovalArtifactsV1, buildApprovalRequestArtifactHeaderV1 } from '../approvals/approvalArtifactHeaderV1.js';
import { decideApprovalRequestTransition } from '../approvals/approvalRequestTransition.js';
import { createDeploymentApprovalScopeResolverV1 } from '../deployments/deploymentApprovalScopeV1.js';

it.each(['delete', 'teardown', 'stop-only', 'failed'] as const)(
  'settles only pending approvals for a confirmed removed Environment: %s', async scenario => {
    const input = { serverId: 'home', environmentId: 'environment', expectedRevision: 3, requestKey: 'remove',
      ...(scenario === 'delete' ? {} : { targetLinkId: 'link', expectedTargetLinkRevision: 2,
        reason: 'manual', ...(scenario !== 'stop-only' ? { removeEnvironment: true } : {}), volumes: [] }) };
    const approval = (environmentId: string, serverId = 'home') => ApprovalRequestV1Schema.parse({
      v: 1, status: 'open', createdAtMs: 1, updatedAtMs: 1, createdBy: { surface: 'agent' }, requestedSurface: 'agent',
      actionId: 'deployments.deploy', actionArgs: { serverId, environmentId, expectedRevision: 2,
        targetLinkId: 'link', expectedTargetLinkRevision: 1, requestKey: 'pending',
        contentArtifactId: 'content', contentHeaderVersion: 1, contentBodyVersion: 1 }, summary: 'Deploy',
    });
    const stored = new Map<string, ApprovalRequest>([
      ['pending', approval('environment')], ['other-environment', approval('other')],
      ['other-home', approval('environment', 'another-home')],
    ]);
    const transport: NonNullable<ActionExecutorDeps['deploymentAction']> = async () => scenario === 'failed'
      ? { ok: false, error: 'deployment_conflict' }
      : scenario === 'delete' ? { ok: true, environmentId: 'environment', revision: 4, detached: false }
        : { ok: true, environmentId: 'environment', revision: 4, deploymentId: 'receipt',
          deploymentRevision: 5, state: 'succeeded', ...(scenario === 'teardown' ? { environmentRemoved: true } : {}) };
    const executor = createActionExecutor({ deploymentAction: transport, isActionApprovalRequired: () => false,
      resolveEnvironmentApprovalScope: createDeploymentApprovalScopeResolverV1(transport, async () => ({ ok: true,
        environment: { id: 'environment', projectSourceId: 'project', purpose: 'standard' } })),
      // Home transport and Artifact persistence are the only substituted boundaries.
      approvalsList: async () => ({ items: [...stored].map(([artifactId, request]) => ({ artifactId,
        status: request.status, actionId: request.actionId, summary: request.summary, serverId: 'home', updatedAtMs: request.updatedAtMs })),
        nextCursor: null, queryPlan: { kind: 'approval_artifact_header_scan', hydratedTranscripts: false } }),
      approvalsGet: async ({ artifactId }) => stored.get(artifactId) ?? null,
      approvalsUpdate: async ({ artifactId, request, expectedStatus }) => {
        const before = stored.get(artifactId)!;
        expect(expectedStatus).toBe('open');
        expect(decideApprovalRequestTransition(before, request)).toMatchObject({ ok: true });
        stored.set(artifactId, request);
        return { ok: true };
      },
    });
    const actionId = scenario === 'delete' ? 'deployments.environments.delete' : 'deployments.teardown';
    const result = await executor.execute(actionId, input, { serverId: 'home', surface: 'ui', authority: 'present_user',
      presentUserConfirmation: { actionId } });
    expect(result).toMatchObject({ ok: scenario !== 'failed' });
    expect(stored.get('pending')?.status).toBe(scenario === 'delete' || scenario === 'teardown' ? 'canceled' : 'open');
    expect(stored.get('other-environment')?.status).toBe('open');
    expect(stored.get('other-home')?.status).toBe('open');
  });

it('reads only approvals for the removed Environment through its subject index', async () => {
  // Live #142: an Account with 942 open approvals kept Stop and remove waiting minutes after the removal landed,
  // because every open approval was read back one by one before the result returned.
  const deploy = ApprovalRequestV1Schema.parse({
    v: 1, status: 'open', createdAtMs: 1, updatedAtMs: 1, createdBy: { surface: 'agent' }, requestedSurface: 'agent',
    actionId: 'deployments.deploy', actionArgs: { serverId: 'home', environmentId: 'environment', expectedRevision: 2,
      targetLinkId: 'link', expectedTargetLinkRevision: 1, requestKey: 'pending',
      contentArtifactId: 'content', contentHeaderVersion: 1, contentBodyVersion: 1 }, summary: 'Deploy',
  });
  const unrelated = Array.from({ length: 942 }, (_, index) => [`other-${index}`, ApprovalRequestV1Schema.parse({
    ...deploy, actionArgs: { ...deploy.actionArgs, environmentId: `environment-${index}` },
  })] as const);
  const stored = new Map<string, ApprovalRequest>([['pending', deploy], ...unrelated]);
  const rows = [...stored].map(([artifactId, request]) => {
    const header = buildApprovalRequestArtifactHeaderV1(request, { legacyServerId: 'home' });
    return { artifactId, request, header, storedKind: deriveArtifactStoredKindV1(header) };
  });
  const reads: string[] = [];
  let listReads = 0;
  let inventoryBodiesRead = 0;
  const transport: NonNullable<ActionExecutorDeps['deploymentAction']> = async () => ({ ok: true, environmentId: 'environment',
    revision: 4, deploymentId: 'receipt', deploymentRevision: 5, state: 'succeeded', environmentRemoved: true });
  const executor = createActionExecutor({ deploymentAction: transport, isActionApprovalRequired: () => false,
    resolveEnvironmentApprovalScope: createDeploymentApprovalScopeResolverV1(transport, async () => ({ ok: true,
      environment: { id: 'environment', projectSourceId: 'project', purpose: 'standard' } })),
    // Home transport and Artifact persistence are the only substituted boundaries.
    approvalsList: async args => {
      listReads++;
      return listApprovalArtifactsV1({ ...args, read: async () => null,
        readPage: options => listArtifactHeadersV1({ options, encodeCursor: item => item.artifactId,
          // Only persistent inventory transport is substituted: header construction,
          // stored-kind projection, private selection and body admission remain real.
          readPage: async physical => {
            const selected = rows.filter(row => (!physical?.indexedKinds
              || physical.indexedKinds.includes(decodeArtifactKindV1(row.storedKind).kindHint ?? ''))
              && (!physical?.kinds || physical.kinds.includes(String(row.header.kind))));
            const start = physical?.cursor ? selected.findIndex(row => row.artifactId === physical.cursor) + 1 : 0;
            const items = selected.slice(start, start + (physical?.limit ?? 500));
            inventoryBodiesRead += items.length;
            return { items: items.map(row => ({ ...row, body: JSON.stringify(row.request), createdAt: 1, updatedAt: 1 })),
              kindCoverage: { status: 'complete' as const, unclassifiedCount: 0 as const },
              ...(start + items.length < selected.length ? { nextCursor: items.at(-1)!.artifactId } : {}) };
          },
        }),
      });
    },
    approvalsGet: async ({ artifactId }) => { reads.push(artifactId); return stored.get(artifactId) ?? null; },
    approvalsUpdate: async ({ artifactId, request }) => { stored.set(artifactId, request); return { ok: true }; },
  });
  const result = await executor.execute('deployments.teardown', { serverId: 'home', environmentId: 'environment',
    targetLinkId: 'link', reason: 'manual', removeEnvironment: true, volumes: [], requestKey: 'remove' },
  { serverId: 'home', surface: 'ui', authority: 'present_user', presentUserConfirmation: { actionId: 'deployments.teardown' } });
  expect(result).toMatchObject({ ok: true });
  expect(stored.get('pending')?.status).toBe('canceled');
  expect(reads).toEqual(['pending']);
  expect(listReads).toBe(1);
  expect(inventoryBodiesRead).toBe(1);
  expect([...stored.values()].filter(request => request.status === 'open')).toHaveLength(942);
});
