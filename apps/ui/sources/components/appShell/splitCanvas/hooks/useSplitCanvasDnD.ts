import * as React from 'react';
import { Platform } from 'react-native';
import { resolveSplitCanvasDropTarget } from '../model/splitCanvasDropTarget';
import type { SplitCanvasDropTarget, SplitCanvasLeafHostRef, SplitCanvasLeafRect } from '../model/splitCanvasTypes';

type SplitCanvasLayoutEvent = Readonly<{
    nativeEvent?: Readonly<{
        layout?: Readonly<{
            x?: number;
            y?: number;
            width?: number;
            height?: number;
        }>;
    }>;
}>;

function readNumber(value: unknown): number {
    return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

function isValidRect(rect: Readonly<{ width: number; height: number }>): boolean {
    return rect.width > 0 && rect.height > 0;
}

function toLeafRect(leafId: string, event: SplitCanvasLayoutEvent): SplitCanvasLeafRect {
    const layout = event.nativeEvent?.layout;
    return {
        leafId,
        x: readNumber(layout?.x),
        y: readNumber(layout?.y),
        width: readNumber(layout?.width),
        height: readNumber(layout?.height),
    };
}

function rectContainsPoint(rect: Readonly<{
    x: number;
    y: number;
    width: number;
    height: number;
}>, x: number, y: number): boolean {
    return x >= rect.x
        && y >= rect.y
        && x <= rect.x + rect.width
        && y <= rect.y + rect.height;
}

function resolveLeafRectAtPoint(
    leafRects: ReadonlyMap<string, SplitCanvasLeafRect>,
    x: number,
    y: number,
): SplitCanvasLeafRect | null {
    let bestMatch: SplitCanvasLeafRect | null = null;
    let bestArea = Number.POSITIVE_INFINITY;
    for (const rect of leafRects.values()) {
        if (!rectContainsPoint(rect, x, y)) {
            continue;
        }
        const area = rect.width * rect.height;
        if (area < bestArea) {
            bestArea = area;
            bestMatch = rect;
        }
    }
    return bestMatch;
}

export function useSplitCanvasDnD(input: Readonly<{
    enabled: boolean;
    onActiveDropTargetChange?: (target: SplitCanvasDropTarget | null) => void;
    onLeafDrop?: (input: Readonly<{
        payload: string;
        target: SplitCanvasDropTarget;
    }>) => void;
}>): Readonly<{
    enabled: boolean;
    onHostLayout?: (event: SplitCanvasLayoutEvent) => void;
    onLeafLayout: (leafId: string, event: SplitCanvasLayoutEvent) => void;
    registerLeafHost: (leafId: string, host: SplitCanvasLeafHostRef | null) => void;
    hostDropTargetProps: Readonly<{
        onDragEnter?: (event: any) => void;
        onDragLeave?: (event: any) => void;
        onDragOver?: (event: any) => void;
        onDrop?: (event: any) => void;
    }>;
}> {
    const leafRectsRef = React.useRef<Map<string, SplitCanvasLeafRect>>(new Map());
    const leafHostsRef = React.useRef<Map<string, SplitCanvasLeafHostRef>>(new Map());

    const enabled = Platform.OS === 'web'
        && input.enabled
        && typeof input.onActiveDropTargetChange === 'function'
        && typeof input.onLeafDrop === 'function';

    const onHostLayout = React.useCallback((_event: SplitCanvasLayoutEvent) => {
        // Browser client rects remain the canonical geometry source on web.
        // The host callback stays available for testkit parity and future non-web extraction.
    }, []);

    const onLeafLayout = React.useCallback((leafId: string, event: SplitCanvasLayoutEvent) => {
        const rect = toLeafRect(leafId, event);
        if (!isValidRect(rect)) {
            leafRectsRef.current.delete(leafId);
            return;
        }
        leafRectsRef.current.set(leafId, rect);
    }, []);

    const registerLeafHost = React.useCallback((leafId: string, host: SplitCanvasLeafHostRef | null) => {
        if (host?.getBoundingClientRect) {
            leafHostsRef.current.set(leafId, host);
            return;
        }

        leafHostsRef.current.delete(leafId);
        leafRectsRef.current.delete(leafId);
    }, []);

    const resolveTargetForEvent = React.useCallback((event: any): SplitCanvasDropTarget | null => {
        const hostRect = event?.currentTarget?.getBoundingClientRect?.();
        if (!hostRect) {
            return null;
        }

        const clientX = readNumber(event?.clientX);
        const clientY = readNumber(event?.clientY);

        let hostMatch: Readonly<{
            leafId: string;
            rect: {
                left: number;
                top: number;
                width: number;
                height: number;
            };
        }> | null = null;
        let hostMatchArea = Number.POSITIVE_INFINITY;

        for (const [leafId, leafHost] of leafHostsRef.current.entries()) {
            const rawRect = leafHost.getBoundingClientRect?.();
            if (!rawRect) {
                continue;
            }

            const rect = {
                left: readNumber(rawRect.left),
                top: readNumber(rawRect.top),
                width: readNumber(rawRect.width),
                height: readNumber(rawRect.height),
            };
            if (!isValidRect(rect)) {
                continue;
            }
            if (!rectContainsPoint({
                x: rect.left,
                y: rect.top,
                width: rect.width,
                height: rect.height,
            }, clientX, clientY)) {
                continue;
            }

            const area = rect.width * rect.height;
            if (area < hostMatchArea) {
                hostMatchArea = area;
                hostMatch = { leafId, rect };
            }
        }

        if (hostMatch) {
            return resolveSplitCanvasDropTarget({
                leafId: hostMatch.leafId,
                rect: hostMatch.rect,
                clientX,
                clientY,
            });
        }

        const hostRelativeX = clientX - readNumber(hostRect.left);
        const hostRelativeY = clientY - readNumber(hostRect.top);
        const leafRect = resolveLeafRectAtPoint(leafRectsRef.current, hostRelativeX, hostRelativeY);
        if (!leafRect) {
            return null;
        }

        return resolveSplitCanvasDropTarget({
            leafId: leafRect.leafId,
            rect: {
                left: readNumber(hostRect.left) + leafRect.x,
                top: readNumber(hostRect.top) + leafRect.y,
                width: leafRect.width,
                height: leafRect.height,
            },
            clientX,
            clientY,
        });
    }, []);

    const clearDropTarget = React.useCallback(() => {
        input.onActiveDropTargetChange?.(null);
    }, [input.onActiveDropTargetChange]);

    const updateDropTarget = React.useCallback((event: any) => {
        const nextTarget = resolveTargetForEvent(event);
        input.onActiveDropTargetChange?.(nextTarget);
        return nextTarget;
    }, [input.onActiveDropTargetChange, resolveTargetForEvent]);

    const commitDrop = React.useCallback((event: any) => {
        const target = updateDropTarget(event);
        if (!target) {
            return;
        }

        const payload = event?.dataTransfer?.getData?.('text/plain') ?? '';
        if (!payload) {
            clearDropTarget();
            return;
        }

        event?.preventDefault?.();
        event?.stopPropagation?.();
        input.onLeafDrop?.({
            payload,
            target,
        });
        clearDropTarget();
    }, [clearDropTarget, input.onLeafDrop, updateDropTarget]);

    return {
        enabled,
        onHostLayout,
        onLeafLayout,
        registerLeafHost,
        hostDropTargetProps: enabled
            ? {
                onDragEnter: updateDropTarget,
                onDragOver: (event: any) => {
                    event?.preventDefault?.();
                    updateDropTarget(event);
                },
                onDragLeave: (event: any) => {
                    const currentTarget = event?.currentTarget as HTMLElement | null;
                    const relatedTarget = event?.relatedTarget as Node | null;
                    if (currentTarget && relatedTarget && currentTarget.contains(relatedTarget)) {
                        return;
                    }
                    clearDropTarget();
                },
                onDrop: commitDrop,
            }
            : {},
    };
}
