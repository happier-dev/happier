import { AutomationV3RunListItemSchema } from '@happier-dev/protocol/automations/automationApiV3';
import { WorkflowDefinitionV1Schema, type WorkflowDefinitionV1 } from '@happier-dev/protocol/workflows/workflowV1';
import {
    WorkflowRunInvocationIndexV1Schema,
    WorkflowRunSummaryV1Schema,
    type WorkflowInvocationLifecycleV1,
    type WorkflowRunInvocationIndexV1,
    type WorkflowRunSummaryV1,
} from '@happier-dev/protocol/workflows/workflowProgressV1';

import type { AutomationDefinitionRun } from '@/sync/domains/automations/automationTypes';
import type { WorkflowRunAutomationSummariesResultV1 } from '@happier-dev/protocol/workflows/actionsV1';

/**
 * Workflow Run fixtures for both transports, built by parsing the canonical
 * Protocol schemas. Parsing rather than casting is deliberate: when the Run
 * contract gains or moves a field, these factories fail here instead of letting
 * every consuming test assert against a shape the server can no longer produce.
 */

type SummaryOverrides = Partial<Omit<WorkflowRunSummaryV1, 'origin' | 'availability'>> & Readonly<{
    origin?: WorkflowRunSummaryV1['origin'];
    availability?: Partial<WorkflowRunSummaryV1['availability']>;
}>;

export function createWorkflowRunSummaryFixture(overrides: SummaryOverrides = {}): WorkflowRunSummaryV1 {
    const { origin, availability, ...rest } = overrides;
    return WorkflowRunSummaryV1Schema.parse({ sourceArtifactId: null, ownerAccountId: 'account-1', visibleTeamId: null,
        id: 'run-1',
        origin: origin ?? { kind: 'automation', automationId: 'automation-1' },
        ...((origin?.kind ?? 'automation') === 'automation' ? { automationScopeSessionId: null } : {}),
        state: 'running',
        revision: 1,
        machineId: 'machine-1',
        workflowCustodyState: 'pending',
        originDeliveryAckRevision: null,
        attentionSeenFailureAt: null,
        failureUnseen: false,
        invocationAttentionRequired: false,
        attentionRequired: false,
        finishedAt: null,
        availability: {
            pause: true,
            resumeBoundary: false,



            restoreWorkspace: false,
            cancel: true,
            inspectExecution: true,
            disabledReasons: [],
            ...availability,
        },
        createdAt: '2026-09-08T10:00:00.000Z',
        updatedAt: '2026-09-08T10:00:00.000Z',
        ...rest,
    });
}

type AutomationLastRunSummary = NonNullable<WorkflowRunAutomationSummariesResultV1['automationSummaries'][number]['lastRun']>;

export function createWorkflowAutomationLastRunSummaryFixture(overrides: Partial<AutomationLastRunSummary> = {}): AutomationLastRunSummary {
    const run = createWorkflowRunSummaryFixture();
    return { id: run.id, state: run.state, workflowCustodyState: null,
        attentionRequired: run.attentionRequired, failureUnseen: run.failureUnseen,
        invocationAttentionRequired: run.invocationAttentionRequired, createdAt: run.createdAt, startedAt: run.createdAt, ...overrides };
}

/** Real accepted-snapshot/key producers for full private Run-list HTTP answers. */
export async function createWorkflowRunListStorageFixture(params: Readonly<{
    runs: readonly WorkflowRunSummaryV1[];
    definition: WorkflowDefinitionV1;
    metadata?: Readonly<{ title: string }>;
}>) {
    const { materializeWorkflowAcceptedSnapshotV1 } = await import('@happier-dev/protocol/workflows/materializeWorkflowAcceptedSnapshotV1');
    const { sealWorkflowAcceptedSnapshotStoredEnvelopeV1, serializeWorkflowStoredContentEnvelopeV1 } = await import('@happier-dev/protocol/workflows/workflowStoredContentV1');
    const { WorkflowRunRecipientCensusResponseV1Schema } = await import('@happier-dev/protocol/workflows/workflowRunKeyV1');
    const entries = await Promise.all(params.runs.map(async run => {
        const materialized = await materializeWorkflowAcceptedSnapshotV1({
            definition: params.definition, admission: { kind: 'user' }, effects: { resolveTargetAvailability: async () => true },
            context: { source: run.origin.kind === 'automation' ? { kind: 'automation', automationId: run.origin.automationId } : { kind: 'inline' },
                inputs: {}, machineId: run.machineId, executionTarget: { kind: 'session' },
                workspaceTarget: { project: { machineId: run.machineId, directory: '/repo', checkoutRootPath: '/repo' } },
                ...(run.origin.kind === 'direct' ? { origin: run.origin } : { actionCaller: { kind: 'automationRun' as const,
                    runId: run.id, automationId: run.origin.automationId, cause: { kind: 'manual' as const, invokedAt: 1 } } }),
                ...(params.metadata ? { metadata: params.metadata } : {}), authorization: { principal: { kind: 'host' } } },
        });
        if (!materialized.ok) throw new Error(`fixture_materialization_failed:${materialized.error.code}`);
        const envelope = serializeWorkflowStoredContentEnvelopeV1(sealWorkflowAcceptedSnapshotStoredEnvelopeV1({ mode: 'plain',
            binding: { v: 1, purpose: 'accepted_snapshot', accountId: run.ownerAccountId, runId: run.id }, acceptedSnapshot: materialized.snapshot }));
        const census = WorkflowRunRecipientCensusResponseV1Schema.parse({ runId: run.id, ownerAccountId: run.ownerAccountId,
            access: 'owner', encryptionMode: 'plain', dataEncryptionKey: null, callerDataEncryptionKey: null, recipients: [], visibleTeamId: null,
            ownerAccountCurrentness: { mode: 'plain', version: 1, contentKeyFingerprint: null } });
        return { id: run.id, envelope, census };
    }));
    return { runs: params.runs, acceptedEnvelopesByRunId: Object.fromEntries(entries.map(row => [row.id, row.envelope])),
        keyCensusByRunId: Object.fromEntries(entries.map(row => [row.id, row.census])) };
}

export function createWorkflowInvocationIndexFixture(
    overrides: Partial<WorkflowRunInvocationIndexV1> = {},
): WorkflowRunInvocationIndexV1 {
    return WorkflowRunInvocationIndexV1Schema.parse({
        id: 'invocation-1',
        runId: 'run-1',
        sequence: '0',
        parentRecordId: null,
        memberOrdinal: '0',
        attempt: '0',
        contentRevision: '0',
        lifecycle: 'running' satisfies WorkflowInvocationLifecycleV1,
        createdAt: '2026-09-08T10:00:00.000Z',
        updatedAt: '2026-09-08T10:00:00.000Z',
        ...overrides,
    });
}

/** The incumbent Automation REST projection of a Run. */
export function createAutomationRunFixture(
    overrides: Partial<AutomationDefinitionRun> = {},
): AutomationDefinitionRun {
    return AutomationV3RunListItemSchema.parse({
        id: 'run-1',
        automationId: 'automation-1',
        revision: 1,
        triggerId: null,
        triggerRetired: false,
        state: 'queued',
        cause: { kind: 'manual', invokedAt: 1 },
        dueAt: 1,
        claimedAt: null,
        startedAt: null,
        finishedAt: null,
        claimedByMachineId: null,
        leaseExpiresAt: null,
        attempt: 0,
        errorCode: null,
        producedSessionId: null,
        executionDispatchState: null,
        executionAttempt: 0,
        replyHandoffState: 'none',
        replyHandoffAttempt: 0,
        replyHandoffDueAt: null,
        createdAt: 1,
        updatedAt: 1,
        ...overrides,
    });
}

/**
 * The smallest definition the canonical schema accepts: one text step. Run
 * detail renders the frozen definition a Run was admitted with, so a fixture
 * that the real codec would reject is worse than useless.
 */
export function createWorkflowDefinitionFixture(
    overrides: Partial<WorkflowDefinitionV1> = {},
): WorkflowDefinitionV1 {
    return WorkflowDefinitionV1Schema.parse({
        version: 1,
        inputs: [],
        defaults: {},
        blocks: [{
            kind: 'step',
            id: 'analyze',
            document: { text: 'Analyze the repository', references: [], attachments: [] },
            input: [],
            result: { kind: 'text' },
        }],
        ...overrides,
    });
}
