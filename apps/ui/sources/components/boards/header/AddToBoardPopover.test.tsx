import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { SelectionListOption } from '@/components/ui/selectionList';
import { standardCleanup } from '@/dev/testkit/cleanup/standardCleanup';
import { createWorkflowRunSummaryFixture } from '@/dev/testkit/fixtures/workflowRunFixtures';
import { createDeferred } from '@/dev/testkit/hooks/createDeferred';
import { renderScreen } from '@/dev/testkit/render/renderScreen';
import { flushHookEffects } from '@/dev/testkit/hooks/flushHookEffects';
import { widgetInstalledPackage, widgetProjectionOf } from '@/dev/testkit/fixtures/pluginWidgetProjectionFixtures';
import { waitForHomeGovernance } from '@/dev/testkit/harness/homeGovernanceHarness';
import { ARTIFACT_LIST_PATH, RUN_STORAGE_PATH, boardDefinitionArtifact, boardRunStoragePage, installBoardLibraryTestHarness } from '../boardLibraryTestHarness';

const harness = installBoardLibraryTestHarness();
const { AppShellPluginUiProjectionValueProvider } = await import('@/components/appShell/plugins/AppShellPluginUiProjection');
const { SelectionList } = await import('@/components/ui/selectionList');
const { storage } = await import('@/sync/domains/state/storageStore');
const { AddToBoardButton } = await import('./AddToBoardPopover');

// The native Markdown package is a rendering boundary this picker never renders.
vi.mock('react-native-enriched-markdown/lib/module/web/streamingReveal.js', () => ({ splitStreamingRevealTextParts: () => [] }));
let serverId: string;
let previousStorage = storage.getState();

const run = createWorkflowRunSummaryFixture({ id: 'run-picker' });
const runPage = await boardRunStoragePage([run]);

function picker(open = true) {
    return <AddToBoardButton
        board={{ id: 'board-picker', name: 'Picker', source: { picked: [] }, mode: 'canvas', snap: true,
            positionsByItemRef: {}, pinnedInSessions: false }}
        homes={{ activeServerId: serverId, mountedServerIds: [serverId], isHomeMounted: (id) => id === serverId }}
        onBoardKeys={new Set()}
        onAdd={() => {}}
        widgets={{ scope: null, instances: [], addInstance: async () => {} }}
        open={open}
        onOpenChange={() => {}}
    />;
}

// The renderer has no browser/native layout engine. Supply the physical anchor measurement only.
const layout = { createNodeMock: () => ({
    getBoundingClientRect: () => ({ x: 100, y: 50, left: 100, top: 50, right: 180, bottom: 82, width: 80, height: 32 }),
    measureInWindow: (done: (x: number, y: number, width: number, height: number) => void) => done(100, 50, 80, 32),
}) };

function options(screen: Awaited<ReturnType<typeof renderScreen>>): readonly SelectionListOption[] {
    return screen.findByType(SelectionList).props.rootStep.sections.flatMap(
        (section: Readonly<{ options: readonly SelectionListOption[] }>) => section.options,
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

describe('AddToBoardButton library recovery', () => {
    it.each(['refused', 'pending'] as const)('preserves the quick widget add %s result in the shared Gallery without adding twice', async kind => {
        harness.home.answer(serverId, ARTIFACT_LIST_PATH, { body: [] });
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
                clientExecutableActivation: { status: 'ready' }, reloadClientExecutables: () => {}, reloadConnectedAccountProjection: () => {} }}>
                <QuickWidgetPicker />
            </AppShellPluginUiProjectionValueProvider>, layout,
        );
        await flushHookEffects({ cycles: 4 });
        await act(async () => { screen.findByType(SelectionList).props.onSelect('widget:plugin-acme.widgets/counter'); });
        await flushHookEffects({ cycles: 4 });
        expect(addInstance).toHaveBeenCalledTimes(1);
        expect(screen.findAllByTestId(`board-add.gallery.entry.plugin-acme.widgets/counter.${kind === 'pending' ? 'pending' : 'failed'}`).length).toBeGreaterThan(0);
        expect(screen.getTextContent()).not.toContain('widgetAdd.justAdded');
    });
    it('preserves approval pending after the quick widget required-input setup without submitting twice', async () => {
        harness.home.answer(serverId, ARTIFACT_LIST_PATH, { body: [] });
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
                clientExecutableActivation: { status: 'ready' }, reloadClientExecutables: () => {}, reloadConnectedAccountProjection: () => {} }}>
                <QuickWidgetPicker />
            </AppShellPluginUiProjectionValueProvider>, layout,
        );
        await act(async () => { screen.findByType(SelectionList).props.onSelect('widget:plugin-acme.widgets/filtered'); });
        expect(screen.findByTestId('board-add.setup.submit')!.props.disabled).toBe(true);
        expect(addInstance).not.toHaveBeenCalled();
        await act(async () => { screen.changeTextByTestId('board-add.setup.field.filter.input', 'open'); });
        expect(screen.findByTestId('board-add.setup.submit')!.props.disabled).toBe(false);
        await screen.pressByTestIdAsync('board-add.setup.submit');
        await flushHookEffects({ cycles: 4 });
        expect(addInstance).toHaveBeenCalledTimes(1);
        expect(addInstance).toHaveBeenCalledWith(expect.objectContaining({ bindings: { filter: { kind: 'value', value: 'open' } } }), { place: false });
        expect(screen.findAllHostsByTestId('board-add.gallery.entry.plugin-acme.widgets/filtered.pending').length).toBeGreaterThan(0);
    });
    it('does not read while closed and offers independent Retry actions after initial failures', async () => {
        harness.home.answer(serverId, ARTIFACT_LIST_PATH, { dispatchThenFail: true });
        harness.home.answer(serverId, RUN_STORAGE_PATH, { dispatchThenFail: true });
        const before = harness.home.requests.length;
        const screen = await renderScreen(picker(false), layout);
        expect(harness.home.requests.slice(before).filter(request => request.path === ARTIFACT_LIST_PATH || request.path === RUN_STORAGE_PATH)).toEqual([]);
        await screen.update(picker());
        await waitForHomeGovernance(() => {
            expect(screen.findHostByTestId('board-add.workflows-failure')).not.toBeNull();
            expect(screen.findHostByTestId('board-add.runs-failure')).not.toBeNull();
        });

        harness.home.answer(serverId, ARTIFACT_LIST_PATH, { body: [boardDefinitionArtifact('recovered', 'Workflow recovered')] });
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
        harness.home.answer(serverId, ARTIFACT_LIST_PATH, { body: [boardDefinitionArtifact('known', 'Workflow known')] });
        harness.home.answer(serverId, RUN_STORAGE_PATH, { body: runPage });
        const initial = await renderScreen(picker(), layout);
        await waitForHomeGovernance(() => expect(options(initial).filter(option => option.label === 'Workflow known' || option.id.includes('run-picker'))).toHaveLength(2));
        await initial.unmount();

        harness.home.answer(serverId, ARTIFACT_LIST_PATH, { dispatchThenFail: true });
        harness.home.answer(serverId, RUN_STORAGE_PATH, { dispatchThenFail: true });
        const screen = await renderScreen(picker(), layout);
        await waitForHomeGovernance(() => {
            expect(screen.findHostByTestId('board-add.workflows-failure')).not.toBeNull();
            expect(screen.findHostByTestId('board-add.runs-failure')).not.toBeNull();
        });
        const knownOptions = () => options(screen).filter((option) => option.label === 'Workflow known' || option.id.includes('run-picker'));
        expect(knownOptions()).toHaveLength(2);
        expect(knownOptions().every((option) => !option.disabled)).toBe(true);

        const pending = createDeferred<void>();
        const beforeRetry = harness.home.requests.length;
        harness.home.answer(serverId, ARTIFACT_LIST_PATH, { respondAfter: pending.promise, dispatchThenFail: true });
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
