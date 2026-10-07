import type * as React from 'react';
import { describe, expect, it, vi } from 'vitest';

import { createSessionSurfaceNoteDocumentV1, type SessionSurfaceItemV1 } from '@happier-dev/protocol/sessions/board';

import { selectBuiltinWidgetCandidates, type WidgetCandidate } from '@/components/widgets/widgetCatalog';
import { projectSessionBoard } from '@/sync/domains/session/board';

import { buildBoardWidgetAddContent, buildCompanionWidgetAddSections } from './widgetAddSections';
import { resolveWidgetAddPick } from './widgetAddModel';

vi.mock('@/text', async () => {
    const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
    return createTextModuleMock();
});

/**
 * What each placement's Add popover offers (lab `cwidgets` WG/WL/WC3): only sources with a real
 * producer, already-added entries in place, and every pick handed to the placement's existing add
 * path exactly once.
 */
function candidate(localId: string, title: string): WidgetCandidate {
    return {
        surface: { pluginId: 'happier.channels', localId },
        key: `happier.channels/${localId}`,
        title,
        pluginName: 'Channels',
        sharedPluginName: false,
        icon: 'chat-circle',
        homeDefault: 'available',
        target: 'app',
        sizeDeclaration: { sizes: ['small', 'medium', 'wide', 'full', 'tall', 'large'], defaultSize: 'medium' },
    };
}

function boardItem(title: string, source: SessionSurfaceItemV1['source']) {
    const value: SessionSurfaceItemV1 = { v: 1, title, frame: 'card', height: { mode: 'auto', fallback: 'regular' }, source };
    return { revision: 'r1', outcome: { status: 'ready' as const, value } };
}

const BOARD = projectSessionBoard({
    layout: undefined,
    items: new Map([
        ['note', boardItem('Release checklist', { kind: 'declarative', document: createSessionSurfaceNoteDocumentV1('- [x] Backoff') })],
        ['conv', boardItem('External conversations', { kind: 'widget', instance: { v: 1, id: 'conv', definition: { kind: 'installed', surface: { pluginId: 'happier.channels', localId: 'conversations' } }, bindings: {} } })],
    ]),
    capabilities: { readTranscript: true, editSessionRecords: true },
    freshness: 'fresh',
    reachability: 'reachable',
    loading: 'idle',
    incomplete: false,
});

const ids = (entries: ReadonlyArray<{ id: string }>) => entries.map((entry) => entry.id);

describe('buildBoardWidgetAddContent', () => {
    it('lets a fully bound Board widget choose its size before the atomic Add', async () => {
        const run = vi.fn(async () => ({ kind: 'applied' as const }));
        const content = buildBoardWidgetAddContent({ intents: ['fromPlugins'], candidates: [{
            ...candidate('summary', 'Summary'), target: 'session', sessionInputPath: 'session',
            inputs: { fields: [{ path: 'session', title: 'Session', widget: 'json', required: true }] },
        }], snapshot: BOARD, run, context: SESSION_A,
            scope: { serverId: 'home', accountId: 'me', owner: { kind: 'sessionBoard', sessionId: 'A' } }, openPlugins: vi.fn() });
        const entry = content.sections.find(section => section.id === 'plugins')!.entries[0]!;
        const pick = resolveWidgetAddPick(entry);
        expect(pick.kind).toBe('setup');
        if (pick.kind !== 'setup') throw new Error('Size choice must be available before Add');
        expect(pick.setup.resolve(pick.setup.initial).status).toBe('ready');
        expect(run).not.toHaveBeenCalled();
        await pick.setup.submit({ ...pick.setup.initial, size: 'large' });
        expect(run).toHaveBeenCalledWith(expect.objectContaining({ kind: 'item.addWidget', size: 'large',
            bindings: { session: { kind: 'context', slot: 'session' } } }));
    });
    it('keeps required-input gallery tiles inert and previews sufficiently bound candidates lazily', () => {
        const preview = vi.fn((_candidate: WidgetCandidate) => 'admitted preview');
        const content = buildBoardWidgetAddContent({ intents: ['fromPlugins'], candidates: [
            candidate('app', 'App widget'), configurable('missing', 'Needs period'),
        ], snapshot: BOARD, run: vi.fn(), context: SESSION_A, renderPluginPreview: preview, openPlugins: vi.fn() });
        const entries = content.sections.flatMap(section => section.entries);
        expect(entries.find(entry => entry.title === 'Needs period')?.renderPreview).toBeUndefined();
        entries.find(entry => entry.title === 'App widget')!.renderPreview!();
        expect(preview.mock.calls[0]?.[0]).toMatchObject({ target: 'app' });
    });
    it('adds a live walkthrough through the Board controller rather than saving preview counts', () => {
        const run = vi.fn();
        const content = buildBoardWidgetAddContent({ intents: ['walkthrough'], candidates: [], snapshot: BOARD, run, openPlugins: vi.fn() });
        const entry = content.sections.flatMap((section) => section.entries).find((entry) => entry.id === 'walkthrough');
        expect(entry).toBeDefined();
        entry!.onPick();
        expect(run).toHaveBeenCalledWith({ kind: 'add', intent: 'walkthrough' });
    });
    it('offers only the sources this Board has a producer for', () => {
        const content = buildBoardWidgetAddContent({
            intents: ['note', 'askAgent'],
            candidates: [candidate('conversations', 'External conversations')],
            snapshot: BOARD,
            run: vi.fn(),
            openPlugins: vi.fn(),
        });
        expect(content.sections.flatMap((section) => ids(section.entries))).toEqual(['note']);
        expect(content.ask).toBeDefined();
    });

    it('keeps a plugin widget with no inputs in place, marked Added, and adds another widget through the one command', () => {
        const run = vi.fn();
        const preview = vi.fn(() => 'preview');
        const content = buildBoardWidgetAddContent({
            intents: ['note', 'interactiveView', 'fromPlugins'],
            candidates: [candidate('conversations', 'External conversations'), candidate('pr', 'This branch’s PR')],
            snapshot: BOARD,
            run,
            renderPluginPreview: preview,
            openPlugins: vi.fn(),
        });
        const plugins = content.sections.find((section) => section.id === 'plugins')!.entries;
        expect(plugins.map((entry) => [entry.id, entry.added === true])).toEqual([
            ['plugin-happier.channels/conversations', true],
            ['plugin-happier.channels/pr', false],
        ]);
        expect(ids(content.sections.find((section) => section.id === 'make')!.entries)).toEqual(['note', 'interactiveView', 'findMore']);
        expect(content.ask).toBeUndefined();

        plugins[1]!.onPick();
        expect(run).toHaveBeenCalledTimes(1);
        expect(run).toHaveBeenCalledWith({ kind: 'item.addWidget', definition: { kind: 'installed', surface: { pluginId: 'happier.channels', localId: 'pr' } }, title: 'This branch’s PR', bindings: {}, size: 'medium' });
        // Previews are lazy: built only when a gallery tile asks for one.
        expect(preview).not.toHaveBeenCalled();
        plugins[1]!.renderPreview?.();
        expect(preview).toHaveBeenCalledTimes(1);
    });
});

describe('buildCompanionWidgetAddSections', () => {
    it('offers saved definitions as independent personal copies under Your widgets, preserving shared Board refs', async () => {
        const addItem = vi.fn();
        const { surface: _surface, ...metadata } = candidate('saved', 'Signups');
        const yours: WidgetCandidate = { ...metadata, definition: { kind: 'artifact', artifactId: 'signups' },
            inputs: { fields: [{ path: 'period', title: 'Period', widget: 'text', required: true }] } };
        const sections = buildCompanionWidgetAddSections({ refs: [{ kind: 'widget', widgetId: 'note' }], snapshot: BOARD,
            glanceCandidates: [candidate('pr', 'PR'), yours], pluginProjection: null, addItem });
        expect(sections.find(section => section.id === 'glances')!.entries.map(entry => entry.title)).toEqual(['PR']);
        const entry = sections.find(section => section.id === 'yours')!.entries[0]!;
        await expect(entry.setup!().submit({ bindings: { period: { kind: 'value', value: '7d' } } })).resolves.toEqual({ ok: true });
        expect(addItem.mock.calls[0]?.[0]).toMatchObject({ kind: 'instance', instance: { definition: { kind: 'artifact', artifactId: 'signups' },
            bindings: { period: { kind: 'value', value: '7d' } } } });
        expect(sections.find(section => section.id === 'board')!.entries.find(entry => entry.id === 'board-note')?.added).toBe(true);
    });
    it('counts native configured copies only on this surface and creates an independent followed copy', () => {
        const addItem = vi.fn();
        const native = selectBuiltinWidgetCandidates().find(row => row.definition?.kind === 'builtin' && row.definition.id === 'changes')!;
        const refs = ['A', 'B'].map(sessionId => ({ kind: 'instance' as const, instance: { v: 1 as const, id: sessionId,
            definition: { kind: 'builtin' as const, id: 'changes' }, bindings: { session: { kind: 'value' as const, value: { serverId: 'home', sessionId } } } } }));
        const sections = buildCompanionWidgetAddSections({ refs, snapshot: BOARD, glanceCandidates: [native],
            pluginProjection: null, addItem, context: { session: { ref: { serverId: 'home', sessionId: 'C' }, label: 'C' } } });
        const entry = sections.find(row => row.id === 'glances')!.entries[0]!;
        expect(entry.count).toBe('widgetAdd.countInCompanion(count=2)');
        expect(entry.added).not.toBe(true);
        entry.onPick();
        const result = addItem.mock.calls[0]![0];
        expect(result).toMatchObject({ kind: 'instance', instance: { definition: { kind: 'builtin', id: 'changes' }, bindings: { session: { kind: 'context', slot: 'session' } } } });
        expect(refs.some(ref => ref.instance.id === result.instance.id)).toBe(false);
        expect(refs.map(ref => ref.instance.bindings.session.value.sessionId)).toEqual(['A', 'B']);
    });
    it('lists glances, board items and pane links, each kept in place when already added', () => {
        const addItem = vi.fn();
        const sections = buildCompanionWidgetAddSections({
            refs: [
                { kind: 'builtin', id: 'changes' },
                { kind: 'widget', widgetId: 'note' },
                { kind: 'pane', paneId: 'terminal' },
            ],
            snapshot: BOARD,
            glanceCandidates: [...selectBuiltinWidgetCandidates(), candidate('pr', 'This branch’s PR')],
            pluginProjection: null,
            addItem,
        });
        const byId = new Map(sections.map((section) => [section.id, section.entries]));
        const glances = byId.get('glances')!;
        expect(ids(glances)).toEqual([
            'plugin-builtin:session_summary',
            'plugin-builtin:agent_plan',
            'plugin-builtin:changes',
            'plugin-builtin:local_services',
            'plugin-happier.channels/pr',
        ]);
        expect(glances.find((entry) => entry.id === 'plugin-builtin:changes')?.setup).toBeDefined();
        expect(glances.find((entry) => entry.id === 'plugin-builtin:changes')?.added).not.toBe(true);
        expect(byId.get('board')!.find((entry) => entry.id === 'board-note')?.added).toBe(true);
        const panes = byId.get('panes')!;
        expect(ids(panes)).not.toContain('pane-board');
        expect(ids(panes)).not.toContain('pane-git');
        expect(ids(panes)).not.toContain('pane-services');
        expect(panes.find((entry) => entry.id === 'pane-terminal')?.added).toBe(true);

        // A compact plugin glance is a Companion reference; nothing is created on the Board.
        glances.find((entry) => entry.id === 'plugin-happier.channels/pr')!.onPick();
        panes.find((entry) => entry.id === 'pane-files')?.onPick();
        expect(addItem.mock.calls).toMatchObject([
            [{ kind: 'instance', instance: { v: 1, definition: { kind: 'installed', surface: { pluginId: 'happier.channels', localId: 'pr' } }, bindings: {} } }],
            [{ kind: 'pane', paneId: 'files' }],
        ]);
    });

    it('previews a Board note inert, and leaves executable items on their glyph', () => {
        const preview = vi.fn((_document: unknown): React.ReactNode => 'preview');
        const sections = buildCompanionWidgetAddSections({
            refs: [],
            snapshot: BOARD,
            glanceCandidates: [],
            pluginProjection: null,
            addItem: vi.fn(),
            renderNotePreview: preview,
        });
        const board = sections.find((section) => section.id === 'board')!.entries;
        expect(board.find((entry) => entry.id === 'board-note')?.renderPreview).toBeDefined();
        expect(board.find((entry) => entry.id === 'board-conv')?.renderPreview).toBeUndefined();
        board.find((entry) => entry.id === 'board-note')!.renderPreview!();
        expect(preview).toHaveBeenCalledTimes(1);
    });
});

/**
 * Configurable widgets (lab `dashboards` dbind G, dadd A/Ab): a widget with inputs is counted by the
 * copies already here and can be added again, differently bound; its Set up step builds the copy's
 * bindings, and the pick goes through the placement's one add path.
 */
function configurable(localId: string, title: string): WidgetCandidate {
    return {
        ...candidate(localId, title),
        target: 'session',
        sessionInputPath: 'session',
        inputs: { fields: [
            { path: 'session', title: 'Session', widget: 'json', required: true },
            { path: 'period', title: 'Period', widget: 'select', required: true, options: [
                { value: '7d', label: '7 days' }, { value: '30d', label: '30 days' },
            ] },
        ] },
    };
}

const SESSION_A = { session: { ref: { serverId: 'home', sessionId: 'A' }, label: 'Retry relay handshake on 503' } } as const;

describe('configurable widgets in the Add popovers', () => {
    const summaryCopy = (id: string, sessionId: string) => boardItem('Summary', { kind: 'widget', instance: {
        v: 1, id, definition: { kind: 'installed', surface: { pluginId: 'happier.channels', localId: 'summary' } },
        bindings: { session: { kind: 'value', value: { serverId: 'home', sessionId } }, period: { kind: 'value', value: '7d' } },
    } });
    const twoCopies = projectSessionBoard({
        layout: undefined,
        items: new Map([['s1', summaryCopy('s1', 'A')], ['s2', summaryCopy('s2', 'B')]]),
        capabilities: { readTranscript: true, editSessionRecords: true },
        freshness: 'fresh', reachability: 'reachable', loading: 'idle', incomplete: false,
    });

    it('counts copies on the Board instead of disabling them, and its step adds a copy bound as chosen', async () => {
        const run = vi.fn(async () => ({ kind: 'applied' as const }));
        const content = buildBoardWidgetAddContent({
            intents: ['fromPlugins'],
            candidates: [configurable('summary', 'Summary')],
            snapshot: twoCopies,
            run,
            context: SESSION_A,
            openPlugins: vi.fn(),
        });
        const entry = content.sections.find((section) => section.id === 'plugins')!.entries[0]!;
        expect(entry.added).toBeUndefined();
        expect(entry.count).toBe('widgetAdd.countOnBoard(count=2)');
        const setup = entry.setup!();
        // The Board's Session follows "This session"; Period still needs a choice, so the step shows.
        expect(setup.initial.bindings).toEqual({ session: { kind: 'context', slot: 'session' } });
        expect(setup.resolve(setup.initial).status).toBe('selection_required');
        const chosen = { ...setup.initial, bindings: { ...setup.initial.bindings, period: { kind: 'value' as const, value: '30d' } } };
        expect(setup.resolve(chosen)).toEqual({ status: 'ready', input: { session: { serverId: 'home', sessionId: 'A' }, period: '30d' } });
        await expect(setup.submit(chosen)).resolves.toEqual({ ok: true });
        expect(run).toHaveBeenCalledTimes(1);
        expect(run).toHaveBeenCalledWith({
            kind: 'item.addWidget', definition: { kind: 'installed', surface: { pluginId: 'happier.channels', localId: 'summary' } }, title: 'Summary',
            bindings: { session: { kind: 'context', slot: 'session' }, period: { kind: 'value', value: '30d' } },
            size: 'medium',
        });
    });

    it('reports a refused add as the step\'s error rather than success', async () => {
        const content = buildBoardWidgetAddContent({
            intents: ['fromPlugins'],
            candidates: [configurable('summary', 'Summary')],
            snapshot: BOARD,
            run: vi.fn(async () => { throw new Error('refused'); }),
            context: SESSION_A,
            openPlugins: vi.fn(),
        });
        const entry = content.sections.find((section) => section.id === 'plugins')!.entries[0]!;
        expect(entry.count).toBeUndefined();
        const setup = entry.setup!();
        await expect(setup.submit(setup.initial)).resolves.toEqual({ ok: false, message: 'widgetAdd.addFailed' });
    });

    it('keeps the step open when the Board did not apply the add (denied, unavailable or nothing ran)', async () => {
        for (const outcome of [{ kind: 'denied' as const }, { kind: 'unavailable' as const, reason: 'offline' }, undefined]) {
            const content = buildBoardWidgetAddContent({
                intents: ['fromPlugins'],
                candidates: [configurable('summary', 'Summary')],
                snapshot: BOARD,
                run: vi.fn(async () => outcome),
                context: SESSION_A,
                openPlugins: vi.fn(),
            });
            const setup = content.sections.find((section) => section.id === 'plugins')!.entries[0]!.setup!();
            const chosen = { bindings: { ...setup.initial.bindings, period: { kind: 'value' as const, value: '30d' } } };
            await expect(setup.submit(chosen)).resolves.toEqual({ ok: false, message: 'widgetAdd.addFailed' });
        }
    });

    it('offers Happier’s own widgets in a Built in section, apart from plugin widgets', () => {
        const content = buildBoardWidgetAddContent({
            intents: ['fromPlugins'],
            candidates: [...selectBuiltinWidgetCandidates(), configurable('summary', 'Summary')],
            snapshot: BOARD,
            run: vi.fn(),
            context: SESSION_A,
            openPlugins: vi.fn(),
        });
        expect(ids(content.sections.find((section) => section.id === 'builtins')!.entries)).toEqual([
            'plugin-builtin:session_summary', 'plugin-builtin:agent_plan', 'plugin-builtin:changes', 'plugin-builtin:local_services',
        ]);
        expect(ids(content.sections.find((section) => section.id === 'plugins')!.entries)).toEqual(['plugin-happier.channels/summary']);
    });

    it('adds a direct personal Companion copy with its own instance id and bindings, counted by definition', async () => {
        const addItem = vi.fn();
        const existing = { kind: 'instance' as const, instance: {
            v: 1 as const, id: 'mine', definition: { kind: 'installed' as const, surface: { pluginId: 'happier.channels', localId: 'summary' } },
            bindings: { session: { kind: 'value' as const, value: { serverId: 'home', sessionId: 'B' } }, period: { kind: 'value' as const, value: '7d' } },
        } };
        const sections = buildCompanionWidgetAddSections({
            refs: [existing],
            snapshot: BOARD,
            glanceCandidates: [configurable('summary', 'Summary')],
            pluginProjection: null,
            addItem,
            context: SESSION_A,
        });
        const entry = sections.find((section) => section.id === 'glances')!.entries.find((candidate) => candidate.id === 'plugin-happier.channels/summary')!;
        expect(entry.count).toBe('widgetAdd.countInCompanion(count=1)');
        const setup = entry.setup!();
        const pinnedB = { bindings: { session: { kind: 'value' as const, value: { serverId: 'home', sessionId: 'B' } }, period: { kind: 'value' as const, value: '30d' } } };
        await setup.submit(pinnedB);
        expect(addItem).toHaveBeenCalledTimes(1);
        const added = addItem.mock.calls[0]![0];
        expect(added).toMatchObject({ kind: 'instance', instance: { v: 1, definition: existing.instance.definition, bindings: pinnedB.bindings } });
        expect(added.instance.id).not.toBe('mine');
    });
});
