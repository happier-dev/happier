import { describe, expect, it } from 'vitest';
import { AgentExecutionTargetV1Schema } from '@happier-dev/protocol/agents/executionTargetV1';
import { buildBackendTargetKeyV2 } from '@happier-dev/protocol/backends/targets/backendTargetRefV2';
import { SessionModelSelectionSchema } from '@happier-dev/protocol/providers/selection/v2';
import { WorkflowSessionAuthoringSelectionSchema } from '@happier-dev/protocol/workflows/workflowV1';

import { projectLlmTaskRunnerAuthoringSelection, readLlmTaskRunnerFromAuthoringSelection } from './llmTaskRunnerAuthoringSelection';

describe('LLM task runner authoring selection', () => {
    const agentTarget = AgentExecutionTargetV1Schema.parse({ kind: 'agent',
        identity: { pluginId: 'happier.agent.codex', localId: 'codex' } });
    const agentTargetKey = buildBackendTargetKeyV2(agentTarget);

    it.each([
        { source: 'native', agentTargetKey, modelId: 'native-model' },
        { source: 'account_provider_connection', agentTargetKey, providerConnectionId: 'work-provider', modelId: 'provider-model' },
        { source: 'team_resource', agentTargetKey, teamId: 'summary-team', resourceId: 'summary-resource',
            expectedResourceRevision: 7, deliveryMode: 'brokered', modelId: 'default' },
    ])('retains the exact $source selection through runner authoring and redisplay', ref => {
        const modelSelection = SessionModelSelectionSchema.parse({ v: 2, ref, updatedAt: 71 });
        const authored = WorkflowSessionAuthoringSelectionSchema.parse({ agentTarget, modelSelection });
        const runner = readLlmTaskRunnerFromAuthoringSelection(authored, 'read_only');
        expect(runner).toMatchObject({ modelSelection: modelSelection.ref, permissionMode: 'read_only' });
        const displayed = projectLlmTaskRunnerAuthoringSelection(runner, undefined);
        expect(SessionModelSelectionSchema.parse(displayed.modelSelection)).toEqual({ ...modelSelection, updatedAt: 0 });
    });

    it('displays a native V2 default as the Agent default', () => {
        const authored = WorkflowSessionAuthoringSelectionSchema.parse({ agentTarget,
            modelSelection: { v: 2, ref: { source: 'native', agentTargetKey, modelId: 'default' }, updatedAt: 71 } });
        const runner = readLlmTaskRunnerFromAuthoringSelection(authored, 'read_only');
        expect(projectLlmTaskRunnerAuthoringSelection(runner, undefined).modelSelection).toBeNull();
    });
});
