import { WorkflowDefinitionV1Schema } from '@happier-dev/protocol/workflows/workflowV1';
import { WorkflowMaterializedLeafV1Schema } from '@happier-dev/protocol/workflows/workflowDefinitionV1';
import { BUNDLED_AGENT_CONTRIBUTION_IDENTITIES } from '@happier-dev/agents/agent-ids';
import {
    WorkflowProgressEnvelopeV1Schema,
    WorkflowRunInvocationIndexV1Schema,
    WorkflowRunSummaryV1Schema,
    type WorkflowProgressEnvelopeV1,
} from '@happier-dev/protocol/workflows/workflowProgressV1';

import { DEMO_MACHINE_ID, DEMO_NOW_MS } from './constants';

const RUN_ID = 'demo-run-checkout-update';
const STEPS = [
    {
        id: 'prepare',
        agent: 'claude',
        name: 'Prepare changes',
        prompt: 'Adapt checkout for phones.',
        lifecycle: 'completed',
        result: 'Order summary and payment controls fit phones.',
    },
    {
        id: 'review',
        agent: 'codex',
        name: 'Review changes',
        prompt: 'Check payment and accessibility.',
        lifecycle: 'completed',
        result: 'Payment and keyboard checks pass.',
    },
    {
        id: 'deploy',
        agent: 'claude',
        name: 'Deploy preview',
        prompt: 'Publish the checkout preview.',
        lifecycle: 'running',
        result: undefined,
    },
] as const;

/** Static, protocol-valid Run records; no workflow executor or remote store is started. */
export function buildDemoWorkflowRun() {
    const createdAt = new Date(DEMO_NOW_MS - 240_000).toISOString();
    const updatedAt = new Date(DEMO_NOW_MS - 10_000).toISOString();
    const definition = WorkflowDefinitionV1Schema.parse({
        version: 1,
        inputs: [],
        defaults: {},
        blocks: STEPS.map((step) => ({
            kind: 'step',
            id: step.id,
            name: step.name,
            execution: { agentTarget: { kind: 'agent', identity: BUNDLED_AGENT_CONTRIBUTION_IDENTITIES[step.agent] } },
            document: { text: step.prompt, references: [], attachments: [] },
            input: [],
            result: { kind: 'text' },
        })),
    });
    const materializedLeaves = STEPS.map((step) => WorkflowMaterializedLeafV1Schema.parse({
        sourceKey: '$root',
        blockId: step.id,
        kind: 'step',
        selection: { agentTarget: { kind: 'agent', identity: BUNDLED_AGENT_CONTRIBUTION_IDENTITIES[step.agent] } },
        authoredWorkspace: { kind: 'inherit' },
        executionTarget: { kind: 'detached_run' },
    }));
    const run = WorkflowRunSummaryV1Schema.parse({
        id: RUN_ID,
        ownerAccountId: 'demo-account',
        visibleTeamId: null,
        sourceArtifactId: null,
        origin: { kind: 'direct' },
        state: 'running',
        revision: 1,
        machineId: DEMO_MACHINE_ID,
        workflowCustodyState: 'pending',
        originDeliveryAckRevision: null,
        attentionSeenFailureAt: null,
        failureUnseen: false,
        invocationAttentionRequired: false,
        attentionRequired: false,
        finishedAt: null,
        stepProgress: { completed: 2, total: 3 },
        availability: {
            pause: false,
            resumeBoundary: false,
            restoreWorkspace: false,
            cancel: false,
            inspectExecution: false,
            disabledReasons: [],
        },
        createdAt,
        updatedAt,
    });
    const invocations = STEPS.map((step, index) => WorkflowRunInvocationIndexV1Schema.parse({
        id: `demo-invocation-${step.id}`,
        runId: RUN_ID,
        sequence: String(index),
        parentRecordId: null,
        memberOrdinal: String(index),
        attempt: '0',
        contentRevision: '1',
        lifecycle: step.lifecycle,
        createdAt: new Date(DEMO_NOW_MS - 240_000 + index * 90_000).toISOString(),
        updatedAt,
    }));
    const progressById = new Map<string, WorkflowProgressEnvelopeV1>(STEPS.map((step, index) => {
        const invocationId = invocations[index]!.id;
        return [invocationId, WorkflowProgressEnvelopeV1Schema.parse({
            kind: 'happier.workflow-progress.v1',
            invocationPath: { blockId: step.id, scope: [] },
            blockKind: 'step',
            attempt: '0',
            logicalInvocationRecordId: invocationId,
            ...(step.result === undefined ? {} : { result: step.result }),
        })] as const;
    }));

    return { title: 'Ship the checkout update', definition, materializedLeaves, run, invocations, progressById };
}
