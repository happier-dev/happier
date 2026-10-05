import { describe, expect, it } from 'vitest';

import { buildSessionListDragSource } from '../drop-resolution/buildSessionListDragSource';
import { buildSessionListTreeRows } from '../drop-resolution/buildSessionListTreeRows';
import { treeRowId } from '../drop-resolution/treeRowId';
import type { SessionFolderWorkspaceRefV1 } from '@/sync/domains/session/folders';
import type { SessionListIndexItem } from '@/sync/domains/sessionList/sessionListIndex';

import {
    beginSessionListStagedMove,
    resolveSessionListStagedMoveResult,
    stepSessionListStagedMove,
} from './sessionListStagedMove';

const S = 'server-a';
const workspace: SessionFolderWorkspaceRefV1 = { t: 'workspaceScope', serverId: S, machineId: 'machine-a', rootPath: '/repo' };

function session(sessionId: string): SessionListIndexItem {
    return {
        type: 'session', sessionId, serverId: S, storageKind: 'persisted', groupKey: 'project-a', groupKind: 'project',
        folderId: null, folderDepth: 0, workspace,
    };
}

const items: SessionListIndexItem[] = [
    { type: 'header', title: 'happier', headerKind: 'project', groupKey: 'project-a', workspaceKey: 'project-a', workspace, serverId: S },
    session('fix'),
    session('review'),
    session('relay'),
    session('craft'),
];

function setup(sourceSessionId: string) {
    const tree = buildSessionListTreeRows({ items });
    const source = buildSessionListDragSource({ tree, sourceRowId: treeRowId.session(S, sourceSessionId) });
    return { tree, source };
}

describe('session list staged keyboard move (KS)', () => {
    it('starts where the row is, so dropping at once changes nothing', () => {
        const { tree, source } = setup('review');
        const state = beginSessionListStagedMove({ tree, source });
        expect(state.place).toEqual({ kind: 'origin' });
        expect(resolveSessionListStagedMoveResult({ tree, source, state })).toBeNull();
    });

    it('chooses the place above with ↑ and below with ↓, skipping its own position', () => {
        const { tree, source } = setup('review');
        let state = beginSessionListStagedMove({ tree, source });
        state = stepSessionListStagedMove({ tree, source, state, intent: 'previous' });
        expect(resolveSessionListStagedMoveResult({ tree, source, state })?.instruction).toMatchObject({
            kind: 'reorder-before', targetId: treeRowId.session(S, 'fix'),
        });
        state = stepSessionListStagedMove({ tree, source, state, intent: 'next' });
        expect(state.place).toEqual({ kind: 'origin' });
        state = stepSessionListStagedMove({ tree, source, state, intent: 'next' });
        expect(resolveSessionListStagedMoveResult({ tree, source, state })?.instruction).toMatchObject({
            kind: 'reorder-after', targetId: treeRowId.session(S, 'relay'),
        });
    });

    it('puts it under the row above the chosen place with →, and back to the line with ←', () => {
        const { tree, source } = setup('review');
        let state = beginSessionListStagedMove({ tree, source });
        state = stepSessionListStagedMove({ tree, source, state, intent: 'previous' });
        state = stepSessionListStagedMove({ tree, source, state, intent: 'in' });
        // From "above Fix", there is no row above: → stays on the line.
        expect(resolveSessionListStagedMoveResult({ tree, source, state })?.instruction.kind).toBe('reorder-before');

        state = beginSessionListStagedMove({ tree, source });
        state = stepSessionListStagedMove({ tree, source, state, intent: 'in' });
        expect(resolveSessionListStagedMoveResult({ tree, source, state })?.instruction).toMatchObject({
            kind: 'nest-into', targetId: treeRowId.session(S, 'fix'),
        });
        state = stepSessionListStagedMove({ tree, source, state, intent: 'out' });
        expect(state.place).toEqual({ kind: 'origin' });
    });

    it('goes to its semantic top level with ← without pointer measurements', () => {
        const { tree, source } = setup('relay');
        let state = beginSessionListStagedMove({ tree, source });
        state = stepSessionListStagedMove({ tree, source, state, intent: 'out' });
        expect(resolveSessionListStagedMoveResult({ tree, source, state })?.instruction).toEqual({
            kind: 'move-to-root',
            containerId: treeRowId.workspaceRoot('project-a'),
            rootId: treeRowId.workspaceRoot('project-a'),
            depth: 0,
        });
    });
});
