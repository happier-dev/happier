import * as React from 'react';
import { Platform } from 'react-native';
import { useKeyboardShortcutHandlers, type KeyboardShortcutHandlers } from '@/keyboard';
import { findAdjacentSplitCanvasLeafId } from '../model/splitCanvasSelectors';
import type {
    SplitCanvasAction,
    SplitCanvasDirection,
    SplitCanvasState,
} from '../model/splitCanvasTypes';

type SplitCanvasKeyboardInput<TLeafPayload> = Readonly<{
    enabled: boolean;
    state: SplitCanvasState<TLeafPayload>;
    dispatch: (action: SplitCanvasAction<TLeafPayload>) => void;
    onFocusAdjacent?: (leafId: string, direction: SplitCanvasDirection) => void;
    onSplit?: (leafId: string, direction: SplitCanvasDirection) => void;
}>;

type SplitCanvasKeyboardCommand =
    | 'closeLeaf'
    | 'focusDown'
    | 'focusLeft'
    | 'focusRight'
    | 'focusUp'
    | 'restoreMaximize'
    | 'splitDown'
    | 'splitRight'
    | 'toggleMaximize';

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

function splitCanvasFocusCommandFromDirection(direction: SplitCanvasDirection): SplitCanvasKeyboardCommand {
    if (direction === 'down') return 'focusDown';
    if (direction === 'left') return 'focusLeft';
    if (direction === 'right') return 'focusRight';
    return 'focusUp';
}

function runSplitCanvasKeyboardCommand<TLeafPayload>(
    input: SplitCanvasKeyboardInput<TLeafPayload>,
    command: SplitCanvasKeyboardCommand,
): boolean {
    if (command === 'restoreMaximize') {
        if (!input.state.maximizedLeafId) return false;
        input.dispatch({ type: 'restoreMaximize' });
        return true;
    }

    const focusedLeafId = input.state.focusedLeafId;
    if (!focusedLeafId) return false;

    if (command === 'closeLeaf') {
        input.dispatch({ type: 'closeLeaf', leafId: focusedLeafId });
        return true;
    }

    if (command === 'toggleMaximize') {
        if (input.state.maximizedLeafId) {
            input.dispatch({ type: 'restoreMaximize' });
        } else {
            input.dispatch({ type: 'toggleMaximizeLeaf', leafId: focusedLeafId });
        }
        return true;
    }

    const focusDirectionByCommand: Partial<Record<SplitCanvasKeyboardCommand, SplitCanvasDirection>> = {
        focusDown: 'down',
        focusLeft: 'left',
        focusRight: 'right',
        focusUp: 'up',
    };
    const focusDirection = focusDirectionByCommand[command];
    if (focusDirection) {
        const adjacentLeafId = findAdjacentSplitCanvasLeafId(input.state, focusedLeafId, focusDirection);
        if (adjacentLeafId) {
            input.dispatch({ type: 'focusLeaf', leafId: adjacentLeafId });
        }
        input.onFocusAdjacent?.(focusedLeafId, focusDirection);
        return true;
    }

    const splitDirectionByCommand: Partial<Record<SplitCanvasKeyboardCommand, SplitCanvasDirection>> = {
        splitDown: 'down',
        splitRight: 'right',
    };
    const splitDirection = splitDirectionByCommand[command];
    if (!splitDirection || !input.onSplit) return false;
    input.onSplit(focusedLeafId, splitDirection);
    return true;
}

export function useSplitCanvasKeyboard<TLeafPayload>(input: SplitCanvasKeyboardInput<TLeafPayload>): void {
    const latestInputRef = React.useRef(input);
    latestInputRef.current = input;
    const registryHandlers = React.useMemo<KeyboardShortcutHandlers>(() => {
        if (!input.enabled) return {};

        const handlers: KeyboardShortcutHandlers = {};
        if (input.state.maximizedLeafId) {
            handlers['splitCanvas.restoreMaximize'] = () => {
                runSplitCanvasKeyboardCommand(latestInputRef.current, 'restoreMaximize');
            };
        }
        if (input.state.focusedLeafId) {
            handlers['splitCanvas.closeLeaf'] = () => {
                runSplitCanvasKeyboardCommand(latestInputRef.current, 'closeLeaf');
            };
            handlers['splitCanvas.focusDown'] = () => {
                runSplitCanvasKeyboardCommand(latestInputRef.current, 'focusDown');
            };
            handlers['splitCanvas.focusLeft'] = () => {
                runSplitCanvasKeyboardCommand(latestInputRef.current, 'focusLeft');
            };
            handlers['splitCanvas.focusRight'] = () => {
                runSplitCanvasKeyboardCommand(latestInputRef.current, 'focusRight');
            };
            handlers['splitCanvas.focusUp'] = () => {
                runSplitCanvasKeyboardCommand(latestInputRef.current, 'focusUp');
            };
            handlers['splitCanvas.toggleMaximize'] = () => {
                runSplitCanvasKeyboardCommand(latestInputRef.current, 'toggleMaximize');
            };
            if (input.onSplit) {
                handlers['splitCanvas.splitDown'] = () => {
                    runSplitCanvasKeyboardCommand(latestInputRef.current, 'splitDown');
                };
                handlers['splitCanvas.splitRight'] = () => {
                    runSplitCanvasKeyboardCommand(latestInputRef.current, 'splitRight');
                };
            }
        }
        return handlers;
    }, [input.enabled, input.onSplit, input.state.focusedLeafId, input.state.maximizedLeafId]);
    const providerOwnsKeyboard = useKeyboardShortcutHandlers(registryHandlers);

    React.useEffect(() => {
        if (!input.enabled) return;
        if (providerOwnsKeyboard) return;
        if (Platform.OS !== 'web') return;

        const maybeWindow: Window | undefined = (globalThis as { window?: Window }).window;
        if (!maybeWindow?.addEventListener) return;

        const onKeyDown = (event: KeyboardEvent) => {
            const currentInput = latestInputRef.current;
            if (event.defaultPrevented) return;
            if (isTextEditingTarget(event.target)) return;
            if (event.metaKey || event.ctrlKey) return;

            if (event.key === 'Escape' && currentInput.state.maximizedLeafId) {
                runSplitCanvasKeyboardCommand(currentInput, 'restoreMaximize');
                event.preventDefault();
                event.stopPropagation();
                return;
            }

            const focusedLeafId = currentInput.state.focusedLeafId;
            if (!focusedLeafId) return;

            const arrowDirection = resolveArrowDirection(event.key);
            if (event.altKey && !event.shiftKey && arrowDirection) {
                runSplitCanvasKeyboardCommand(currentInput, splitCanvasFocusCommandFromDirection(arrowDirection));
                event.preventDefault();
                event.stopPropagation();
                return;
            }

            const splitDirection = event.altKey && event.shiftKey
                ? resolveSplitDirection(event.key)
                : null;
            if (splitDirection) {
                if (runSplitCanvasKeyboardCommand(currentInput, splitDirection === 'down' ? 'splitDown' : 'splitRight')) {
                    event.preventDefault();
                    event.stopPropagation();
                }
                return;
            }

            if (event.altKey && !event.shiftKey && event.key.toLowerCase() === 'm') {
                runSplitCanvasKeyboardCommand(currentInput, 'toggleMaximize');
                event.preventDefault();
                event.stopPropagation();
                return;
            }

            if (event.altKey && !event.shiftKey && event.key === 'Backspace') {
                runSplitCanvasKeyboardCommand(currentInput, 'closeLeaf');
                event.preventDefault();
                event.stopPropagation();
            }
        };

        maybeWindow.addEventListener('keydown', onKeyDown);
        return () => {
            maybeWindow.removeEventListener('keydown', onKeyDown);
        };
    }, [input.enabled, providerOwnsKeyboard]);
}
