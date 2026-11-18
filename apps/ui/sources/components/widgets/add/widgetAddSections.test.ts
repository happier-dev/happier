import type * as React from 'react';
import { describe, expect, it, vi } from 'vitest';

import { createSessionSurfaceNoteDocumentV1, type SessionSurfaceItemV1 } from '@happier-dev/protocol/sessions/board';
import { HEALTH_BUILTIN_WIDGET_IDS_V1, HOME_BUILTIN_WIDGET_IDS_V1, MACHINE_BUILTIN_WIDGET_IDS_V1, PROJECT_BUILTIN_WIDGET_IDS_V1, isProjectSurfaceBuiltinWidgetIdV1, SESSION_COMPANION_BUILTIN_ITEM_IDS, USAGE_BUILTIN_WIDGET_IDS_V1 } from '@happier-dev/protocol/widgets';

import { selectBuiltinWidgetCandidates, type WidgetCandidate } from '@/components/widgets/widgetCatalog';
import { projectSessionBoard } from '@/sync/domains/session/board';

import { buildBoardWidgetAddContent, buildCompanionWidgetAddSections } from './widgetAddSections';
import { buildAccountWidgetAddSections } from './accountWidgetAddSections';

vi.mock('@/text', async () => {
    const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
    return createTextModuleMock();
});

/**
 * What each placement's Add popover offers (lab `cwidgets` WG/WL/WC3): only sources with a real
 * producer, already-added entries in place, and every pick handed to the placement's existing add
 * path exactly once.
 */
function candidate(localId: string, title: string): Extract<WidgetCandidate, { surface: unknown }> {
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
        const setup = content.sections.find(section => section.id === 'plugin:happier.channels')!.entries[0]!.setup!();
        expect(setup.resolve(setup.initial).status).toBe('ready');
        expect(run).not.toHaveBeenCalled();
        await setup.submit({ ...setup.initial, size: 'large' });
        expect(run).toHaveBeenCalledWith(expect.objectContaining({ kind: 'item.addWidget', size: 'large',
            bindings: { session: { kind: 'context', slot: 'session' } } }));
    });
    it('previews a widget only through its pane, lazily, at the draft its inputs resolve to', () => {
        const preview = vi.fn((_candidate: WidgetCandidate) => 'admitted preview');
        const content = buildBoardWidgetAddContent({ intents: ['fromPlugins'], candidates: [
            candidate('app', 'App widget'), configurable('missing', 'Needs period'),
        ], snapshot: BOARD, run: vi.fn(), context: SESSION_A, renderSetupPreview: preview, openPlugins: vi.fn() });
        const entries = content.sections.flatMap(section => section.entries);
        expect(entries.every(entry => entry.renderPreview === undefined)).toBe(true);
        expect(preview).not.toHaveBeenCalled();
        const setup = entries.find(entry => entry.title === 'App widget')!.setup!();
        setup.renderPreview!({ input: {}, draft: setup.initial });
        expect(preview.mock.calls[0]?.[0]).toMatchObject({ target: 'app' });
    });
    it('adds a live walkthrough through the Board controller rather than saving preview counts', () => {
        const run = vi.fn();
        const content = buildBoardWidgetAddContent({ intents: ['walkthrough'], candidates: [], snapshot: BOARD, run, openPlugins: vi.fn() });
        const entry = content.sections.flatMap((section) => section.entries).find((entry) => entry.id === 'walkthrough');
        expect(entry).toBeDefined();
        entry!.onPick!();
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

    it('keeps a plugin widget with no inputs in place, marked Added, and adds another widget through the one command', async () => {
        const run = vi.fn(async () => ({ kind: 'applied' as const }));
        const content = buildBoardWidgetAddContent({
            intents: ['note', 'interactiveView', 'fromPlugins'],
            candidates: [candidate('conversations', 'External conversations'), candidate('pr', 'This branch’s PR')],
            snapshot: BOARD,
            run,
            openPlugins: vi.fn(),
        });
        const plugins = content.sections.find((section) => section.id === 'plugin:happier.channels')!.entries;
        expect(plugins.map((entry) => [entry.id, entry.added === true])).toEqual([
            ['plugin-happier.channels/conversations', true],
            ['plugin-happier.channels/pr', false],
        ]);
        expect(ids(content.sections.find((section) => section.id === 'make')!.entries)).toEqual(['note', 'interactiveView', 'findMore']);
        expect(content.ask).toBeUndefined();

        const setup = plugins[1]!.setup!();
        await setup.submit(setup.initial);
        expect(run).toHaveBeenCalledTimes(1);
        expect(run).toHaveBeenCalledWith({ kind: 'item.addWidget', definition: { kind: 'installed', surface: { pluginId: 'happier.channels', localId: 'pr' } }, title: 'This branch’s PR', bindings: {}, size: 'medium' });
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
        expect(sections.map(section => section.id)).toEqual(['builtins', 'plugin:happier.channels', 'yours', 'board', 'panes']);
        expect(sections.find(section => section.id === 'plugin:happier.channels')!.entries.map(entry => entry.title)).toEqual(['PR']);
        const entry = sections.find(section => section.id === 'yours')!.entries[0]!;
        await expect(entry.setup!().submit({ bindings: { period: { kind: 'value', value: '7d' } } })).resolves.toEqual({ ok: true });
        expect(addItem.mock.calls[0]?.[0]).toMatchObject({ kind: 'instance', instance: { definition: { kind: 'artifact', artifactId: 'signups' },
            bindings: { period: { kind: 'value', value: '7d' } } } });
        expect(sections.find(section => section.id === 'board')!.entries.find(entry => entry.id === 'board-note')?.added).toBe(true);
    });
    it('counts native configured copies only on this surface and creates an independent followed copy', async () => {
        const addItem = vi.fn();
        const native = selectBuiltinWidgetCandidates().find(row => row.definition?.kind === 'builtin' && row.definition.id === 'changes')!;
        const refs = ['A', 'B'].map(sessionId => ({ kind: 'instance' as const, instance: { v: 1 as const, id: sessionId,
            definition: { kind: 'builtin' as const, id: 'changes' }, bindings: { session: { kind: 'value' as const, value: { serverId: 'home', sessionId } } } } }));
        const sections = buildCompanionWidgetAddSections({ refs, snapshot: BOARD, glanceCandidates: [native],
            pluginProjection: null, addItem, context: { session: { ref: { serverId: 'home', sessionId: 'C' }, label: 'C' } } });
        const entry = sections.find(row => row.id === 'builtins')!.entries[0]!;
        expect(entry.count).toBe('widgetAdd.countInCompanion(count=2)');
        expect(entry.added).not.toBe(true);
        const setup = entry.setup!();
        await setup.submit(setup.initial);
        const result = addItem.mock.calls[0]![0];
        expect(result).toMatchObject({ kind: 'instance', instance: { definition: { kind: 'builtin', id: 'changes' }, bindings: { session: { kind: 'context', slot: 'session' } } } });
        expect(refs.some(ref => ref.instance.id === result.instance.id)).toBe(false);
        expect(refs.map(ref => ref.instance.bindings.session.value.sessionId)).toEqual(['A', 'B']);
    });
    it('groups widgets by provenance, then lists Board items and pane links with their existing references', () => {
        const addItem = vi.fn();
        const sections = buildCompanionWidgetAddSections({
            refs: [
                { kind: 'builtin', id: 'changes' },
                { kind: 'widget', widgetId: 'note' },
                { kind: 'pane', paneId: 'terminal' },
            ],
            snapshot: BOARD,
            glanceCandidates: [...selectBuiltinWidgetCandidates(),
                { ...candidate('pr', 'This branch’s PR'), sharedPluginName: true },
                { ...candidate('checks', 'Checks'), surface: { pluginId: 'happier.checks', localId: 'checks' },
                    key: 'happier.checks/checks', sharedPluginName: true },
            ],
            pluginProjection: null,
            addItem,
        });
        const byId = new Map(sections.map((section) => [section.id, section.entries]));
        expect(sections.map(section => [section.id, section.title, section.pluginId])).toEqual([
            ['builtins', 'widgetAdd.builtIn', undefined],
            ['plugin:happier.channels', 'Channels (happier.channels)', 'happier.channels'],
            ['plugin:happier.checks', 'Channels (happier.checks)', 'happier.checks'],
            ['board', 'widgetAdd.onBoard', undefined],
            ['panes', 'widgetAdd.panes', undefined],
        ]);
        const builtins = byId.get('builtins')!;
        expect(ids(builtins)).toEqual([
            ...[...SESSION_COMPANION_BUILTIN_ITEM_IDS, ...PROJECT_BUILTIN_WIDGET_IDS_V1.filter(id => !isProjectSurfaceBuiltinWidgetIdV1(id)), ...USAGE_BUILTIN_WIDGET_IDS_V1, ...MACHINE_BUILTIN_WIDGET_IDS_V1, ...HOME_BUILTIN_WIDGET_IDS_V1, ...HEALTH_BUILTIN_WIDGET_IDS_V1].map(id => `plugin-builtin:${id}`),
        ]);
        expect(ids(byId.get('plugin:happier.channels')!)).toEqual(['plugin-happier.channels/pr']);
        expect(ids(byId.get('plugin:happier.checks')!)).toEqual(['plugin-happier.checks/checks']);
        expect(builtins.find((entry) => entry.id === 'plugin-builtin:changes')?.setup).toBeDefined();
        expect(builtins.find((entry) => entry.id === 'plugin-builtin:changes')?.added).not.toBe(true);
        expect(byId.get('board')!.find((entry) => entry.id === 'board-note')?.added).toBe(true);
        const panes = byId.get('panes')!;
        expect(ids(panes)).not.toContain('pane-board');
        expect(ids(panes)).not.toContain('pane-git');
        expect(ids(panes)).not.toContain('pane-services');
        expect(panes.find((entry) => entry.id === 'pane-terminal')?.added).toBe(true);

        // A compact plugin glance is a Companion reference; nothing is created on the Board.
        byId.get('plugin:happier.channels')![0]!.onPick!();
        panes.find((entry) => entry.id === 'pane-files')?.onPick?.();
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
        const entry = content.sections.find((section) => section.id === 'plugin:happier.channels')!.entries[0]!;
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
        const entry = content.sections.find((section) => section.id === 'plugin:happier.channels')!.entries[0]!;
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
            const setup = content.sections.find((section) => section.id === 'plugin:happier.channels')!.entries[0]!.setup!();
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
            ...[...SESSION_COMPANION_BUILTIN_ITEM_IDS, ...PROJECT_BUILTIN_WIDGET_IDS_V1.filter(id => !isProjectSurfaceBuiltinWidgetIdV1(id)), ...USAGE_BUILTIN_WIDGET_IDS_V1, ...MACHINE_BUILTIN_WIDGET_IDS_V1, ...HOME_BUILTIN_WIDGET_IDS_V1, ...HEALTH_BUILTIN_WIDGET_IDS_V1].map(id => `plugin-builtin:${id}`),
        ]);
        expect(ids(content.sections.find((section) => section.id === 'plugin:happier.channels')!.entries)).toEqual(['plugin-happier.channels/summary']);
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
        const entry = sections.find((section) => section.id === 'plugin:happier.channels')!.entries.find((candidate) => candidate.id === 'plugin-happier.channels/summary')!;
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

describe('built-in widgets by host surface', () => {
    const labels = { count: (count: number) => `${count} here`, submit: 'Add' };
    const addSections = (ownerKind: 'home' | 'project') => buildAccountWidgetAddSections({
        candidates: selectBuiltinWidgetCandidates(), instances: [], addInstance: vi.fn(), labels,
        scope: { serverId: 's', accountId: 'a', owner: ownerKind === 'home' ? { kind: 'home' } : { kind: 'project', projectId: 'p' } },
    });
    const builtIns = (ownerKind: 'home' | 'project') => addSections(ownerKind).find(section => section.id === 'builtins')!.entries.map(entry => entry.id);
    const everyBuiltIn = (ownerKind: 'home' | 'project') => addSections(ownerKind).filter(section => section.id.startsWith('builtins'))
        .flatMap(section => section.entries.map(entry => entry.id));

    it.each([
        { name: 'Project', owner: { kind: 'project', projectId: 'p' } as const, families: ['projects', 'machines', 'usage', 'session'] },
        { name: 'named Project dashboard', owner: { kind: 'project', projectId: 'p', layoutId: 'release' } as const, families: ['projects', 'machines', 'usage', 'session'] },
        { name: 'Machine', owner: { kind: 'corePage', pageId: 'machines', area: 'main' } as const, families: ['machines', 'usage', 'projects', 'session'] },
        { name: 'Account Home', owner: { kind: 'home' } as const, families: ['machines', 'usage', 'projects', 'session'] },
        { name: 'no context', owner: null, families: ['machines', 'usage', 'projects', 'session'] },
    ])('ranks matching families first on $name and preserves the remaining catalog order', ({ owner, families }) => {
        const candidates = selectBuiltinWidgetCandidates();
        const sections = buildAccountWidgetAddSections({
            candidates, instances: [], addInstance: vi.fn(), labels,
            scope: owner ? { serverId: 's', accountId: 'a', owner } : null,
        });
        expect(sections.map(section => section.id)).toEqual([...families.map(id => `builtins:${id}`), 'builtins']);
        const projects = sections.find(section => section.id === 'builtins:projects');
        const projectWidgetIds = owner === null || owner.kind === 'project'
            ? PROJECT_BUILTIN_WIDGET_IDS_V1
            : PROJECT_BUILTIN_WIDGET_IDS_V1.filter(id => !isProjectSurfaceBuiltinWidgetIdV1(id));
        expect(projects?.entries.map(entry => entry.id)).toEqual(projectWidgetIds.map(id => `plugin-builtin:${id}`));
    });

    it('offers the ten Machine widgets as one built-in Machines group, apart from the other built-ins (plan 60 AGW-14)', () => {
        const sections = buildAccountWidgetAddSections({
            candidates: selectBuiltinWidgetCandidates(), instances: [], addInstance: vi.fn(), labels,
            scope: { serverId: 's', accountId: 'a', owner: { kind: 'home' } },
        });
        const machines = sections.find(section => section.id === 'builtins:machines');
        expect(machines?.entries.map(entry => entry.id)).toEqual(MACHINE_BUILTIN_WIDGET_IDS_V1.map(id => `plugin-builtin:${id}`));
        expect(machines?.hint).toBeTruthy();
        expect(builtIns('home').some(id => id.startsWith('plugin-builtin:machine_'))).toBe(false);
        expect(sections.findIndex(section => section.id === 'builtins:machines')).toBeLessThan(sections.findIndex(section => section.id === 'builtins'));
    });

    it('offers the Usage widgets as one built-in Usage group, and the page’s own group leads on its page', () => {
        const sectionIds = (owner: Parameters<typeof buildAccountWidgetAddSections>[0]['scope'] extends infer S
            ? S extends { owner: infer O } ? O : never : never) => buildAccountWidgetAddSections({
            candidates: selectBuiltinWidgetCandidates(), instances: [], addInstance: vi.fn(), labels,
            scope: { serverId: 's', accountId: 'a', owner },
        });
        const home = sectionIds({ kind: 'home' });
        const usage = home.find(section => section.id === 'builtins:usage');
        expect(usage?.entries.map(entry => entry.id)).toEqual(USAGE_BUILTIN_WIDGET_IDS_V1.map(id => `plugin-builtin:${id}`));
        expect(usage?.hint).toBeTruthy();
        expect(builtIns('home').some(id => id.startsWith('plugin-builtin:usage_'))).toBe(false);
        const onUsagePage = sectionIds({ kind: 'corePage', pageId: 'usage', area: 'main' });
        expect(onUsagePage[0]?.id).toBe('builtins:usage');
        expect(home[0]?.id).toBe('builtins:machines');
    });

    it('offers the four Session-companion widgets as one built-in Companion group, apart from the other built-ins', () => {
        const sections = buildAccountWidgetAddSections({
            candidates: selectBuiltinWidgetCandidates(), instances: [], addInstance: vi.fn(), labels,
            scope: { serverId: 's', accountId: 'a', owner: { kind: 'home' } },
        });
        const session = sections.find(section => section.id === 'builtins:session');
        expect(session?.family).toBe(true);
        expect(session?.entries.map(entry => entry.id)).toEqual(SESSION_COMPANION_BUILTIN_ITEM_IDS.map(id => `plugin-builtin:${id}`));
        expect(builtIns('home').some(id => SESSION_COMPANION_BUILTIN_ITEM_IDS.some(item => id === `plugin-builtin:${item}`))).toBe(false);
        // Every family is flagged: the Board's short lead is whatever remains unflagged.
        expect(sections.filter(section => section.id.startsWith('builtins:')).every(section => section.family === true)).toBe(true);
    });

    it('offers a checkout widget on Home and Project for explicit target selection', () => {
        expect(everyBuiltIn('home')).toContain('plugin-builtin:project_readme');
        expect(everyBuiltIn('project')).toEqual(expect.arrayContaining(['plugin-builtin:project_readme']));
    });
    it('offers Session-target and app widgets in a page area for explicit target selection', () => {
        const candidates = [...selectBuiltinWidgetCandidates(), configurable('summary', 'Summary')];
        const sections = buildAccountWidgetAddSections({ candidates, instances: [], addInstance: vi.fn(), labels,
            scope: { serverId: 's', accountId: 'a', owner: { kind: 'corePage', pageId: 'usage', area: 'main' } } });
        const offered = sections.flatMap(section => section.entries.map(entry => entry.id));
        expect(offered).toContain('plugin-builtin:session_summary');
        expect(offered).toContain('plugin-happier.channels/summary');
        expect(offered).toContain('plugin-builtin:usage_daily');
    });
});
