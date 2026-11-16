import { expect, it } from 'vitest';
import { WorkflowStepSelectionV1Schema } from '@happier-dev/protocol/workflows/workflowV1';
import { withWorkflowAuthoringEngine, withoutWorkflowAuthoringEngine } from './workflowAuthoringEngineSelection';

it('replaces a Team provider model when a Role takes ownership of the engine, preserving service bindings', () => {
    const selection = WorkflowStepSelectionV1Schema.parse({
        agentTarget: { kind: 'agent', identity: { pluginId: 'happier.agent.codex', localId: 'codex' } },
        teamCredentialBindings: [{ v: 1, slot: { kind: 'provider_model' }, resourceId: 'provider', teamId: 'team',
            expectedResourceRevision: 1, deliveryMode: 'brokered', providerModelSelection: {
                agentTargetKey: 'agent:happier.agent.codex/codex', modelId: 'team-model',
            } }, { v: 1, slot: { kind: 'connected_service_purpose', purpose: {
                consumer: { pluginId: 'happier.agent.codex', localId: 'codex' }, purpose: 'openai-codex',
            } },
            resourceId: 'service', teamId: 'team', expectedResourceRevision: 1, deliveryMode: 'brokered' }],
    });
    expect(withWorkflowAuthoringEngine(selection, { roleId: 'role' }).teamCredentialBindings).toEqual([
        selection.teamCredentialBindings![1], { v: 1, slot: { kind: 'provider_model' }, resourceId: null },
    ]);
});

it('returns the complete provider-model choice to inheritance when a step resets its engine', () => {
    const selection = WorkflowStepSelectionV1Schema.parse({
        agentTarget: { kind: 'agent', identity: { pluginId: 'happier.agent.codex', localId: 'codex' } },
        title: 'Keep this title', teamCredentialBindings: [{ v: 1, slot: { kind: 'provider_model' }, resourceId: 'provider',
            teamId: 'team', expectedResourceRevision: 1, deliveryMode: 'brokered', providerModelSelection: {
                agentTargetKey: 'agent:happier.agent.codex/codex', modelId: 'team-model',
            } }],
    });
    expect(withoutWorkflowAuthoringEngine(selection)).toEqual({ title: 'Keep this title' });
});
