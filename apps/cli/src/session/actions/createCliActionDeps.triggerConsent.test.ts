import axios from 'axios';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AutomationDefinitionCreateRequestSchema, AutomationDefinitionDetailSchema,
  FeaturesResponseSchema, WorkflowDefinitionV1Schema, sealAutomationTriggerDefinitionStoredEnvelopeV1,
  AutomationTriggerIdSchema, AutomationSourceSelectorIdV1Schema, type ActionExecutorContext,
  type AutomationDefinitionDetail } from '@happier-dev/protocol';
import { createAccountEncryptionCurrentnessFixture } from '@/testkit/backends/sessionFixtures';
import { createCliActionDeps } from './createCliActionDeps';

afterEach(() => vi.restoreAllMocks());

describe('CLI saved deployment trigger consent composition', () => {
  it('saves and reloads person consent through the actual Account adapter without opening Environment content', async () => {
    const token = `fixture.${Buffer.from(JSON.stringify({ sub: 'account-owner', tokenEpoch: 0,
      provenance: { v: 1, kind: 'account', authority: 'present_user' } })).toString('base64url')}.signature`;
    const definition = WorkflowDefinitionV1Schema.parse({ version: 1, inputs: [
      { name: 'sha', valueType: 'string', required: true }, { name: 'requestKey', valueType: 'string', required: true },
    ], blocks: [{ kind: 'action', id: 'deploy', actionId: 'deployments.deploy', input: {
      serverId: { kind: 'literal', value: 'home' }, environmentId: { kind: 'literal', value: 'staging' },
      targetLinkId: { kind: 'literal', value: 'runtime' },
      sha: { kind: 'input', name: 'sha' }, requestKey: { kind: 'input', name: 'requestKey' },
    } }] });
    let row: AutomationDefinitionDetail | undefined;
    let credentialCurrent = true;
    // HTTP is the system boundary. The default CLI composition, Account codec,
    // person-consent producer and trigger lifecycle are real.
    vi.spyOn(axios, 'get').mockImplementation(async url => {
      const path = new URL(String(url)).pathname;
      if (path === '/v1/account/encryption/currentness') return { status: 200, data: createAccountEncryptionCurrentnessFixture() };
      if (path === '/v1/account/encryption') return { status: 200, data: { mode: 'plain', updatedAt: 0 } };
      if (path === '/v3/automations') return { status: 200, data: { automations: row ? [row] : [], nextCursor: null } };
      throw new Error(`unexpected_read:${path}`);
    });
    const writes: unknown[] = [];
    vi.spyOn(axios, 'request').mockImplementation(async config => {
      const path = new URL(String(config.url)).pathname;
      if (path.startsWith('/v3/automations/') && config.method === 'GET') return { status: 200, data: row };
      if (path === '/v3/automations' && config.method === 'POST') {
        const input = AutomationDefinitionCreateRequestSchema.parse(config.data);
        row = AutomationDefinitionDetailSchema.parse({ id: input.automationId, name: input.name, description: null,
          enabled: input.enabled, targetType: null, existingSessionId: null, templateVersion: 1, lastRunAt: null,
          createdAt: 1, updatedAt: 1, workflowDefinitionId: null, scopeSessionId: null, executionRecipe: input.executionRecipe,
          assignments: input.assignments?.map(assignment => ({ ...assignment, enabled: assignment.enabled ?? true,
            priority: assignment.priority ?? 0, updatedAt: 1 })) ?? [], triggers: input.triggers.map(item => {
            if (item.trigger.kind !== 'pluginEvent') throw new Error('expected_event');
            const sourceSelectorId = 'sourceSelectorId' in item.trigger ? item.trigger.sourceSelectorId : AutomationSourceSelectorIdV1Schema.parse('88888888-8888-4888-8888-888888888888');
            const envelope = 'triggerDefinitionEnvelope' in item.trigger ? item.trigger.triggerDefinitionEnvelope
              : sealAutomationTriggerDefinitionStoredEnvelopeV1({ mode: 'plain', binding: { v: 1,
                automationId: input.automationId, triggerId: AutomationTriggerIdSchema.parse(item.triggerId), triggerRevision: 0,
                triggerKind: 'pluginEvent', eventRef: item.trigger.eventRef, sourceSelectorId }, definition: {
                v: 1, sourceInstanceId: item.trigger.sourceInstanceId, sourceConfig: item.trigger.sourceConfig,
                displayLabel: item.trigger.displayLabel, filter: item.trigger.filter,
                maximumObservationAgeMs: item.trigger.maximumObservationAgeMs } });
            return { kind: 'pluginEvent', id: item.triggerId, revision: 0, enabled: item.trigger.enabled, createdAt: 1, updatedAt: 1,
              eventRef: item.trigger.eventRef, sourceSelectorId, sourceContractVersion: item.trigger.sourceContractVersion,
              observation: { kind: 'checkpointedPull', watcher: null }, sourceStatus: null, sourceCatalogStatus: null,
              triggerDefinitionEnvelope: JSON.stringify(envelope) };
          }) });
        writes.push(input);
        return { status: 200, data: row };
      }
      throw new Error(`unexpected_request:${config.method}:${path}`);
    });
    vi.spyOn(axios, 'post').mockImplementation(async url => {
      if (new URL(String(url)).pathname === '/v3/automations/query') return { status: 200,
        data: { automations: row ? [row] : [], nextCursor: null } };
      throw new Error('unexpected_post');
    });
    const deps = createCliActionDeps({ token, credentials: { token, encryption: null, credentialProvenance: 'stored_session' },
      sessionId: 'cli-global', mode: 'plain', ctx: null, serverId: 'home', serverHttpBaseUrl: 'https://consent.test',
      isCredentialCurrent: async () => credentialCurrent,
      resolveServerFeaturesSnapshot: () => ({ status: 'ready', provenance: 'authenticated',
        features: FeaturesResponseSchema.parse({ features: { automations: { enabled: true }, workflows: { enabled: true } }, capabilities: {} }) }) });
    expect(axios.get).not.toHaveBeenCalled();
    expect(axios.request).not.toHaveBeenCalled();
    expect(axios.post).not.toHaveBeenCalled();
    const context: ActionExecutorContext = { authority: 'present_user', surface: 'cli', actionCaller: { kind: 'host' },
      runtimeAccountId: 'account-owner', serverId: 'home', actionRequestId: 'save-trigger' };
    const input = { target: { kind: 'inline' as const, definition }, project: { machineId: 'machine-a', directory: '/workspace' },
      trigger: { kind: 'pluginEvent' as const, enabled: true,
        eventRef: { pluginId: 'happier.scm.forge.github', localId: 'automation/repository-pushed-v1' },
        sourceInstanceId: 'repo-source', sourceContractVersion: 1, sourceConfig: {}, displayLabel: 'Repository',
        observationTransport: { kind: 'checkpointedPull' as const, watcherMaterializationRef: {
          machineId: 'machine-a', materializationId: 'github-install', pluginId: 'happier.scm.forge.github' } },
        filter: null, maximumObservationAgeMs: null }, deployment: { branch: 'main' }, actionApproval: 'automatic' as const };
    const saved = await deps.workflowAction!({ actionId: 'workflow.trigger.add', input, context });
    expect(saved).toMatchObject({
      set: { context: { actionApprovals: [{ operation: { approvedBy: { accountId: 'account-owner' },
        steps: [{ actionId: 'deployments.deploy', input: { serverId: 'home', environmentId: 'staging', targetLinkId: 'runtime' },
          binding: { kind: 'deployment_sha' } }] } }] } } });
    expect(writes).toHaveLength(1);
    expect(row?.executionRecipe).toMatchObject({ v: 2, workflow: { t: 'plain', v: {
      actionApprovals: [{ operation: { parent: { actionId: 'workflow.trigger.add' } } }],
    } } });
    expect(await deps.workflowAction!({ actionId: 'workflow.trigger.list', input: { scope: 'account_inline' }, context }))
      .toMatchObject({ sets: [{ context: { actionApprovals: [{ operation: { approvedBy: { accountId: 'account-owner' } } }] } }] });
    const artifactReads = () => vi.mocked(axios.get).mock.calls.filter(([url]) => new URL(String(url)).pathname.startsWith('/v1/artifacts/')).length;
    const beforeRetirement = artifactReads();
    expect(beforeRetirement).toBe(0);
    credentialCurrent = false;
    expect(await deps.workflowAction!({ actionId: 'workflow.trigger.add', input, context })).toMatchObject({ ok: false });
    expect(writes).toHaveLength(1);
    expect(artifactReads()).toBe(beforeRetirement);
  });
});
