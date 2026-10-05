import * as React from 'react';
import type { EntityDragItemV1, EntityDragKindV1, EntityDragScopeV1, EntityDropAdmissionV1, EntityDropEffectV1, EntityDropOutcomeV1 } from '@happier-dev/protocol/plugins/ui';
import type { EntityDragDropRuntime, EntityDragInput } from '@/components/ui/treeDragDrop';
import { resolveSplitCanvasDropTarget } from '../model/splitCanvasDropTarget';
import type { SplitCanvasDirection, SplitCanvasDropTarget, SplitCanvasLeafHostRef } from '../model/splitCanvasTypes';

export const SPLIT_CANVAS_DROP_PLACEMENTS = ['center', 'left', 'right', 'up', 'down'] as const;
export type SplitCanvasEntityDrop = Readonly<{
    runtime: EntityDragDropRuntime;
    id: string;
    scope: EntityDragScopeV1;
    acceptedKinds: readonly EntityDragKindV1[];
    isCurrent?: () => boolean;
    resolve: (input: Readonly<{
        item: EntityDragItemV1;
        target: SplitCanvasDropTarget;
        input: EntityDragInput;
        availableSizePx?: number;
        minimumExistingSizePx?: number;
        /** Centre only: the pointer is in this edge's band, but the pane is too narrow to split there. */
        declinedSplit?: SplitCanvasDirection;
    }>) => EntityDropAdmissionV1;
    execute: (effect: EntityDropEffectV1) => Promise<EntityDropOutcomeV1>;
    label?: (target: SplitCanvasDropTarget) => string;
}>;

type LayoutEvent = Readonly<{ nativeEvent?: Readonly<{ layout?: Readonly<{ width?: number; height?: number }> }> }>;
type LeafHost = SplitCanvasLeafHostRef & Readonly<{
    measureInWindow?: (callback: (x: number, y: number, width: number, height: number) => void) => void;
}>;
type WindowRect = Readonly<{ left: number; top: number; width: number; height: number }>;

export function splitCanvasEntityTargetId(id: string, leafId: string, placement: SplitCanvasDropTarget['placement']): string {
    return JSON.stringify(['split-canvas', id, leafId, placement]);
}

/** Five-zone shape adapter. Carrying, admission, cancellation and release stay in E01. */
export function useSplitCanvasDnD(input: Readonly<{
    entityDrop?: SplitCanvasEntityDrop;
    isLeafCurrent: (leafId: string) => boolean;
    readSplitMeasurement: (leafId: string, direction: SplitCanvasDirection) => Readonly<{ availableSizePx: number; minimumExistingSizePx: number }> | null;
    /** Whether an edge can split now; an edge that cannot is part of the centre. */
    isSplitOffered: (leafId: string, direction: SplitCanvasDirection) => boolean;
}>) {
    const latest = React.useRef(input);
    latest.current = input;
    const hosts = React.useRef(new Map<string, LeafHost>());
    const nativeBounds = React.useRef(new Map<string, WindowRect>());
    const retirements = React.useRef(new Map<string, () => void>());
    const binding = input.entityDrop;

    const readBounds = React.useCallback((leafId: string): WindowRect | null => {
        const current = latest.current;
        if (!current.entityDrop || current.entityDrop.isCurrent?.() === false || !current.isLeafCurrent(leafId)) return null;
        const rect = hosts.current.get(leafId)?.getBoundingClientRect?.() ?? nativeBounds.current.get(leafId);
        if (!rect || typeof rect.left !== 'number' || typeof rect.top !== 'number'
            || typeof rect.width !== 'number' || typeof rect.height !== 'number'
            || ![rect.left, rect.top, rect.width, rect.height].every(Number.isFinite)
            || rect.width <= 0 || rect.height <= 0) return null;
        return { left: rect.left, top: rect.top, width: rect.width, height: rect.height };
    }, []);

    // Pointer geometry picks the zone; an edge the pane cannot split now folds into the centre.
    const readPlacement = React.useCallback((leafId: string, pointer: Readonly<{ x: number; y: number }>) => {
        const rect = readBounds(leafId);
        if (!rect) return null;
        const geometric = resolveSplitCanvasDropTarget({ leafId, rect, clientX: pointer.x, clientY: pointer.y }).placement;
        if (geometric === 'center' || latest.current.isSplitOffered(leafId, geometric)) return { placement: geometric, declined: undefined };
        return { placement: 'center' as const, declined: geometric };
    }, [readBounds]);

    const register = React.useCallback((leafId: string) => {
        retirements.current.get(leafId)?.();
        retirements.current.delete(leafId);
        const owner = latest.current.entityDrop;
        if (!owner || !hosts.current.has(leafId)) return;
        const { runtime, id, scope } = owner;
        const isCurrent = () => {
            const current = latest.current.entityDrop;
            return current?.runtime === runtime && current.id === id
                && current.scope.serverId === scope.serverId && current.scope.accountId === scope.accountId
                && current.isCurrent?.() !== false && hosts.current.has(leafId) && latest.current.isLeafCurrent(leafId);
        };
        const retire = SPLIT_CANVAS_DROP_PLACEMENTS.map(placement => {
            const target = { leafId, placement };
            return runtime.registerTarget({
                id: splitCanvasEntityTargetId(id, leafId, placement), scope,
                get acceptedKinds() { return latest.current.entityDrop?.acceptedKinds ?? []; },
                isCurrent,
                getBounds: () => {
                    const rect = readBounds(leafId);
                    return rect ? { x: rect.left, y: rect.top, width: rect.width, height: rect.height } : null;
                },
                containsPointer: pointer => readPlacement(leafId, pointer)?.placement === placement,
                listDestinations: () => {
                    const label = latest.current.entityDrop?.label?.(target);
                    return label ? [{ destination: target, label }] : [];
                },
                resolve: context => {
                    const measurement = placement === 'center' ? null : latest.current.readSplitMeasurement(leafId, placement);
                    const declinedSplit = placement === 'center' && context.pointer ? readPlacement(leafId, context.pointer)?.declined : undefined;
                    return latest.current.entityDrop!.resolve({
                        item: context.item, target, input: context.input, ...(measurement ?? {}),
                        ...(declinedSplit ? { declinedSplit } : {}),
                    });
                },
                execute: effect => latest.current.entityDrop!.execute(effect),
            });
        });
        retirements.current.set(leafId, () => { for (const dispose of retire) dispose(); });
        runtime.refresh();
    }, [readBounds, readPlacement]);

    React.useEffect(() => {
        for (const leafId of hosts.current.keys()) register(leafId);
        return () => {
            for (const dispose of retirements.current.values()) dispose();
            retirements.current.clear();
        };
    }, [binding?.runtime, binding?.id, binding?.scope.serverId, binding?.scope.accountId, register]);

    const measureNative = React.useCallback((leafId: string) => {
        const host = hosts.current.get(leafId);
        host?.measureInWindow?.((left, top, width, height) => {
            if (hosts.current.get(leafId) !== host) return;
            nativeBounds.current.set(leafId, { left, top, width, height });
            latest.current.entityDrop?.runtime.refresh();
        });
    }, []);
    React.useEffect(() => {
        const runtime = binding?.runtime;
        if (!runtime) return;
        let phase = runtime.getSnapshot().phase;
        return runtime.subscribe(() => {
            const next = runtime.getSnapshot().phase;
            const began = next === 'carrying' && phase !== next;
            phase = next;
            if (began) {
                for (const leafId of hosts.current.keys()) measureNative(leafId);
            }
        });
    }, [binding?.runtime, measureNative]);
    const registerLeafHost = React.useCallback((leafId: string, host: LeafHost | null) => {
        if (hosts.current.get(leafId) === host) return;
        retirements.current.get(leafId)?.();
        retirements.current.delete(leafId);
        nativeBounds.current.delete(leafId);
        if (host) {
            hosts.current.set(leafId, host);
            measureNative(leafId);
            register(leafId);
        } else {
            hosts.current.delete(leafId);
            latest.current.entityDrop?.runtime.refresh();
        }
    }, [measureNative, register]);
    const onLeafLayout = React.useCallback((leafId: string, _event: LayoutEvent) => {
        measureNative(leafId);
        latest.current.entityDrop?.runtime.refresh();
    }, [measureNative]);
    const onHostLayout = React.useCallback((_event: LayoutEvent) => {
        for (const leafId of hosts.current.keys()) measureNative(leafId);
        latest.current.entityDrop?.runtime.refresh();
    }, [measureNative]);
    const targetId = React.useCallback((leafId: string, placement: SplitCanvasDropTarget['placement']) =>
        splitCanvasEntityTargetId(latest.current.entityDrop?.id ?? '', leafId, placement), []);
    return { registerLeafHost, onLeafLayout, onHostLayout, targetId };
}
