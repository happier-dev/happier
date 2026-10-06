import * as React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { act } from 'react-test-renderer';
import { flushHookEffects, renderScreen, standardCleanup } from '@/dev/testkit';
import { DropdownMenu } from '@/components/ui/forms/dropdown/DropdownMenu';

import { buildWidgetCandidateSetup, type WidgetSurfaceContext } from '@/components/widgets/surface/widgetSurfaceSetup';
import { selectBuiltinWidgetCandidates, type WidgetCandidate } from '@/components/widgets/widgetCatalog';

import type { WidgetAddAsk, WidgetAddSection, WidgetAddView } from './widgetAddModel';
import { WidgetAddPanel } from './WidgetAddPanel';
import type { WidgetSetupDraft } from './widgetSetupModel';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock();
});
vi.mock('react-native-unistyles', async () => {
    const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
    return createUnistylesMock();
});
vi.mock('@/text', async () => {
    const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
    return createTextModuleMock();
});

// Option discovery crosses the network to the Action executor (`action.options.resolve`): that call
// is the boundary; the options store, the step and the row below it are real.
const optionsResolve = vi.hoisted(() => ({ options: [] as unknown[] }));
vi.mock('@/sync/domains/workflows/callWorkflowAction', () => ({
    callWorkflowAction: async (args: { actionId: string; input: { optionsSourceId?: string; fieldPath?: string }; parseResult: (value: unknown) => unknown }) => args.parseResult({
        actionId: null, fieldPath: args.input.fieldPath ?? null, optionsSourceId: args.input.optionsSourceId ?? null, options: optionsResolve.options,
    }),
}));

afterEach(() => {
    standardCleanup();
    optionsResolve.options = [];
});

/**
 * The one Add popover (lab `cwidgets` WG/WL, round 2): one component for every placement, a Gallery |
 * List switch, sections whose already-added entries stay in place, and every choice handed to the
 * placement's own add path.
 */
function boardSections(input: Readonly<{ pick: (id: string) => void; preview: () => void }>): WidgetAddSection[] {
    return [
        {
            id: 'plugins',
            title: 'From plugins',
            hint: 'live, with this session’s data',
            kind: 'preview',
            entries: [
                {
                    id: 'pr',
                    title: 'This branch’s PR',
                    subtitle: 'PRs & Issues',
                    icon: 'git-pull-request',
                    renderPreview: () => { input.preview(); return 'preview:pr'; },
                    onPick: () => input.pick('pr'),
                },
                {
                    id: 'conv',
                    title: 'External conversations',
                    subtitle: 'Channels',
                    icon: 'chat-circle',
                    added: true,
                    renderPreview: () => { input.preview(); return 'preview:conv'; },
                    onPick: () => input.pick('conv'),
                },
            ],
        },
        {
            id: 'make',
            title: 'Make one',
            kind: 'make',
            entries: [
                { id: 'note', title: 'Note', subtitle: 'Markdown', icon: 'note', closesOnPick: true, onPick: () => input.pick('note') },
            ],
        },
    ];
}

async function renderPanel(props: Readonly<{
    serverId?: string;
    view: WidgetAddView;
    sections: WidgetAddSection[];
    ask?: WidgetAddAsk;
    onViewChange?: (view: WidgetAddView) => void;
    onRequestClose?: () => void;
}>) {
    const screen = await renderScreen(
        <WidgetAddPanel
            testID="add"
            title="Add to the board"
            hint="Everyone here sees what you add"
            searchPlaceholder="Search widgets"
            view={props.view}
            onViewChange={props.onViewChange ?? (() => {})}
            sections={props.sections}
            {...(props.ask ? { ask: props.ask } : {})}
            onRequestClose={props.onRequestClose ?? (() => {})}
            {...(props.serverId ? { serverId: props.serverId } : {})}
        />,
    );
    await flushHookEffects({ cycles: 2 });
    return screen;
}

describe('WidgetAddPanel', () => {
    it('shows the gallery with live previews, keeps an added widget in place marked Added, and keeps open after a pick', async () => {
        const pick = vi.fn();
        const preview = vi.fn();
        const close = vi.fn();
        const screen = await renderPanel({ view: 'gallery', sections: boardSections({ pick, preview }), onRequestClose: close });
        const text = screen.getTextContent();
        expect(text).toContain('From plugins');
        expect(text).toContain('preview:pr');
        expect(text).toContain('preview:conv');
        expect(text).toContain('widgetAdd.added');

        screen.pressByTestId('add.entry.conv');
        expect(pick).not.toHaveBeenCalled();

        screen.pressByTestId('add.entry.pr');
        expect(pick).toHaveBeenCalledTimes(1);
        expect(pick).toHaveBeenCalledWith('pr');
        expect(close).not.toHaveBeenCalled();
    });

    it('closes when the pick hands focus elsewhere (a new note)', async () => {
        const pick = vi.fn();
        const close = vi.fn();
        const screen = await renderPanel({ view: 'gallery', sections: boardSections({ pick, preview: () => {} }), onRequestClose: close });
        screen.pressByTestId('add.entry.note');
        expect(pick).toHaveBeenCalledWith('note');
        expect(close).toHaveBeenCalledTimes(1);
    });

    it('lists the same sections and Added rows in the List view without mounting any preview', async () => {
        const pick = vi.fn();
        const preview = vi.fn();
        const screen = await renderPanel({ view: 'list', sections: boardSections({ pick, preview }) });
        const text = screen.getTextContent();
        expect(text).toContain('From plugins');
        expect(text).toContain('This branch’s PR');
        expect(text).toContain('Note');
        expect(text).toContain('widgetAdd.added');
        expect(preview).not.toHaveBeenCalled();
        screen.pressByTestId('add.entry.pr');
        expect(pick).toHaveBeenCalledWith('pr');
    });

    it('switches between Gallery and List through the remembered view', async () => {
        const onViewChange = vi.fn();
        const screen = await renderPanel({ view: 'gallery', sections: boardSections({ pick: () => {}, preview: () => {} }), onViewChange });
        screen.pressByTestId('add.view:list');
        expect(onViewChange).toHaveBeenCalledWith('list');
    });

    it('narrows by search, keeping matching entries and dropping empty sections', async () => {
        const screen = await renderPanel({ view: 'list', sections: boardSections({ pick: () => {}, preview: () => {} }) });
        screen.changeTextByTestId('add.search', 'conversations');
        await flushHookEffects({ cycles: 2 });
        const text = screen.getTextContent();
        expect(text).toContain('External conversations');
        expect(text).not.toContain('This branch’s PR');
        expect(text).not.toContain('Make one');
    });

    it('drafts in the composer from the ask entry and closes, sending nothing itself', async () => {
        const ask = vi.fn();
        const close = vi.fn();
        const screen = await renderPanel({
            view: 'gallery',
            sections: boardSections({ pick: () => {}, preview: () => {} }),
            ask: { title: 'Ask the agent for a widget', draft: 'Put something on this board that shows ', note: 'Nothing is sent', onPick: ask },
            onRequestClose: close,
        });
        expect(screen.getTextContent()).toContain('Put something on this board that shows');
        screen.pressByTestId('add.ask');
        expect(ask).toHaveBeenCalledTimes(1);
        expect(close).toHaveBeenCalledTimes(1);
    });
});

/**
 * The one Set up step (lab `dashboards` dadd A/Ab): a configurable pick that binds on its own goes
 * straight through the placement's add path with feedback on the tile; one with something missing
 * opens the inputs-first step, whose Cancel and Back write nothing and whose button adds exactly
 * once with the chosen bindings.
 */
const SUMMARY: WidgetCandidate = {
    surface: { pluginId: 'happier.sessions', localId: 'summary' },
    key: 'happier.sessions/summary',
    title: 'Summary',
    pluginName: 'Sessions',
    sharedPluginName: false,
    icon: 'chat-circle',
    homeDefault: 'available',
    target: 'session',
    sessionInputPath: 'session',
    inputs: { fields: [{ path: 'session', title: 'Session', widget: 'json', required: true }] },
};
const WITH_PERIOD: WidgetCandidate = {
    ...SUMMARY,
    inputs: { fields: [
        { path: 'session', title: 'Session', widget: 'json', required: true },
        { path: 'period', title: 'Period', widget: 'select', required: true, options: [
            { value: '7d', label: '7 days' }, { value: '30d', label: '30 days' }, { value: '90d', label: '90 days' },
        ] },
    ] },
};
const THIS_SESSION: WidgetSurfaceContext = { session: { ref: { serverId: 'home', sessionId: 'A' }, label: 'Retry relay handshake on 503' } };

function configurableSections(candidate: WidgetCandidate, context: WidgetSurfaceContext, submit: (draft: WidgetSetupDraft) => void): WidgetAddSection[] {
    return [{
        id: 'plugins',
        title: 'From plugins',
        kind: 'preview',
        entries: [{
            id: 'summary',
            title: candidate.title,
            icon: candidate.icon,
            count: '2 on the board',
            setup: () => buildWidgetCandidateSetup({
                candidate,
                context,
                audience: 'shared',
                mode: { kind: 'add', submitLabel: 'Add to the board' },
                submit: async (draft) => { submit(draft); return { ok: true }; },
            }),
            onPick: () => { throw new Error('a configurable pick goes through its setup'); },
        }],
    }];
}

describe('WidgetAddPanel Set up step', () => {
    it('announces pending approval rather than Added after a fully bound publication', async () => {
        const sections = configurableSections(SUMMARY, THIS_SESSION, () => {});
        const original = sections[0]!.entries[0]!;
        const setup = original.setup!();
        const pending = { ...setup, submit: async () => ({ ok: true as const, approvalPending: true as const }) };
        const screen = await renderPanel({ view: 'list', sections: [{ ...sections[0]!, entries: [{ ...original, setup: () => pending }] }] });
        await act(async () => { screen.pressByTestId('add.entry.summary'); });
        await flushHookEffects({ cycles: 3 });
        expect(screen.getTextContent()).toContain('widgetAdd.areaApprovalPending');
        expect(screen.getTextContent()).not.toContain('widgetAdd.justAdded');
    });

    it('returns to the gallery with pending approval after choosing a required input', async () => {
        const sections = configurableSections(WITH_PERIOD, THIS_SESSION, vi.fn());
        const original = sections[0]!.entries[0]!;
        const pending = { ...original.setup!(), submit: async () => ({ ok: true as const, approvalPending: true as const }) };
        const screen = await renderPanel({ view: 'gallery', sections: [{ ...sections[0]!, entries: [{ ...original, setup: () => pending }] }] });
        await act(async () => { screen.pressByTestId('add.entry.summary'); });
        await flushHookEffects({ cycles: 2 });
        await act(async () => { screen.pressByTestId('add.setup.field.period.option.1'); });
        await flushHookEffects({ cycles: 2 });
        await act(async () => { screen.pressByTestId('add.setup.submit'); });
        await flushHookEffects({ cycles: 3 });
        expect(screen.findAllByTestId('add.setup')).toHaveLength(0);
        expect(screen.getTextContent()).toContain('widgetAdd.areaApprovalPending');
        expect(screen.getTextContent()).not.toContain('widgetAdd.justAdded');
    });

    it('adds a fully bound copy at once, with no step, and says so in place', async () => {
        const submit = vi.fn();
        const screen = await renderPanel({ view: 'gallery', sections: configurableSections(SUMMARY, THIS_SESSION, submit) });
        expect(screen.getTextContent()).toContain('2 on the board');
        screen.pressByTestId('add.entry.summary');
        await flushHookEffects({ cycles: 3 });
        expect(submit).toHaveBeenCalledTimes(1);
        expect(submit.mock.calls[0]![0]).toEqual({ bindings: { session: { kind: 'context', slot: 'session' } } });
        expect(screen.findAllByTestId('add.setup')).toHaveLength(0);
        // In place on the picked tile: the check lands beside its count; nothing is inserted above.
        expect(screen.findAllByTestId('add.entry.summary.added').length).toBeGreaterThan(0);
        expect(screen.findAllByTestId('add.feedback')).toHaveLength(0);
    });

    it('opens the inputs-first step when an input is missing; Cancel writes nothing', async () => {
        const submit = vi.fn();
        const close = vi.fn();
        // Home offers no Session, so the Session input is needed.
        const screen = await renderPanel({ view: 'gallery', sections: configurableSections(SUMMARY, {}, submit), onRequestClose: close });
        screen.pressByTestId('add.entry.summary');
        await flushHookEffects({ cycles: 2 });
        expect(screen.findAllByTestId('add.setup').length).toBeGreaterThan(0);
        expect(screen.getTextContent()).toContain('widgetAdd.setupTitle(widget=Summary)');
        expect(screen.getTextContent()).toContain('widgetAdd.stillNeeded(field=Session)');
        screen.pressByTestId('add.setup.submit');
        await flushHookEffects({ cycles: 2 });
        expect(submit).not.toHaveBeenCalled();
        screen.pressByTestId('add.setup.cancel');
        expect(close).toHaveBeenCalledTimes(1);
        expect(submit).not.toHaveBeenCalled();
    });

    it('goes back to the same gallery search, and adds once with the chosen value', async () => {
        const submit = vi.fn();
        const screen = await renderPanel({ view: 'gallery', sections: configurableSections(WITH_PERIOD, THIS_SESSION, submit) });
        screen.changeTextByTestId('add.search', 'Sum');
        await flushHookEffects({ cycles: 2 });
        screen.pressByTestId('add.entry.summary');
        await flushHookEffects({ cycles: 2 });
        expect(screen.findAllByTestId('add.setup').length).toBeGreaterThan(0);
        screen.pressByTestId('add.setup.back');
        await flushHookEffects({ cycles: 2 });
        expect(screen.findAllByTestId('add.setup')).toHaveLength(0);
        expect(screen.findByTestId('add.search')!.props.value).toBe('Sum');
        expect(submit).not.toHaveBeenCalled();

        screen.pressByTestId('add.entry.summary');
        await flushHookEffects({ cycles: 2 });
        screen.pressByTestId('add.setup.field.period.option.1');
        await flushHookEffects({ cycles: 2 });
        screen.pressByTestId('add.setup.submit');
        await flushHookEffects({ cycles: 3 });
        expect(submit).toHaveBeenCalledTimes(1);
        expect(submit.mock.calls[0]![0].bindings).toEqual({
            session: { kind: 'context', slot: 'session' },
            period: { kind: 'value', value: '30d' },
        });
        // Back on the gallery, with the check on the picked tile.
        expect(screen.findAllByTestId('add.setup')).toHaveLength(0);
        expect(screen.findAllByTestId('add.entry.summary.added').length).toBeGreaterThan(0);
    });

    it('picks a Session on Home from the sessions source, listing one the viewer cannot read without letting it be chosen', async () => {
        optionsResolve.options = [
            { value: { serverId: 'home', sessionId: 'B' }, label: 'Fix settings modal remount', description: 'Needs you' },
            { value: { serverId: 'home', sessionId: 'C' }, label: 'C', description: 'Recent', disabled: true },
        ];
        const summary = selectBuiltinWidgetCandidates().find((candidate) => candidate.definition?.kind === 'builtin' && candidate.definition.id === 'session_summary')!;
        const submit = vi.fn();
        const screen = await renderPanel({ view: 'gallery', serverId: 'home', sections: configurableSections(summary, {}, submit) });
        screen.pressByTestId('add.entry.summary');
        await flushHookEffects({ cycles: 4 });
        const menu = () => screen.findAllByType(DropdownMenu).find((node) => node.props.testID === 'add.setup.field.session')!;
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
        screen.pressByTestId('add.setup.submit');
        await flushHookEffects({ cycles: 3 });
        expect(submit).toHaveBeenCalledWith({ bindings: { session: { kind: 'value', value: { serverId: 'home', sessionId: 'B' } } } });
    });
});
