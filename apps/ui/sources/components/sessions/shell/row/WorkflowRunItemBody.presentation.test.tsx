import * as React from 'react';
import { StyleSheet } from 'react-native';
import { useUnistyles } from 'react-native-unistyles';
import { afterEach, expect, it } from 'vitest';

import { renderScreen, standardCleanup } from '@/dev/testkit';
import { createWorkflowRunSummaryFixture } from '@/dev/testkit/fixtures/workflowRunFixtures';
import { storage } from '@/sync/domains/state/storage';
import { workflowRunRowFromSummary, workflowRunStoreKey } from '@/sync/store/domains/workflowRuns';
import { formatShortRelativeTimeAt } from '@/utils/time/formatShortRelativeTime';
import { t } from '@/text';
import { resolveWorkStatusTone } from '@/components/work/status/resolveWorkStatusTone';
import { readWorkflowRunWorkStatusFacts } from '@/components/work/status/workflowWorkStatusFacts';

import { WorkflowRunItemBody } from './WorkflowRunItemBody';
import { SessionListHeaderItem } from '../sessionListHeaderItem';
import { buildSessionListProjectHeaderViewModels } from '../sessionListProjectHeaderViewModels';
import { useSessionListGroupMachineFacts } from '../useSessionListGroupMachineFacts';
import { computeVisibleSessionListIndex } from '@/sync/domains/session/listing/computeVisibleSessionListIndex';
import { normalizeSessionListFilterV1 } from '@happier-dev/protocol/sessions/listFilter/sessionListFilterV1';
import { createMachineFixture } from '@/dev/testkit/fixtures/machineFixtures';
import { resolveMachineDisplayNames } from '@/utils/sessions/machineDisplayNames';

afterEach(() => { standardCleanup(); storage.setState(storage.getInitialState(), true); });

const RUN_SCOPE = { serverId: 'home', accountId: 'account' };

it('renders distinct machine lines for Run-derived headers sharing the same project path', async () => {
    const machines = ['laptop-a', 'laptop-b'].map(id => createMachineFixture({ id,
        metadata: { ...createMachineFixture().metadata!, displayName: 'Laptop', host: 'laptop.local' },
    }));
    const listItems = computeVisibleSessionListIndex({ source: [], resolveSessionRow: () => null,
        hideInactiveSessions: false, pinnedSessionKeysV1: [], sessionListGroupOrderV1: {},
        sessionListLayoutChoice: 'projects', presentation: { enabled: false, presentation: 'grouped' },
        workFilter: normalizeSessionListFilterV1({ show: 'runs', homeServerIds: ['home'] }),
        viewerAccountIdByServerId: new Map([['home', 'run-viewer']]),
        workflowRuns: machines.map(machine => ({ serverId: 'home', summary: createWorkflowRunSummaryFixture({
            id: machine.id, ownerAccountId: 'run-viewer', startedBy: 'user', where: { machineId: machine.id, directory: '/home/happier' },
        }) })),
    })!;
    const machinesById = new Map(machines.map(machine => [machine.id, machine]));
    const headerState = buildSessionListProjectHeaderViewModels({
        listItems, machinesById, workspaceLabels: undefined, workspaceRefs: [],
    });
    storage.setState({ machineDisplayById: Object.fromEntries(machines.map(machine => [machine.id, machine])) });
    const headers = listItems.filter(item => item.type === 'header');
    expect(headers).toHaveLength(2);
    function Headers() {
        const { projectHeaderViewModelByGroupKey } = useSessionListGroupMachineFacts({
            listItems, membershipItems: listItems, headerState,
        });
        return <>{headers.map(item => <SessionListHeaderItem key={item.groupKey} item={item}
            collapsedKeys={{}} projectHeaderViewModelByGroupKey={projectHeaderViewModelByGroupKey}
            newSessionEnabled={false}
            onOpenProject={() => {}} onCreateSessionFromWorkspaceScope={() => {}}
            onAddFolderToWorkspace={() => {}} onRenameWorkspace={() => {}}
            onResetWorkspaceName={() => {}} onToggleCollapse={() => {}} />)}</>;
    }
    const screen = await renderScreen(<Headers />);
    const names = [...resolveMachineDisplayNames(machines).values()];
    expect(new Set(names).size).toBe(2);
    for (const name of names) expect(screen.getTextContent()).toContain(name);
});

it('uses the shared attention word for a held Run before its attention window catches up', async () => {
    const run = createWorkflowRunSummaryFixture({ id: 'held-run', state: 'waiting_for_review', attentionRequired: false });
    storage.setState({ profileScope: RUN_SCOPE });
    storage.getState().upsertWorkflowRuns([workflowRunRowFromSummary(run,
        { kind: 'available', value: { title: 'Prepare the 0.3 release' } })], RUN_SCOPE);
    const screen = await renderScreen(<WorkflowRunItemBody kind="workflow_run" runId={run.id} serverId="home" />);
    expect(screen.getTextContent()).toContain(t('workStatus.buckets.needs_you'));
    expect(screen.getTextContent()).toContain('Prepare the 0.3 release');
    expect(storage.getState().workflowRunsById[workflowRunStoreKey(run.id, RUN_SCOPE)]?.detail).toBeUndefined();
});

it('identifies a finished history Run by its frozen workflow name and visible age without opening a body', async () => {
    const run = createWorkflowRunSummaryFixture({ id: 'history-run', state: 'succeeded' });
    storage.setState({ profileScope: RUN_SCOPE });
    storage.getState().upsertWorkflowRuns([workflowRunRowFromSummary(run,
        { kind: 'available', value: { title: 'Release review' } })], RUN_SCOPE);
    const screen = await renderScreen(<WorkflowRunItemBody kind="workflow_run" runId={run.id} serverId="home" />);
    expect(screen.getTextContent()).toContain('Release review');
    expect(screen.findByTestId(`workflow-run-row:${run.id}:age`)).toBeTruthy();
    expect(screen.getTextContent()).toContain(formatShortRelativeTimeAt(Date.parse(run.updatedAt), Date.now()));
    expect(storage.getState().workflowRunsById[workflowRunStoreKey(run.id, RUN_SCOPE)]?.detail).toBeUndefined();
});

it('shows observed authored-step progress and trigger origin together on the Run context line', async () => {
    const run = createWorkflowRunSummaryFixture({ id: 'triggered-run', state: 'running', startedBy: 'trigger',
        stepProgress: { completed: 3, total: 5 } });
    storage.setState({ profileScope: RUN_SCOPE });
    storage.getState().upsertWorkflowRuns([workflowRunRowFromSummary(run,
        { kind: 'available', value: { title: 'Prepare the release' } })], RUN_SCOPE);
    const screen = await renderScreen(<WorkflowRunItemBody kind="workflow_run" runId={run.id} serverId="home" />);
    expect(screen.getTextContent()).toContain(`${t('workflows.list.stepsProgress', run.stepProgress!)} · ${t('workflows.list.startedByTrigger')}`);
    expect(storage.getState().workflowRunsById[workflowRunStoreKey(run.id, RUN_SCOPE)]?.detail).toBeUndefined();
});

it('says an interrupted Run in its word alone, with no tinted row, as a Session row says it (lab convo-N4)', async () => {
    const run = createWorkflowRunSummaryFixture({ id: 'interrupted-run', state: 'interrupted' });
    storage.setState({ profileScope: RUN_SCOPE });
    storage.getState().upsertWorkflowRuns([workflowRunRowFromSummary(run,
        { kind: 'available', value: { title: 'Nightly dependency check' } })], RUN_SCOPE);
    const screen = await renderScreen(<WorkflowRunItemBody kind="workflow_run" runId={run.id} serverId="home" />);
    const { theme } = useUnistyles();
    const tinted = screen.findAllByType('View').map((node) => StyleSheet.flatten(node.props.style))
        .filter((style) => style?.backgroundColor === theme.colors.state.warning.background);
    expect(screen.findByTestId(`workflow-run-row:${run.id}:status`)).toBeTruthy();
    expect(tinted).toHaveLength(0);
});

it('draws a Run as one line at the list\'s one-line density: glyph alone, its word only with status words (lab clicon:icon)', async () => {
    const run = createWorkflowRunSummaryFixture({ id: 'stopped-run', state: 'cancelled', startedBy: 'trigger',
        stepProgress: { completed: 0, total: 4 } });
    storage.setState({ profileScope: RUN_SCOPE });
    storage.getState().upsertWorkflowRuns([workflowRunRowFromSummary(run,
        { kind: 'available', value: { title: 'Nightly dependency check' } })], RUN_SCOPE);
    const word = resolveWorkStatusTone({ kind: 'workflow_run', facts: readWorkflowRunWorkStatusFacts(run, {}) }).word!;
    const progress = t('workflows.list.stepsProgress', run.stepProgress!);
    const quiet = await renderScreen(<WorkflowRunItemBody kind="workflow_run" runId={run.id} serverId="home" density="minimal" />);
    expect(quiet.getTextContent()).toContain('Nightly dependency check');
    expect(quiet.getTextContent()).not.toContain(progress);
    expect(quiet.getTextContent()).not.toContain(word);
    expect(quiet.findByTestId(`workflow-run-row:${run.id}:status`)).toBeTruthy();
    // What the line no longer draws is still spoken.
    const label = String(quiet.findHostByTestId(`workflow-run-row:${run.id}`)?.props.accessibilityLabel);
    expect(label).toContain(word);
    expect(label).toContain(progress);
    standardCleanup();
    const worded = await renderScreen(<WorkflowRunItemBody kind="workflow_run" runId={run.id} serverId="home" density="minimal" statusWords />);
    expect(worded.getTextContent()).toContain(word);
    expect(worded.getTextContent()).not.toContain(progress);
});

it('follows status words like a Session row: a failed Run is the rose dot, its word spoken, and drawn only with status words (ruling 2026-11-01)', async () => {
    const run = createWorkflowRunSummaryFixture({ id: 'failed-run', state: 'failed', failureUnseen: true });
    storage.setState({ profileScope: RUN_SCOPE });
    storage.getState().upsertWorkflowRuns([workflowRunRowFromSummary(run,
        { kind: 'available', value: { title: 'Nightly dependency check' } })], RUN_SCOPE);
    const status = resolveWorkStatusTone({ kind: 'workflow_run', facts: readWorkflowRunWorkStatusFacts(run, {}) });
    expect(status.tone).toBe('danger');
    const screen = await renderScreen(<WorkflowRunItemBody kind="workflow_run" runId={run.id} serverId="home" density="minimal" />);
    expect(screen.getTextContent()).not.toContain(status.word!);
    expect(screen.findHostByTestId(`session-row-attention-indicator-dot-workflow-run-${run.id}`)).not.toBeNull();
    expect(String(screen.findHostByTestId(`workflow-run-row:${run.id}`)?.props.accessibilityLabel)).toContain(status.word!);
    standardCleanup();
    const worded = await renderScreen(<WorkflowRunItemBody kind="workflow_run" runId={run.id} serverId="home" density="minimal" statusWords />);
    expect(worded.getTextContent()).toContain(status.word!);
});
