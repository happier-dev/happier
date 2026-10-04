import type * as React from 'react';
import { describe, expect, it, vi } from 'vitest';

import { createSessionSurfaceNoteDocumentV1, type SessionSurfaceItemV1 } from '@happier-dev/protocol/sessions/board';

import type { WidgetCandidate } from '@/components/widgets/widgetCatalog';
import { projectSessionBoard } from '@/sync/domains/session/board';

import { buildBoardWidgetAddContent, buildCompanionWidgetAddSections } from './widgetAddSections';

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
        ['conv', boardItem('External conversations', { kind: 'installedSurface', surface: { pluginId: 'happier.channels', localId: 'conversations' } })],
    ]),
    capabilities: { readTranscript: true, editSessionRecords: true },
    freshness: 'fresh',
    reachability: 'reachable',
    loading: 'idle',
    incomplete: false,
});

const ids = (entries: ReadonlyArray<{ id: string }>) => entries.map((entry) => entry.id);

describe('buildBoardWidgetAddContent', () => {
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

    it('keeps a plugin widget already on the Board in place, marked added, and adds another through the one command', () => {
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
        expect(run).toHaveBeenCalledWith({ kind: 'item.addInstalled', surface: { pluginId: 'happier.channels', localId: 'pr' }, title: 'This branch’s PR' });
        // Previews are lazy: built only when a gallery tile asks for one.
        expect(preview).not.toHaveBeenCalled();
        plugins[1]!.renderPreview?.();
        expect(preview).toHaveBeenCalledTimes(1);
    });
});

describe('buildCompanionWidgetAddSections', () => {
    it('lists glances, board items and pane links, each kept in place when already added', () => {
        const addItem = vi.fn();
        const sections = buildCompanionWidgetAddSections({
            refs: [
                { kind: 'builtin', id: 'changes' },
                { kind: 'widget', widgetId: 'note' },
                { kind: 'pane', paneId: 'terminal' },
            ],
            snapshot: BOARD,
            glanceCandidates: [candidate('pr', 'This branch’s PR')],
            pluginProjection: null,
            addItem,
        });
        const byId = new Map(sections.map((section) => [section.id, section.entries]));
        const glances = byId.get('glances')!;
        expect(ids(glances)).toEqual([
            'builtin-session_summary',
            'builtin-agent_plan',
            'builtin-changes',
            'builtin-local_services',
            'plugin-happier.channels/pr',
        ]);
        expect(glances.find((entry) => entry.id === 'builtin-changes')?.added).toBe(true);
        expect(byId.get('board')!.find((entry) => entry.id === 'board-note')?.added).toBe(true);
        const panes = byId.get('panes')!;
        expect(ids(panes)).not.toContain('pane-board');
        expect(ids(panes)).not.toContain('pane-git');
        expect(ids(panes)).not.toContain('pane-services');
        expect(panes.find((entry) => entry.id === 'pane-terminal')?.added).toBe(true);

        // A compact plugin glance is a Companion reference; nothing is created on the Board.
        glances.find((entry) => entry.id === 'plugin-happier.channels/pr')!.onPick();
        panes.find((entry) => entry.id === 'pane-files')?.onPick();
        expect(addItem.mock.calls).toEqual([
            [{ kind: 'plugin', surface: { pluginId: 'happier.channels', localId: 'pr' } }],
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
