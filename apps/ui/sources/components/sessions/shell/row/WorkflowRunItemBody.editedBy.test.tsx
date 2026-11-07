import * as React from 'react';
import { afterEach, describe, expect, it } from 'vitest';

import { renderScreen, standardCleanup } from '@/dev/testkit';
import { createWorkflowDefinitionFixture, createWorkflowRunSummaryFixture } from '@/dev/testkit/fixtures/workflowRunFixtures';
import { createWorkflowAccountRunActionOwner } from '@happier-dev/protocol/actions/executor/workflowRunActions';
import { materializeWorkflowAcceptedSnapshotV1 } from '@happier-dev/protocol/workflows/materializeWorkflowAcceptedSnapshotV1';
import { sealWorkflowAcceptedSnapshotStoredEnvelopeV1, serializeWorkflowStoredContentEnvelopeV1 } from '@happier-dev/protocol/workflows/workflowStoredContentV1';
import { WorkflowRunRecipientCensusResponseV1Schema } from '@happier-dev/protocol/workflows/workflowRunKeyV1';
import { WorkflowRunListResultV1Schema } from '@happier-dev/protocol/workflows/actionsV1';
import { ArtifactSavedByV1Schema } from '@happier-dev/protocol/artifacts/artifactBinaryV1';
import { UserProfileSchema } from '@happier-dev/protocol/social/friends';
import { storage } from '@/sync/domains/state/storage';
import { workflowRunRowFromSummary } from '@/sync/store/domains/workflowRuns';
import { t } from '@/text';

import { WorkflowRunItemBody } from './WorkflowRunItemBody';

afterEach(() => { standardCleanup(); storage.setState(storage.getInitialState(), true); });

const VIEWER = 'account-viewer';
const OTHER = 'account-bo';
const VIEWER_SCOPE = { serverId: 'home', accountId: VIEWER };
type SavedBy = { kind: 'person'; accountId: string } | { kind: 'agent'; accountId: string } | null | undefined;


async function renderHistoryRow(savedBy: SavedBy, input: Readonly<{ people?: Record<string, string>; inTriggerHistory?: boolean }> = {}) {
    const run = createWorkflowRunSummaryFixture({ id: 'occurrence-run', state: 'succeeded', startedBy: 'trigger', ownerAccountId: VIEWER });
    storage.setState({ profileScope: VIEWER_SCOPE });
    storage.getState().applyUsers(Object.fromEntries(Object.entries(input.people ?? {}).map(([id, name]) => [id,
        UserProfileSchema.parse({ id, name, firstName: '', lastName: null, username: '', avatar: null,
            bio: null, publicKey: null, status: 'none' })])));
    // A cold History page has only the lean projection, not an opened Run detail.
    const definition = createWorkflowDefinitionFixture({ defaults: { agentTarget: {
        kind: 'agent', identity: { pluginId: 'happier.agent.test', localId: 'test' },
    } } });
    const accepted = await materializeWorkflowAcceptedSnapshotV1({ definition, admission: { kind: 'user' },
        effects: { resolveTargetAvailability: async () => true },
        context: { source: { kind: 'automation', automationId: 'automation-1', definitionId: 'definition-1',
            revision: { headerVersion: 2, bodyVersion: 2 },
            savedBy: savedBy == null ? null : ArtifactSavedByV1Schema.parse(savedBy) },
            actionCaller: { kind: 'automationRun', runId: run.id, automationId: 'automation-1',
                cause: { kind: 'manual', invokedAt: 1 } },
            inputs: {}, machineId: run.machineId, executionTarget: { kind: 'session' },
            workspaceTarget: { project: { machineId: run.machineId, directory: '/repo', checkoutRootPath: '/repo' } },
            authorization: { principal: { kind: 'host' } } } });
    if (!accepted.ok) throw new Error(`accepted_fixture_${accepted.error.code}`);
    const envelope = serializeWorkflowStoredContentEnvelopeV1(sealWorkflowAcceptedSnapshotStoredEnvelopeV1({
        mode: 'plain', binding: { v: 1, purpose: 'accepted_snapshot', accountId: VIEWER, runId: run.id },
        acceptedSnapshot: accepted.snapshot }));
    const census = WorkflowRunRecipientCensusResponseV1Schema.parse({ runId: run.id, ownerAccountId: VIEWER,
        encryptionMode: 'plain', visibleTeamId: null, access: 'owner', dataEncryptionKey: null, callerDataEncryptionKey: null, recipients: [],
        ownerAccountCurrentness: { mode: 'plain', version: 1, contentKeyFingerprint: null } });
    // Only storage/encryption are system boundaries; the real list owner projects the frozen fact.
    const owner = createWorkflowAccountRunActionOwner({ resolveAccountId: async () => VIEWER,
        resolveEncryption: async () => ({ kind: 'available', witness: { mode: 'plain', version: 1, contentKeyFingerprint: null } }),
        resolveRunReportPolicy: async () => ({ preset: 'important' }), normalizeAbsolutePath: path => path,
        randomBytes: () => { throw new Error('read must not mint keys'); },
        definitions: { get: async () => ({ definitionId: 'definition-1', definition,
            revision: { headerVersion: 3, bodyVersion: 3 }, metadata: { title: 'Current' },
            savedBy: { kind: 'person', accountId: VIEWER } }) },
        storage: { execute: async operation => {
            if (operation.operation !== 'list') throw new Error('cold History must not read detail');
            return { runs: [run], acceptedEnvelopesByRunId: { [run.id]: envelope }, keyCensusByRunId: { [run.id]: census } };
        } } });
    const page = WorkflowRunListResultV1Schema.parse(await owner.execute({ actionId: 'workflow.run.list', input: {}, context: {} }));
    storage.getState().upsertWorkflowRuns(page.runs.map(summary => workflowRunRowFromSummary(summary,
        { kind: 'available', value: { title: 'Nightly check' } })), VIEWER_SCOPE);
    return renderScreen(<WorkflowRunItemBody kind="workflow_run" runId={run.id} serverId="home"
        inTriggerHistory={input.inTriggerHistory ?? true} />);
}

describe('History occurrence "Edited by" line', () => {
    it('says "you" for an occurrence that ran the viewer\'s own edit', async () => {
        const screen = await renderHistoryRow({ kind: 'person', accountId: VIEWER });
        expect(screen.getTextContent()).toContain(t('workflows.run.editedByYou'));
    });

    it('names another person by their Account name', async () => {
        const screen = await renderHistoryRow({ kind: 'person', accountId: OTHER }, { people: { [OTHER]: 'Bo Lindqvist' } });
        expect(screen.getTextContent()).toContain(t('workflows.run.editedBy', { name: 'Bo Lindqvist' }));
        expect(screen.getTextContent()).not.toContain(OTHER);
    });

    it('outside Workflow History omits the viewer\'s own save but still names other people and agents', async () => {
        const own = await renderHistoryRow({ kind: 'person', accountId: VIEWER }, { inTriggerHistory: false });
        expect(own.getTextContent()).not.toContain(t('workflows.run.editedByYou'));
        standardCleanup();
        const other = await renderHistoryRow({ kind: 'person', accountId: OTHER }, { people: { [OTHER]: 'Bo Lindqvist' }, inTriggerHistory: false });
        expect(other.getTextContent()).toContain(t('workflows.run.editedBy', { name: 'Bo Lindqvist' }));
        standardCleanup();
        const agent = await renderHistoryRow({ kind: 'agent', accountId: VIEWER }, { inTriggerHistory: false });
        expect(agent.getTextContent()).toContain(t('workflows.run.editedByAgent'));
    });
    it('draws no line when the frozen saved-by fact is absent', async () => {
        for (const savedBy of [undefined, null] as const) {
            const screen = await renderHistoryRow(savedBy);
            expect(screen.getTextContent()).not.toContain(t('workflows.run.editedByYou'));
            expect(screen.getTextContent()).not.toContain(t('workflows.run.editedByPerson'));
            standardCleanup();
        }
    });

    it('reads the occurrence\'s frozen saver, not the live definition\'s', async () => {
        // The viewer owns the Run and the workflow may since have been saved by them; the occurrence froze Bo's save.
        const screen = await renderHistoryRow({ kind: 'person', accountId: OTHER }, { people: { [OTHER]: 'Bo Lindqvist' } });
        expect(screen.getTextContent()).toContain('Bo Lindqvist');
        expect(screen.getTextContent()).not.toContain(t('workflows.run.editedByYou'));
    });
});
