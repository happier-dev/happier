import * as React from 'react';

import type { CodeLine } from '@/components/ui/code/model/codeLineTypes';
import { resolveDiffSelectionLines } from '@/components/ui/code/diff/diffTextSelection';

import type { AskSelection } from './useAskSelection';

type NativeLineRangeSource = 'file' | 'diff';

export type NativeLineRangeState = Readonly<{
    /** The selected rows, so the code view paints them; empty when nothing is selected. */
    lineIds: ReadonlySet<string>;
    selection: AskSelection | null;
}>;

/**
 * The selection source of a touch reading surface: the rows a long-press and taps selected, published
 * as the same `AskSelection` the web DOM selection and the editors publish, so one `AskSelectionControls`
 * and one `askAboutRanges` serve every host.
 */
export type NativeLineRangeSelection = Readonly<{
    getState: () => NativeLineRangeState;
    subscribe: (listener: () => void) => () => void;
    getSelection: () => AskSelection | null;
    /** The rows the view reports; an empty list clears. */
    select: (lines: readonly CodeLine[], source: NativeLineRangeSource) => void;
    clear: () => void;
}>;

const EMPTY_STATE: NativeLineRangeState = { lineIds: new Set(), selection: null };

/** A code row range as an Ask selection: file rows by their file lines, diff rows by the side the change lands on. */
export function askSelectionFromCodeLines(lines: readonly CodeLine[], source: NativeLineRangeSource): AskSelection | null {
    const first = lines[0];
    const last = lines[lines.length - 1];
    if (!first || !last) return null;
    const text = lines.map((line) => line.renderCodeText).join('\n');
    const key = `${first.id}:${last.id}`;
    if (source === 'file') {
        if (first.newLine === null || last.newLine === null) return null;
        return { startLine: first.newLine, endLine: last.newLine, text, key };
    }
    const resolved = resolveDiffSelectionLines(
        { oldLine: first.oldLine, newLine: first.newLine },
        { oldLine: last.oldLine, newLine: last.newLine },
    );
    return resolved ? { ...resolved, text, key } : null;
}

export function createNativeLineRangeSelection(): NativeLineRangeSelection {
    let state = EMPTY_STATE;
    const listeners = new Set<() => void>();
    const publish = (next: NativeLineRangeState) => {
        if (next === state) return;
        state = next;
        for (const listener of [...listeners]) listener();
    };
    return {
        getState: () => state,
        subscribe: (listener) => {
            listeners.add(listener);
            return () => { listeners.delete(listener); };
        },
        getSelection: () => state.selection,
        select: (lines, source) => {
            const selection = askSelectionFromCodeLines(lines, source);
            publish(selection ? { lineIds: new Set(lines.map((line) => line.id)), selection } : EMPTY_STATE);
        },
        clear: () => publish(EMPTY_STATE),
    };
}

export function useNativeLineRangeSelection(): NativeLineRangeSelection {
    return React.useMemo(createNativeLineRangeSelection, []);
}

const NO_SUBSCRIPTION = () => () => {};
const NO_STATE = () => EMPTY_STATE;

/** The selection's rows for the code view; re-renders only the reader of the rows. */
export function useNativeLineRangeState(selection: NativeLineRangeSelection | undefined): NativeLineRangeState {
    return React.useSyncExternalStore(selection?.subscribe ?? NO_SUBSCRIPTION, selection?.getState ?? NO_STATE, NO_STATE);
}
