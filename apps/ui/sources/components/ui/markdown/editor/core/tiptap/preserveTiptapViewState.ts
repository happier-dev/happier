import type { Editor } from '@tiptap/core';

type ScrollPositionElement = {
    scrollTop: number;
    scrollLeft: number;
};

type TiptapSelectionSnapshot = Readonly<{
    from: number;
    to: number;
}>;

type TiptapViewStateSnapshot = Readonly<{
    selection: TiptapSelectionSnapshot;
    scrollElement: ScrollPositionElement | null;
    scrollTop: number | null;
    scrollLeft: number | null;
}>;

function readEditorScrollElement(editor: Editor): ScrollPositionElement | null {
    const candidate = editor.view?.dom?.parentElement;
    if (!candidate) return null;
    if (typeof candidate.scrollTop !== 'number' || typeof candidate.scrollLeft !== 'number') return null;
    return candidate;
}

function readSelectionSnapshot(editor: Editor): TiptapSelectionSnapshot {
    const selection = editor.state.selection;
    const docSize = readEditorDocContentSize(editor);
    return {
        from: typeof selection.from === 'number' ? selection.from : docSize,
        to: typeof selection.to === 'number' ? selection.to : docSize,
    };
}

function readEditorDocContentSize(editor: Editor): number {
    const viewSize = editor.view?.state?.doc?.content?.size;
    if (typeof viewSize === 'number' && Number.isFinite(viewSize)) return viewSize;
    const stateSize = editor.state?.doc?.content?.size;
    if (typeof stateSize === 'number' && Number.isFinite(stateSize)) return stateSize;
    return 0;
}

function clampEditorPosition(position: number, editor: Editor): number {
    const docSize = readEditorDocContentSize(editor);
    if (!Number.isFinite(position)) return docSize;
    return Math.min(Math.max(0, Math.trunc(position)), docSize);
}

function captureTiptapViewState(editor: Editor): TiptapViewStateSnapshot {
    const scrollElement = readEditorScrollElement(editor);
    return {
        selection: readSelectionSnapshot(editor),
        scrollElement,
        scrollTop: scrollElement ? scrollElement.scrollTop : null,
        scrollLeft: scrollElement ? scrollElement.scrollLeft : null,
    };
}

function restoreTiptapViewState(editor: Editor, snapshot: TiptapViewStateSnapshot): void {
    try {
        editor.commands.setTextSelection({
            from: clampEditorPosition(snapshot.selection.from, editor),
            to: clampEditorPosition(snapshot.selection.to, editor),
        });
    } catch {
        // Selection may be invalid for the incoming document shape.
    }

    if (snapshot.scrollElement && typeof snapshot.scrollTop === 'number') {
        snapshot.scrollElement.scrollTop = snapshot.scrollTop;
    }
    if (snapshot.scrollElement && typeof snapshot.scrollLeft === 'number') {
        snapshot.scrollElement.scrollLeft = snapshot.scrollLeft;
    }
}

/**
 * Runs a destructive TipTap content replacement while restoring the user's caret
 * and scroll position afterwards. This is the canonical guard for host-applied
 * external document sync; direct `setContent` resets editor view state.
 */
export function runWithPreservedTiptapViewState(editor: Editor, operation: () => void): void {
    const snapshot = captureTiptapViewState(editor);
    operation();
    restoreTiptapViewState(editor, snapshot);
}
