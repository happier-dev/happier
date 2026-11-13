import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createActionExecutor, type ActionExecutorContext } from '@happier-dev/protocol/actions';
import { ActionDefinitionV1Schema } from '@happier-dev/protocol/actions/actionDefinitionV1';
import { createCommittedContributedActionSchemaReader } from '@/plugins/runtime/invocation/actions/createCommittedContributedActionDeps';
import { materializeWorkflowAcceptedSnapshotV1 } from '@happier-dev/protocol/workflows/materializeWorkflowAcceptedSnapshotV1';
import { deriveWorkflowSessionInputLocalIdV2 } from '@happier-dev/protocol/sessions/messages/sessionInputAdmission';
import type { WorkflowDefinitionV1 } from '@happier-dev/protocol/workflows';
import { WorkflowDefinitionSchema } from '@happier-dev/protocol/workflows';
import type { PluginJsonSchemaV2 } from '@happier-dev/protocol/plugins/contributions/jsonSchema';
import { createTargetActionInvocationRegistry } from '@/plugins/runtime/invocation/targetActionRegistry';
import { createTargetActionHostBindingResolver } from '@/plugins/runtime/hostAccess/resolve';
import { createUnavailablePluginServicesFactory } from '@/plugins/runtime/invocation/services/factory';
import { createManagedPluginSourceCustody } from '@/plugins/runtime/lifecycle/contributions/runtimeIdentity.testkit';
import { createPluginRuntimeOccurrenceId } from '@/plugins/runtime/runtimeSlots';
import { createUnavailableActionTransportDeps } from '@/testkit/actionTransportDeps';
import { buildWorkflowActionContext } from './daemonRuntime';
import { createWorkflowCoordinator } from './coordinator';
import { createInMemoryWorkflowCoordinatorStore } from './workflowCoordinator.testkit';
import { renderWorkflowSessionStepInput } from './sessionStepExecutor';

const pluginId = 'happier.channels';
const localId = 'conversation/start-v1';
const actionId = `${pluginId}/actions/${localId}`;
const workspace = { machineId: 'machine', directory: '/repo', checkoutRootPath: '/repo' };
const authorization = { principal: { kind: 'host' as const }, admittedPermissionCeiling: 'default' as const };
const inputSchema = { type: 'object', properties: {
  routerBindingId: { type: 'string' }, audienceGroupId: { type: 'string' }, subject: { type: 'string' },
  sessionId: { type: 'string' }, content: { type: 'object', properties: {
    text: { type: 'string' }, html: { type: 'string' },
  }, required: ['text'], additionalProperties: false },
}, required: ['routerBindingId', 'audienceGroupId', 'subject', 'sessionId', 'content'], additionalProperties: false } satisfies PluginJsonSchemaV2;
const outputSchema = { type: 'object', properties: { kind: { const: 'accepted' }, custodyId: { type: 'string' } },
  required: ['kind', 'custodyId'], additionalProperties: false };

describe('workflow contributed Action leaves', () => {
  it.each([
    { decision: 'approved', published: false, failed: false, review: false },
    { decision: 'rejected', published: false, failed: false, review: false },
    { decision: 'approved', published: true, failed: false, review: false },
    { decision: 'approved', published: true, failed: true, review: false },
    { decision: 'approved', published: false, failed: false, review: true },
  ] as const)('preserves output, caller and one effect ($decision, published=$published, failed=$failed, review=$review)', async ({ decision, published, failed, review }) => {
    const attribution = { requestRef: 'accepted-input', requester: { serverId: 'home', accountId: 'bob' },
      persona: { serverId: 'home', sessionId: 'release-bot' }, origin: null };
    const html = `<html>${'x'.repeat(120 * 1024)}</html>`;
    const content = { text: 'French morning brief', html };
    const definition: WorkflowDefinitionV1 = { version: 1, inputs: [], defaults: {
      agentTarget: { kind: 'agent', identity: { pluginId: 'happier.agent.codex', localId: 'codex' } },
    }, blocks: [
      { kind: 'step', id: 'brief', document: { text: 'Produce the brief', references: [], attachments: [] },
        input: [], result: { kind: 'json', schema: { type: 'object', properties: { content: inputSchema.properties.content },
          required: ['content'], additionalProperties: false } } },
      { kind: 'action', id: 'send', actionId, ...(review ? { pauseForReview: true } : {}), input: {
        routerBindingId: { kind: 'literal', value: 'router' }, audienceGroupId: { kind: 'literal', value: 'brief' },
        subject: { kind: 'literal', value: 'Brief matinal' }, sessionId: { kind: 'literal', value: 'brief-session' },
        content: { kind: 'result', producer: { blockId: 'brief', scope: { kind: 'current' } }, path: ['content'] },
      } },
    ] };
    const guide = readFileSync(fileURLToPath(new URL('../../../../docs/content/docs/extending/email-agent-recipes.mdx', import.meta.url)), 'utf8');
    const publishedDefinition = WorkflowDefinitionSchema.parse(JSON.parse([...guide.matchAll(/```json\n([\s\S]*?)\n```/g)][2]![1]!));
    const selectedDefinition = published ? publishedDefinition : definition;
    const accepted = await materializeWorkflowAcceptedSnapshotV1({ definition: selectedDefinition,
      context: { source: { kind: 'inline' }, inputs: {}, machineId: workspace.machineId, executionTarget: { kind: 'session' },
        workspaceTarget: { project: workspace }, origin: { kind: 'direct', originSessionId: 'brief-session', actionRequestAttributionV1: attribution }, authorization }, admission: { kind: 'user' },
      effects: { resolveTargetAvailability: async () => true, readActionContract: async id => id === actionId
        ? { inputSchema, outputSchema } : null } });
    if (!accepted.ok) throw new Error(accepted.error.code);
    expect(accepted.snapshot.authorization.admittedPermissionCeiling).toBe(published ? 'read-only' : 'default');
    attribution.requester.accountId = 'carol';
    const effects: unknown[] = [];
    const contexts: ActionExecutorContext[] = [];
    const confirmations: unknown[] = [];
    const occurrenceId = createPluginRuntimeOccurrenceId(pluginId);
    const registry = createTargetActionInvocationRegistry({
      actions: [{ pluginId, pluginVersion: '1.0.0', occurrenceId,
        sourceCustody: createManagedPluginSourceCustody('channels-generation'), localId,
        definition: { id: localId, dangerLevel: 'externalSideEffect', scopes: ['global'], surfaces: ['agent'],
          inputSchema, resultSchema: outputSchema, confirmation: { title: 'Send brief',
            body: 'Send this brief to the configured audience?', confirmLabel: 'Send' } },
        handler: async value => { effects.push(value); return { kind: 'accepted', custodyId: 'custody' }; } }],
      readCurrentPluginOccurrenceId: () => occurrenceId,
      resolveAuthorizationFacts: action => ({ generation: { targetGeneration: action.occurrenceId,
        desiredGeneration: action.occurrenceId, appliedGeneration: action.occurrenceId },
        resourceSelections: [], scopedGrants: [], operatingSystemAuthorization: [] }),
      createServices: createUnavailablePluginServicesFactory(), resolveHostBinding: createTargetActionHostBindingResolver(),
    });
    const listDefinitions = () => [ActionDefinitionV1Schema.parse({ kindVersion: 1, id: actionId, title: 'Send brief', description: null,
      safety: 'danger', placements: [], slash: null, bindings: null, examples: null, surfaces: { agent: true },
      inputHints: null, inputSchema, outputSchema })];
    const executor = createActionExecutor({ ...createUnavailableActionTransportDeps(),
      listContributedActionDefinitions: listDefinitions, readContributedActionSchemas: createCommittedContributedActionSchemaReader(listDefinitions),
      invokeContributedAction: async request => {
      contexts.push(request.context);
      const result = await registry.invoke({ ...request.action, input: request.input, surface: 'agent',
        initiatingActionCaller: request.context.actionCaller, signal: request.signal,
        requestCurrentIntent: async confirmation => {
          confirmations.push(confirmation.action.input);
          return decision === 'approved' ? { status: 'approved', fingerprint: confirmation.fingerprint }
            : { status: 'rejected', code: 'plugin_action_current_intent_rejected' };
        } });
      if (result.status === 'executed') return { ok: true, result: result.value };
      if (result.status === 'deferred') throw new Error('Unexpected deferred approval');
      return { ok: false, errorCode: result.code, error: result.message };
    } });
    const store = createInMemoryWorkflowCoordinatorStore();
    const coordinator = createWorkflowCoordinator({ store,
      executeStep: async params => {
        await params.beforeInputAdmission();
        const correspondence = { kind: 'session' as const, sessionId: 'brief-session',
          localInputId: deriveWorkflowSessionInputLocalIdV2({ purpose: 'invocation', runId: params.runId,
            invocationRecordId: params.invocationRecordId! }) };
        if (published) {
          // The published recipe offers frozen input to its existing origin;
          // production's Session adapter records that offer before host dispatch.
          if (!params.onOriginInputOffered) throw new Error('Expected origin input producer');
          const renderedText = renderWorkflowSessionStepInput({ input: params.input, result: params.step.result });
          await params.onOriginInputOffered(correspondence, renderedText);
          expect(store.readByLogicalInvocation(params.invocation.logicalInvocationRecordId)).toMatchObject({
            lifecycle: 'admitting', execution: correspondence, input: { renderedText }, resultContract: params.step.result,
          });
        }
        await params.onInputAccepted(correspondence);
        return failed ? { kind: 'failed', code: 'workflow_step_timeout' }
          : { kind: 'completed', result: published ? content : { content }, resultEncoding: 'typed' };
      }, resolveWorkspace: async () => ({ ok: true, workspace }),
      action: { executor, buildContext: async params => buildWorkflowActionContext(params),
        observeRun: async () => { throw new Error('Immediate plugin Action must not observe Runs'); } } });
    const run = { ...accepted.snapshot, runId: 'brief-run',
      // Match the production accepted-snapshot → coordinator boundary.
      originSessionId: accepted.snapshot.origin?.originSessionId };
    try {
      const result = await coordinator.run(run);
      expect(result, JSON.stringify(result)).toMatchObject({ state: review ? 'waiting_for_review'
        : decision === 'approved' ? 'succeeded' : 'interrupted' });
      if (failed) expect(result).toMatchObject({ completedWithFailures: true });
      const expectedInput = published ? {
        routerBindingId: 'brief-router-id', audienceGroupId: 'brief',
        subject: failed ? 'Brief indisponible' : 'Votre brief du matin', sessionId: 'brief-session',
        content: failed ? { text: "Le brief n'a pas pu être envoyé. Consultez le tableau de bord : https://dashboard.example.com/brief" } : content,
      } : { routerBindingId: 'router', audienceGroupId: 'brief', subject: 'Brief matinal', sessionId: 'brief-session', content };
      expect(confirmations).toEqual([expectedInput]);
      expect(effects).toEqual(decision === 'approved' ? confirmations : []);
      const row = store.list().find(value => value.blockId === (failed ? 'notice' : 'send'))!;
      expect(row.execution).toMatchObject({ kind: 'action', actionId, input: expectedInput });
      expect(row.execution?.kind === 'action' ? row.execution.output : undefined).toBeUndefined();
      if (review) {
        // A person's selected downstream result is not the provider's original
        // effect identity. Cleanup readers consume execution.output only.
        await store.commitFact({ key: row.key, lifecycle: 'completed', result: { kind: 'accepted', custodyId: 'reviewed-other' } });
        expect(await coordinator.run(run)).toMatchObject({ state: 'succeeded' });
        expect(store.read(row.key)).toMatchObject({ result: { custodyId: 'reviewed-other' } });
        expect(store.read(row.key)?.execution).not.toHaveProperty('output');
      }
      expect(contexts).toEqual([expect.objectContaining({ actionCaller: { kind: 'workflowRun', runId: run.runId, authorization: accepted.snapshot.authorization },
        actionRequestAttributionV1: expect.objectContaining({ requestRef: 'accepted-input', requester: { serverId: 'home', accountId: 'bob' } }),
        actionRequestId: `${run.runId}/${row.logicalInvocationRecordId ?? row.recordId}/0`, surface: 'agent', authority: 'account_automation' })]);
      await coordinator.run(run);
      expect(contexts).toHaveLength(1);
      expect(effects).toHaveLength(decision === 'approved' ? 1 : 0);
    } finally { registry.dispose(); }
  });

});
