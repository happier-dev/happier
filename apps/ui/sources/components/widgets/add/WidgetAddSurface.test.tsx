import * as React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react-test-renderer';
import { WidgetSizePicker } from '@happier-dev/plugin-ui/presentation';
import { composeWidgetGroupContextV1, createWidgetSurfaceArtifactPortV1, instantiateWidgetLayoutFragmentGroupV1, resolveConfiguredWidgetInputs, type WidgetLayoutFragmentSummaryV1, type WidgetSizeV1, type WidgetSurfaceRefV1 } from '@happier-dev/protocol/widgets';
import { createWorkBoardArtifactBoundary } from '../../../../../../packages/protocol/src/boards/workBoardArtifactV1.testkit';

import { flushHookEffects, renderScreen, standardCleanup } from '@/dev/testkit';
import { DropdownMenu } from '@/components/ui/forms/dropdown/DropdownMenu';
import { buildWidgetCandidateSetup, type WidgetSurfaceContext } from '@/components/widgets/surface/widgetSurfaceSetup';
import { selectBuiltinWidgetCandidates, type WidgetCandidate } from '@/components/widgets/widgetCatalog';

import { buildHomeWidgetAddSections } from './HomeWidgetAddPopover';
import { buildBoardWidgetAddContent, buildCompanionWidgetAddSections } from './widgetAddSections';

import type { WidgetAddAsk, WidgetAddEntry, WidgetAddSection } from './widgetAddModel';
import type { WidgetSetupDraft, WidgetSetupSubmitResult } from './widgetSetupModel';
import { WidgetAddPanel } from './WidgetAddSurface';
import { buildAccountWidgetAddSections } from './accountWidgetAddSections';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const accessibilityBoundary = vi.hoisted(() => ({ os: 'web', announce: vi.fn() }));
vi.mock('react-native', async () => (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock({
    Platform: { get OS() { return accessibilityBoundary.os; } },
    AccessibilityInfo: { announceForAccessibility: accessibilityBoundary.announce },
}));
vi.mock('react-native-unistyles', async () => (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock());
vi.mock('@/text', async () => (await import('@/dev/testkit/mocks/text')).createTextModuleMock());
// The menu's portal and window measurement are the boundary; its rows and selection stay real.
vi.mock('@/components/ui/popover', async (importOriginal) =>
    (await import('@/dev/testkit/mocks/popover')).createInlinePopoverModuleMock(importOriginal));

// Option discovery crosses the network to the Action executor (`action.options.resolve`); that call is
// the boundary. The panel, the setup step, the binder and the size policy below it are real.
const optionsResolve = vi.hoisted(() => ({ options: [] as unknown[] }));
vi.mock('@/sync/domains/workflows/callWorkflowAction', () => ({
    callWorkflowAction: async (args: { input: { optionsSourceId?: string; fieldPath?: string }; parseResult: (value: unknown) => unknown }) => args.parseResult({
        actionId: null, fieldPath: args.input.fieldPath ?? null, optionsSourceId: args.input.optionsSourceId ?? null, options: optionsResolve.options,
    }),
}));

afterEach(() => { standardCleanup(); optionsResolve.options = []; accessibilityBoundary.os = 'web'; accessibilityBoundary.announce.mockClear(); });

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
}> = {}): WidgetAddEntry {
    const id = candidate.key;
    return {
        id,
        title: candidate.title,
        subtitle: candidate.description ?? candidate.pluginName,
        icon: candidate.icon,
        ...(options.count ? { count: options.count } : {}),
        setup: () => buildWidgetCandidateSetup({
            candidate, context: options.context ?? {}, audience: 'personal', scope: HOME,
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
    onRequestClose?: () => void;
}>) {
    const screen = await renderScreen(
        <WidgetAddPanel
            testID="add"
            title="Add to Home"
            hint="Only you see your Home"
            searchPlaceholder="Search widgets"
            addLabel="Add to Home"
            composition={props.composition ?? 'split'}
            sections={props.sections}
            {...(props.ask ? { ask: props.ask } : {})}
            {...(props.initialEntryId ? { initialEntryId: props.initialEntryId } : {})}
            {...(props.serverId ? { serverId: props.serverId } : {})}
            onRequestClose={props.onRequestClose ?? (() => {})}
        />,
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
        await act(async () => screen.findByTestId('add.search')!.props.onKeyPress({ nativeEvent: { key: 'ArrowDown' }, preventDefault: () => {} }));
        await flushHookEffects({ cycles: 2 });
        expect(accessibilityBoundary.announce).toHaveBeenLastCalledWith('Summary, Sessions');
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
        screen.changeTextByTestId('add.search', '');
        await flushHookEffects({ cycles: 2 });
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
        optionsResolve.options = [
            { value: { serverId: 'home', sessionId: 'B' }, label: 'Fix settings modal remount', description: 'Needs you' },
            { value: { serverId: 'home', sessionId: 'C' }, label: 'C', description: 'Recent', disabled: true },
        ];
        const summary = selectBuiltinWidgetCandidates().find((candidate) => candidate.definition?.kind === 'builtin' && candidate.definition.id === 'session_summary')!;
        const rec = recorder();
        const screen = await renderPanel({ serverId: 'home', sections: [{ id: 'builtins', title: 'Built in', entries: [widgetEntry(summary, rec)] }] });
        await act(async () => { screen.pressByTestId(`add.entry.${summary.key}`); });
        await flushHookEffects({ cycles: 4 });
        const menu = () => screen.findAllByType(DropdownMenu).find((node) => node.props.testID === 'add.detail.field.session')!;
        const items = menu().props.items as ReadonlyArray<{ id: string; title: string; subtitle?: string; disabled?: boolean }>;
        expect(items.map((item) => [item.title, item.subtitle, item.disabled === true])).toEqual([
            ['Fix settings modal remount', 'Needs you', false],
            ['C', 'Recent', true],
        ]);
        await act(async () => { menu().props.onSelect(items[1]!.id); });
        await flushHookEffects({ cycles: 2 });
        expect(screen.getTextContent()).toContain('widgetAdd.stillNeeded(field=Session)');
        await act(async () => { menu().props.onSelect(items[0]!.id); });
        await flushHookEffects({ cycles: 2 });
        await screen.pressByTestIdAsync('add.detail.submit');
        await flushHookEffects({ cycles: 3 });
        expect(rec.submits.map((submit) => submit.draft.bindings)).toEqual([{ session: { kind: 'value', value: { serverId: 'home', sessionId: 'B' } } }]);
    });

    it('moves the focus to the first input still needed when ↵ or ⌘↵ cannot add yet', async () => {
        const summary = selectBuiltinWidgetCandidates().find((candidate) => candidate.definition?.kind === 'builtin' && candidate.definition.id === 'session_summary')!;
        const rec = recorder();
        const screen = await renderPanel({ serverId: 'home', sections: [{ id: 'builtins', title: 'Built in', entries: [widgetEntry(summary, rec)] }] });
        await act(async () => { screen.pressByTestId(`add.entry.${summary.key}`); });
        await flushHookEffects({ cycles: 3 });
        const menu = () => screen.findAllByType(DropdownMenu).find((node) => node.props.testID === 'add.detail.field.session')!;
        expect(menu().props.open).toBe(false);
        await act(async () => { screen.findByTestId('add.search')!.props.onKeyPress({ nativeEvent: { key: 'Enter' }, preventDefault: () => {} }); });
        await flushHookEffects({ cycles: 3 });
        expect(menu().props.open).toBe(true);
        expect(rec.submits).toEqual([]);
    });
});
