import * as React from 'react';
import { AppState, Dimensions, Platform } from 'react-native';

import { readWebStepAnchor } from './capturePressedElement.web';
import type { StepAnchor, StepBuild, StepBuildResult, StepMotionLayerHandle, StepMove } from './stepMotionTypes';

type PendingMove = Readonly<{
    layer: string;
    kind: StepMove['kind'];
    returnTo?: StepAnchor;
}>;

function createStepMotionStage() {
    const layers = new Set<StepMotionLayerHandle>();
    const anchors: Array<StepAnchor | undefined> = [];
    const pointerCommits = new Map<number, number>();
    let pressed: StepAnchor | null = null;
    let pending: PendingMove | null = null;
    let active: (() => void) | null = null;
    let commitOrder = 0;
    let stopObserving: (() => void) | undefined;

    function settle() {
        pending = null;
        active?.();
    }

    function showIncoming(layer: StepMotionLayerHandle, complete?: (outcome: StepBuildResult) => void) {
        let cancel: (() => void) | undefined;
        let settled = false;
        const finish = (outcome: StepBuildResult) => {
            if (settled) return;
            settled = true;
            if (active === skip) active = null;
            cancel?.();
            complete?.(outcome);
        };
        const skip = () => finish('skipped');
        active = skip;
        cancel = layer.fadeIn(() => finish('settled'));
    }

    function layerFor(target: EventTarget | null) {
        if (!(target instanceof Node)) return undefined;
        return Array.from(layers).findLast(layer => layer.webElement()?.contains(target));
    }

    function isBackTarget(target: EventTarget | null) {
        if (!(target instanceof Element)) return false;
        const testID = target.closest<HTMLElement>('[data-testid]')?.dataset.testid;
        return testID !== undefined && Array.from(layers).some(layer => layer.backTestID === testID);
    }

    function webInput(target: EventTarget | null) {
        if (isBackTarget(target)) return;
        settle();
        const element = layerFor(target)?.webElement();
        pressed = element ? readWebStepAnchor(element, target) : null;
    }

    function observeInput() {
        if (Platform.OS !== 'web') {
            const visibility = AppState.addEventListener('change', state => {
                if (state !== 'active') settle();
            });
            const resize = Dimensions.addEventListener('change', settle);
            return () => { visibility.remove(); resize.remove(); };
        }
        if (typeof document === 'undefined') return undefined;
        const pointer = (event: PointerEvent) => {
            pointerCommits.set(event.pointerId, commitOrder);
            webInput(event.target);
        };
        const cancelPointer = (event: PointerEvent) => { pointerCommits.delete(event.pointerId); };
        const click = (event: MouseEvent) => {
            if (event.detail === 0) return;
            const pointerID = 'pointerId' in event && typeof event.pointerId === 'number' ? event.pointerId : 1;
            const beganAt = pointerCommits.get(pointerID);
            pointerCommits.delete(pointerID);
            if (beganAt === undefined || beganAt === commitOrder || !layerFor(event.target)) return;
            event.preventDefault();
            event.stopImmediatePropagation();
        };
        const key = (event: KeyboardEvent) => {
            if (event.key === 'Escape') return;
            if (event.key === 'Enter' || event.key === ' ') webInput(document.activeElement);
            else { settle(); pressed = null; }
        };
        const visibility = () => { if (document.hidden) settle(); };
        document.addEventListener('pointerdown', pointer, true);
        document.addEventListener('pointercancel', cancelPointer, true);
        document.addEventListener('click', click, true);
        document.addEventListener('keydown', key, true);
        document.addEventListener('visibilitychange', visibility);
        window.addEventListener('resize', settle);
        return () => {
            document.removeEventListener('pointerdown', pointer, true);
            document.removeEventListener('pointercancel', cancelPointer, true);
            document.removeEventListener('click', click, true);
            document.removeEventListener('keydown', key, true);
            document.removeEventListener('visibilitychange', visibility);
            window.removeEventListener('resize', settle);
        };
    }

    return {
        attach(layer: StepMotionLayerHandle) {
            if (layers.size === 0) stopObserving = observeInput();
            layers.add(layer);
            return () => {
                layers.delete(layer);
                if (layers.size !== 0) return;
                stopObserving?.();
                stopObserving = undefined;
                if (!pending) pointerCommits.clear();
                pressed = null;
                // A route/tree swap can unregister its outgoing layer before the new layer commits.
                if (!pending) settle();
            };
        },
        commit(layer: StepMotionLayerHandle) {
            commitOrder++;
            if (pending?.layer !== layer.key) return;
            const { kind, returnTo } = pending;
            pending = null;
            if (kind === 'step' || kind === 'back') layer.focus(returnTo?.testID);
            showIncoming(layer);
        },
        nativeInput(anchor: StepAnchor, backTestID?: string) {
            if (backTestID !== undefined && anchor.testID === backTestID) return;
            settle();
            pressed = anchor;
        },
        run<T>(move: StepMove<T>): T {
            settle();
            const source = pressed;
            pressed = null;
            const returnTo = move.kind === 'back' ? anchors.pop() : undefined;
            if (move.kind === 'step') anchors.push(source ?? undefined);
            if (move.kind === 'home') anchors.length = 0;
            if (Array.from(layers).some(layer => layer.key === move.layer)) pending = { layer: move.layer, kind: move.kind, returnTo };
            return move.commit();
        },
        build(build: StepBuild): Promise<StepBuildResult> {
            settle();
            const layer = Array.from(layers).findLast(layer => layer.key === build.layer);
            if (!layer) return Promise.resolve('skipped');
            return new Promise(resolve => showIncoming(layer, resolve));
        },
        settle,
    };
}

type StepMotionStageController = ReturnType<typeof createStepMotionStage>;
const StageContext = React.createContext<StepMotionStageController | null>(null);
let rootStage: StepMotionStageController | null = null;

export function StepMotionStage({ children }: React.PropsWithChildren) {
    const [stage] = React.useState(createStepMotionStage);
    React.useLayoutEffect(() => {
        rootStage = stage;
        return () => {
            if (rootStage === stage) rootStage = null;
            stage.settle();
        };
    }, [stage]);
    return <StageContext.Provider value={stage}>{children}</StageContext.Provider>;
}

export function useStepMotionStage() {
    return React.useContext(StageContext);
}

export function runStepMove<T>(move: StepMove<T>): T {
    return rootStage ? rootStage.run(move) : move.commit();
}

export function playBuild(build: StepBuild): Promise<StepBuildResult> {
    return rootStage?.build(build) ?? Promise.resolve('skipped');
}

export function skipStepMotion(): void {
    rootStage?.settle();
}
