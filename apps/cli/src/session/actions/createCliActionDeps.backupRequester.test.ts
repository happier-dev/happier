import Fastify from 'fastify';
import { afterEach, expect, it, vi } from 'vitest';
import { encodePlainArtifactStoredContent, ExternalActionExecutionAuthorizationV1Schema, validateWorkflowDefinition, WorkflowDefinitionV1Schema } from '@happier-dev/protocol';
import { DeploymentBackupRunInputV1Schema } from '@happier-dev/protocol/deployments/deploymentBackupActionsV1';
import { AutomationDefinitionDetailSchema } from '@happier-dev/protocol/automations/automationApiV3';
import { AutomationStoredWorkflowDefinitionRecipeV2Schema } from '@happier-dev/protocol/automations/automationWorkflowRecipeV2';
import { projectDeploymentNativeAdmissionV1 } from '@happier-dev/protocol/deployments/deploymentCandidatePublicationV1';
import { admitRequesterAccountActionContext } from '@/daemon/sessionEncryption/requesterAccountActionProjection';
import { createRequesterCurrentnessSocketHarness } from '@/testkit/backends/requesterCurrentnessSocketHarness';
import { createCliActionDeps } from './createCliActionDeps';
import { createCliWorkflowTriggerActions } from './workflowTriggers';
import { registerAccountHomeHttp, registerPlainArtifactRoutes } from './widgetApproval.testkit';

afterEach(() => vi.restoreAllMocks());

it('lists backup Workflows with restored requester custody after another Account constructs the executor', async () => {
  const channel = await createRequesterCurrentnessSocketHarness();
  const definitionId = '11111111-1111-4111-8111-111111111111';
  const token = (accountId: string) => `header.${Buffer.from(JSON.stringify({ sub: accountId })).toString('base64url')}.signature`;
  const target = DeploymentBackupRunInputV1Schema.parse({ serverId: 'backup-home', environmentId: 'environment', machineId: 'machine',
    installationId: 'installation', targetLinkId: 'runtime', deploymentId: 'deployment', configRevision: 1, expectedRevision: 1 });
  const homes = await Promise.all(['requester', 'approver'].map(async accountId => {
    const app = Fastify();
    const accountTarget = { ...target, environmentId: accountId === 'requester' ? target.environmentId : 'other-environment' };
    const definition = WorkflowDefinitionV1Schema.parse({ version: 1, defaults: {}, blocks: [{ kind: 'action', id: 'backup',
      actionId: 'deployments.backups.run', input: Object.fromEntries(Object.entries(accountTarget).map(([key, value]) => [key, { kind: 'literal', value }])) }] });
    expect(validateWorkflowDefinition(definition)).toMatchObject({ valid: true });
    registerAccountHomeHttp(app, { accountId, serverId: 'backup-home' });
    const requests: { path: string; bearer: string | undefined }[] = [];
    app.addHook('onRequest', async request => { requests.push({ path: request.url, bearer: request.headers.authorization }); });
    const artifacts = registerPlainArtifactRoutes(app, accountId);
    artifacts.seed(definitionId, encodePlainArtifactStoredContent({ kind: 'workflow-definition.v1', definitionId,
      revision: { headerVersion: 1, bodyVersion: 1 }, metadata: { title: 'Backup' } }),
    encodePlainArtifactStoredContent({ body: JSON.stringify({ kind: 'workflow-definition.v1', definition }) }));
    const row = AutomationDefinitionDetailSchema.parse({ id: `${accountId}-automation`, name: 'Backup', description: null,
      enabled: true, targetType: null, existingSessionId: null, templateVersion: 1, lastRunAt: null, createdAt: 1, updatedAt: 1,
      workflowDefinitionId: definitionId, scopeSessionId: null, assignments: [],
      executionRecipe: AutomationStoredWorkflowDefinitionRecipeV2Schema.parse({ v: 2, templateVersion: 1,
        workflow: { t: 'plain', v: { workspace: { directory: '/repo' }, executionTarget: { kind: 'session' }, visibleTeamId: null } },
        visibleTeamId: null, triggerEvidence: null }),
      triggers: [{ id: `${accountId}-trigger`, kind: 'schedule', enabled: true, revision: 0, createdAt: 1, updatedAt: 1,
        nextRunAt: 2, triggerDefinitionEnvelope: null,
        schedule: { kind: 'interval', everyMs: 60000, scheduleExpr: null, timezone: null } }],
    });
    app.post('/v3/automations/query', async () => ({ automations: [row], nextCursor: null }));
    const url = await app.listen({ host: '127.0.0.1', port: 0 });
    return { app, url, requests, credentials: { token: token(accountId), encryption: null } };
  }));
  const requester = homes[0]!;
  const approver = homes[1]!;
  let custody: Awaited<ReturnType<typeof admitRequesterAccountActionContext>> = null;
  try {
    const authorization = ExternalActionExecutionAuthorizationV1Schema.parse({ v: 1, token: 'admitted-backup-root', binding: {
      accountId: 'requester', custodianAccountId: 'requester', authentication: { kind: 'account', tokenEpoch: 1 },
      accountEncryptionMode: 'plain', serverIdentityId: 'backup-home', machineId: 'machine', installationId: 'installation',
      actionId: 'deployments.backups.configure', requestId: 'configure', requestEnvelopeDigest: 'a'.repeat(43),
      environmentId: target.environmentId,
      deploymentNativeAdmission: projectDeploymentNativeAdmissionV1('deployments.backups.configure', {
        serverId: target.serverId, environmentId: target.environmentId, expectedRevision: 1, intent: 'markNotNeeded',
      }),
      target: { kind: 'machine', machineId: 'machine' },
    } });
    custody = await admitRequesterAccountActionContext({ authorization, credentials: requester.credentials,
      serverId: 'backup-home', serverIdentityId: 'backup-home', serverHttpBaseUrl: requester.url, isCurrent: async () => true });
    expect(custody).not.toBeNull();
    let list: ReturnType<typeof createCliWorkflowTriggerActions>['list'] | undefined;
    createCliActionDeps({ token: approver.credentials.token, credentials: approver.credentials, sessionId: 'approval-session',
      mode: 'plain', ctx: null, serverId: 'backup-home', serverHttpBaseUrl: approver.url,
      registerWorkflowTriggerList: read => { list = read; } });
    expect(approver.requests).toEqual([]);
    expect(list).toBeTypeOf('function');
    const result = await list!({ deploymentBackupEnvironment: { serverId: 'backup-home', environmentId: 'environment' } }, {
      surface: 'cli', authority: 'present_user', externalActionExecutionAuthorization: custody!.authorization,
    });
    expect(result.sets.map(set => set.automationId)).toEqual(['requester-automation']);
    expect(approver.requests).toEqual([]);
    const artifactReads = requester.requests.filter(request => request.path.startsWith('/v1/artifacts/'));
    expect(artifactReads.length).toBeGreaterThan(0);
    expect(artifactReads.every(request => request.bearer === `Bearer ${requester.credentials.token}`)).toBe(true);
    expect(requester.requests.filter(request => request.path === '/v3/automations/query')).toHaveLength(1);
  } finally {
    await custody?.dispose();
    await Promise.all(homes.map(home => home.app.close()));
    await channel.close();
  }
});
