import { expect, it } from 'vitest';
import { createActionExecutor, type ActionExecutorDeps } from './actionExecutor.js';
import { ApprovalRequestV1Schema, type ApprovalRequest } from '../approvals/approvalRequestV1.js';
import { decideApprovalRequestTransition } from '../approvals/approvalRequestTransition.js';
import { createDeploymentApprovalScopeResolverV1 } from '../deployments/deploymentApprovalScopeV1.js';

it.each(['delete', 'teardown', 'stop-only', 'failed'] as const)(
  'settles only pending approvals for a confirmed removed Environment: %s', async scenario => {
    const input = { serverId: 'home', environmentId: 'environment', expectedRevision: 3, requestKey: 'remove',
      ...(scenario === 'delete' ? {} : { targetLinkId: 'link', expectedTargetLinkRevision: 2,
        reason: 'manual', removeEnvironment: scenario !== 'stop-only', volumes: [] }) };
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
