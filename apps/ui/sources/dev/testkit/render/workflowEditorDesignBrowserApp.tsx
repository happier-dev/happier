import '@/unistyles';
import * as React from 'react';
import { createRoot } from 'react-dom/client';
import { View } from 'react-native';
import { UnistylesRuntime } from 'react-native-unistyles';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { WorkspaceProvider } from '@/components/appShell/workspace/WorkspaceProvider';
import { DestinationInstanceHost } from '@/components/appShell/workspace/DestinationInstanceHost';
import { resolveCompactAppDestinations } from '@/components/appShell/destinations/compactAppDestinationCatalog';
import { AppPaneProvider } from '@/components/appShell/panes/AppPaneProvider';
import { AppShellMaterialFrame } from '@/components/navigation/shell/AppShellMaterialFrame';
import { WorkflowEditorBody } from '@/components/workflows/screens/WorkflowEditorBody';
import { WorkflowEditorHostScreen } from '@/components/workflows/screens/WorkflowEditorHostScreen';
import { WorkflowBuiltinEditorHostScreen } from '@/components/workflows/screens/WorkflowCatalogEditorHostScreen';
import { useWorkflowAuthoringHost } from '@/components/workflows/screens/useWorkflowAuthoringHost';
import type { WorkflowAuthoringTarget } from '@/sync/domains/workflows/workflowProjectTarget';
import { createMachineFixture } from '@/dev/testkit/fixtures/machineFixtures';
import { createSessionFixture } from '@/dev/testkit/fixtures/sessionFixtures';
import { WorkflowTriggerSection } from '@/components/workflows/triggers/WorkflowTriggerSection';
import { EMPTY_WORKFLOW_TRIGGER_DRAFT } from '@/components/workflows/triggers/workflowTriggerDraft';
import { WorkflowTriggerSetV1Schema } from '@happier-dev/protocol';
import { createWorkflowEditorDraft, insertWorkflowEditorBlock, type WorkflowEditorDraft } from '@/sync/domains/workflows/workflowEditorDraft';
import { storage } from '@/sync/domains/state/storage';
import { settingsDefaults } from '@/sync/domains/settings/settings';
import { InjectedAuthProvider } from '@/auth/context/AuthContext';
import { authoringMemoryDefaults } from '@/sync/store/domains/authoringMemory';
import { publishAppliedActiveServerSnapshot } from '@/sync/runtime/orchestration/appliedActiveServerRuntime';
import { WorkspaceBrowserPresentation } from './WorkspaceBrowserPresentation';

const catalog = resolveCompactAppDestinations({ pages: [], builtins: { workflows: true, friends: false, inbox: false, externalSessions: false } });

/** The owner's habit (EDITOR-FIDELITY): an Agent step continuing a Session, then a quiet Notify me. */
const HABIT_SESSION_ID = 'cmv35zdl300n7m2tgnj0yd98z';
const HABIT_MACHINE = createMachineFixture({ id: 'machine-habit', metadata: {
    host: 'NLDW4-5-40-40', platform: 'linux', happyCliVersion: '0.3.0', happyHomeDir: '/home/me/.happier', homeDir: '/home/me',
} });
const HABIT_SESSION = createSessionFixture({ id: HABIT_SESSION_ID, metadata: {
    path: '/tmp', host: 'NLDW4-5-40-40', homeDir: '/home/me', machineId: HABIT_MACHINE.id, summary: { text: 'Nightly quiet check', updatedAt: 1 },
} as never });
const HABIT_AGENT_TARGET = { kind: 'agent' as const, identity: { pluginId: 'happier.agent.claude', localId: 'claude' } };

function habitDraft() {
    const reported = { kind: 'result' as const, producer: { blockId: 'quiet-check', scope: { kind: 'current' as const } }, path: ['reported'] };
    return createWorkflowEditorDraft({ draftId: 'qa-l10a-habit', name: 'QA L10A quiet habit', blocks: [
        { kind: 'step', id: 'quiet-check', name: 'QA L10A quiet check', input: [],
            document: { text: 'QA L10A habit: return only a JSON object with reported set to false. Do not use tools or change files.', references: [], attachments: [] },
            execution: { agentTarget: HABIT_AGENT_TARGET, conversation: { kind: 'existing_session', sessionId: HABIT_SESSION_ID, machineId: HABIT_MACHINE.id } },
            result: { kind: 'json', schema: { type: 'object', properties: { reported: { type: 'boolean' } }, required: ['reported'] } } },
        { kind: 'action', id: 'notify', name: 'QA L10A Notify only if reported', actionId: 'notifications.notify_me',
            input: { message: { kind: 'literal', value: 'QA L10A agent reported something.' }, title: { kind: 'literal', value: 'QA L10A habit' } },
            onlyWhen: { kind: 'compare', operator: 'eq', left: reported, right: { kind: 'literal', value: true } } },
    ] as never });
}

/** The habit's own trigger set: one nightly schedule and one paused, as Runs automatically lists them. */
const HABIT_TRIGGERS = WorkflowTriggerSetV1Schema.parse({ automationId: 'qa-l10a-habit', revision: 1, enabled: true, health: 'available',
    target: { kind: 'inline', definition: { version: 1, inputs: [], blocks: [{ kind: 'step', id: 'quiet-check', name: 'QA L10A quiet check',
        document: { text: 'Check quietly', references: [], attachments: [] }, input: [], result: { kind: 'text' } }] } },
    destinations: { targetSessionIds: [], usesOriginSession: false, unresolvedWorkflowRefs: [], leaves: [] },
    triggers: [
        { id: 'nightly', revision: 1, enabled: true, kind: 'schedule', nextRunAt: Date.UTC(2026, 9, 12, 0), createdAt: 1, updatedAt: 1,
            triggerDefinitionEnvelope: null, schedule: { kind: 'cron', everyMs: null, scheduleExpr: '0 2 * * *', timezone: 'Europe/Zurich' } },
        { id: 'weekly', revision: 1, enabled: false, kind: 'schedule', nextRunAt: null, createdAt: 1, updatedAt: 1,
            triggerDefinitionEnvelope: null, schedule: { kind: 'cron', everyMs: null, scheduleExpr: '0 9 * * 1', timezone: 'Europe/Zurich' } },
    ] });

function Habit() {
    const [draft, setDraft] = React.useState(habitDraft);
    const [selectedBlockId, selectBlock] = React.useState<string | null>(null);
    const [view, setView] = React.useState<'steps' | 'flow'>('steps');
    const [target, setTarget] = React.useState<WorkflowAuthoringTarget>({ machineId: HABIT_MACHINE.id, directory: '/tmp' });
    const host = useWorkflowAuthoringHost({ projectTarget: target, serverId: 'home-a' });
    return <WorkflowEditorBody draft={draft} onChange={setDraft} machineName="NLDW4-5-40-40"
        projectTarget={target} projectMachines={[HABIT_MACHINE]} onChangeProjectTarget={setTarget}
        selectedBlockId={selectedBlockId} onSelectBlock={selectBlock} onCustomizeBlock={selectBlock}
        view={view} onChangeView={setView} composerScope={host.composerScope} authoringFacts={host.authoringFacts}
        existingSessions={host.existingSessions}
        description="One manual occurrence into the fresh session." onChangeDescription={() => {}}
        triggersSummary="Every night at 02:00 · 1 more" saveStatus={{ kind: 'saved', savedAtMs: null }}
        triggersSection={<WorkflowTriggerSection testIDPrefix="workflow-editor" set={HABIT_TRIGGERS} draft={EMPTY_WORKFLOW_TRIGGER_DRAFT}
            onChangeDraft={() => {}} status="ready" onRetry={() => {}} stepsUnsaved={false}
            whereTarget={{ machineId: HABIT_MACHINE.id, directory: '/tmp' }} whereSummary="NLDW4-5-40-40 / /tmp" inputs={[]} />}
        menuActions={[{ id: 'export', title: 'Export JSON', onSelect: () => {} }, { id: 'delete', title: 'Delete workflow', destructive: true, onSelect: () => {} }]}
        onEditWithAgent={() => {}} onTestRun={() => {}} onRunNow={() => {}} onSave={() => {}} />;
}

/** DESIGN-13: the lab's "Prepare the 0.3 release" (editor-E1), as a person would author it. */
function releaseDraft() {
    const result = (blockId: string, path: string[] = [], levels = 0) => ({ kind: 'result' as const,
        producer: { blockId, scope: levels ? { kind: 'outer' as const, levels } : { kind: 'current' as const } }, path });
    const doc = (text: string) => ({ text, references: [], attachments: [] });
    const role = (r: string) => ({ engine: { role: r } });
    const draft = createWorkflowEditorDraft({ draftId: 'design13-release', name: 'Prepare the 0.3 release',
        defaults: { agentTarget: HABIT_AGENT_TARGET }, blocks: [
        { kind: 'step', id: 'gather', name: 'Gather changes', input: [{ kind: 'input', name: 'previousTag' }],
            document: doc('List everything merged since the previous tag. Group it by area and link each issue it closes.'),
            result: { kind: 'json', schema: { type: 'object', required: ['issues', 'commits', 'summary'], properties: {
                issues: { type: 'array' }, commits: { type: 'array' }, summary: { type: 'string' } } } } },
        { kind: 'parallel', id: 'lanes', name: 'Side by side', failurePolicy: 'collect_outcomes', branches: [
            { id: 'changelog', name: 'Changelog', blocks: [
                { kind: 'step', id: 'changelog-write', name: 'Write changelog', input: [result('gather', ['summary'], 1)], pauseForReview: true,
                    execution: role('builder'), document: doc('Write the 0.3 changelog from the gathered summary. Lead with what people will notice and link every issue.') },
            ] },
            { id: 'issues', name: 'Issues', blocks: [
                { kind: 'loop', id: 'each-issue', name: 'For each issue', repetition: { kind: 'items', items: result('gather', ['issues'], 1),
                    execution: 'parallel', failurePolicy: 'collect_outcomes', maxConcurrent: 6 }, body: [
                    { kind: 'step', id: 'check-fix', name: 'Check the fix', input: [{ kind: 'item', field: 'value' }], execution: role('reviewer'),
                        document: doc('Confirm this issue is fixed on the release branch. Run its repro if it has one.'),
                        result: { kind: 'json', schema: { type: 'object', required: ['fixed', 'notes'], properties: {
                            fixed: { type: 'boolean' }, notes: { type: 'string' } } } } },
                    { kind: 'if', id: 'not-fixed', name: 'If it is not fixed',
                        when: { kind: 'compare', operator: 'eq', left: result('check-fix', ['fixed']), right: { kind: 'literal', value: false } },
                        then: [{ kind: 'step', id: 'reopen', name: 'Reopen with notes', input: [{ kind: 'item', field: 'value' }, result('check-fix', ['notes'], 1)],
                            document: doc('Reopen this issue and add the check notes as a comment.') }], otherwise: [] },
                ] },
            ] },
            { id: 'tests', name: 'Tests', blocks: [
                { kind: 'action', id: 'run-tests', name: 'Run the release tests', actionId: 'machines.command.run',
                    input: { command: { kind: 'literal', value: 'yarn test:release' } } },
            ] },
        ] },
        { kind: 'workflow', id: 'review-release', name: 'Review the release', workflowRef: 'builtin:review-and-converge', input: {} },
        { kind: 'wait', id: 'approve', name: 'Approve the release', document: doc('Read the changelog and the review, then approve the release.') },
        { kind: 'action', id: 'announce', name: 'Announce it', actionId: 'notifications.notify_me',
            input: { title: { kind: 'literal', value: '0.3 is ready' }, message: result('changelog-write') } },
    ] as never });
    return { ...draft, inputs: [{ name: 'previousTag', valueType: 'string' as const, required: true, description: 'The last released tag, for example v0.2.9' },
        { name: 'channel', valueType: 'string' as const, required: false, default: 'preview', description: 'Where the release is published' }] };
}

function Release() {
    const [draft, setDraft] = React.useState<WorkflowEditorDraft>(releaseDraft);
    const [selectedBlockId, selectBlock] = React.useState<string | null>(null);
    const [view, setView] = React.useState<'steps' | 'flow'>('steps');
    const [target, setTarget] = React.useState<WorkflowAuthoringTarget>({ machineId: HABIT_MACHINE.id, directory: '/home/me/src/happier' });
    const host = useWorkflowAuthoringHost({ projectTarget: target, serverId: 'home-a' });
    return <WorkflowEditorBody draft={draft} onChange={setDraft} machineName="NLDW4-5-40-40"
        projectTarget={target} projectMachines={[HABIT_MACHINE]} onChangeProjectTarget={setTarget}
        selectedBlockId={selectedBlockId} onSelectBlock={selectBlock} onCustomizeBlock={selectBlock}
        view={view} onChangeView={setView} composerScope={host.composerScope} authoringFacts={host.authoringFacts}
        existingSessions={host.existingSessions}
        description="Changelog, issue checks and tests before a release." onChangeDescription={() => {}}
        triggersSummary="Every night at 02:00 · 1 more" saveStatus={{ kind: 'saved', savedAtMs: Date.now() - 120_000 }}
        onEditWithAgent={() => {}} onTestRun={() => {}} onRunNow={() => {}} onSave={() => {}} onExportJson={() => {}} />;
}

function Pristine() {
    const [draft, setDraft] = React.useState(() => createWorkflowEditorDraft({ draftId: 'design13-pristine' }));
    const [selectedBlockId, selectBlock] = React.useState<string | null>(null);
    const [view, setView] = React.useState<'steps' | 'flow'>('steps');
    const [target, setTarget] = React.useState<WorkflowAuthoringTarget | null>(null);
    const host = useWorkflowAuthoringHost({ projectTarget: target, serverId: 'home-a' });
    return <WorkflowEditorBody draft={draft} onChange={setDraft} machineName={null}
        projectTarget={target} projectMachines={[HABIT_MACHINE]} onChangeProjectTarget={setTarget}
        selectedBlockId={selectedBlockId} onSelectBlock={selectBlock} onCustomizeBlock={selectBlock}
        view={view} onChangeView={setView} composerScope={host.composerScope} authoringFacts={host.authoringFacts}
        existingSessions={host.existingSessions} description="" onChangeDescription={() => {}}
        triggersSummary="Manual" saveStatus={{ kind: 'notSaved' }} focusNameOnMount
        onEditWithAgent={() => {}} onRunNow={() => {}} onSave={() => {}} />;
}

function Editor() {
    const [draft, setDraft] = React.useState(() => insertWorkflowEditorBlock(createWorkflowEditorDraft({
        draftId: 'design12-wait', name: 'Release check', blocks: [],
    }), { request: { kind: 'wait' }, list: { kind: 'root' } }).draft);
    const [selectedBlockId, selectBlock] = React.useState<string | null>(null);
    const [view, setView] = React.useState<'steps' | 'flow'>('steps');
    return <WorkflowEditorBody draft={draft} onChange={setDraft} machineName={null}
        selectedBlockId={selectedBlockId} onSelectBlock={selectBlock} onCustomizeBlock={selectBlock}
        view={view} onChangeView={setView} composerScope={{ kind: 'machine', machineId: null }}
        onRunNow={() => {}} onSave={() => {}} />;
}

/** Real editor and workspace owners; only the browser viewport/theme are supplied by the fixture. */
function mount(phone: boolean, theme: 'light' | 'dark', state: 'wait' | 'lost-copy' | 'habit' | 'keep-going' | 'release' | 'pristine' | 'review-builtin' | 'plan') {
    UnistylesRuntime.setAdaptiveThemes(false);
    UnistylesRuntime.setTheme(theme);
    publishAppliedActiveServerSnapshot({ serverId: 'home-a', serverUrl: location.origin, generation: 0 });
    const fidelity = state !== 'wait' && state !== 'lost-copy';
    storage.setState({ profileScope: { serverId: 'home-a', accountId: 'alice' }, isDataReady: true, isSessionDraftsReady: true,
        settings: settingsDefaults, authoringMemory: authoringMemoryDefaults,
        machines: fidelity ? { [HABIT_MACHINE.id]: HABIT_MACHINE } : {},
        machineListByServerId: fidelity ? { 'home-a': [HABIT_MACHINE] } : {},
        ...(fidelity ? { sessions: { [HABIT_SESSION_ID]: HABIT_SESSION } } : {}) });
    createRoot(document.getElementById('root')!).render(<WorkspaceBrowserPresentation><SafeAreaProvider initialMetrics={{
        frame: { x: 0, y: 0, width: window.innerWidth, height: window.innerHeight },
        insets: { top: 0, right: 0, bottom: 0, left: 0 },
    }}><InjectedAuthProvider credentials={null}><AppPaneProvider><WorkspaceProvider enabled={!phone} phone={phone} catalog={catalog}>{navigation => {
        const group = navigation.state.groups[navigation.state.focusedGroupId];
        const tab = navigation.state.tabs[group.activeTabId];
        return <AppShellMaterialFrame showChrome={!phone} dragEnabled={false} leftOffsetPx={0} sidebarWidth={0}
            titleStrip={null} rail={null} column={null} peek={null}>
        <DestinationInstanceHost tabId={tab.id} ref={tab.target} pathname="/workflows/new" focused visible
            phone={phone} navigation={navigation.navigationForTab(tab.id)}>
            <View style={{ flex: 1, height: window.innerHeight }}>{state === 'wait' ? <Editor />
                : state === 'habit' ? <Habit />
                : state === 'release' ? <Release />
                : state === 'pristine' ? <Pristine />
                : state === 'review-builtin' ? <WorkflowBuiltinEditorHostScreen workflow="builtin:review-and-converge" />
                : state === 'keep-going' ? <WorkflowBuiltinEditorHostScreen workflow="builtin:keep-going" />
                : state === 'plan' ? <WorkflowBuiltinEditorHostScreen workflow="builtin:plan-with-a-panel" />
                : <WorkflowEditorHostScreen source={{ kind: 'new', definitionDraftSeedId: 'lost-copy' }} />}</View>
        </DestinationInstanceHost></AppShellMaterialFrame>;
    }}</WorkspaceProvider></AppPaneProvider></InjectedAuthProvider></SafeAreaProvider></WorkspaceBrowserPresentation>);
}

Object.assign(globalThis, { editorHarness: { mount } });
