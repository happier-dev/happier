import * as React from 'react';
import { AppState, Dimensions, Platform, StyleSheet, View, useWindowDimensions, type GestureResponderEvent } from 'react-native';
import normalizeColor from '@react-native/normalize-colors';
import { useUnistyles } from 'react-native-unistyles';

import type { GlyphSurfaceProps, GlyphSurfaceReadiness } from '@/components/atmosphere/glyph/glyphSurfaceTypes';
import { readReducedMotionPreference } from '@/hooks/ui/useReducedMotionPreference';
import type { FocusReturnTarget } from '@/keyboard/focusReturn';

import { captureElementFlightRect } from '../rectFlight';
import { readNativeStepAnchor } from './capturePressedElement.native';
import { findInteractiveWebStepTarget, findPressedWebControl, readWebStepAnchor } from './capturePressedElement.web';
import type { StepGrammar } from './stepMotionChoreography';
import type { StepAnimation } from './stepMotionScene';
import { stepMotionTiming } from './stepMotionTiming';
import type { StepAnchor, StepBuild, StepBuildResult, StepFreeze, StepGrid, StepMotionLayerHandle, StepMove, StepWebLeaf } from './stepMotionTypes';

type AnimatedGrammar = Exclude<StepGrammar, 'fade'>;
type StepMotionPresentation = typeof import('./stepMotionPresentation');
type PendingMove = {
    outgoing: StepMotionLayerHandle;
    destination: string;
    kind: StepMove['kind'];
    grammar: StepGrammar;
    grid: StepGrid;
    anchor?: StepAnchor;
    returnTo?: StepAnchor;
    startProgress?: number;
    freeze?: StepFreeze;
    complete?: (outcome: StepBuildResult) => void;
    cancelled: boolean;
    layoutReady: boolean;
};
type StagePaint = Readonly<{
    animation: StepAnimation;
    duration: number;
    freeze?: StepFreeze;
    freezeOpacity: readonly number[];
    scene: GlyphSurfaceProps['scene'];
    releaseFreeze: () => void;
    finish: () => void;
}>;

const emptyScene: Extract<GlyphSurfaceProps['scene'], readonly unknown[]> = [];
const gridForWindow = (): StepGrid => {
    const { width, height } = Dimensions.get('window');
    const cell = stepMotionTiming.cell;
    return { width, height, cell, cols: Math.ceil(width / cell[0]), rows: Math.ceil(height / cell[1]) };
};

function targetRect(target: FocusReturnTarget): StepAnchor['rect'] | undefined {
    if (!target || typeof target !== 'object' || !('getBoundingClientRect' in target)) return;
    if (typeof target.getBoundingClientRect !== 'function') return;
    const rect = (target as { getBoundingClientRect: () => StepAnchor['rect'] }).getBoundingClientRect();
    return rect.width > 0 && rect.height > 0 ? rect : undefined;
}

function layerRect(layer: StepMotionLayerHandle): StepAnchor['rect'] | undefined {
    const element = layer.webElement();
    return element ? captureElementFlightRect(element) : targetRect(layer.nativeElement());
}

function inkFor(color: string) {
    const rgba = normalizeColor(color);
    return rgba === null ? undefined : [rgba >>> 24, (rgba >>> 16) & 255, (rgba >>> 8) & 255, rgba & 255] as const;
}

function leaveClip(progress: number, region: StepAnchor['rect'], origin?: StepAnchor['rect']) {
    if (!origin) return `inset(0 0 ${100 * progress}% 0)`;
    const x = Math.min(1, Math.max(0, (origin.x + origin.width / 2 - region.x) / region.width));
    const y = Math.min(1, Math.max(0, (origin.y + origin.height / 2 - region.y) / region.height));
    return `inset(${100 * progress * y}% ${100 * progress * (1 - x)}% ${100 * progress * (1 - y)}% ${100 * progress * x}%)`;
}

function createStepMotionStage(
    publish: (paint: StagePaint | null) => void,
    requestRenderer: (needed: boolean) => void,
    colors: () => Readonly<{ primary: string; tertiary: string; page: string }>,
) {
    const layers = new Set<StepMotionLayerHandle>();
    const anchors = new Map<string, Array<StepAnchor | undefined>>();
    const pointerCommits = new Map<number, number>();
    const handledNativeTouches = new WeakSet<GestureResponderEvent['nativeEvent']>();
    const committedSteps = new WeakSet<StepMotionLayerHandle>();
    const laidOutLayers = new WeakSet<StepMotionLayerHandle>();
    let pressed: StepAnchor | null = null;
    let pending: PendingMove | null = null;
    let active: { layer: string; animation?: StepAnimation; stop: () => void } | null = null;
    let commitOrder = 0;
    let glyphReady = false;
    let buildPrepared = false;
    let reportBuildReady: ((ready: boolean) => void) | undefined;
    let presentation: StepMotionPresentation | null = null;
    let stopObserving: (() => void) | undefined;

    function syncPresentation() {
        const firstRunMounted = Array.from(layers).some(layer => layer.warmOnMount);
        if (!pending && !active?.animation && !firstRunMounted && !buildPrepared) {
            glyphReady = false;
            requestRenderer(false);
        }
        if (firstRunMounted || active || pending) {
            stopObserving ??= observeInput();
        } else {
            stopObserving?.();
            stopObserving = undefined;
            pointerCommits.clear();
            pressed = null;
        }
    }

    function warm() {
        requestRenderer(true);
    }

    function cancelPending() {
        if (!pending) return;
        const abandoned = pending;
        pending = null;
        abandoned.cancelled = true;
        abandoned.freeze?.release();
        abandoned.complete?.('skipped');
    }

    function settle() {
        cancelPending();
        active?.stop();
        syncPresentation();
    }

    function showIncoming(layer: StepMotionLayerHandle, complete?: (outcome: StepBuildResult) => void) {
        let cancel: (() => void) | undefined;
        let settled = false;
        const finish = (outcome: StepBuildResult) => {
            if (settled) return;
            settled = true;
            if (active?.stop === skip) active = null;
            cancel?.();
            complete?.(outcome);
            syncPresentation();
        };
        const skip = () => finish('skipped');
        active = { layer: layer.key, stop: skip };
        syncPresentation();
        cancel = layer.fadeIn(() => finish('settled'));
    }

    function showAnimated(input: {
        layer: StepMotionLayerHandle;
        animation: StepAnimation;
        grid: StepGrid;
        freeze?: StepFreeze;
        source?: StepAnchor;
        returnTo?: StepAnchor;
        complete?: (outcome: StepBuildResult) => void;
    }) {
        const { layer, animation, grid, freeze, source, returnTo, complete } = input;
        const incoming = layerRect(layer);
        const duration = presentation?.stepAnimationDuration(animation);
        if (!presentation || !incoming || incoming.width <= 0 || incoming.height <= 0 || !duration || !glyphReady) {
            freeze?.release();
            showIncoming(layer, complete);
            return;
        }
        const { createStepMotionScene, radialDistance, readStepLeaves, readStepProgress, revealRadius, visualAt } = presentation;
        const reversing = animation.to === 0;
        const focalTarget = layer.focal();
        const returnTarget = returnTo?.testID ? layer.focal(returnTo.testID) : undefined;
        const sourceRect = reversing ? targetRect(returnTarget) ?? returnTo?.rect : source?.rect;
        const target = reversing ? source?.rect : targetRect(focalTarget);
        const web = layer.webElement();
        const leaves = web ? readStepLeaves(web, grid) : null;
        const { primary, tertiary, page } = colors();
        const cover = web ? undefined : reversing ? undefined : inkFor(page);
        const scene = createStepMotionScene({
            animation,
            grid,
            outgoing: reversing ? incoming : freeze?.rect,
            incoming: reversing && freeze ? freeze.rect : incoming,
            source: sourceRect,
            target,
            outgoingInk: reversing ? leaves?.ink : freeze?.ink,
            incomingInk: reversing ? freeze?.ink : leaves?.ink,
            ink: inkFor(tertiary),
            controlInk: inkFor(primary),
            cover,
        });
        const intervals = Math.ceil(duration * 60);
        const frames = Array.from({ length: intervals + 1 }, (_, index) =>
            visualAt(animation.grammar, readStepProgress(animation, duration * index / intervals)));
        const durationMs = duration * 1000;
        const delayMs = animation.epoch - performance.now();
        const cleanups: Array<() => void> = [];
        const animate = (node: HTMLElement, keyframes: Keyframe[], duration = durationMs) => {
            const effect = node.animate(keyframes, { duration, delay: delayMs, fill: 'both' });
            cleanups.push(() => { effect.onfinish = null; effect.cancel(); });
            return effect;
        };
        const building = animation.grammar === 'home' || animation.grammar === 'opening';
        const paintIncomingWeb = (element: HTMLElement, region: StepAnchor['rect'], leafNodes: readonly StepWebLeaf[], focal?: HTMLElement) => {
            if (leafNodes.length === 0) {
                animate(element, frames.map(frame => ({ opacity: frame.arrive, clipPath: `inset(${100 * (1 - frame.arriveFront)}% 0 0)` })));
            } else {
                const origin = !building && sourceRect
                    ? { x: sourceRect.x + sourceRect.width / 2, y: sourceRect.y + sourceRect.height / 2 }
                    : undefined;
                const radius = origin ? revealRadius(region, origin) : region.height;
                for (const { element: leaf, rect } of leafNodes) {
                    if (!building && leaf === focal) continue;
                    const midpoint = rect.y + rect.height / 2;
                    const distance = origin ? radialDistance(rect.x + rect.width / 2, midpoint, origin) : region.y + region.height - midpoint;
                    const at = Math.min(1, Math.max(0, distance / radius));
                    animate(leaf, frames.map(frame => ({
                        opacity: frame.arriveFront === 1 ? 1 : Math.max(0, Math.min(1, (frame.arriveFront - at) * 8)),
                    })));
                }
            }
            if (!building && focal && element.contains(focal)) animate(focal, frames.map(frame => ({ opacity: frame.focal })));
        };
        const paintOutgoingWeb = (element: HTMLElement, region: StepAnchor['rect'], pressed?: HTMLElement | null, onCleared?: () => void) => {
            const fold = building ? region : animation.grammar === 'fold' ? sourceRect : undefined;
            const clearFrame = onCleared ? frames.findIndex(frame => frame.leave === 0) : -1;
            const lastFrame = clearFrame > 0 ? clearFrame : intervals;
            const dissolve = animate(element, frames.slice(0, lastFrame + 1).map(frame => ({
                opacity: frame.leave, clipPath: leaveClip(frame.leaveFront, region, fold),
            })), durationMs * lastFrame / intervals);
            if (onCleared) dissolve.onfinish = onCleared;
            if (pressed && !building) animate(pressed, frames.map(frame => ({ opacity: frame.pressed })));
        };
        if (web?.animate) {
            if (reversing) paintOutgoingWeb(web, incoming, returnTarget instanceof HTMLElement ? returnTarget : undefined);
            else paintIncomingWeb(web, incoming, leaves?.leaves ?? [], focalTarget instanceof HTMLElement ? focalTarget : undefined);
        } else if (!cover) {
            cleanups.push(layer.paintOpacity(frames.map(frame => reversing ? frame.leave : frame.arrive), durationMs, delayMs));
        }
        const freezeOpacity = frames.map(frame => reversing ? frame.arrive : frame.leave);
        let freezeReleased = false;
        const releaseFreeze = () => {
            if (freezeReleased) return;
            freezeReleased = true;
            freeze?.release();
        };
        if (freeze?.clone) {
            if (reversing) paintIncomingWeb(freeze.clone, freeze.rect, freeze.webLeaves ?? [], freeze.webFocal);
            else paintOutgoingWeb(freeze.clone, freeze.rect, freeze.control, releaseFreeze);
        }

        const finish = (outcome: StepBuildResult) => {
            if (active?.stop !== skip) return;
            active = null;
            for (const cleanup of cleanups) cleanup();
            publish(null);
            releaseFreeze();
            syncPresentation();
            complete?.(outcome);
        };
        const skip = () => finish('skipped');
        active = { layer: layer.key, animation, stop: skip };
        syncPresentation();
        publish({ animation, duration, freeze, freezeOpacity, scene, releaseFreeze, finish: () => finish('settled') });
    }

    function enter(layer: StepMotionLayerHandle) {
        const move = pending;
        if (!move || move.destination !== layer.key) return;
        pending = null;
        move.cancelled = true;
        if (move.grammar === 'fade' || !move.freeze) {
            move.freeze?.release();
            showIncoming(layer, move.complete);
            return;
        }
        const back = move.kind === 'back';
        const grammar = move.grammar;
        const animation: StepAnimation = {
            grammar,
            from: back ? move.startProgress ?? 1 : 0,
            to: back ? 0 : 1,
            secondsPerProgress: grammar === 'home' ? stepMotionTiming.homeS : back ? stepMotionTiming.backS : stepMotionTiming.forwardS,
            epoch: performance.now(),
        };
        showAnimated({ layer, animation, grid: move.grid, freeze: move.freeze, source: move.anchor, returnTo: move.returnTo, complete: move.complete });
    }

    function layerFor(target: EventTarget | null) {
        if (!(target instanceof Node)) return undefined;
        let found: StepMotionLayerHandle | undefined;
        for (const layer of layers) {
            const candidate = layer.webElement();
            if (candidate?.contains(target) && (!found || found.webElement()?.contains(candidate))) found = layer;
        }
        return found;
    }

    function isBackControl(testID: string | undefined) {
        return testID !== undefined && Array.from(layers).some(layer => layer.backTestID === testID);
    }

    function webInput(target: EventTarget | null) {
        const control = findPressedWebControl(target);
        if (isBackControl(control?.dataset.testid)) return;
        settle();
        const element = layerFor(target)?.webElement();
        pressed = element ? readWebStepAnchor(element, control) : null;
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
        const mouseDown = (event: MouseEvent) => {
            if (event.button !== 0 || event.detail < 2) return;
            const layer = layerFor(event.target);
            if (layer && layer.focal() === document.activeElement && !findInteractiveWebStepTarget(event.target)) {
                // A repeat on decoration would otherwise blur the newly focused step.
                event.preventDefault();
            }
        };
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
        document.addEventListener('mousedown', mouseDown, true);
        document.addEventListener('click', click, true);
        document.addEventListener('keydown', key, true);
        document.addEventListener('beforeinput', settle, true);
        document.addEventListener('visibilitychange', visibility);
        window.addEventListener('resize', settle);
        return () => {
            document.removeEventListener('pointerdown', pointer, true);
            document.removeEventListener('pointercancel', cancelPointer, true);
            document.removeEventListener('mousedown', mouseDown, true);
            document.removeEventListener('click', click, true);
            document.removeEventListener('keydown', key, true);
            document.removeEventListener('beforeinput', settle, true);
            document.removeEventListener('visibilitychange', visibility);
            window.removeEventListener('resize', settle);
        };
    }

    function findLayer(key: string) {
        return Array.from(layers).findLast(layer => layer.key === key);
    }

    return {
        attach(layer: StepMotionLayerHandle) {
            if (layer.warmOnMount && !readReducedMotionPreference()) warm();
            layers.add(layer);
            syncPresentation();
            return () => {
                layers.delete(layer);
                if (layers.size === 0 && !pending) settle();
                else syncPresentation();
            };
        },
        commit(layer: StepMotionLayerHandle, reactivated = false) {
            const alreadyCommitted = committedSteps.has(layer);
            committedSteps.add(layer);
            commitOrder++;
            if (pending?.destination !== layer.key) {
                if (alreadyCommitted && !reactivated && layer.warmOnMount && !pending) {
                    settle();
                    showIncoming(layer);
                }
                return;
            }
            if (pending.kind === 'step' || pending.kind === 'back') layer.focus(pending.returnTo?.testID, pending.kind === 'step');
            pending.layoutReady = true;
            // A retained route or the held Personal Home frame can already have a native layout.
            const alreadyLaidOut = (reactivated || (pending.kind === 'home' && alreadyCommitted)) && laidOutLayers.has(layer);
            if (Platform.OS === 'web' || pending.grammar === 'fade' || alreadyLaidOut) enter(layer);
        },
        laidOut(layer: StepMotionLayerHandle) {
            laidOutLayers.add(layer);
            if (layers.has(layer) && pending?.layoutReady) enter(layer);
        },
        nativeTouch(event: GestureResponderEvent, layer?: View) {
            if (!layer && !pending && !active) return;
            // The closest layer handles the press first, before it bubbles to app chrome.
            if (handledNativeTouches.has(event.nativeEvent)) return;
            handledNativeTouches.add(event.nativeEvent);
            const anchor = readNativeStepAnchor(event, layer ?? event.currentTarget);
            if (isBackControl(anchor.testID)) return;
            settle();
            pressed = layer ? anchor : null;
        },
        nativeTyping() {
            if (active || pending) settle();
            pressed = null;
        },
        glyphReadiness(readiness: GlyphSurfaceReadiness) {
            const ready = readiness === 'ready';
            if (ready !== glyphReady) {
                glyphReady = ready;
                reportBuildReady?.(ready);
            }
            if (!glyphReady && active?.animation) settle();
        },
        loadPresentation(loaded: StepMotionPresentation) {
            presentation = loaded;
        },
        prepareBuild(onReady?: (ready: boolean) => void) {
            buildPrepared = true;
            reportBuildReady = onReady;
            onReady?.(glyphReady);
            warm();
            return () => {
                buildPrepared = false;
                reportBuildReady = undefined;
                syncPresentation();
            };
        },
        isBuildReady: () => glyphReady,
        run<T>(move: StepMove<T>): T {
            const previous = active?.animation;
            const startProgress = move.kind === 'back' && previous?.to === 1 && active?.layer === move.layer
                && (previous.grammar === 'morph' || previous.grammar === 'fold')
                ? presentation?.readStepProgress(previous, (performance.now() - previous.epoch) / 1000)
                : undefined;
            const outgoing = findLayer(move.layer);
            // Approval can request navigation while auth publishes the same Home in its mounted route.
            // Both commits matter, but the one outgoing layer only needs one capture and one presentation.
            if (move.kind === 'home' && pending?.kind === 'home' && pending.outgoing === outgoing) {
                const { onSettled } = move;
                if (onSettled) {
                    const complete = pending.complete;
                    pending.complete = outcome => { complete?.(outcome); onSettled(outcome); };
                }
                return move.commit();
            }
            const outgoingFocal = move.kind === 'back' && outgoing ? targetRect(outgoing.focal()) : undefined;
            const anchor = outgoingFocal ? { rect: outgoingFocal } : pressed ?? undefined;
            pressed = null;
            settle();
            if (move.kind === 'home') anchors.clear();
            if (!outgoing) {
                const result = move.commit();
                move.onSettled?.('skipped');
                return result;
            }
            const stack = anchors.get(move.layer) ?? [];
            const returnTo = move.kind === 'back' ? stack.pop() : undefined;
            if (move.kind === 'step') {
                stack.push(anchor);
                anchors.set(move.layer, stack);
            }
            const reduced = readReducedMotionPreference();
            if (!reduced) warm();
            const grammar = presentation?.resolveMoveGrammar({
                ...move, reduced: reduced || !glyphReady, compact: outgoing.compact,
            }) ?? 'fade';
            const grid = gridForWindow();
            const next: PendingMove = {
                outgoing,
                kind: move.kind, grammar, grid, anchor, returnTo, startProgress, complete: move.onSettled,
                cancelled: false, layoutReady: false,
                destination: move.kind === 'home' ? 'home' : move.layer,
            };
            pending = next;
            syncPresentation();
            if (presentation && grammar !== 'fade') {
                const freeze = presentation.freezeStepLayer(outgoing, grid, move.kind === 'back' ? undefined : anchor);
                if (freeze instanceof Promise) {
                    void freeze.then(result => {
                        if (next.cancelled) result?.release();
                        else next.freeze = result ?? undefined;
                    });
                } else next.freeze = freeze ?? undefined;
            }
            try {
                return move.commit();
            } catch (error) {
                cancelPending();
                throw error;
            }
        },
        build(build: StepBuild): Promise<StepBuildResult> {
            settle();
            const layer = findLayer(build.layer);
            if (!layer) return Promise.resolve('skipped');
            const reduced = readReducedMotionPreference();
            if (!reduced) warm();
            return new Promise(resolve => {
                if (reduced || !glyphReady) {
                    showIncoming(layer, resolve);
                    return;
                }
                const grammar: AnimatedGrammar = build.choreography;
                showAnimated({
                    layer, grid: gridForWindow(), complete: resolve,
                    animation: {
                        grammar, from: 0, to: 1,
                        secondsPerProgress: grammar === 'opening' ? stepMotionTiming.openingS : stepMotionTiming.homeS,
                        epoch: (build.epoch ?? performance.now()) + (build.leadSeconds ?? 0) * 1000,
                    },
                });
            });
        },
        settle,
    };
}

type StepMotionStageController = ReturnType<typeof createStepMotionStage>;
const StageContext = React.createContext<StepMotionStageController | null>(null);
let rootStage: StepMotionStageController | null = null;

export function StepMotionStage({ children }: React.PropsWithChildren) {
    const [paints, publish] = React.useState<StagePaint | null>(null);
    const [warming, setWarming] = React.useState(false);
    const [renderer, setRenderer] = React.useState<Readonly<{
        GlyphSurface: React.ComponentType<GlyphSurfaceProps>;
        StepFreezeImage: StepMotionPresentation['StepFreezeImage'];
    }> | null>(null);
    const { theme } = useUnistyles();
    const colors = React.useRef({ ...theme.colors.text, page: theme.colors.background.canvas });
    colors.current = { ...theme.colors.text, page: theme.colors.background.canvas };
    const [stage] = React.useState(() => createStepMotionStage(publish, setWarming, () => colors.current));
    const { width, height } = useWindowDimensions();
    React.useEffect(() => {
        if (!warming) return;
        let live = true;
        void Promise.all([import('@/components/atmosphere/glyph/GlyphSurface'), import('./stepMotionPresentation')]).then(
            ([glyph, loaded]) => {
                if (!live) return;
                stage.loadPresentation(loaded);
                setRenderer({ GlyphSurface: glyph.GlyphSurface, StepFreezeImage: loaded.StepFreezeImage });
            },
            () => { if (live) stage.glyphReadiness('still'); },
        );
        return () => { live = false; };
    }, [warming, stage]);
    React.useLayoutEffect(() => {
        rootStage = stage;
        return () => {
            if (rootStage === stage) rootStage = null;
            stage.settle();
        };
    }, [stage]);
    const motion = React.useMemo<GlyphSurfaceProps['motion']>(() => paints ? ({
        kind: 'transition', epoch: paints.animation.epoch,
        durationS: paints.duration, onSettled: paints.finish,
    }) : null, [paints]);
    return <StageContext.Provider value={stage}>
        <View style={{ flex: 1 }} onTouchStart={Platform.OS === 'web' ? undefined : stage.nativeTouch}>
            {children}
            {warming && renderer ? <View pointerEvents="none" accessible={false} accessibilityElementsHidden
                importantForAccessibility="no-hide-descendants" aria-hidden
                style={[StyleSheet.absoluteFillObject, { zIndex: 1001 }]}>
                {paints?.freeze?.image ? <renderer.StepFreezeImage
                    key={paints.animation.epoch}
                    freeze={paints.freeze}
                    opacity={paints.freezeOpacity}
                    durationMs={paints.duration * 1000}
                    delayMs={paints.animation.epoch - performance.now()}
                    onCleared={paints.releaseFreeze}
                /> : null}
                <renderer.GlyphSurface width={width} height={height} cell={stepMotionTiming.cell}
                    scene={paints?.scene ?? emptyScene} motion={motion} onReady={stage.glyphReadiness} warmWhenHidden />
            </View> : null}
        </View>
    </StageContext.Provider>;
}

export function useStepMotionStage() {
    return React.useContext(StageContext);
}

/** Warm the admitted opening without delaying its first layout. */
export function usePrepareStepBuild(admitted: boolean, onReady?: (ready: boolean) => void): () => boolean {
    const stage = useStepMotionStage();
    React.useLayoutEffect(() => admitted ? stage?.prepareBuild(onReady) : undefined, [admitted, onReady, stage]);
    return React.useCallback(() => stage?.isBuildReady() ?? false, [stage]);
}

export function runStepMove<T>(move: StepMove<T>): T {
    if (rootStage) return rootStage.run(move);
    const result = move.commit();
    move.onSettled?.('skipped');
    return result;
}

export function playBuild(build: StepBuild): Promise<StepBuildResult> {
    return rootStage?.build(build) ?? Promise.resolve('skipped');
}

export function skipStepMotion(): void {
    rootStage?.settle();
}

export function settleStepMotionOnNativeInput(): void {
    if (Platform.OS !== 'web') rootStage?.nativeTyping();
}
