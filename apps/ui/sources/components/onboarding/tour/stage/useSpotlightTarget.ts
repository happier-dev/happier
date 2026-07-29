import * as React from 'react';
import { type LayoutChangeEvent, type ViewStyle } from 'react-native';

import type { StageTargetRect } from './useStageTransform';

export type SpotlightTargetRef = Readonly<{
    getBoundingClientRect?: () => Readonly<{
        x: number;
        y: number;
        width: number;
        height: number;
    }>;
    measureInWindow?: (callback: (x: number, y: number, width: number, height: number) => void) => void;
    measure?: (
        callback: (
            x: number,
            y: number,
            width: number,
            height: number,
            pageX: number,
            pageY: number,
        ) => void,
    ) => void;
}>;

type SpotlightTargetStyle = ViewStyle & Readonly<{
    isolation?: 'isolate';
}>;

export type SpotlightTargetProps = Readonly<{
    active: boolean;
    onLayout: (event?: LayoutChangeEvent) => void;
    style?: SpotlightTargetStyle;
}>;

type RegisteredTarget = Readonly<{
    refs: Set<React.RefObject<SpotlightTargetRef | null>>;
}>;

type SpotlightRegistryContextValue = Readonly<{
    activeTargetId: string | null;
    rects: ReadonlyMap<string, StageTargetRect>;
    registeredTargetIds: ReadonlySet<string>;
    hasTarget: (id: string) => boolean;
    registerTarget: (id: string, ref: React.RefObject<SpotlightTargetRef | null>) => () => void;
    measureTarget: (id: string) => void;
    readVisualTargetRect: (id: string, callback: (rect: StageTargetRect) => void) => void;
}>;

export type SpotlightProviderProps = React.PropsWithChildren<Readonly<{
    activeTargetId?: string | null;
    stageRef?: React.RefObject<SpotlightTargetRef | null>;
}>>;

const EMPTY_RECTS: ReadonlyMap<string, StageTargetRect> = new Map();

const SpotlightRegistryContext = React.createContext<SpotlightRegistryContextValue>({
    activeTargetId: null,
    rects: EMPTY_RECTS,
    registeredTargetIds: new Set(),
    hasTarget: () => false,
    registerTarget: () => () => undefined,
    measureTarget: () => undefined,
    readVisualTargetRect: () => undefined,
});

const SpotlightTargetScopeContext = React.createContext(true);

export function SpotlightTargetScope(props: React.PropsWithChildren<Readonly<{
    active: boolean;
}>>): React.ReactElement {
    return React.createElement(
        SpotlightTargetScopeContext.Provider,
        { value: props.active },
        props.children,
    );
}

const activeTargetStyle: SpotlightTargetStyle = {
    isolation: 'isolate',
    position: 'relative',
    zIndex: 40,
};

function resolveMeasuredRect(
    ref: React.RefObject<SpotlightTargetRef | null>,
    callback: (rect: StageTargetRect) => void,
    preferVisualBounds = false,
): void {
    const node = ref.current;
    if (!node) return;

    if (preferVisualBounds && typeof node.getBoundingClientRect === 'function') {
        const rect = node.getBoundingClientRect();
        if (
            Number.isFinite(rect.x)
            && Number.isFinite(rect.y)
            && Number.isFinite(rect.width)
            && Number.isFinite(rect.height)
            && rect.width > 0
            && rect.height > 0
        ) {
            callback({ x: rect.x, y: rect.y, width: rect.width, height: rect.height });
            return;
        }
    }

    if (typeof node.measureInWindow === 'function') {
        node.measureInWindow((x, y, width, height) => {
            callback({ x, y, width, height });
        });
        return;
    }

    if (typeof node.measure === 'function') {
        node.measure((x, y, width, height, pageX, pageY) => {
            callback({
                x: Number.isFinite(pageX) ? pageX : x,
                y: Number.isFinite(pageY) ? pageY : y,
                width,
                height,
            });
        });
    }
}

function unionRects(rects: readonly StageTargetRect[]): StageTargetRect | null {
    if (rects.length === 0) return null;
    const minX = Math.min(...rects.map((rect) => rect.x));
    const minY = Math.min(...rects.map((rect) => rect.y));
    const maxX = Math.max(...rects.map((rect) => rect.x + rect.width));
    const maxY = Math.max(...rects.map((rect) => rect.y + rect.height));
    return {
        x: minX,
        y: minY,
        width: maxX - minX,
        height: maxY - minY,
    };
}

function resolveMeasuredRects(
    refs: ReadonlySet<React.RefObject<SpotlightTargetRef | null>>,
    callback: (rects: readonly StageTargetRect[]) => void,
    preferVisualBounds = false,
): void {
    const measurableRefs = Array.from(refs).filter(({ current }) => (
        Boolean(current)
        && (
            (preferVisualBounds && typeof current?.getBoundingClientRect === 'function')
            || typeof current?.measureInWindow === 'function'
            || typeof current?.measure === 'function'
        )
    ));
    if (measurableRefs.length === 0) return;

    const rects: StageTargetRect[] = [];
    let remaining = measurableRefs.length;
    for (const ref of measurableRefs) {
        resolveMeasuredRect(ref, (rect) => {
            rects.push(rect);
            remaining -= 1;
            if (remaining === 0) callback(rects);
        }, preferVisualBounds);
    }
}

function subtractStageOrigin(rect: StageTargetRect, stageRect: StageTargetRect | null): StageTargetRect {
    if (!stageRect) return rect;
    return {
        x: rect.x - stageRect.x,
        y: rect.y - stageRect.y,
        width: rect.width,
        height: rect.height,
    };
}

export function SpotlightProvider(props: SpotlightProviderProps): React.ReactElement {
    const targetsRef = React.useRef(new Map<string, RegisteredTarget>());
    const measurementGenerationRef = React.useRef(new Map<string, number>());
    const [rects, setRects] = React.useState<ReadonlyMap<string, StageTargetRect>>(EMPTY_RECTS);
    const [registeredTargetIds, setRegisteredTargetIds] = React.useState<ReadonlySet<string>>(() => new Set());

    const commitRect = React.useCallback((id: string, rect: StageTargetRect) => {
        setRects((currentRects) => {
            const currentRect = currentRects.get(id);
            if (
                currentRect
                && currentRect.x === rect.x
                && currentRect.y === rect.y
                && currentRect.width === rect.width
                && currentRect.height === rect.height
            ) {
                return currentRects;
            }
            const nextRects = new Map(currentRects);
            nextRects.set(id, rect);
            return nextRects;
        });
    }, []);

    const measureTarget = React.useCallback((id: string) => {
        const target = targetsRef.current.get(id);
        if (!target) return;
        const generation = (measurementGenerationRef.current.get(id) ?? 0) + 1;
        measurementGenerationRef.current.set(id, generation);

        resolveMeasuredRects(target.refs, (targetRects) => {
            if (measurementGenerationRef.current.get(id) !== generation) return;
            const stageRef = props.stageRef;
            if (!stageRef?.current) {
                const union = unionRects(targetRects);
                if (union) commitRect(id, union);
                return;
            }

            resolveMeasuredRect(stageRef, (stageRect) => {
                if (measurementGenerationRef.current.get(id) !== generation) return;
                const union = unionRects(targetRects.map((rect) => subtractStageOrigin(rect, stageRect)));
                if (union) commitRect(id, union);
            }, true);
        }, true);
    }, [commitRect, props.stageRef]);

    const readVisualTargetRect = React.useCallback((id: string, callback: (rect: StageTargetRect) => void) => {
        const target = targetsRef.current.get(id);
        if (!target) return;

        resolveMeasuredRects(target.refs, (targetRects) => {
            const stageRef = props.stageRef;
            if (!stageRef?.current) {
                const union = unionRects(targetRects);
                if (union) callback(union);
                return;
            }

            resolveMeasuredRect(stageRef, (stageRect) => {
                const union = unionRects(targetRects.map((rect) => subtractStageOrigin(rect, stageRect)));
                if (union) callback(union);
            }, true);
        }, true);
    }, [props.stageRef]);

    const registerTarget = React.useCallback((id: string, ref: React.RefObject<SpotlightTargetRef | null>) => {
        const target = targetsRef.current.get(id) ?? { refs: new Set<React.RefObject<SpotlightTargetRef | null>>() };
        target.refs.add(ref);
        targetsRef.current.set(id, target);
        setRegisteredTargetIds((currentIds) => {
            if (currentIds.has(id)) return currentIds;
            const nextIds = new Set(currentIds);
            nextIds.add(id);
            return nextIds;
        });
        measureTarget(id);

        return () => {
            const currentTarget = targetsRef.current.get(id);
            if (!currentTarget?.refs.has(ref)) return;
            currentTarget.refs.delete(ref);
            if (currentTarget.refs.size > 0) {
                measureTarget(id);
                return;
            }
            targetsRef.current.delete(id);
            measurementGenerationRef.current.set(
                id,
                (measurementGenerationRef.current.get(id) ?? 0) + 1,
            );
            setRegisteredTargetIds((currentIds) => {
                if (!currentIds.has(id)) return currentIds;
                const nextIds = new Set(currentIds);
                nextIds.delete(id);
                return nextIds;
            });
            setRects((currentRects) => {
                if (!currentRects.has(id)) return currentRects;
                const nextRects = new Map(currentRects);
                nextRects.delete(id);
                return nextRects.size === 0 ? EMPTY_RECTS : nextRects;
            });
        };
    }, [measureTarget]);

    const hasTarget = React.useCallback((id: string) => (targetsRef.current.get(id)?.refs.size ?? 0) > 0, []);

    const value = React.useMemo<SpotlightRegistryContextValue>(() => ({
        activeTargetId: props.activeTargetId ?? null,
        rects,
        registeredTargetIds,
        hasTarget,
        registerTarget,
        measureTarget,
        readVisualTargetRect,
    }), [
        props.activeTargetId,
        rects,
        registeredTargetIds,
        hasTarget,
        registerTarget,
        measureTarget,
        readVisualTargetRect,
    ]);

    return React.createElement(SpotlightRegistryContext.Provider, { value }, props.children);
}

export function useSpotlightTarget(
    ref: React.RefObject<SpotlightTargetRef | null>,
    id: string | null | undefined,
): SpotlightTargetProps {
    const registry = React.useContext(SpotlightRegistryContext);
    const scopeActive = React.useContext(SpotlightTargetScopeContext);
    const { activeTargetId, measureTarget, registerTarget } = registry;
    const registrationActive = Boolean(scopeActive && id);

    React.useLayoutEffect(() => {
        if (!id || !registrationActive) return undefined;
        return registerTarget(id, ref);
    }, [id, ref, registerTarget, registrationActive]);

    const handleLayout = React.useCallback(() => {
        if (!id || !registrationActive) return;
        measureTarget(id);
    }, [id, measureTarget, registrationActive]);

    const isActive = Boolean(registrationActive && id && activeTargetId === id);

    return React.useMemo(() => ({
        active: isActive,
        onLayout: handleLayout,
        style: isActive ? activeTargetStyle : undefined,
    }), [handleLayout, isActive]);
}

export function useRegisteredSpotlightTargetRect(
    targetId: string | null | undefined,
    fallbackRect: StageTargetRect,
): Readonly<{ found: boolean; rect: StageTargetRect }> {
    const registry = React.useContext(SpotlightRegistryContext);
    if (!targetId) {
        return { found: false, rect: fallbackRect };
    }
    const rect = registry.rects.get(targetId);
    return {
        found: Boolean(rect),
        rect: rect ?? fallbackRect,
    };
}

export function useRemeasureSpotlightTarget(targetId: string | null | undefined): () => void {
    const registry = React.useContext(SpotlightRegistryContext);
    const { measureTarget } = registry;

    return React.useCallback(() => {
        if (!targetId) return;
        measureTarget(targetId);
    }, [measureTarget, targetId]);
}

export function useReadVisualSpotlightTargetRect(
    targetId: string | null | undefined,
): (callback: (rect: StageTargetRect) => void) => void {
    const registry = React.useContext(SpotlightRegistryContext);
    const { readVisualTargetRect } = registry;

    return React.useCallback((callback) => {
        if (!targetId) return;
        readVisualTargetRect(targetId, callback);
    }, [readVisualTargetRect, targetId]);
}

export function useSpotlightTargetRegistration(targetId: string | null | undefined): boolean {
    const registry = React.useContext(SpotlightRegistryContext);
    return Boolean(targetId && registry.registeredTargetIds.has(targetId));
}

export function useSpotlightTargetRegistrationChecker(): (targetId: string | null | undefined) => boolean {
    const registry = React.useContext(SpotlightRegistryContext);
    return React.useCallback((targetId) => (
        Boolean(targetId && registry.hasTarget(targetId))
    ), [registry]);
}
