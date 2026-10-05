import { beforeEach, describe, expect, it, vi } from 'vitest';

// The applied connection and storage reader are the Account host boundary;
// lifetime capture and retirement underneath them remain real.
const accountHost = vi.hoisted(() => ({
    scope: { serverId: 'server-a', accountId: 'account-a' },
}));
vi.mock('@/sync/runtime/orchestration/connectionManager', () => ({
    getAppliedActiveServerSnapshot: () => ({ serverId: accountHost.scope.serverId }),
    isAppliedActiveServerRuntimeAvailable: () => true,
}));
vi.mock('@/sync/domains/state/storageStateReaderBridge', () => ({
    readRegisteredStorageState: () => ({ profileScope: accountHost.scope }),
}));

import { WorkflowDefinitionV1Schema } from '@happier-dev/protocol/workflows/workflowV1';
import { WorkflowRunSummaryV1Schema } from '@happier-dev/protocol/workflows/workflowProgressV1';
import type { WorkflowRunAcceptedContextV1 } from '@happier-dev/protocol';

import {
    buildWorkflowReviewedRunSeed,
    readWorkflowReviewedRunSeed,
    storeWorkflowReviewedRunSeed,
} from './workflowReviewedRunSeed';

function createWorkflowDefinitionFixture() {
    return WorkflowDefinitionV1Schema.parse({ version: 1, inputs: [], defaults: {}, blocks: [{ kind: 'step', id: 'step-1', document: { text: 'Analyze the repository', references: [], attachments: [] }, input: [], result: { kind: 'text' } }] });
}

function createWorkflowRunSummaryFixture(overrides: Partial<ReturnType<typeof WorkflowRunSummaryV1Schema.parse>> = {}) {
    return WorkflowRunSummaryV1Schema.parse({ sourceArtifactId: null, ownerAccountId: 'account-1', visibleTeamId: null,
        id: 'run-1', origin: { kind: 'direct' }, state: 'succeeded', revision: 1,
        machineId: 'machine-1', workflowCustodyState: 'settled', originDeliveryAckRevision: null,
        availability: { pause: false, resumeBoundary: false,    restoreWorkspace: false, cancel: false, inspectExecution: true, disabledReasons: [] },
        createdAt: '2026-09-08T10:00:00.000Z', updatedAt: '2026-09-08T10:00:00.000Z', ...overrides,
    });
}

const ACCEPTED_CONTEXT: WorkflowRunAcceptedContextV1 = {
    startedBy: 'user',
    source: { kind: 'inline' },
    inputs: { topic: 'release' },
    machineId: 'machine-1',
    executionTarget: { kind: 'detached_run' },
    materializedLeaves: [],
    frozenChildren: {},
    workspaceTarget: { project: { machineId: 'machine-1', directory: '/Users/me/project', checkoutRootPath: '/Users/me/project' } },
    origin: { kind: 'direct' },
};

describe('workflow reviewed-run seed', () => {
    it('pins each accepted root step target rather than re-reading the current role runs-as', () => {
        const definition = createWorkflowDefinitionFixture();
        const seed = buildWorkflowReviewedRunSeed({ run: createWorkflowRunSummaryFixture(), definition,
            acceptedContext: { ...ACCEPTED_CONTEXT, executionTarget: { kind: 'session' }, materializedLeaves: [{
                sourceKey: '$root', blockId: 'step-1', kind: 'step', selection: {}, authoredWorkspace: { kind: 'inherit' },
                executionTarget: { kind: 'detached_run' },
            }] } });
        expect(seed.definition.blocks[0]).toMatchObject({ execution: { executionTarget: { kind: 'detached_run' } } });
        expect(definition.blocks[0]).not.toHaveProperty('execution');
    });
    beforeEach(() => {
        accountHost.scope = { serverId: 'server-a', accountId: 'account-a' };
    });
    it('keeps accepted library metadata when opening a run as an unsaved workflow', () => {
        const seed = buildWorkflowReviewedRunSeed({
            run: createWorkflowRunSummaryFixture({ id: 'run-completed' }),
            definition: createWorkflowDefinitionFixture(),
            acceptedContext: { ...ACCEPTED_CONTEXT, metadata: { title: 'Release review', description: 'Review the release changes' } },
        });
        expect(seed).toMatchObject({ name: 'Release review', description: 'Review the release changes' });
        expect(seed.reasonCode).toBeUndefined();
        expect(seed.supersededRunId).toBeUndefined();
    });
    it('carries the accepted definition, placement, runtime and inputs of the run it reviews', () => {
        const definition = createWorkflowDefinitionFixture();
        const seed = buildWorkflowReviewedRunSeed({
            run: createWorkflowRunSummaryFixture({ id: 'run-interrupted', state: 'interrupted' }),
            definition,
            acceptedContext: ACCEPTED_CONTEXT,
            reasonCode: 'workspace_conflict',
        });

        expect(seed).toMatchObject({
            name: 'Analyze the repository',
            project: { machineId: 'machine-1', directory: '/Users/me/project' },
            // Repeating effectful work under a different runtime would be a
            // different operation; the reviewed copy keeps what was accepted.
            executionTarget: { kind: 'detached_run' },
            inputs: { topic: 'release' },
            supersededRunId: 'run-interrupted',
            reasonCode: 'workspace_conflict',
        });
        expect(seed.definition).toEqual(definition);
    });

    it('reads the stored copy exactly once so history cannot re-seed the editor', () => {
        const seed = buildWorkflowReviewedRunSeed({
            run: createWorkflowRunSummaryFixture({ id: 'run-1' }),
            definition: createWorkflowDefinitionFixture(),
            acceptedContext: ACCEPTED_CONTEXT,
            reasonCode: 'workspace_unavailable',
        });
        const seedId = storeWorkflowReviewedRunSeed(seed);

        expect(readWorkflowReviewedRunSeed(seedId)).toEqual(seed);
        expect(readWorkflowReviewedRunSeed(seedId)).toBeNull();
    });

    it('refuses a handle that does not name a reviewed-run copy', () => {
        expect(readWorkflowReviewedRunSeed('not-a-stored-seed')).toBeNull();
    });

    it('refuses a seed after the Account changes before editor intake', () => {
        const seedId = storeWorkflowReviewedRunSeed(buildWorkflowReviewedRunSeed({
            run: createWorkflowRunSummaryFixture(),
            definition: createWorkflowDefinitionFixture(),
            acceptedContext: ACCEPTED_CONTEXT,
        }));
        accountHost.scope = { serverId: 'server-a', accountId: 'account-b' };
        expect(readWorkflowReviewedRunSeed(seedId)).toBeNull();
    });

    it('refuses a seed after its Account lifetime retires even when the same Account returns', async () => {
        const { retireActiveServerAccountScopeLifetime } = await import('@/sync/domains/scope/activeServerAccountScope');
        const seedId = storeWorkflowReviewedRunSeed(buildWorkflowReviewedRunSeed({
            run: createWorkflowRunSummaryFixture(),
            definition: createWorkflowDefinitionFixture(),
            acceptedContext: ACCEPTED_CONTEXT,
        }));
        retireActiveServerAccountScopeLifetime();
        expect(readWorkflowReviewedRunSeed(seedId)).toBeNull();
    });
});
