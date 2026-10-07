import { describe, expect, it } from 'vitest';
import { act } from 'react-test-renderer';

import type { SessionBoardLayoutV1, SessionSurfaceItemV1 } from '@happier-dev/protocol/sessions/board';

import { renderHook } from '@/dev/testkit';
import {
    projectSessionBoard,
    type SessionBoardActionsPort,
    type SessionBoardItemUpsertInput,
    type SessionBoardMutationResult,
    type SessionBoardSnapshot,
} from '@/sync/domains/session/board';

import type { SessionBoardBinding } from './observeSessionBoard';
import { useSessionBoardController } from './useSessionBoardController';

/**
 * Adding an installed plugin widget to a Board.
 *
 * The failures pinned here are the ones the Board cannot show you: an Add entry
 * offered where no plugin actually contributes one, a creation that lands an item
 * record without its placement, and a stored record that captures a plugin
 * version or renderer and therefore goes stale on the next update.
 */

const LAYOUT: SessionBoardLayoutV1 = {
    v: 1,
    tabs: [{ id: 'overview', title: 'Overview', items: [] }],
} as SessionBoardLayoutV1;

const TWO_VIEW_LAYOUT: SessionBoardLayoutV1 = {
    v: 1,
    tabs: [
        { id: 'overview', title: 'Overview', items: [] },
        { id: 'release', title: 'Release', items: [] },
    ],
} as SessionBoardLayoutV1;

function readySnapshot(canEdit = true, layout: SessionBoardLayoutV1 = LAYOUT): SessionBoardSnapshot {
    return projectSessionBoard({
        layout: { revision: 'rev-layout', outcome: { status: 'ready', value: layout } },
        items: new Map(),
        capabilities: { readTranscript: true, editSessionRecords: canEdit },
        freshness: 'fresh',
        reachability: 'reachable',
        loading: 'idle',
        incomplete: false,
    });
}

function binding(snapshot: SessionBoardSnapshot): SessionBoardBinding {
    return { status: 'ready', snapshot };
}

function recordingActions(): Readonly<{ port: SessionBoardActionsPort; upserts: SessionBoardItemUpsertInput[] }> {
    const upserts: SessionBoardItemUpsertInput[] = [];
    const ok = {
        status: 'ok' as const,
        value: {
            v: 1,
            serverId: 'home-1',
            sessionId: 'session-1',
            result: { operation: 'upsert_item', itemId: 'item-1', itemRevision: 'rev-1', layoutRevision: 'rev-layout-2' },
            destination: null,
        } as SessionBoardMutationResult,
    };
    return {
        upserts,
        port: {
            upsertItem: async (input) => { upserts.push(input); return ok; },
            removeItem: async () => ok,
            updateLayout: async () => ok,
        },
    };
}

async function mountController(input: Readonly<{
    installedWidgetsAvailable?: boolean;
    canEdit?: boolean;
    actions?: SessionBoardActionsPort;
    layout?: SessionBoardLayoutV1;
}> = {}) {
    return await renderHook(() => useSessionBoardController({
        sessionId: 'session-1',
        serverId: 'home-1',
        binding: binding(readySnapshot(input.canEdit ?? true, input.layout)),
        actions: input.actions ?? recordingActions().port,
        ...(input.installedWidgetsAvailable === undefined
            ? {}
            : { installedWidgetsAvailable: input.installedWidgetsAvailable }),
    }));
}

describe('Board Add: installed plugin widgets', () => {
    it('adds independently bound native glance copies through the same atomic Board writer', async () => {
        const actions = recordingActions();
        const hook = await mountController({ installedWidgetsAvailable: true, actions: actions.port });
        for (const sessionId of ['session-A', 'session-B']) {
            await act(async () => { await hook.getCurrent().run({ kind: 'item.addWidget', definition: { kind: 'builtin', id: 'changes' },
                title: 'Changes', bindings: { session: { kind: 'value', value: { serverId: 'home-1', sessionId } } } }); });
        }
        expect(actions.upserts).toHaveLength(2);
        expect(actions.upserts.map(upsert => upsert.item.source)).toMatchObject([
            { kind: 'widget', instance: { definition: { kind: 'builtin', id: 'changes' }, bindings: { session: { value: { sessionId: 'session-A' } } } } },
            { kind: 'widget', instance: { definition: { kind: 'builtin', id: 'changes' }, bindings: { session: { value: { sessionId: 'session-B' } } } } },
        ]);
        expect(actions.upserts[0]?.itemId).not.toBe(actions.upserts[1]?.itemId);
        expect(actions.upserts.every(upsert => upsert.placement?.tabId === 'overview')).toBe(true);
    });
    it('omits From plugins… when this Session projects no admitted widget', async () => {
        const hook = await mountController({ installedWidgetsAvailable: false });
        expect(hook.getCurrent().addIntents).not.toContain('fromPlugins');
    });

    it('offers From plugins… only once a real contribution exists AND writes are possible', async () => {
        const offered = await mountController({ installedWidgetsAvailable: true });
        expect(offered.getCurrent().addIntents).toContain('fromPlugins');

        const readOnly = await mountController({ installedWidgetsAvailable: true, canEdit: false });
        expect(readOnly.getCurrent().addIntents).toEqual([]);
    });

    it('creates the item and its first placement in ONE aggregate mutation', async () => {
        const actions = recordingActions();
        const hook = await mountController({ installedWidgetsAvailable: true, actions: actions.port });
        await act(async () => { await hook.getCurrent().run({
            kind: 'item.addWidget',
            definition: { kind: 'installed', surface: { pluginId: 'acme.review', localId: 'review-status-widget' } },
            title: 'Review status',
            size: 'large',
        }); });

        expect(actions.upserts).toHaveLength(1);
        const created = actions.upserts[0]!;
        expect(created.expectedItemRevision).toBeNull();
        // Creation without an atomic placement leaves an item no Board view shows.
        expect(created.placement).toMatchObject({ tabId: 'overview', width: 'full' });
        expect(created.item.height).toEqual({ mode: 'fixed', size: 'tall' });
        expect(created.item.source).toEqual({
            kind: 'widget',
            instance: { v: 1, id: created.itemId, definition: { kind: 'installed', surface: { pluginId: 'acme.review', localId: 'review-status-widget' } }, bindings: {} },
        });
        expect(created.item.title).toBe('Review status');
        // No version, immutable generation, renderer, machine, Artifact or
        // placement is persisted: those are resolved at every mount.
        expect(Object.keys(created.item.source)).toEqual(['kind', 'instance']);
        expect(Object.keys(created.item.source.kind === 'widget' && created.item.source.instance.definition.kind === 'installed' ? created.item.source.instance.definition.surface : {}))
            .toEqual(['pluginId', 'localId']);
    });

    it('refuses to create while writes are blocked', async () => {
        const actions = recordingActions();
        const hook = await mountController({
            installedWidgetsAvailable: true,
            canEdit: false,
            actions: actions.port,
        });
        await act(async () => { await hook.getCurrent().run({
            kind: 'item.addWidget',
            definition: { kind: 'installed', surface: { pluginId: 'acme.review', localId: 'review-status-widget' } },
            title: 'Review status',
        }); });
        expect(actions.upserts).toHaveLength(0);
    });
});

describe('Board widget copies: Edit inputs and Rename', () => {
    const definition = { kind: 'installed' as const, surface: { pluginId: 'acme.ci', localId: 'checks' } };
    const copy = (id: string, branch: string): SessionSurfaceItemV1 => ({ v: 1, title: 'Checks', frame: 'card', height: { mode: 'auto', fallback: 'regular' },
        source: { kind: 'widget', instance: { v: 1, id, definition, bindings: { branch: { kind: 'value', value: branch } } } } });
    const twoCopies = projectSessionBoard({
        layout: { revision: 'rev-layout', outcome: { status: 'ready', value: { v: 1, tabs: [{ id: 'overview', title: 'Overview', items: [
            { itemId: 'main', width: 'medium' }, { itemId: 'web', width: 'medium' },
        ] }] } as SessionBoardLayoutV1 } },
        items: new Map([
            ['main', { revision: 'rev-main', outcome: { status: 'ready' as const, value: copy('main', 'main') } }],
            ['web', { revision: 'rev-web', outcome: { status: 'ready' as const, value: copy('web', 'web') } }],
        ]),
        capabilities: { readTranscript: true, editSessionRecords: true },
        freshness: 'fresh', reachability: 'reachable', loading: 'idle', incomplete: false,
    });

    async function mountCopies(actions: SessionBoardActionsPort) {
        return await renderHook(() => useSessionBoardController({
            sessionId: 'session-1', serverId: 'home-1', binding: binding(twoCopies), actions, installedWidgetsAvailable: true,
        }));
    }

    it('changes one copy’s bindings only, against its own revision, and reports that it applied', async () => {
        const actions = recordingActions();
        const hook = await mountCopies(actions.port);
        expect(hook.getCurrent().supports('item.inputs')).toBe(true);
        let outcome: unknown;
        await act(async () => { outcome = await hook.getCurrent().run({ kind: 'item.inputs', itemId: 'web', bindings: { branch: { kind: 'value', value: 'release' } } }); });
        expect(outcome).toEqual({ kind: 'applied' });
        expect(actions.upserts).toHaveLength(1);
        expect(actions.upserts[0]).toMatchObject({ itemId: 'web', expectedItemRevision: 'rev-web' });
        expect(actions.upserts[0]!.item).toEqual({ ...copy('web', 'web'), source: { kind: 'widget',
            instance: { v: 1, id: 'web', definition, bindings: { branch: { kind: 'value', value: 'release' } } } } });
    });

    it('renames a widget copy so its name travels with it, not only the card title', async () => {
        const actions = recordingActions();
        const hook = await mountCopies(actions.port);
        await act(async () => { await hook.getCurrent().run({ kind: 'item.rename', itemId: 'main', title: 'Release soak' }); });
        expect(actions.upserts).toHaveLength(1);
        expect(actions.upserts[0]!.item).toMatchObject({ title: 'Release soak', source: { kind: 'widget', instance: { id: 'main', displayName: 'Release soak',
            bindings: { branch: { kind: 'value', value: 'main' } } } } });
    });
});
