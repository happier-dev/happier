import * as React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react-test-renderer';
import * as Unistyles from 'react-native-unistyles';
import { HappierInputField, WidgetSizePicker } from '@happier-dev/plugin-ui/presentation';
import { composeWidgetGroupContextV1, createWidgetSurfaceArtifactPortV1, instantiateWidgetLayoutFragmentGroupV1, resolveConfiguredWidgetInputs, type WidgetLayoutFragmentSummaryV1, type WidgetSizeV1, type WidgetSurfaceRefV1 } from '@happier-dev/protocol/widgets';
import { createWorkBoardArtifactBoundary } from '../../../../../../packages/protocol/src/boards/workBoardArtifactV1.testkit';

import { flushHookEffects, renderScreen, standardCleanup } from '@/dev/testkit';
import type { WidgetSurfaceContext } from '@/components/widgets/surface/widgetSurfaceSetup';
import type { WidgetCandidate } from '@/components/widgets/widgetCatalog';


import type { WidgetAddAsk, WidgetAddEntry, WidgetAddSection } from './widgetAddModel';
import type { WidgetSetupDraft, WidgetSetupSubmitResult } from './widgetSetupModel';
import { createHomeGovernanceHarness, installHomeGovernanceBoundaries } from '@/dev/testkit/harness/homeGovernanceHarness';
import { installDisconnectedServerSocketBoundary, restoreServerAccountForTest } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { installSessionActionFixture } from '@/dev/testkit/harness/sessionActionRpcBoundary';
import { installRealActionExecutorModuleLoader } from '@/dev/testkit/harness/actionHomesHttpHarness';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';
import { SessionCurrentProjectionRecordV1Schema } from '@happier-dev/protocol/sessions/listing/response';
import { createSessionListSourceFixture } from '@/dev/testkit/harness/sessionReadBatchHttpBoundary';
import { SessionViewerProjectionV1Schema } from '@happier-dev/protocol/sessions/personal/viewer';
import { createPlainAccountEncryptionCurrentnessFixture } from '@/dev/testkit/fixtures/accountEncryptionCurrentness';
import { darkTheme, lightTheme } from '@/theme';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const accessibilityBoundary = vi.hoisted(() => ({ os: 'web', announce: vi.fn() }));
// The field's choices float in the host's Popover; render it in place so the real rows are driven.
vi.mock('@/components/ui/popover/Popover', async (importOriginal) =>
    (await import('@/dev/testkit/mocks/popover')).createInlinePopoverModuleMock(importOriginal as never) as never);
vi.mock('react-native', async () => (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock({
    Platform: { get OS() { return accessibilityBoundary.os; } },
    AccessibilityInfo: { announceForAccessibility: accessibilityBoundary.announce },
}));
vi.mock('react-native-unistyles', async () => (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock());
vi.mock('@/text', async () => (await import('@/dev/testkit/mocks/text')).createTextModuleMock());
// The menu's portal and window measurement are the boundary; its rows and selection stay real.
vi.mock('@/components/ui/popover', async (importOriginal) =>
    (await import('@/dev/testkit/mocks/popover')).createInlinePopoverModuleMock(importOriginal));

vi.mock('socket.io-client', async importOriginal =>
    (await import('@/dev/testkit/harness/serverAccountConnectionHarness')).createSocketIoClientBoundary(importOriginal));
installDisconnectedServerSocketBoundary();
const homes = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(homes);
await loadSyncSingletonForTests();
const { DropdownMenu } = await import('@/components/ui/forms/dropdown/DropdownMenu');
const { buildWidgetCandidateSetup } = await import('@/components/widgets/surface/widgetSurfaceSetup');
const { selectBuiltinWidgetCandidates } = await import('@/components/widgets/widgetCatalog');
const { buildHomeWidgetAddSections } = await import('./HomeWidgetAddPopover');
const { buildBoardWidgetAddContent, buildCompanionWidgetAddSections } = await import('./widgetAddSections');
const { WidgetAddPanel } = await import('./WidgetAddSurface');
const { AppShellPluginUiProjectionProvider } = await import('@/components/appShell/plugins/AppShellPluginUiProjection');
const { buildAccountWidgetAddSections } = await import('./accountWidgetAddSections');
const { storage } = await import('@/sync/domains/state/storage');
let connection: Awaited<ReturnType<typeof restoreServerAccountForTest>> | undefined;
let releaseLoader: (() => void) | undefined;

afterEach(async () => {
    standardCleanup(); releaseLoader?.(); releaseLoader = undefined; await connection?.dispose(); connection = undefined;
    accessibilityBoundary.os = 'web'; accessibilityBoundary.announce.mockClear();
});

const HOME: WidgetSurfaceRefV1 = { serverId: 'home', accountId: 'me', owner: { kind: 'home' } };
const THIS_SESSION: WidgetSurfaceContext = { session: { ref: { serverId: 'home', sessionId: 'A' }, label: 'Retry relay handshake' } };

const SIGNUPS: WidgetCandidate = {
    surface: { pluginId: 'acme.analytics', localId: 'signups' }, key: 'acme.analytics/signups', title: 'Signups this week',
    description: 'New people per day', pluginName: 'Analytics', sharedPluginName: false, icon: 'chart-bar',
    homeDefault: 'available', target: 'app', sizeDeclaration: { sizes: ['small', 'wide'], defaultSize: 'wide' },
};
const SUMMARY: WidgetCandidate = {
    surface: { pluginId: 'happier.sessions', localId: 'summary' }, key: 'happier.sessions/summary', title: 'Summary',
    pluginName: 'Sessions', sharedPluginName: false, icon: 'chat-circle', homeDefault: 'available', target: 'session',
    sessionInputPath: 'session', sizeDeclaration: { sizes: ['small', 'medium', 'wide', 'full', 'tall', 'large'], defaultSize: 'medium' },
    inputs: { fields: [{ path: 'session', title: 'Session', widget: 'json', required: true }] },
};

type Recorder = Readonly<{ previews: string[]; submits: Array<Readonly<{ id: string; draft: WidgetSetupDraft }>> }>;

function widgetEntry(candidate: WidgetCandidate, recorder: Recorder, options: Readonly<{
    context?: WidgetSurfaceContext;
    result?: () => WidgetSetupSubmitResult;
    count?: string;
    scope?: WidgetSurfaceRefV1;
}> = {}): WidgetAddEntry {
    const id = candidate.key;
    return {
        id,
        title: candidate.title,
        subtitle: candidate.description ?? candidate.pluginName,
        icon: candidate.icon,
        ...(options.count ? { count: options.count } : {}),
        setup: () => buildWidgetCandidateSetup({
            candidate, context: options.context ?? {}, audience: 'personal', scope: options.scope ?? HOME,
            mode: { kind: 'add', submitLabel: 'Add to Home' },
            submit: async (draft) => { recorder.submits.push({ id, draft }); return options.result?.() ?? { ok: true }; },
            renderPreview: () => { recorder.previews.push(id); return `preview:${id}`; },
        }),
    };
}

async function renderPanel(props: Readonly<{
    sections: readonly WidgetAddSection[];
    serverId?: string;
    composition?: 'split' | 'push';
    ask?: WidgetAddAsk;
    initialEntryId?: string;
    pendingSections?: readonly Readonly<{ id: string; title: string; retry?: () => void }>[];
    onRequestClose?: () => void;
}>, options: Parameters<typeof renderScreen>[1] = {}) {
    const screen = await renderScreen(
        <WidgetAddPanel
            testID="add"
            title="Add to Home"
            hint="Only you see your Home"
            searchPlaceholder="Search widgets"
            addLabel="Add to Home"
            composition={props.composition ?? 'split'}
            sections={props.sections}
            {...(props.pendingSections ? { pendingSections: props.pendingSections } : {})}
            {...(props.ask ? { ask: props.ask } : {})}
            {...(props.initialEntryId ? { initialEntryId: props.initialEntryId } : {})}
            {...(props.serverId ? { serverId: props.serverId } : {})}
            onRequestClose={props.onRequestClose ?? (() => {})}
        />,
        options,
    );
    await flushHookEffects({ cycles: 2 });
    return screen;
}

const recorder = (): Recorder => ({ previews: [], submits: [] });

describe('WidgetAddSurface', () => {
    it('delivers native search-arrow selection changes through the platform announcement boundary', async () => {
        accessibilityBoundary.os = 'ios';
        const rec = recorder();
        const screen = await renderPanel({ sections: [{ id: 'all', title: 'All', entries: [widgetEntry(SIGNUPS, rec), widgetEntry(SUMMARY, rec)] }] });
        expect(accessibilityBoundary.announce).not.toHaveBeenCalled();
        await act(async () => screen.findByTestId('add.search')!.props.onKeyPress({ nativeEvent: { key: 'ArrowDown' }, preventDefault: () => {} }));
        await flushHookEffects({ cycles: 2 });
        expect(accessibilityBoundary.announce).toHaveBeenLastCalledWith('Signups this week, New people per day');
        await act(async () => screen.findByTestId('add.search')!.props.onKeyPress({ nativeEvent: { key: 'Enter' }, preventDefault: () => {} }));
        await flushHookEffects({ cycles: 3 });
        expect(accessibilityBoundary.announce).toHaveBeenLastCalledWith('widgetAdd.justAdded(widget=Signups this week)');
        await act(async () => screen.findByTestId('add.search')!.props.onKeyPress({ nativeEvent: { key: 'ArrowDown' }, preventDefault: () => {} }));
        await flushHookEffects({ cycles: 2 });
        expect(accessibilityBoundary.announce).toHaveBeenLastCalledWith('Summary, Sessions');
        expect(rec.submits.map(submit => submit.id)).toEqual([SIGNUPS.key]);
    });

    it('delivers Android search-arrow selection through the mounted polite live region', async () => {
        accessibilityBoundary.os = 'android';
        const rec = recorder();
        const screen = await renderPanel({ sections: [{ id: 'all', title: 'All', entries: [widgetEntry(SIGNUPS, rec)] }] });
        const status = () => screen.findByTestId('add.selectionStatus')!;
        expect(status().props.accessibilityLiveRegion).toBe('polite');
        expect(status().props.children.props.children).toBe('');
        await act(async () => screen.findByTestId('add.search')!.props.onKeyPress({ nativeEvent: { key: 'ArrowDown' }, preventDefault: () => {} }));
        await flushHookEffects({ cycles: 2 });
        expect(status().props.children.props.children).toBe('Signups this week, New people per day');
        expect(accessibilityBoundary.announce).not.toHaveBeenCalled();
        expect(rec.submits).toEqual([]);
    });

    it('clears an optional saved-group pin in preview and persists the same empty context atomically without changing the saved fragment', async () => {
        const scope: WidgetSurfaceRefV1 = { ...HOME, owner: { kind: 'corePage', pageId: 'example', area: 'main' } };
        const descriptor = { inputs: { fields: [{ path: 'amount', title: 'Amount', widget: 'number' as const }] },
            inputSchema: { type: 'object' as const, properties: { amount: { type: 'number' as const } }, additionalProperties: false } };
        const fragment: WidgetLayoutFragmentSummaryV1 = { artifactId: 'saved', name: 'Optional amounts', childCount: 1,
            ...descriptor, group: { width: 'full', frameStyle: 'card', dividers: 'hairline',
                context: { amount: { kind: 'value', value: 42 } }, children: [{ kind: 'widget',
                    instance: { v: 1, definition: { kind: 'builtin', id: 'amounts' }, bindings: { amount: { kind: 'context', slot: 'amount' } } } }] } };
        const original = structuredClone(fragment);
        const boundary = createWorkBoardArtifactBoundary();
        const port = createWidgetSurfaceArtifactPortV1(boundary.forAccount('me'), { surface: scope, isCurrent: () => true });
        const resolve = (bindings: WidgetSetupDraft['bindings']) => resolveConfiguredWidgetInputs({
            instance: { ...fragment.group.children[0]!.instance, id: 'child' }, descriptor,
            providedContext: composeWidgetGroupContextV1({ providedContext: {}, groupBindings: bindings }), viewerValues: {},
        });
        const screen = await renderPanel({ sections: buildAccountWidgetAddSections({ candidates: [], instances: [], scope,
            labels: { count: String, submit: 'Add' }, addInstance: async () => ({ ok: true }), fragments: [fragment],
            renderGroupPreview: (_saved, draft) => JSON.stringify(resolve(draft.bindings)),
            // The Artifact transport is the persistence boundary; instantiation, reduction and reads stay real.
            addGroup: async (saved) => { await port.apply({ kind: 'group_add', group: instantiateWidgetLayoutFragmentGroupV1(saved.group,
                { groupId: 'copy', childIds: ['copy-child'] }) }); return { ok: true }; },
        }) });
        await act(async () => screen.pressByTestId('add.entry.group-saved'));
        await flushHookEffects({ cycles: 2 });
        expect(screen.getTextContent()).toContain('"amount":42');
        await act(async () => screen.changeTextByTestId('add.detail.field.amount.input', ''));
        await flushHookEffects({ cycles: 2 });
        expect(screen.getTextContent()).not.toContain('"amount":42');
        expect(boundary.rows.size).toBe(0);
        await screen.pressByTestIdAsync('add.detail.submit');
        await flushHookEffects({ cycles: 2 });
        const persisted = (await createWidgetSurfaceArtifactPortV1(boundary.forAccount('me'), { surface: scope, isCurrent: () => true }).read()).items[0]!;
        expect(persisted.kind).toBe('group');
        if (persisted.kind !== 'group') throw new Error('expected copied group');
        expect(persisted.context).toEqual({});
        expect(resolve(persisted.context ?? {})).toMatchObject({ status: 'selection_required', fields: [{ path: 'amount' }] });
        expect(boundary.rows.size).toBe(1);
        expect(fragment).toEqual(original);
    });

    it('retains the phone setup step and edited inputs through appearance changes', async () => {
        const rec = recorder();
        const candidate: WidgetCandidate = { ...SIGNUPS, inputs: { fields: [{ path: 'label', title: 'Label', widget: 'text' }] } };
        const sections: WidgetAddSection[] = [{ id: 'plugins', title: 'Analytics', entries: [widgetEntry(candidate, rec)] }];
        const runtime = Unistyles.useUnistyles();
        const appearance = vi.spyOn(Unistyles, 'useUnistyles').mockReturnValue({ ...runtime, theme: lightTheme });
        const close = () => {};
        const scene = () => <WidgetAddPanel testID="add" title="Add to Board" searchPlaceholder="Search widgets"
            addLabel="Add to Board" composition="push" phone sections={sections} onRequestClose={close} />;
        try {
            const screen = await renderScreen(scene());
            await act(async () => { screen.pressByTestId(`add.entry.${candidate.key}`); });
            await act(async () => { screen.changeTextByTestId('add.detail.field.label.input', 'Keep this setup'); });
            for (const theme of [darkTheme, lightTheme]) {
                appearance.mockReturnValue({ ...runtime, theme });
                await screen.update(scene());
                expect(screen.findByTestId('add.detail.field.label.input')?.props.value).toBe('Keep this setup');
                expect(screen.getTextContent()).toContain(`preview:${candidate.key}`);
            }
            expect(rec.submits).toEqual([]);
        } finally { appearance.mockRestore(); }
    });

    it('opens with nothing selected and mounts only the selected widget’s live body', async () => {
        const rec = recorder();
        const sections: WidgetAddSection[] = [{ id: 'plugins', title: 'Analytics', entries: [widgetEntry(SIGNUPS, rec), widgetEntry(SUMMARY, rec, { context: THIS_SESSION })] }];
        const screen = await renderPanel({ sections });
        expect(rec.previews).toEqual([]);
        expect(screen.findAllByTestId('add.empty').length).toBeGreaterThan(0);
        expect(screen.findByTestId('add.detail.submit')!.props.disabled).toBe(true);

        await act(async () => { screen.pressByTestId(`add.entry.${SIGNUPS.key}`); });
        await flushHookEffects({ cycles: 2 });
        expect(screen.getTextContent()).toContain(`preview:${SIGNUPS.key}`);
        expect(new Set(rec.previews)).toEqual(new Set([SIGNUPS.key]));

        await act(async () => { screen.pressByTestId(`add.entry.${SUMMARY.key}`); });
        await flushHookEffects({ cycles: 2 });
        const text = screen.getTextContent();
        expect(text).toContain(`preview:${SUMMARY.key}`);
        expect(text).not.toContain(`preview:${SIGNUPS.key}`);
        expect(rec.submits).toEqual([]);
    });

    it('adds a fully bound widget only from Add, with its default declared size, and stays open for another', async () => {
        const rec = recorder();
        const close = vi.fn();
        const screen = await renderPanel({ sections: [{ id: 'plugins', title: 'Analytics', entries: [widgetEntry(SIGNUPS, rec)] }], onRequestClose: close });
        await act(async () => { screen.pressByTestId(`add.entry.${SIGNUPS.key}`); });
        await flushHookEffects({ cycles: 2 });
        // Selecting is the preview, never the add; the line says what Add will do.
        expect(rec.submits).toEqual([]);
        expect(screen.findByTestId('add.detail.why')!.props.children).toBe('widgetAdd.addsAtSize(size=widgetAdd.sizes.wide)');
        await screen.pressByTestIdAsync('add.detail.submit');
        await flushHookEffects({ cycles: 3 });
        expect(rec.submits).toEqual([{ id: SIGNUPS.key, draft: { bindings: {}, size: 'wide' } }]);
        expect(close).not.toHaveBeenCalled();
        expect(screen.findAllByTestId(`add.entry.${SIGNUPS.key}.added`).length).toBeGreaterThan(0);
        expect(screen.getTextContent()).toContain('widgetAdd.justAdded(widget=Signups this week)');
    });

    it('adds the selected ready widget with ⌘↵ and refuses while an input is still needed', async () => {
        const rec = recorder();
        const sections: WidgetAddSection[] = [{ id: 'all', title: 'All', entries: [widgetEntry(SIGNUPS, rec), widgetEntry(SUMMARY, rec)] }];
        const screen = await renderPanel({ sections });
        const command = async () => {
            await act(async () => {
                screen.findByTestId('add')!.props.onKeyDown({ key: 'Enter', metaKey: true, ctrlKey: false, preventDefault: () => {} });
            });
            await flushHookEffects({ cycles: 3 });
        };
        // Nothing selected: nothing to add.
        await command();
        expect(rec.submits).toEqual([]);
        // Home has no Session: Summary needs one, so ⌘↵ does nothing and the line says why.
        await act(async () => { screen.pressByTestId(`add.entry.${SUMMARY.key}`); });
        await flushHookEffects({ cycles: 2 });
        await command();
        expect(rec.submits).toEqual([]);
        expect(screen.getTextContent()).toContain('widgetAdd.stillNeeded(field=Session)');
        await act(async () => { screen.pressByTestId(`add.entry.${SIGNUPS.key}`); });
        await flushHookEffects({ cycles: 2 });
        await command();
        expect(rec.submits.map((submit) => submit.id)).toEqual([SIGNUPS.key]);
    });

    it('moves the selection with the arrow keys from search and adds with ↵', async () => {
        const rec = recorder();
        const sections: WidgetAddSection[] = [{ id: 'all', title: 'All', entries: [widgetEntry(SIGNUPS, rec), widgetEntry(SUMMARY, rec, { context: THIS_SESSION })] }];
        const screen = await renderPanel({ sections });
        const selected = (testID: string) => screen.findAll((node) => node.props.testID === testID && node.props.selected === true).length > 0;
        const key = async (name: string) => {
            await act(async () => { screen.findByTestId('add.search')!.props.onKeyPress({ nativeEvent: { key: name }, preventDefault: () => {} }); });
            await flushHookEffects({ cycles: 3 });
        };
        await key('ArrowDown');
        expect(selected(`add.entry.${SIGNUPS.key}`)).toBe(true);
        await key('ArrowDown');
        expect(selected(`add.entry.${SUMMARY.key}`)).toBe(true);
        expect(selected(`add.entry.${SIGNUPS.key}`)).toBe(false);
        await key('Enter');
        expect(rec.submits).toEqual([{ id: SUMMARY.key, draft: { bindings: { session: { kind: 'context', slot: 'session' } }, size: 'medium' } }]);
    });

    it('offers only the sizes the widget declares for this surface', async () => {
        const rec = recorder();
        const screen = await renderPanel({ sections: [{ id: 'plugins', title: 'Analytics', entries: [widgetEntry(SIGNUPS, rec)] }] });
        await act(async () => { screen.pressByTestId(`add.entry.${SIGNUPS.key}`); });
        await flushHookEffects({ cycles: 2 });
        const picker = screen.findAllByType(WidgetSizePicker)[0]!;
        expect((picker.props.choices as ReadonlyArray<{ key: WidgetSizeV1 }>).map((choice) => choice.key)).toEqual(['small', 'wide']);
        await screen.pressByTestIdAsync('add.detail.size.small');
        expect(screen.findByTestId('add.detail.why')!.props.children).toBe('widgetAdd.addsAtSize(size=widgetAdd.sizes.small)');
        await screen.pressByTestIdAsync('add.detail.submit');
        await flushHookEffects({ cycles: 3 });
        expect(rec.submits[0]!.draft.size).toBe('small');
    });

    it('says pending approval and refusal in place, in the reserved line and on the row, without leaving the pane', async () => {
        const rec = recorder();
        let next: WidgetSetupSubmitResult = { ok: false, message: 'widgetAdd.addFailed' };
        const screen = await renderPanel({ sections: [{ id: 'plugins', title: 'Analytics', entries: [widgetEntry(SIGNUPS, rec, { result: () => next })] }] });
        await act(async () => { screen.pressByTestId(`add.entry.${SIGNUPS.key}`); });
        await flushHookEffects({ cycles: 2 });
        const line = () => screen.findByTestId('add.detail.why');
        expect(line()).not.toBeNull();

        await screen.pressByTestIdAsync('add.detail.submit');
        await flushHookEffects({ cycles: 3 });
        expect(screen.findAllByTestId(`add.entry.${SIGNUPS.key}.failed`).length).toBeGreaterThan(0);
        expect(line()!.props.children).toBe('widgetAdd.addFailed');
        // The same button retries.
        next = { ok: true, approvalPending: true };
        await screen.pressByTestIdAsync('add.detail.submit');
        await flushHookEffects({ cycles: 3 });
        expect(screen.findAllByTestId(`add.entry.${SIGNUPS.key}.pending`).length).toBeGreaterThan(0);
        expect(screen.findAllByTestId(`add.entry.${SIGNUPS.key}.failed`)).toHaveLength(0);
        expect(line()!.props.children).toBe('widgetAdd.areaApprovalPending');
        expect(screen.getTextContent()).not.toContain('widgetAdd.justAdded');
        expect(screen.findAllByTestId('add.detail')).not.toHaveLength(0);
    });

    it('keeps an already-added widget listed, but its Add says so and cannot add a duplicate', async () => {
        const rec = recorder();
        const screen = await renderPanel({ sections: [{ id: 'plugins', title: 'Analytics', entries: [{ ...widgetEntry(SIGNUPS, rec), added: true }] }] });
        expect(screen.getTextContent()).toContain('widgetAdd.added');
        await act(async () => { screen.pressByTestId(`add.entry.${SIGNUPS.key}`); });
        await flushHookEffects({ cycles: 2 });
        expect(screen.findByTestId('add.detail.submit')!.props.disabled).toBe(true);
        await screen.pressByTestIdAsync('add.detail.submit');
        expect(rec.submits).toEqual([]);
    });

    it('runs an entry without its own setup from Add, closing when it hands the focus elsewhere', async () => {
        const note = vi.fn();
        const close = vi.fn();
        const screen = await renderPanel({
            sections: [{ id: 'make', title: 'Make one', entries: [{ id: 'note', title: 'Note', subtitle: 'Markdown', icon: 'note', closesOnPick: true, onPick: note }] }],
            onRequestClose: close,
        });
        await act(async () => { screen.pressByTestId('add.entry.note'); });
        await flushHookEffects({ cycles: 2 });
        expect(note).not.toHaveBeenCalled();
        await screen.pressByTestIdAsync('add.detail.submit');
        expect(note).toHaveBeenCalledTimes(1);
        expect(close).toHaveBeenCalledTimes(1);
    });

    it('waits for saved inventory before saying a search has no match, then offers Clear', async () => {
        const rec = recorder();
        const panelProps: React.ComponentProps<typeof WidgetAddPanel> = {
            testID: 'add', title: 'Add to Home', searchPlaceholder: 'Search widgets', addLabel: 'Add to Home',
            composition: 'split', onRequestClose: () => {},
            sections: [{ id: 'all', title: 'All', entries: [widgetEntry(SIGNUPS, rec)] }],
            pendingSections: [{ id: 'yours', title: 'Your widgets' }],
        };
        const screen = await renderScreen(<WidgetAddPanel {...panelProps} />);
        await act(async () => { screen.changeTextByTestId('add.search', 'kanban'); });
        await flushHookEffects({ cycles: 2 });
        expect(screen.findHostByTestId('add.noMatch')).toBeNull();
        expect(screen.findHostByTestId('add.clearSearch')).toBeNull();
        expect(screen.findAllByTestId('add.pending.yours').length).toBeGreaterThan(0);
        expect(screen.getTextContent()).toContain('Your widgets');
        await screen.update(<WidgetAddPanel {...panelProps} pendingSections={[]} />);
        expect(screen.findHostByTestId('add.pending.yours')).toBeNull();
        expect(screen.findHostByTestId('add.noMatch')).not.toBeNull();
        expect(screen.findHostByTestId('add.clearSearch')).not.toBeNull();
    });

    it('says a refused Your widgets read could not load and offers Retry, instead of reading Loading', async () => {
        const rec = recorder();
        const retry = vi.fn();
        const screen = await renderPanel({
            sections: [{ id: 'all', title: 'All', entries: [widgetEntry(SIGNUPS, rec)] }],
            pendingSections: [{ id: 'yours', title: 'Your widgets', retry }],
        });
        expect(screen.findAllByTestId('add.pending.yours.failed').length).toBeGreaterThan(0);
        expect(screen.getTextContent()).toContain('widgetAdd.yoursFailed');
        expect(screen.getTextContent()).not.toContain('common.loading');
        await act(async () => { screen.pressByTestId('add.pending.yours.retry'); });
        expect(retry).toHaveBeenCalledTimes(1);
    });

    it('narrows by search and offers the ask entry, which drafts and closes', async () => {
        const rec = recorder();
        const ask = vi.fn();
        const close = vi.fn();
        const screen = await renderPanel({
            sections: [{ id: 'all', title: 'All', entries: [widgetEntry(SIGNUPS, rec), widgetEntry(SUMMARY, rec)] }],
            ask: { title: 'Ask the agent for a widget', draft: 'Put something on Home that shows ', note: 'Nothing is sent', onPick: ask },
            onRequestClose: close,
        });
        screen.changeTextByTestId('add.search', 'summ');
        await flushHookEffects({ cycles: 2 });
        const text = screen.getTextContent();
        expect(text).toContain('Summary');
        expect(text).not.toContain('Signups this week');
        screen.changeTextByTestId('add.search', 'kanban');
        await flushHookEffects({ cycles: 2 });
        expect(screen.findAllByTestId('add.noMatch').length).toBeGreaterThan(0);
        // An empty search is never a dead end: the ask stays offered, and Clear brings the list back.
        expect(screen.findAllByTestId('add.entry.ask').length).toBeGreaterThan(0);
        await act(async () => { screen.pressByTestId('add.clearSearch'); });
        await flushHookEffects({ cycles: 2 });
        expect(screen.getTextContent()).toContain('Signups this week');
        expect(screen.findAllByTestId('add.noMatch')).toHaveLength(0);
        await act(async () => { screen.pressByTestId('add.entry.ask'); });
        await flushHookEffects({ cycles: 2 });
        expect(screen.getTextContent()).toContain('Put something on Home that shows');
        await screen.pressByTestIdAsync('add.detail.submit');
        expect(ask).toHaveBeenCalledTimes(1);
        expect(close).toHaveBeenCalledTimes(1);
    });

    it('pushes the selected widget’s pane in the narrow composition and returns to the same search', async () => {
        const rec = recorder();
        const screen = await renderPanel({ composition: 'push', sections: [{ id: 'all', title: 'All', entries: [widgetEntry(SIGNUPS, rec), widgetEntry(SUMMARY, rec)] }] });
        expect(screen.findAllByTestId('add.detail')).toHaveLength(0);
        screen.changeTextByTestId('add.search', 'sign');
        await flushHookEffects({ cycles: 2 });
        await act(async () => { screen.pressByTestId(`add.entry.${SIGNUPS.key}`); });
        await flushHookEffects({ cycles: 2 });
        expect(screen.findAllByTestId('add.detail').length).toBeGreaterThan(0);
        expect(screen.findAllByTestId('add.search')).toHaveLength(0);
        expect(rec.previews).toContain(SIGNUPS.key);
        await screen.pressByTestIdAsync('add.detail.back');
        await flushHookEffects({ cycles: 2 });
        expect(screen.findAllByTestId('add.detail')).toHaveLength(0);
        expect(screen.findByTestId('add.search')!.props.value).toBe('sign');
        expect(rec.submits).toEqual([]);
    });

    it('opens on a widget chosen elsewhere (Add to board’s list), its pane ready', async () => {
        const rec = recorder();
        const screen = await renderPanel({ initialEntryId: SIGNUPS.key, sections: [{ id: 'all', title: 'All', entries: [widgetEntry(SIGNUPS, rec), widgetEntry(SUMMARY, rec)] }] });
        expect(screen.getTextContent()).toContain(`preview:${SIGNUPS.key}`);
        expect(screen.findByTestId('add.detail.submit')!.props.disabled).toBe(false);
    });

    it.each(['home', 'board', 'companion'] as const)('shows an inputless %s Add refused, then pending approval, in place through each placement’s own add path', async (surface) => {
        const candidate: WidgetCandidate = {
            sizeDeclaration: { sizes: ['medium'], defaultSize: 'medium' },
            surface: { pluginId: 'acme.widgets', localId: 'counter' }, key: 'acme.widgets/counter',
            title: 'Counter', pluginName: 'Widgets', sharedPluginName: false, icon: 'chart-bar', homeDefault: 'available', target: 'app',
        };
        let pending = false;
        const result = () => (pending ? { ok: true as const, approvalPending: true as const } : { ok: false as const, message: 'permission_denied' });
        const sections = surface === 'home'
            ? buildHomeWidgetAddSections({ candidates: [candidate], instances: [], scope: null, addInstance: async () => result() })
            : surface === 'board'
                ? buildBoardWidgetAddContent({ candidates: [candidate], intents: ['fromPlugins'], snapshot: null,
                    run: async () => (pending ? { kind: 'approvalPending', artifactId: 'approval', actionId: 'widgets.item.add' }
                        : { kind: 'failed', error: 'permission_denied' }), openPlugins: () => {} }).sections
                : buildCompanionWidgetAddSections({ glanceCandidates: [candidate], refs: [], snapshot: null, pluginProjection: null, addItem: async () => result() });
        const close = vi.fn();
        const screen = await renderPanel({ sections: [...sections], onRequestClose: close });
        const id = 'add.entry.plugin-acme.widgets/counter';
        await act(async () => { screen.pressByTestId(id); });
        await flushHookEffects({ cycles: 2 });
        await screen.pressByTestIdAsync('add.detail.submit');
        await flushHookEffects({ cycles: 3 });
        expect(screen.findAllByTestId(`${id}.failed`).length).toBeGreaterThan(0);
        expect(screen.getTextContent()).not.toContain('widgetAdd.justAdded');
        expect(close).not.toHaveBeenCalled();
        pending = true;
        await screen.pressByTestIdAsync('add.detail.submit');
        await flushHookEffects({ cycles: 3 });
        expect(screen.findAllByTestId(`${id}.pending`).length).toBeGreaterThan(0);
        expect(screen.getTextContent()).toContain('widgetAdd.areaApprovalPending');
        expect(screen.findAllByTestId(`${id}.added`)).toHaveLength(0);
    });

    it('picks a Session on Home from the sessions source, listing one the viewer cannot read without letting it be chosen', async () => {
        await homes.reset();
        const serverId = await homes.addHome({ name: 'Picker', serverUrl: 'https://picker.test', accountId: 'me' });
        homes.answer(serverId, '/v1/account/encryption/currentness', { body: createPlainAccountEncryptionCurrentnessFixture() });
        connection = await restoreServerAccountForTest({ serverUrl: 'https://picker.test', accountId: 'me', request: homes.request });
        releaseLoader = await installRealActionExecutorModuleLoader();
        installSessionActionFixture({ homes, storage, serverId, session: { id: 'B', pendingPermissionRequestCount: 1,
            pendingUserActionRequestCount: 0, active: true, activeAt: Date.now(),
            metadata: { path: '/repo', host: 'test', name: 'Fix settings modal remount' } } });
        installSessionActionFixture({ homes, storage, serverId, session: { id: 'C', active: false } });
        const wire = async (id: string) => {
            const response: unknown = await (await homes.request(`https://picker.test/v2/sessions/${id}`)).json();
            if (!response || typeof response !== 'object' || !('session' in response)) throw new Error('Missing HTTP Session');
            return SessionCurrentProjectionRecordV1Schema.parse(response.session);
        };
        const viewer = SessionViewerProjectionV1Schema.parse({ latestFailureSeq: null, readState: { state: 'not_started' },
            relevance: { relevant: false, reasons: [] }, attention: { needsAttention: false, reasons: [], primary: null, presentation: 'full' },
            follow: { follows: false, notificationLevel: 'none' }, notification: { level: 'none', source: 'preference' } });
        const b = SessionCurrentProjectionRecordV1Schema.parse({ ...await wire('B'), viewer, agentState: JSON.stringify({ requests: {
            ask: { tool: 'Bash', arguments: {}, createdAt: Date.now() },
        } }) });
        // This inaccessible encrypted row comes from the same HTTP producer shape;
        // the real hydrator/awareness owner decides that it cannot be selected.
        const { SecretBoxEncryption } = await import('@/sync/encryption/encryptor');
        const { encodeBase64 } = await import('@/encryption/base64');
        const cipher = new SecretBoxEncryption(new Uint8Array(32).fill(7));
        const c = SessionCurrentProjectionRecordV1Schema.parse({ ...await wire('C'), encryptionMode: 'e2ee', metadata: encodeBase64((await cipher.encrypt([{}]))[0]!), viewer });
        homes.answer(serverId, '/v2/sessions/B', { body: { session: b } });
        homes.answer(serverId, '/v2/sessions/C', { body: { session: c } });
        // C must enter through the query hydrator, not an already-ready plain
        // Session left in the cache by the plain HTTP producer helper above.
        const { C: _seededPlainC, ...sessions } = storage.getState().sessions;
        storage.setState({ sessions, sessionListRowsByServerId: {} });
        homes.answer(serverId, 'POST /v2/sessions/query', { body: createSessionListSourceFixture({ sessions: [b, c], hasNext: false, nextCursor: null,
            attentionHasNext: false, attentionNextCursor: null }) });
        const home = { serverId: connection.home.id, accountId: 'me', owner: { kind: 'home' as const } };
        const summary = selectBuiltinWidgetCandidates().find((candidate) => candidate.definition?.kind === 'builtin' && candidate.definition.id === 'session_summary')!;
        const rec = recorder();
        const screen = await renderPanel({ serverId: home.serverId, sections: [{ id: 'builtins', title: 'Built in', entries: [widgetEntry(summary, rec, { scope: home })] }] }, {
            wrapper: ({ children }) => <AppShellPluginUiProjectionProvider>{children}</AppShellPluginUiProjectionProvider>,
        });
        await act(async () => { screen.pressByTestId(`add.entry.${summary.key}`); });
        await flushHookEffects({ cycles: 4 });
        const field = () => screen.findAllByType(HappierInputField).find(node => node.props.field.path === 'session')!;
        await vi.waitFor(() => expect(field().props.options).toHaveLength(2));
        const items = field().props.options as ReadonlyArray<{ label: string; description?: string; disabled?: boolean }>;
        expect(items.map(item => [item.label, item.description, item.disabled === true])).toEqual([
            ['Fix settings modal remount', 'Needs you', false],
            ['C', 'Recent', true],
        ]);
        await screen.pressByTestIdAsync('add.detail.field.session.control.trigger');
        expect(screen.findByTestId('add.detail.field.session.option.1')!.props.disabled).toBe(true);
        await act(async () => { screen.findHostByTestId('add.detail.field.session.option.1')?.props.onPress?.(); });
        await flushHookEffects({ cycles: 2 });
        expect(screen.getTextContent()).toContain('widgetAdd.stillNeeded(field=Session)');
        await screen.pressByTestIdAsync('add.detail.field.session.option.0');
        await flushHookEffects({ cycles: 2 });
        await screen.pressByTestIdAsync('add.detail.submit');
        await flushHookEffects({ cycles: 3 });
        expect(rec.submits.map((submit) => submit.draft.bindings)).toEqual([{ session: { kind: 'value', value: { serverId: home.serverId, sessionId: 'B' } } }]);
    });

    it('moves the focus to the first input still needed when ↵ or ⌘↵ cannot add yet', async () => {
        const summary = selectBuiltinWidgetCandidates().find((candidate) => candidate.definition?.kind === 'builtin' && candidate.definition.id === 'session_summary')!;
        const rec = recorder();
        const screen = await renderPanel({ serverId: 'home', sections: [{ id: 'builtins', title: 'Built in', entries: [widgetEntry(summary, rec)] }] });
        await act(async () => { screen.pressByTestId(`add.entry.${summary.key}`); });
        await flushHookEffects({ cycles: 3 });
        const choicesOpen = () => screen.findAllHostsByTestId('add.detail.field.session.control').some(node => node.props.role === 'radiogroup');
        expect(choicesOpen()).toBe(false);
        await act(async () => { screen.findByTestId('add.search')!.props.onKeyPress({ nativeEvent: { key: 'Enter' }, preventDefault: () => {} }); });
        await flushHookEffects({ cycles: 3 });
        expect(choicesOpen()).toBe(true);
        expect(rec.submits).toEqual([]);
    });
});
