import { resolveHappierStagedMoveKey } from '@happier-dev/plugin-ui/presentation';
import * as React from 'react';
import { I18nManager } from 'react-native';

import type { SessionListIndexItem } from '@/sync/domains/sessionList/sessionListIndex';

import { buildSessionListDragIntent } from '../drag/sessionListDragIntent';
import { buildSessionListDragSnapshot } from '../drag/sessionListDragSnapshot';
import type { SessionListDragSnapshot } from '../drag/_types';
import type { SessionListTreeDragSource, SessionListTreeModel } from '../drop-resolution/sessionListTreeTypes';
import { buildSessionListTreeRows } from '../drop-resolution/buildSessionListTreeRows';
import type { SessionListCarry } from '../useSessionListEntityDragDrop';
import type { EntityDragDropRuntime } from '@/components/ui/treeDragDrop';
import {
    beginSessionListStagedMove,
    resolveSessionListStagedMoveResult,
    stepSessionListStagedMove,
    type SessionListStagedMoveState,
} from './sessionListStagedMove';

type Staged = {
    sessionKey: string;
    label: string;
    snapshot: SessionListDragSnapshot;
    tree: SessionListTreeModel;
    source: SessionListTreeDragSource;
    state: SessionListStagedMoveState;
    carry: SessionListCarry;
};

export type SessionListStagedMoveView = Readonly<{
    /** The carried row's name while a keyboard move is staged; `null` otherwise. */
    label: string | null;
    /** Increments on every staged step, so the polite status re-speaks a repeated outcome. */
    step: number;
}>;

export type SessionListStagedMoveController = Readonly<{
    view: SessionListStagedMoveView;
    /** Row key handler: returns true when the key belonged to the staged move. */
    handleRowKey: (input: Readonly<{ sessionKey: string; label: string; key: string; repeat?: boolean }>) => boolean;
    cancel: () => void;
}>;

const IDLE_VIEW: SessionListStagedMoveView = Object.freeze({ label: null, step: 0 });

/**
 * The Session list's staged keyboard move (DnD lab KS), on the same carry the pointer uses: Space or
 * Enter picks the focused row up, ↑/↓ choose a place, → puts it under the row above, ← steps out to
 * the top level, Enter drops and Escape cancels without writing. The owner's verdict is docked under
 * the list and spoken by its status line.
 */
export function useSessionListStagedMove(input: Readonly<{
    getItems: () => ReadonlyArray<SessionListIndexItem>;
    foldersFeatureEnabled: boolean;
    beginCarry: (snapshot: SessionListDragSnapshot, mode: 'pointer' | 'keyboard') => SessionListCarry | null;
    runtime: EntityDragDropRuntime;
}>): SessionListStagedMoveController {
    const stagedRef = React.useRef<Staged | null>(null);
    const [view, setView] = React.useState<SessionListStagedMoveView>(IDLE_VIEW);
    const inputRef = React.useRef(input);
    inputRef.current = input;

    const stage = React.useCallback((staged: Staged) => {
        const result = resolveSessionListStagedMoveResult({ tree: staged.tree, source: staged.source, state: staged.state });
        staged.carry.choose(result
            ? buildSessionListDragIntent({
                result,
                sourceRowId: staged.snapshot.source.sourceRowId,
                sourceKind: staged.snapshot.source.kind,
                snapshotSignature: staged.snapshot.signature,
            })
            : {
                sourceRowId: staged.snapshot.source.sourceRowId,
                sourceKind: staged.snapshot.source.kind,
                instructionKind: 'idle',
                targetRowId: null,
                containerId: null,
                parentRowId: null,
                depth: null,
                edge: null,
                sourceSnapshotSignature: staged.snapshot.signature,
            });
        setView((previous) => ({ label: staged.label, step: previous.step + 1 }));
    }, []);

    const finish = React.useCallback(() => {
        stagedRef.current = null;
        setView((previous) => ({ label: null, step: previous.step + 1 }));
    }, []);

    const cancel = React.useCallback(() => {
        const staged = stagedRef.current;
        if (!staged) return;
        staged.carry.cancel();
        finish();
    }, [finish]);

    React.useEffect(() => input.runtime.subscribe(() => {
        const staged = stagedRef.current;
        if (!staged) return;
        const snapshot = input.runtime.getSnapshot();
        if (snapshot.sourceId !== staged.carry.sourceId || snapshot.phase !== 'carrying') finish();
    }), [input.runtime, finish]);

    const handleRowKey = React.useCallback((key: Readonly<{ sessionKey: string; label: string; key: string; repeat?: boolean }>) => {
        const staged = stagedRef.current && stagedRef.current.sessionKey === key.sessionKey ? stagedRef.current : null;
        const intent = resolveHappierStagedMoveKey({ key: key.key, staged: staged !== null, repeat: key.repeat, rtl: I18nManager.isRTL });
        if (!intent) return false;
        if (intent === 'pickUp') {
            stagedRef.current?.carry.cancel();
            const items = inputRef.current.getItems();
            let snapshot: SessionListDragSnapshot;
            try {
                snapshot = buildSessionListDragSnapshot({
                    items, viewItems: items, sessionDragKey: key.sessionKey, foldersFeatureEnabled: inputRef.current.foldersFeatureEnabled,
                });
            } catch {
                return false;
            }
            const carry = inputRef.current.beginCarry(snapshot, 'keyboard');
            if (!carry) return false;
            const tree = buildSessionListTreeRows({ items });
            const source = snapshot.source.treeSource;
            const next: Staged = { sessionKey: key.sessionKey, label: key.label, snapshot, tree, source, state: beginSessionListStagedMove({ tree, source }), carry };
            stagedRef.current = next;
            stage(next);
            return true;
        }
        if (!staged) return false;
        if (intent === 'cancel') {
            cancel();
            return true;
        }
        if (intent === 'drop') {
            staged.carry.end(true, null);
            finish();
            return true;
        }
        staged.state = stepSessionListStagedMove({ tree: staged.tree, source: staged.source, state: staged.state, intent });
        stage(staged);
        return true;
    }, [cancel, finish, stage]);

    React.useEffect(() => () => {
        stagedRef.current?.carry.cancel();
        stagedRef.current = null;
    }, []);

    return React.useMemo(() => ({ view, handleRowKey, cancel }), [cancel, handleRowKey, view]);
}
