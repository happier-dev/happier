import * as React from 'react';
import { Platform } from 'react-native';
import { findAdjacentSplitCanvasLeafId } from '../model/splitCanvasSelectors';
import type {
    SplitCanvasAction,
    SplitCanvasDirection,
    SplitCanvasState,
} from '../model/splitCanvasTypes';

function isTextEditingTarget(target: unknown): boolean {
    const tagNameRaw = typeof (target as { tagName?: unknown } | null)?.tagName === 'string'
        ? (target as { tagName: string }).tagName
        : '';
    const tagName = tagNameRaw.toLowerCase();
    if (tagName === 'input' || tagName === 'textarea' || tagName === 'select') return true;
    return Boolean((target as { isContentEditable?: boolean } | null)?.isContentEditable);
}

function resolveArrowDirection(key: string): SplitCanvasDirection | null {
    if (key === 'ArrowLeft') return 'left';
    if (key === 'ArrowRight') return 'right';
    if (key === 'ArrowUp') return 'up';
    if (key === 'ArrowDown') return 'down';
    return null;
}

function resolveSplitDirection(key: string): SplitCanvasDirection | null {
    if (key === 'Enter' || key === 'ArrowRight') return 'right';
    if (key === 'ArrowDown') return 'down';
    return null;
}

export function useSplitCanvasKeyboard<TLeafPayload>(input: Readonly<{
    enabled: boolean;
    state: SplitCanvasState<TLeafPayload>;
    dispatch: (action: SplitCanvasAction<TLeafPayload>) => void;
    onFocusAdjacent?: (leafId: string, direction: SplitCanvasDirection) => void;
    onSplit?: (leafId: string, direction: SplitCanvasDirection) => void;
}>): void {
    const latestInputRef = React.useRef(input);
    latestInputRef.current = input;

    React.useEffect(() => {
        if (!input.enabled) return;
        if (Platform.OS !== 'web') return;

        const maybeWindow: Window | undefined = (globalThis as { window?: Window }).window;
        if (!maybeWindow?.addEventListener) return;

        const onKeyDown = (event: KeyboardEvent) => {
            const currentInput = latestInputRef.current;
            if (event.defaultPrevented) return;
            if (isTextEditingTarget(event.target)) return;
            if (event.metaKey || event.ctrlKey) return;

            if (event.key === 'Escape' && currentInput.state.maximizedLeafId) {
                currentInput.dispatch({ type: 'restoreMaximize' });
                event.preventDefault();
                event.stopPropagation();
                return;
            }

            const focusedLeafId = currentInput.state.focusedLeafId;
            if (!focusedLeafId) return;

            const arrowDirection = resolveArrowDirection(event.key);
            if (event.altKey && !event.shiftKey && arrowDirection) {
                const adjacentLeafId = findAdjacentSplitCanvasLeafId(currentInput.state, focusedLeafId, arrowDirection);
                if (adjacentLeafId) {
                    currentInput.dispatch({ type: 'focusLeaf', leafId: adjacentLeafId });
                }
                currentInput.onFocusAdjacent?.(focusedLeafId, arrowDirection);
                event.preventDefault();
                event.stopPropagation();
                return;
            }

            const splitDirection = event.altKey && event.shiftKey
                ? resolveSplitDirection(event.key)
                : null;
            if (splitDirection) {
                if (currentInput.onSplit) {
                    currentInput.onSplit(focusedLeafId, splitDirection);
                    event.preventDefault();
                    event.stopPropagation();
                }
                return;
            }

            if (event.altKey && !event.shiftKey && event.key.toLowerCase() === 'm') {
                if (currentInput.state.maximizedLeafId) {
                    currentInput.dispatch({ type: 'restoreMaximize' });
                } else {
                    currentInput.dispatch({ type: 'toggleMaximizeLeaf', leafId: focusedLeafId });
                }
                event.preventDefault();
                event.stopPropagation();
                return;
            }

            if (event.altKey && !event.shiftKey && event.key === 'Backspace') {
                currentInput.dispatch({ type: 'closeLeaf', leafId: focusedLeafId });
                event.preventDefault();
                event.stopPropagation();
            }
        };

        maybeWindow.addEventListener('keydown', onKeyDown);
        return () => {
            maybeWindow.removeEventListener('keydown', onKeyDown);
        };
    }, [input.enabled]);
}
