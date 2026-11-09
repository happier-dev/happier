import { captureActiveServerAccountScopeLifetime } from '@/sync/domains/scope/activeServerAccountScope';
import * as React from 'react';
import { View } from 'react-native';
import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { SelectionListOption } from '@/components/ui/selectionList';
import { standardCleanup } from '@/dev/testkit/cleanup/standardCleanup';
import { createWorkflowRunSummaryFixture } from '@/dev/testkit/fixtures/workflowRunFixtures';
import { createDeferred } from '@/dev/testkit/hooks/createDeferred';
import { renderScreen } from '@/dev/testkit/render/renderScreen';
import { flushHookEffects } from '@/dev/testkit/hooks/flushHookEffects';
import { widgetInstalledPackage, widgetProjectionOf } from '@/dev/testkit/fixtures/pluginWidgetProjectionFixtures';
import { MACHINE_BUILTIN_WIDGET_IDS_V1, PROJECT_BUILTIN_WIDGET_IDS_V1, SESSION_COMPANION_BUILTIN_ITEM_IDS, USAGE_BUILTIN_WIDGET_IDS_V1 } from '@happier-dev/protocol/widgets';
import { waitForHomeGovernance } from '@/dev/testkit/harness/homeGovernanceHarness';
import { ARTIFACT_LIST_PATH, RUN_STORAGE_PATH, boardDefinitionArtifact, boardRunStoragePage, installBoardLibraryTestHarness } from '../boardLibraryTestHarness';

const harness = installBoardLibraryTestHarness();
// Portal/window measurement is the boundary. Each rendered node is not the opener's rectangle;
// a fixed measured desktop frame keeps these Add-flow tests independent of asynchronous layout.
vi.mock('@/components/ui/popover', async importOriginal =>
    (await import('@/dev/testkit/mocks/popover')).createInlinePopoverModuleMock(importOriginal, {
        maxHeight: 624, maxWidth: 960, placement: 'bottom',
    }));
const { AppShellPluginUiProjectionValueProvider } = await import('@/components/appShell/plugins/AppShellPluginUiProjection');
const { SelectionList } = await import('@/components/ui/selectionList');
const { SurfaceStateCard } = await import('@/components/ui/surfaces/SurfaceStateCard');
const { storage } = await import('@/sync/domains/state/storageStore');
const { AddToBoardButton, AddToBoardPopover } = await import('./AddToBoardPopover');
const { t } = await import('@/text');

// The native Markdown package is a rendering boundary this picker never renders.
vi.mock('react-native-enriched-markdown/lib/module/web/streamingReveal.js', () => ({ splitStreamingRevealTextParts: () => [] }));
let serverId: string;
let previousStorage = storage.getState();

const run = createWorkflowRunSummaryFixture({ id: 'run-picker' });
const runPage = await boardRunStoragePage([run]);

function Picker(props: Omit<React.ComponentProps<typeof AddToBoardPopover>, 'anchorRef'>) {
    const anchorRef = React.useRef<View>(null);
    return <><AddToBoardButton anchorRef={anchorRef} open={props.open} onOpenChange={props.onOpenChange} />
        <AddToBoardPopover {...props} anchorRef={anchorRef} /></>;
}

function picker(open = true) {
    return <Picker
        homes={{ activeServerId: serverId, mountedServerIds: [serverId], isHomeMounted: (id) => id === serverId }}
        onBoardKeys={new Set()}
        onAdd={() => {}}
        widgets={{ scope: null, instances: [], addInstance: async () => {} }}
        open={open}
        onOpenChange={() => {}}
    />;
}

function options(screen: Awaited<ReturnType<typeof renderScreen>>): readonly SelectionListOption[] {
    return screen.findByType(SelectionList).props.rootStep.sections.flatMap(
        (section: Readonly<{ options?: readonly SelectionListOption[] }>) => section.options ?? [],
    );
}

beforeEach(async () => {
    previousStorage = storage.getState();
    serverId = await harness.connect('http://board-add.test');
    storage.setState({ profileScope: { serverId, accountId: 'account-a' } });
});

afterEach(async () => {
    standardCleanup();
    (await import('@/components/workflows/library/workflowLibraryReads')).resetWorkflowLibraryReadsForTests();
    (await import('@/sync/domains/scope/activeServerAccountScope')).retireActiveServerAccountScopeLifetime();
    await harness.dispose();
    storage.setState(previousStorage);
});

describe('AddToBoardPopover library recovery', () => {
    it('omits private Session choices while sharing and restores them without altering Board picks', async () => {
        const { buildSessionOrganizationSessionKey } = await import('@/sync/domains/session/organization/keys');
        const { setScreenSharingPrivacyActive } = await import('@/desktop/capture/useNativeRecordingActive');
        const { createSessionListRenderableSessionFixture } = await import('@/dev/testkit/fixtures/sessionFixtures');
        harness.answerDefinitions(serverId, { body: [] });
        harness.home.answer(serverId, RUN_STORAGE_PATH, { body: await boardRunStoragePage([]) });
        const row = createSessionListRenderableSessionFixture({ id: 'private-choice', metadata: { name: 'Secret invoices', path: '/private', host: 'host' } });
        storage.setState({ settings: { ...storage.getState().settings, sessionListHiddenTagIdsWhileRecording: { [serverId]: ['secret'] } },
            sessionOrganizationTagAssignmentsBySessionKey: { [buildSessionOrganizationSessionKey(serverId, row.id)]: { sessionId: row.id, tagIds: ['secret'] } },
            sessionListRowsByServerId: { [serverId]: { [row.id]: row } } });
        const screen = await renderScreen(picker());
        try {
            expect(options(screen).map(option => option.label)).toContain('Secret invoices');
            await act(async () => setScreenSharingPrivacyActive(true));
            expect(options(screen).map(option => option.label)).not.toContain('Secret invoices');
            await act(async () => setScreenSharingPrivacyActive(false));
            expect(options(screen).map(option => option.label)).toContain('Secret invoices');
        } finally { await screen.unmount(); setScreenSharingPrivacyActive(false); }
    });
    it('keeps later Run rows reachable through the existing list pagination control', async () => {
        const later = createWorkflowRunSummaryFixture({ id: 'later-run', ownerAccountId: 'account-a' });
        const first = await boardRunStoragePage([run]);
        const second = await boardRunStoragePage([later]);
        harness.answerDefinitions(serverId, { body: [] });
        harness.home.answer(serverId, RUN_STORAGE_PATH, { select: input => {
            const more = input !== null && typeof input === 'object' && 'request' in input
                && input.request !== null && typeof input.request === 'object' && 'cursor' in input.request;
            return { body: more ? second : { ...first, nextCursor: 'later-page' } };
        } });
        const screen = await renderScreen(picker());
        await waitForHomeGovernance(() => expect(options(screen).some(option => option.id.includes(run.id))).toBe(true));
        expect(options(screen).some(option => option.id.includes(later.id))).toBe(false);
        await act(async () => { screen.findByType(SelectionList).props.pagination?.onEndReached(); });
        await waitForHomeGovernance(() => expect(options(screen).some(option => option.id.includes(later.id))).toBe(true));
        expect(options(screen).some(option => option.id.includes(run.id))).toBe(true);
    });

    it('shows delayed and refused saved-widget inventory in Gallery and recovers on Retry without closed reads', async () => {
        const definitionPath = '/v1/artifacts?limit=500&kind=widget_definition';
        const { createDefaultActionExecutor } = await import('@/sync/ops/actions/defaultActionExecutor');
        expect(await createDefaultActionExecutor().execute('widgets.definition.create', {
            account: { serverId, accountId: 'account-a' }, artifactId: 'board-checks', definition: {
                name: 'Checks on main', body: { kind: 'declarative', document: { version: 1, root: { kind: 'text', text: 'Checks' } } },
                inputs: { fields: [] }, inputSchema: { type: 'object', properties: {}, additionalProperties: false },
                sizeDeclaration: { sizes: ['small'], defaultSize: 'small' },
            },
        }, { serverId, surface: 'ui', authority: 'present_user' })).toMatchObject({ ok: true });
        const recovered = await harness.home.artifacts(serverId).handle(definitionPath);
        if (!recovered) throw new Error('Expected the canonical Artifact list boundary');
        const recoveredInventory: unknown = await recovered.json();
        const pending = createDeferred<void>();
        harness.home.answer(serverId, definitionPath, { status: 403, body: { error: 'forbidden' }, respondAfter: pending.promise });
        harness.answerDefinitions(serverId, { body: [] });
        harness.home.answer(serverId, RUN_STORAGE_PATH, { body: await boardRunStoragePage([]) });
        const button = picker(false);
        const widgets: React.ComponentProps<typeof AddToBoardPopover>['widgets'] = {
            scope: { serverId, accountId: 'account-a', owner: { kind: 'workBoard', boardId: 'board' } },
            instances: [], addInstance: async () => {},
        };
        function Gallery({ open }: { open: boolean }) {
            const [visible, setVisible] = React.useState(open);
            React.useEffect(() => { setVisible(open); }, [open]);
            return React.cloneElement(button, { widgets, open: visible, onOpenChange: setVisible });
        }
        const reads = () => harness.home.requestsFor(definitionPath).length;
        const before = reads();
        const screen = await renderScreen(<Gallery open={false} />);
        try {
            expect(reads()).toBe(before);
            await screen.update(<Gallery open />);
            await act(async () => { screen.findByType(SelectionList).props.onSelect('widgets:gallery'); });
            await waitForHomeGovernance(() => expect(reads()).toBeGreaterThan(before));
            expect(screen.findHostByTestId('board-add.gallery.pending.yours')).not.toBeNull();
            expect(screen.findHostByTestId('board-add.gallery.pending.yours.failed')).toBeNull();
            await act(async () => { screen.changeTextByTestId('board-add.gallery.search', 'Checks on main'); });
            expect(screen.findHostByTestId('board-add.gallery.noMatch')).toBeNull();
            await act(async () => { pending.resolve(); });
            await waitForHomeGovernance(() => expect(screen.findHostByTestId('board-add.gallery.pending.yours.failed')).not.toBeNull());
            expect(screen.findHostByTestId('board-add.gallery.noMatch')).toBeNull();
            harness.home.answer(serverId, definitionPath, { body: recoveredInventory });
            await screen.pressByTestIdAsync('board-add.gallery.pending.yours.retry');
            await waitForHomeGovernance(() => expect(screen.getTextContent()).toContain('Checks on main'));
            expect(reads()).toBeGreaterThan(before + 1);
            expect(screen.findHostByTestId('board-add.gallery.pending.yours')).toBeNull();
        } finally { pending.resolve(); await screen.unmount(); }
    });

    it('says which groups are loading and settles each independently', async () => {
        const definitions = createDeferred<void>();
        const runs = createDeferred<void>();
        const sessions = createDeferred<void>();
        // Keep bootstrap's real Session reads in flight instead of letting an
        // unanswered HTTP fixture replace this case's loading observation with error.
        for (const path of ['/v2/sessions', '/v2/sessions/active']) harness.home.answer(serverId, path, {
            body: { sessions: [], nextCursor: null, hasNext: false }, respondAfter: sessions.promise,
        });
        harness.answerDefinitions(serverId, { body: [], respondAfter: definitions.promise });
        harness.home.answer(serverId, RUN_STORAGE_PATH, { body: await boardRunStoragePage([]), respondAfter: runs.promise });
        // This case holds the other three readers; the Machine census has already answered.
        storage.setState({ machineListByServerId: { [serverId]: [] }, machineListStatusByServerId: { [serverId]: 'idle' },
            concurrentSessionListCacheByServerId: { [serverId]: {
            serverName: null, listObservation: { phase: 'loading', lastSuccessAt: null },
        } } });
        try {
            const screen = await renderScreen(picker());
            // One loading line names every group still opening; it narrows as each settles.
            const loading = () => screen.findAllByType(SurfaceStateCard).filter(node => node.props.kind === 'loading')
                .map(node => `${node.props.testID}: ${node.props.title}`);
            expect(loading()).toEqual(['board-add.loading: Opening Sessions, Workflows, and Runs']);
            definitions.resolve();
            await waitForHomeGovernance(() => expect(loading()).toEqual(['board-add.loading: Opening Sessions and Runs']));
            await act(async () => storage.setState({ concurrentSessionListCacheByServerId: { [serverId]: {
                serverName: null, listObservation: { phase: 'ready', lastSuccessAt: 1 },
            } } }));
            expect(loading()).toEqual(['board-add.loading: Opening Runs']);
            runs.resolve();
            await waitForHomeGovernance(() => expect(loading()).toEqual([]));
        } finally { definitions.resolve(); runs.resolve(); sessions.resolve(); }
    });
    it('updates a Machine option from the exact Home request reachability without changing its presence row', async () => {
        const { createMachineFixture } = await import('@/dev/testkit/fixtures/machineFixtures');
        const { recordMachineRequestFailed, clearMachineRequestReachabilityForTest } = await import('@/sync/domains/machines/reachability/machineReachability');
        const { describeMachinePresenceLine } = await import('@/utils/sessions/machinePresenceLine');
        const machine = createMachineFixture({ id: 'board-option-machine', active: true, activeAt: Date.now() });
        storage.setState({ machineListByServerId: { [serverId]: [machine] } });
        harness.answerDefinitions(serverId, { body: [] });
        harness.home.answer(serverId, RUN_STORAGE_PATH, { body: await boardRunStoragePage([]) });
        const screen = await renderScreen(picker());
        const id = JSON.stringify(['machine', serverId, machine.id]);
        await waitForHomeGovernance(() => expect(options(screen).find(option => option.id === id)?.subtitle)
            .toBe(describeMachinePresenceLine(machine, undefined, undefined, { serverId, accountId: 'account-a' }).label));
        try {
            await act(async () => recordMachineRequestFailed({ serverId, accountId: 'account-a', machineId: machine.id }));
            expect(options(screen).find(option => option.id === id)?.subtitle)
                .toBe(describeMachinePresenceLine(machine, undefined, undefined, { serverId, accountId: 'account-a' }).label);
        } finally { clearMachineRequestReachabilityForTest(); }
    });
    it('leads with a short Widgets group and reaches the built-in families through Gallery and search (lab dashboards L1)', async () => {
        harness.answerDefinitions(serverId, { body: [] });
        harness.home.answer(serverId, RUN_STORAGE_PATH, { body: await boardRunStoragePage([]) });
        const projection = widgetProjectionOf([{ pluginId: 'acme.widgets', localId: 'counter', target: 'app', title: 'Counter' }],
            { 'acme.widgets': widgetInstalledPackage('acme.widgets', 'Widgets') });
        const screen = await renderScreen(
            <AppShellPluginUiProjectionValueProvider value={{ pluginUiProjection: projection, pluginBrowserProjection: null, phase: 'current',
                interactionEnabled: true, machineId: 'machine', serverId, platform: 'web',
                accountLifetime: captureActiveServerAccountScopeLifetime(), clientExecutableActivation: { status: 'ready' }, reloadClientExecutables: () => {}, reloadConnectedAccountProjection: () => {} }}>
                {picker()}
            </AppShellPluginUiProjectionValueProvider>,
        );
        await flushHookEffects({ cycles: 4 });
        const sections = screen.findByType(SelectionList).props.rootStep.sections as readonly Readonly<{
            id: string; kind: string; options?: readonly SelectionListOption[];
            visibleWhen?: (input: string) => boolean;
            resolve?: (seed: string, signal: AbortSignal) => Promise<Readonly<{ options: readonly SelectionListOption[] }>>;
        }>[];
        // Widgets lead, then the work the empty board promises.
        expect(sections.map(section => section.id).slice(0, 3)).toEqual(['widgets', 'widgets-more', 'sessions']);
        const lead = sections[0]!.options!.map(option => option.id);
        expect(lead).toContain('widget:plugin-acme.widgets/counter');
        expect(lead.at(-1)).toBe('widgets:gallery');
        // Machines, Usage, Project and Session-companion widgets are families: one row away through Gallery, never the lead.
        const families = [...MACHINE_BUILTIN_WIDGET_IDS_V1, ...USAGE_BUILTIN_WIDGET_IDS_V1, ...PROJECT_BUILTIN_WIDGET_IDS_V1,
            ...SESSION_COMPANION_BUILTIN_ITEM_IDS];
        expect(lead.filter(id => families.some(family => id.endsWith(family)))).toEqual([]);
        // Typing still finds every widget in this one search.
        const more = sections[1]!;
        expect(more.visibleWhen?.('')).toBe(false);
        expect(more.visibleWhen?.('vit')).toBe(true);
        const found = (await more.resolve!('vit', new AbortController().signal)).options.map(option => option.id);
        expect(found.some(id => id.endsWith('machine_vitals'))).toBe(true);
        const companion = (await more.resolve!('session summary', new AbortController().signal)).options.map(option => option.id);
        expect(companion.some(id => id.endsWith('session_summary'))).toBe(true);
        expect(found).not.toContain('widget:plugin-acme.widgets/counter');
    });
    it.each(['refused', 'pending'] as const)('opens a picked widget in the shared Add surface and shows a %s Add there without adding twice', async kind => {
        harness.answerDefinitions(serverId, { body: [] });
        harness.home.answer(serverId, RUN_STORAGE_PATH, { body: await boardRunStoragePage([]) });
        const projection = widgetProjectionOf([{ pluginId: 'acme.widgets', localId: 'counter', target: 'app', title: 'Counter' }],
            { 'acme.widgets': widgetInstalledPackage('acme.widgets', 'Widgets') });
        const addInstance = vi.fn(async () => kind === 'pending' ? { ok: true as const, approvalPending: true as const }
            : { ok: false as const, message: 'permission_denied' });
        const button = picker();
        const widgets = { scope: null, instances: [], addInstance };
        function QuickWidgetPicker() {
            const [open, setOpen] = React.useState(true);
            return React.cloneElement(button, { widgets, open, onOpenChange: setOpen });
        }
        const screen = await renderScreen(
            <AppShellPluginUiProjectionValueProvider value={{ pluginUiProjection: projection, pluginBrowserProjection: null, phase: 'current',
                interactionEnabled: true, machineId: 'machine', serverId, platform: 'web',
                accountLifetime: captureActiveServerAccountScopeLifetime(), clientExecutableActivation: { status: 'ready' }, reloadClientExecutables: () => {}, reloadConnectedAccountProjection: () => {} }}>
                <QuickWidgetPicker />
            </AppShellPluginUiProjectionValueProvider>,
        );
        await flushHookEffects({ cycles: 4 });
        expect(options(screen)).toContainEqual(expect.objectContaining({ id: 'widget:plugin-acme.widgets/counter' }));
        await act(async () => { screen.findByType(SelectionList).props.onSelect('widget:plugin-acme.widgets/counter'); });
        await flushHookEffects({ cycles: 4 });
        // Picking is the preview, never the add.
        expect(addInstance).not.toHaveBeenCalled();
        await screen.pressByTestIdAsync('board-add.gallery.detail.submit');
        await flushHookEffects({ cycles: 4 });
        expect(addInstance).toHaveBeenCalledTimes(1);
        // In place: on the pane's reserved line, and on the widget's row once back in the list.
        expect(screen.findByTestId('board-add.gallery.detail.why')!.props.children).toBe(kind === 'pending' ? t('widgetAdd.areaApprovalPending') : 'permission_denied');
        if (screen.findByTestId('board-add.gallery.detail.back')) await act(async () => { screen.pressByTestId('board-add.gallery.detail.back'); });
        expect(screen.findAllByTestId(`board-add.gallery.entry.plugin-acme.widgets/counter.${kind === 'pending' ? 'pending' : 'failed'}`).length).toBeGreaterThan(0);
        expect(screen.getTextContent()).not.toContain('widgetAdd.justAdded');
    });
    it.each([false, true])('adds a picked widget once its required input is filled, keeping approval pending in place (⌘↵ places it: %s)', async place => {
        harness.answerDefinitions(serverId, { body: [] });
        harness.home.answer(serverId, RUN_STORAGE_PATH, { body: await boardRunStoragePage([]) });
        const projection = widgetProjectionOf([{ pluginId: 'acme.widgets', localId: 'filtered', target: 'app', title: 'Filtered',
            inputs: { fields: [{ path: 'filter', title: 'Filter', widget: 'text', required: true }] },
            inputSchema: { type: 'object', properties: { filter: { type: 'string', minLength: 1 } },
                required: ['filter'], additionalProperties: false },
        }], { 'acme.widgets': widgetInstalledPackage('acme.widgets', 'Widgets') });
        // The Board's injected writer is the acknowledgement boundary; the setup/parser path stays real.
        const addInstance = vi.fn(async () => ({ ok: true as const, approvalPending: true as const }));
        const button = picker();
        const widgets = { scope: null, instances: [], addInstance };
        function QuickWidgetPicker() {
            const [open, setOpen] = React.useState(true);
            return React.cloneElement(button, { widgets, open, onOpenChange: setOpen });
        }
        const screen = await renderScreen(
            <AppShellPluginUiProjectionValueProvider value={{ pluginUiProjection: projection, pluginBrowserProjection: null, phase: 'current',
                interactionEnabled: true, machineId: 'machine', serverId, platform: 'web',
                accountLifetime: captureActiveServerAccountScopeLifetime(), clientExecutableActivation: { status: 'ready' }, reloadClientExecutables: () => {}, reloadConnectedAccountProjection: () => {} }}>
                <QuickWidgetPicker />
            </AppShellPluginUiProjectionValueProvider>,
        );
        await act(async () => { screen.findByType(SelectionList).props[place ? 'onCommandSelect' : 'onSelect']('widget:plugin-acme.widgets/filtered'); });
        await flushHookEffects({ cycles: 4 });
        expect(screen.findByTestId('board-add.gallery.detail.submit')!.props.disabled).toBe(true);
        expect(addInstance).not.toHaveBeenCalled();
        await act(async () => { screen.changeTextByTestId('board-add.gallery.detail.field.filter.input', 'open'); });
        expect(screen.findByTestId('board-add.gallery.detail.submit')!.props.disabled).toBe(false);
        await screen.pressByTestIdAsync('board-add.gallery.detail.submit');
        await flushHookEffects({ cycles: 4 });
        expect(addInstance).toHaveBeenCalledTimes(1);
        expect(addInstance).toHaveBeenCalledWith(expect.objectContaining({ bindings: { filter: { kind: 'value', value: 'open' } } }), { place });
        expect(screen.findByTestId('board-add.gallery.detail.why')!.props.children).toBe(t('widgetAdd.areaApprovalPending'));
        if (screen.findByTestId('board-add.gallery.detail.back')) await act(async () => { screen.pressByTestId('board-add.gallery.detail.back'); });
        expect(screen.findAllHostsByTestId('board-add.gallery.entry.plugin-acme.widgets/filtered.pending').length).toBeGreaterThan(0);
    });
    it('does not read while closed and offers independent Retry actions after initial failures', async () => {
        harness.answerDefinitions(serverId, { dispatchThenFail: true });
        harness.home.answer(serverId, RUN_STORAGE_PATH, { dispatchThenFail: true });
        const before = harness.home.requests.length;
        const screen = await renderScreen(picker(false));
        expect(harness.home.requests.slice(before).filter(request => request.path === ARTIFACT_LIST_PATH || request.path === RUN_STORAGE_PATH)).toEqual([]);
        await screen.update(picker());
        await waitForHomeGovernance(() => {
            expect(screen.findHostByTestId('board-add.workflows-failure')).not.toBeNull();
            expect(screen.findHostByTestId('board-add.runs-failure')).not.toBeNull();
        });

        harness.answerDefinitions(serverId, { body: [boardDefinitionArtifact('recovered', 'Workflow recovered')] });
        harness.home.answer(serverId, RUN_STORAGE_PATH, { body: runPage });
        await screen.pressByTestIdAsync('board-add.workflows-failure.retry');
        await waitForHomeGovernance(() => expect(options(screen).some((option) => option.label === 'Workflow recovered')).toBe(true));
        expect(screen.findHostByTestId('board-add.runs-failure')).not.toBeNull();
        await screen.pressByTestIdAsync('board-add.runs-failure.retry');
        await waitForHomeGovernance(() => expect(options(screen).some((option) => option.id.includes('run-picker'))).toBe(true));
        expect(screen.findHostByTestId('board-add.workflows-failure')).toBeNull();
        expect(screen.findHostByTestId('board-add.runs-failure')).toBeNull();
        expect(options(screen).some((option) => option.id === 'widgets:gallery')).toBe(true);
    });

    it('keeps hydrated definition and run choices selectable when refresh and Retry are unavailable', async () => {
        harness.answerDefinitions(serverId, { body: [boardDefinitionArtifact('known', 'Workflow known')] });
        harness.home.answer(serverId, RUN_STORAGE_PATH, { body: runPage });
        const initial = await renderScreen(picker());
        await waitForHomeGovernance(() => expect(options(initial).filter(option => option.label === 'Workflow known' || option.id.includes('run-picker'))).toHaveLength(2));
        await initial.unmount();

        harness.answerDefinitions(serverId, { dispatchThenFail: true });
        harness.home.answer(serverId, RUN_STORAGE_PATH, { dispatchThenFail: true });
        const screen = await renderScreen(picker());
        await waitForHomeGovernance(() => {
            expect(screen.findHostByTestId('board-add.workflows-failure')).not.toBeNull();
            expect(screen.findHostByTestId('board-add.runs-failure')).not.toBeNull();
        });
        const knownOptions = () => options(screen).filter((option) => option.label === 'Workflow known' || option.id.includes('run-picker'));
        expect(knownOptions()).toHaveLength(2);
        expect(knownOptions().every((option) => !option.disabled)).toBe(true);

        const pending = createDeferred<void>();
        const beforeRetry = harness.home.requests.length;
        harness.answerDefinitions(serverId, { respondAfter: pending.promise, dispatchThenFail: true });
        harness.home.answer(serverId, RUN_STORAGE_PATH, { respondAfter: pending.promise, dispatchThenFail: true });
        await screen.pressByTestIdAsync('board-add.workflows-failure.retry');
        await screen.pressByTestIdAsync('board-add.runs-failure.retry');
        await waitForHomeGovernance(async () => {
            await act(async () => {});
            expect(harness.home.requests.slice(beforeRetry).map(request => request.path))
                .toEqual(expect.arrayContaining([ARTIFACT_LIST_PATH, RUN_STORAGE_PATH]));
        });
        expect(knownOptions()).toHaveLength(2);
        expect(knownOptions().every(option => !option.disabled)).toBe(true);
        await act(async () => { pending.resolve(); await pending.promise; });
        expect(knownOptions()).toHaveLength(2);
        expect(knownOptions().every(option => !option.disabled)).toBe(true);
        await waitForHomeGovernance(() => {
            expect(screen.findHostByTestId('board-add.workflows-failure')).not.toBeNull();
            expect(screen.findHostByTestId('board-add.runs-failure')).not.toBeNull();
        });
    });
});
