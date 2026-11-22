import * as React from 'react';
import { Dimensions, Platform, StyleSheet, View, useWindowDimensions, type GestureResponderEvent } from 'react-native';
import normalizeColor from '@react-native/normalize-colors';
import { useUnistyles } from 'react-native-unistyles';

import type { GlyphSurfaceProps, GlyphSurfaceReadiness } from '@/components/atmosphere/glyph/glyphSurfaceTypes';
import { readReducedMotionPreference } from '@/hooks/ui/useReducedMotionPreference';
import type { FocusReturnTarget } from '@/keyboard/focusReturn';
import { readHostActivelyFocused, subscribeToHostActivelyViewed } from '@/utils/runtime/useHostActivelyViewed';

import { captureElementFlightRect } from '../rectFlight';
import { readNativeStepAnchor } from './capturePressedElement.native';
import { findInteractiveWebStepTarget, findPressedWebControl, readWebStepAnchor } from './capturePressedElement.web';
import type { StepGrammar } from './stepMotionChoreography';
import type { StepAnimation, StepFocalInk } from './stepMotionScene';
import { stepMotionTiming } from './stepMotionTiming';
import { copyStepLayer } from './stepPaintCopy';
import type { StepAnchor, StepBuild, StepBuildResult, StepFreeze, StepGrid, StepMotionLayerHandle, StepMove, StepWebLeaf } from './stepMotionTypes';

type AnimatedGrammar = Exclude<StepGrammar, 'fade'>;
type StepMotionPresentation = typeof import('./stepMotionPresentation');
type StepEndpoints = { source?: StepAnchor['rect']; target?: StepAnchor['rect']; focalInk?: StepFocalInk };
type PendingMove = {
    destination: string;
    kind: StepMove['kind'];
    grammar: StepGrammar;
    grid: StepGrid;
    anchor?: StepAnchor;
    returnTo?: StepAnchor;
    reverse?: Readonly<{ progress: number; grammar: 'morph' | 'fold'; endpoints: StepEndpoints }>;
    freeze?: StepFreeze;
    complete?: (outcome: StepBuildResult) => void;
    cancelled: boolean;
    layoutReady: boolean;
    homePaintFrame?: number;
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
type OpeningBuildGlyphs = Pick<StagePaint, 'animation' | 'duration' | 'scene' | 'finish'>;
type OpeningInput = Readonly<{
    web: (control: HTMLElement | null) => boolean;
    native: (event: GestureResponderEvent) => boolean;
}>;
type HomeGlyphArrival = Readonly<{
    settleEpoch: number;
    building: boolean;
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
    publishHomeArrival: React.Dispatch<React.SetStateAction<HomeGlyphArrival | null>>,
    requestRenderer: (needed: boolean) => void,
    prepareOpeningRenderer: (preparing: boolean) => void,
    colors: () => Readonly<{ tertiary: string; page: string }>,
) {
    const layers = new Set<StepMotionLayerHandle>();
    const anchors = new Map<string, Array<StepAnchor | undefined>>();
    const pointerCommits = new Map<number, number | null>();
    const handledNativeTouches = new WeakSet<GestureResponderEvent['nativeEvent']>();
    const committedSteps = new WeakSet<StepMotionLayerHandle>();
    const laidOutLayers = new WeakSet<StepMotionLayerHandle>();
    let pressed: StepAnchor | null = null;
    let pressedChrome: { layer: string; regions: readonly StepWebLeaf[] } | undefined;
    let pending: PendingMove | null = null;
    let active: { layer: string; animation?: StepAnimation; endpoints?: StepEndpoints; openingInput?: OpeningInput; stop: () => void } | null = null;
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
        if (abandoned.homePaintFrame !== undefined) cancelAnimationFrame(abandoned.homePaintFrame);
        abandoned.freeze?.release();
        requestRenderer(false);
        abandoned.complete?.('skipped');
    }

    function settle() {
        pressedChrome = undefined;
        cancelPending();
        active?.stop();
        syncPresentation();
    }

    function skip(focusDestination: boolean) {
        const destination = focusDestination && active ? findLayer(active.layer) : undefined;
        settle();
        destination?.focus();
    }

    /** The cross-fade: the next step rises in while a web copy of the departing one fades over it. */
    function showIncoming(layer: StepMotionLayerHandle, rise: boolean, complete?: (outcome: StepBuildResult) => void,
        outgoing?: StepFreeze, duration?: number) {
        const leaving = outgoing?.clone ? outgoing : undefined;
        if (!leaving) outgoing?.release();
        let cancel: (() => void) | undefined;
        let settled = false;
        const leaves: Animation[] = [];
        const finish = (outcome: StepBuildResult) => {
            if (settled) return;
            settled = true;
            if (active?.stop === skip) active = null;
            cancel?.();
            for (const leave of leaves) leave.cancel();
            leaving?.release();
            requestRenderer(false);
            complete?.(outcome);
            syncPresentation();
        };
        const skip = () => finish('skipped');
        active = { layer: layer.key, stop: skip };
        syncPresentation();
        cancel = layer.fadeIn(() => finish('settled'), rise, duration);
        const backdrop = leaving?.webBackdrop;
        for (const region of backdrop ? [backdrop] : leaving ? [leaving.clone!, ...leaving.webChrome ?? []] : []) {
            leaves.push(region.animate([{ opacity: 1 }, { opacity: 0 }],
                { duration: stepMotionTiming.noticeCrossFadeMs, easing: 'ease-out', fill: 'both' }));
        }
    }

    function showAnimated(input: {
        layer: StepMotionLayerHandle;
        animation: StepAnimation;
        grid: StepGrid;
        freeze?: StepFreeze;
        source?: StepAnchor;
        returnTo?: StepAnchor;
        endpoints?: StepEndpoints;
        complete?: (outcome: StepBuildResult) => void;
        interactiveOpening?: boolean;
    }) {
        const { layer, animation, grid, freeze, source, returnTo, complete } = input;
        const incoming = layerRect(layer);
        const duration = presentation?.stepAnimationDuration(animation);
        if (!presentation || !incoming || incoming.width <= 0 || incoming.height <= 0 || !duration ||
            (animation.grammar !== 'opening' && !glyphReady)) {
            showIncoming(layer, true, complete, freeze);
            return;
        }
        const { createStepMotionScene, leavingEdge, radialDistance, readStepLeaves, readStepProgress, readWebFocalInk,
            revealRadius, stepLeavesIn, visualAt } = presentation;
        const reversing = animation.to === 0;
        const focalTarget = layer.focal();
        const returnTarget = returnTo?.testID ? layer.focal(returnTo.testID) : undefined;
        const endpoints = input.endpoints ?? {
            source: reversing ? targetRect(returnTarget) ?? returnTo?.rect : source?.rect,
            target: reversing ? source?.rect : targetRect(focalTarget),
        };
        const { source: sourceRect, target } = endpoints;
        const morphing = animation.grammar === 'morph';
        const sampleFocalInk = (node: HTMLElement) => {
            if (morphing && target && !reversing && !endpoints.focalInk) {
                endpoints.focalInk = readWebFocalInk(node, target);
            }
        };
        const web = layer.webElement();
        if (web && focalTarget instanceof HTMLElement) sampleFocalInk(focalTarget);
        const leaves = web ? readStepLeaves(web, grid, animation.grammar !== 'home' && animation.grammar !== 'opening') : null;
        const { tertiary, page } = colors();
        const cover = web ? undefined : reversing ? undefined : inkFor(page);
        const scene = createStepMotionScene({
            animation,
            grid,
            outgoing: reversing ? incoming : freeze?.rect,
            incoming: reversing && freeze ? freeze.rect : incoming,
            source: sourceRect,
            target,
            readFocalInk: () => endpoints.focalInk,
            outgoingInk: reversing ? leaves?.ink : freeze?.ink,
            incomingInk: reversing ? freeze?.ink : leaves?.ink,
            ink: inkFor(tertiary),
            cover,
        });
        const intervals = Math.ceil(duration * 60);
        const frames = Array.from({ length: intervals + 1 }, (_, index) =>
            visualAt(animation.grammar, readStepProgress(animation, duration * index / intervals)));
        const durationMs = duration * 1000;
        const delayMs = animation.epoch - performance.now();
        const cleanups: Array<() => void> = [];
        const animate = (node: HTMLElement, keyframes: Keyframe[], duration = durationMs) => {
            const effect = node.animate(keyframes, { duration, delay: animation.epoch - performance.now(), fill: 'both' });
            cleanups.push(() => { effect.onfinish = null; effect.cancel(); });
            return effect;
        };
        const building = animation.grammar === 'home' || animation.grammar === 'opening';
        const revealPositions = input.interactiveOpening && web ? new WeakMap<HTMLElement, number>() : null;
        const openingFront = () => visualAt('opening', readStepProgress(animation, (performance.now() - animation.epoch) / 1000)).arriveFront;
        const revealed = (front: number, at: number) => front === 1 || front > at;
        const paintIncomingWeb = (element: HTMLElement, region: StepAnchor['rect'], leafNodes: readonly StepWebLeaf[],
            focal?: HTMLElement, live = false) => {
            const origin = !building && sourceRect
                ? { x: sourceRect.x + sourceRect.width / 2, y: sourceRect.y + sourceRect.height / 2 }
                : undefined;
            const radius = origin ? revealRadius(region, origin) : region.height;
            const painted = new Set<Element>();
            const paintFocal = (node: HTMLElement | undefined) => {
                if (building || !node || !element.contains(node) || painted.has(node)) return;
                painted.add(node);
                animate(node, frames.map(frame => ({ opacity: frame.focal })));
            };
            const paintLeaves = (leaves: readonly StepWebLeaf[]) => {
                for (const { element: leaf, rect } of leaves) {
                    painted.add(leaf);
                    if (!building && focal?.contains(leaf)) continue;
                    const midpoint = rect.y + rect.height / 2;
                    const distance = origin ? radialDistance(rect.x + rect.width / 2, midpoint, origin) : region.y + region.height - midpoint;
                    const at = Math.min(1, Math.max(0, distance / radius));
                    if (live) revealPositions?.set(leaf, at);
                    animate(leaf, frames.map(frame => ({
                        opacity: frame.arriveFront === 1 ? 1 : Math.max(0, Math.min(1, (frame.arriveFront - at) * 8)),
                    })));
                }
            };
            paintFocal(focal);
            paintLeaves(leafNodes);
            if (!live && painted.size === 0) {
                animate(element, frames.map(frame => ({ opacity: frame.arrive, clipPath: `inset(${100 * (1 - frame.arriveFront)}% 0 0)` })));
            }
            if (!live) return;
            const observer = new MutationObserver(records => {
                const currentFocal = layer.focal();
                if (currentFocal instanceof HTMLElement) {
                    paintFocal(currentFocal);
                    sampleFocalInk(currentFocal);
                }
                const added = new Set<HTMLElement>();
                const collect = (node: Node) => {
                    const candidate = node.nodeType === Node.TEXT_NODE ? node.parentElement : node;
                    if (!(candidate instanceof HTMLElement) || !element.contains(candidate)) return;
                    if (!building && currentFocal instanceof HTMLElement && currentFocal.contains(candidate)) return;
                    added.add(candidate);
                    if (candidate === node) {
                        for (const child of candidate.querySelectorAll<HTMLElement>('*')) added.add(child);
                    }
                };
                for (const record of records) {
                    if (record.type === 'characterData') collect(record.target);
                    for (const node of record.addedNodes) collect(node);
                }
                if (added.size === 0) return;
                paintLeaves(stepLeavesIn(element, [...added], painted));
            });
            observer.observe(element, { characterData: true, childList: true, subtree: true });
            cleanups.push(() => observer.disconnect());
        };
        const paintOutgoingWeb = (element: HTMLElement, region: StepAnchor['rect'], leafNodes: readonly StepWebLeaf[],
            pressed?: HTMLElement | null, onCleared?: () => void) => {
            const fold = building ? region : animation.grammar === 'fold' ? sourceRect : undefined;
            const clearFrame = onCleared ? frames.findIndex(frame => frame.leave === 0) : -1;
            const lastFrame = clearFrame > 0 ? clearFrame : intervals;
            const dissolve = animate(element, frames.slice(0, lastFrame + 1).map(frame => animation.grammar === 'morph'
                ? { opacity: frame.leave, clipPath: `inset(0 0 ${Math.max(0, Math.min(100, 100 * (region.y + region.height - leavingEdge(region, frame.leaveFront)) / region.height))}% 0)` }
                : { opacity: frame.leave, clipPath: leaveClip(frame.leaveFront, region, fold) }), durationMs * lastFrame / intervals);
            if (onCleared) dissolve.onfinish = onCleared;
            if (animation.grammar === 'morph') {
                for (const { element: leaf, rect } of leafNodes) {
                    if (leaf === pressed) continue;
                    animate(leaf, frames.map(frame => ({
                        opacity: Math.max(0, Math.min(1, (leavingEdge(region, frame.leaveFront) - rect.y - rect.height / 2) / 32)),
                    })));
                }
            }
            if (pressed && !building) animate(pressed, frames.map(frame => ({ opacity: frame.pressed })));
        };
        if (web?.animate) {
            if (reversing) {
                paintOutgoingWeb(web, incoming, leaves?.leaves ?? [], returnTarget instanceof HTMLElement ? returnTarget : undefined);
                for (const chrome of layer.webChrome?.() ?? []) animate(chrome, frames.map(frame => ({ opacity: frame.chrome })));
            } else {
                // The opening's band climbs the whole window, so each element decodes as the band passes it.
                const built = animation.grammar === 'opening' ? { x: 0, y: 0, width: grid.width, height: grid.height } : incoming;
                paintIncomingWeb(web, built, leaves?.leaves ?? [], focalTarget instanceof HTMLElement ? focalTarget : undefined, true);
                // The opening's climb builds the whole shell: its chrome decodes under the same front as the step.
                if (animation.grammar === 'opening') {
                    for (const chrome of layer.webChrome?.('shell') ?? []) {
                        paintIncomingWeb(chrome, built, readStepLeaves(chrome, grid, false).leaves, undefined, true);
                    }
                }
            }
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
            else {
                paintOutgoingWeb(freeze.clone, freeze.rect, freeze.webLeaves ?? [], freeze.control,
                    animation.grammar === 'morph' ? undefined : releaseFreeze);
                for (const chrome of freeze.webChrome ?? []) animate(chrome, frames.map(frame => ({ opacity: frame.chrome })));
                const backdrop = freeze.webBackdrop;
                const pageInk = backdrop && inkFor(page);
                if (backdrop && pageInk) {
                    const [red, green, blue] = pageInk;
                    animate(backdrop, frames.map(frame => ({
                        backgroundColor: `rgba(${red}, ${green}, ${blue}, ${frame.leave})`,
                    })));
                }
            }
        }

        const releaseHomeArrival = () => {
            publishHomeArrival(current => current?.finish === releaseHomeArrival ? null : current);
        };
        const homeArrival: HomeGlyphArrival | null = animation.grammar === 'home' ? {
            settleEpoch: animation.epoch + durationMs,
            building: true,
            finish: releaseHomeArrival,
        } : null;
        const finish = (outcome: StepBuildResult) => {
            if (active?.stop !== skip) return;
            active = null;
            for (const cleanup of cleanups) cleanup();
            publish(null);
            if (homeArrival) {
                if (outcome === 'skipped') releaseHomeArrival();
                else publishHomeArrival(current => current?.finish === releaseHomeArrival ? { ...homeArrival, building: false } : current);
            }
            releaseFreeze();
            if (!pending) requestRenderer(false);
            syncPresentation();
            complete?.(outcome);
        };
        const skip = () => finish('skipped');
        const openingInput: OpeningInput | undefined = input.interactiveOpening ? {
            web(control) {
                if (!control || !revealPositions) return false;
                const front = openingFront();
                // Pressable contents can share their painted ancestor's keyframes; the step and its chrome are built.
                for (let node: HTMLElement | null = control; node && node !== web; node = node.parentElement) {
                    const at = revealPositions.get(node);
                    if (at !== undefined) return revealed(front, at);
                }
                return false;
            },
            native(event) {
                const view = layer.nativeElement();
                if (!view) return false;
                const { pageX, pageY } = event.nativeEvent;
                if (pageX < incoming.x || pageX > incoming.x + incoming.width
                    || pageY < incoming.y || pageY > incoming.y + incoming.height) return false;
                const { testID, rect } = readNativeStepAnchor(event, view);
                return testID !== undefined && revealed(openingFront(), (incoming.y + incoming.height - rect.y - rect.height / 2) / incoming.height);
            },
        } : undefined;
        active = { layer: layer.key, animation, endpoints, openingInput, stop: skip };
        syncPresentation();
        if (homeArrival) publishHomeArrival(homeArrival);
        publish({ animation, duration, freeze, freezeOpacity, scene, releaseFreeze, finish: () => finish('settled') });
    }

    function afterHomePaint(move: PendingMove, action: () => void) {
        if (move.homePaintFrame !== undefined) cancelAnimationFrame(move.homePaintFrame);
        // Layout effects run before paint. Leave one browser rendering opportunity for the
        // retained destination while the outgoing copy still supplies the visible pixels.
        move.homePaintFrame = requestAnimationFrame(() => {
            move.homePaintFrame = requestAnimationFrame(() => {
                move.homePaintFrame = undefined;
                if (pending === move) action();
            });
        });
    }

    function enter(layer: StepMotionLayerHandle) {
        const move = pending;
        if (!move || move.destination !== layer.key) return;
        pending = null;
        move.cancelled = true;
        if (move.grammar === 'fade' || !move.freeze) {
            showIncoming(layer, move.kind !== 'notice', move.complete, move.freeze);
            return;
        }
        const back = move.kind === 'back';
        const grammar = move.grammar;
        const animation: StepAnimation = {
            grammar,
            from: back ? move.reverse?.progress ?? 1 : 0,
            to: back ? 0 : 1,
            secondsPerProgress: grammar === 'home' ? stepMotionTiming.homeS : back ? stepMotionTiming.backS : stepMotionTiming.forwardS,
            epoch: performance.now(),
        };
        showAnimated({
            layer, animation, grid: move.grid, freeze: move.freeze, source: move.anchor,
            returnTo: move.returnTo, endpoints: move.reverse?.endpoints, complete: move.complete,
        });
    }

    function layerFor(target: EventTarget | null) {
        if (!(target instanceof Node)) return undefined;
        let found: StepMotionLayerHandle | undefined;
        for (const layer of layers) {
            const candidate = layer.webElement();
            if (!candidate) continue;
            if ((candidate.contains(target) || layer.webChrome?.().some(region => region.contains(target))) &&
                (!found || found.webElement()?.contains(candidate))) found = layer;
        }
        return found;
    }

    function isBackControl(testID: string | undefined) {
        return testID !== undefined && Array.from(layers).some(layer => layer.backTestID === testID);
    }

    function webInput(target: EventTarget | null, settleExisting = true) {
        const control = findPressedWebControl(target);
        if (isBackControl(control?.dataset.testid)) return;
        if (settleExisting) settle();
        const layer = layerFor(target);
        const element = layer?.webElement();
        const chrome = layer?.webChrome?.();
        pressed = (element ? readWebStepAnchor(element, control) : null)
            ?? chrome?.map(region => readWebStepAnchor(region, control)).find(Boolean) ?? null;
        if (pressed && layer && chrome?.length) {
            // Login's Home lookup can remove the corner before the move commits. Keep its measured
            // node for this press so admission can still freeze it with the departing step.
            pressedChrome = { layer: layer.key, regions: chrome.map(element => ({ element, rect: captureElementFlightRect(element) })) };
        }
    }

    function observeInput() {
        const unwatchHost = subscribeToHostActivelyViewed(() => {
            if (!readHostActivelyFocused()) settle();
        });
        if (Platform.OS !== 'web') {
            const resize = Dimensions.addEventListener('change', settle);
            return () => { unwatchHost(); resize.remove(); };
        }
        if (typeof document === 'undefined') return unwatchHost;
        const pointer = (event: PointerEvent) => {
            const opening = active?.openingInput;
            if (opening && !opening.web(findInteractiveWebStepTarget(event.target))) {
                pointerCommits.set(event.pointerId, null);
                event.preventDefault();
                skip(true);
                return;
            }
            pointerCommits.set(event.pointerId, commitOrder);
            webInput(event.target, !opening);
        };
        const cancelPointer = (event: PointerEvent) => {
            pointerCommits.delete(event.pointerId);
            pressedChrome = undefined;
        };
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
            if (beganAt !== null && (beganAt === undefined || beganAt === commitOrder || !layerFor(event.target))) return;
            event.preventDefault();
            event.stopImmediatePropagation();
        };
        const key = (event: KeyboardEvent) => {
            if (event.key === 'Escape' || (event.key === 'Tab' && active?.openingInput)) return;
            if (event.key === 'Enter' || event.key === ' ') webInput(document.activeElement);
            else { settle(); pressed = null; }
        };
        document.addEventListener('pointerdown', pointer, true);
        document.addEventListener('pointercancel', cancelPointer, true);
        document.addEventListener('mousedown', mouseDown, true);
        document.addEventListener('click', click, true);
        document.addEventListener('keydown', key, true);
        document.addEventListener('beforeinput', settle, true);
        window.addEventListener('resize', settle);
        return () => {
            document.removeEventListener('pointerdown', pointer, true);
            document.removeEventListener('pointercancel', cancelPointer, true);
            document.removeEventListener('mousedown', mouseDown, true);
            document.removeEventListener('click', click, true);
            document.removeEventListener('keydown', key, true);
            document.removeEventListener('beforeinput', settle, true);
            unwatchHost();
            window.removeEventListener('resize', settle);
        };
    }

    function findLayer(key: string) {
        let latest: StepMotionLayerHandle | undefined;
        for (const layer of layers) {
            if (layer.key === key) latest = layer;
        }
        return latest;
    }

    return {
        attach(layer: StepMotionLayerHandle) {
            if (layer.warmOnMount && !glyphReady && !readReducedMotionPreference()) warm();
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
                    showIncoming(layer, true);
                }
                return;
            }
            if (pending.kind === 'step' || pending.kind === 'back') layer.focus(pending.returnTo?.testID, pending.kind === 'step');
            if (pending.freeze?.webBackdrop) {
                const move = pending;
                afterHomePaint(move, () => {
                    if (layers.has(layer)) enter(layer);
                });
                return;
            }
            pending.layoutReady = true;
            // A retained route or the held Personal Home frame can already have a native layout.
            const alreadyLaidOut = (reactivated || (pending.kind === 'home' && alreadyCommitted)) && laidOutLayers.has(layer);
            if (Platform.OS === 'web' || pending.grammar === 'fade' || alreadyLaidOut) enter(layer);
        },
        revealHomeRetry() {
            if (pending?.kind === 'home') afterHomePaint(pending, settle);
        },
        laidOut(layer: StepMotionLayerHandle) {
            laidOutLayers.add(layer);
            if (layers.has(layer) && pending?.layoutReady) enter(layer);
        },
        claimNativeOpeningTouch(event: GestureResponderEvent) {
            const opening = active?.openingInput;
            if (!opening || opening.native(event)) return false;
            handledNativeTouches.add(event.nativeEvent);
            skip(true);
            return true;
        },
        nativeTouch(event: GestureResponderEvent, layer?: View) {
            if (!layer && !pending && !active) return;
            // The closest layer handles the press first, before it bubbles to app chrome.
            if (handledNativeTouches.has(event.nativeEvent)) return;
            handledNativeTouches.add(event.nativeEvent);
            const anchor = readNativeStepAnchor(event, layer ?? event.currentTarget);
            if (isBackControl(anchor.testID)) return;
            if (!active?.openingInput) settle();
            pressed = layer ? anchor : null;
        },
        nativeTyping() {
            if (active || pending) settle();
            pressed = null;
        },
        glyphReadiness(readiness: GlyphSurfaceReadiness) {
            glyphReady = readiness === 'ready';
            if (!glyphReady && active?.animation) settle();
        },
        loadPresentation(loaded: StepMotionPresentation) {
            presentation = loaded;
            reportBuildReady?.(true);
        },
        prepareBuild(onReady?: (ready: boolean) => void) {
            buildPrepared = true;
            glyphReady = false;
            prepareOpeningRenderer(true);
            reportBuildReady = onReady;
            onReady?.(presentation !== null);
            warm();
            return () => {
                buildPrepared = false;
                reportBuildReady = undefined;
                prepareOpeningRenderer(false);
                syncPresentation();
            };
        },
        isBuildReady: () => buildPrepared ? presentation !== null : glyphReady,
        run<T>(move: StepMove<T>): T {
            // New notice content joins an already-moving destination through its paint observer.
            if (move.kind === 'notice' && (pending || (active && active.layer !== move.layer))) {
                const result = move.commit();
                move.onSettled?.('skipped');
                return result;
            }
            const previous = active?.animation;
            const reverse = move.kind === 'back' && previous?.to === 1 && active?.layer === move.layer
                && (previous.grammar === 'morph' || previous.grammar === 'fold') && active.endpoints && presentation
                ? {
                    grammar: previous.grammar,
                    progress: presentation.readStepProgress(previous, (performance.now() - previous.epoch) / 1000),
                    endpoints: active.endpoints,
                }
                : undefined;
            const outgoing = findLayer(move.layer);
            const outgoingFocal = move.kind === 'back' && outgoing ? targetRect(outgoing.focal()) : undefined;
            const anchor = outgoingFocal ? { rect: outgoingFocal } : pressed ?? undefined;
            const chrome = pressedChrome?.layer === move.layer ? pressedChrome.regions : undefined;
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
            if (!readHostActivelyFocused()) {
                const result = move.commit();
                move.onSettled?.('skipped');
                return result;
            }
            const reduced = readReducedMotionPreference();
            if (!reduced) warm();
            const still = reduced || !glyphReady;
            const grammar = (!still ? reverse?.grammar : undefined)
                ?? presentation?.resolveMoveGrammar({ ...move, reduced: still, compact: outgoing.compact })
                ?? 'fade';
            const grid = gridForWindow();
            const next: PendingMove = {
                kind: move.kind, grammar, grid, anchor, returnTo, reverse, complete: move.onSettled,
                cancelled: false, layoutReady: false,
                destination: move.kind === 'home' ? 'home' : move.layer,
            };
            pending = next;
            syncPresentation();
            // The web capture has its own opaque page until the outgoing ink is gone. Home's
            // real shell can attach behind it without ever lending its chrome to the old step.
            const backdrop = move.kind === 'home' && Platform.OS === 'web' ? colors().page : undefined;
            if (presentation && grammar !== 'fade') {
                const freeze = presentation.freezeStepLayer(outgoing, grid, move.kind === 'back' ? undefined : anchor, chrome, backdrop);
                if (freeze instanceof Promise) {
                    void freeze.then(result => {
                        if (next.cancelled) result?.release();
                        else next.freeze = result ?? undefined;
                    });
                } else next.freeze = freeze ?? undefined;
            } else if (grammar === 'fade' && move.kind !== 'notice' && Platform.OS === 'web') {
                // Without the renderer the move still never shows an empty column between the two steps.
                next.freeze = copyStepLayer(outgoing, backdrop) ?? undefined;
            }
            try {
                return move.commit();
            } catch (error) {
                settle();
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
                if (reduced || (build.choreography === 'opening' ? !presentation : !glyphReady)) {
                    showIncoming(layer, true, resolve);
                    return;
                }
                const grammar: AnimatedGrammar = build.choreography;
                showAnimated({
                    layer, grid: gridForWindow(), complete: resolve,
                    interactiveOpening: grammar === 'opening' && build.interactive,
                    animation: {
                        grammar, from: 0, to: 1,
                        secondsPerProgress: grammar === 'opening' ? stepMotionTiming.openingS : stepMotionTiming.homeS,
                        epoch: (build.epoch ?? performance.now()) + (build.leadSeconds ?? 0) * 1000,
                    },
                });
            });
        },
        settle,
        skip,
    };
}

type StepMotionStageController = ReturnType<typeof createStepMotionStage>;
const StageContext = React.createContext<StepMotionStageController | null>(null);
const OpeningBuildGlyphsContext = React.createContext<OpeningBuildGlyphs | null>(null);
const HomeGlyphArrivalContext = React.createContext<HomeGlyphArrival | null>(null);
let rootStage: StepMotionStageController | null = null;

export function StepMotionStage({ children }: React.PropsWithChildren) {
    const [paints, publish] = React.useState<StagePaint | null>(null);
    const [homeArrival, publishHomeArrival] = React.useState<HomeGlyphArrival | null>(null);
    const [warming, setWarming] = React.useState(false);
    const [openingPrepared, setOpeningPrepared] = React.useState(false);
    const [renderer, setRenderer] = React.useState<Readonly<{
        GlyphSurface: React.ComponentType<GlyphSurfaceProps>;
        StepFreezeImage: StepMotionPresentation['StepFreezeImage'];
    }> | null>(null);
    const { theme } = useUnistyles();
    const colors = React.useRef({ ...theme.colors.text, page: theme.colors.background.canvas });
    colors.current = { ...theme.colors.text, page: theme.colors.background.canvas };
    const [stage] = React.useState(() => createStepMotionStage(publish, publishHomeArrival, setWarming, setOpeningPrepared, () => colors.current));
    const { width, height } = useWindowDimensions();
    React.useEffect(() => {
        if (!warming || renderer) return;
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
    }, [warming, renderer, stage]);
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
    const opening = paints?.animation.grammar === 'opening' ? paints : null;
    return <StageContext.Provider value={stage}>
        <View style={{ flex: 1 }} onTouchStart={Platform.OS === 'web' ? undefined : stage.nativeTouch}
            onStartShouldSetResponderCapture={Platform.OS !== 'web' && opening ? stage.claimNativeOpeningTouch : undefined}>
            <OpeningBuildGlyphsContext.Provider value={opening}>
                <HomeGlyphArrivalContext.Provider value={homeArrival}>{children}</HomeGlyphArrivalContext.Provider>
            </OpeningBuildGlyphsContext.Provider>
            {warming && renderer && !openingPrepared && !opening ? <View pointerEvents="none" accessible={false} accessibilityElementsHidden
                importantForAccessibility="no-hide-descendants" aria-hidden
                style={[StyleSheet.absoluteFillObject, { zIndex: 1001, opacity: paints ? 1 : 0 }]}>
                {paints?.freeze?.image ? <renderer.StepFreezeImage
                    key={paints.animation.epoch}
                    freeze={paints.freeze}
                    opacity={paints.freezeOpacity}
                    durationMs={paints.duration * 1000}
                    delayMs={paints.animation.epoch - performance.now()}
                    onCleared={paints.releaseFreeze}
                /> : null}
                <renderer.GlyphSurface testID="step-motion-glyphs" width={width} height={height} cell={stepMotionTiming.cell}
                    scene={paints?.scene ?? emptyScene} motion={motion} onReady={stage.glyphReadiness} warmWhenHidden />
            </View> : null}
        </View>
    </StageContext.Provider>;
}

export function revealHomeRetryAfterPaint() {
    rootStage?.revealHomeRetry();
}

export function useStepMotionStage() {
    return React.useContext(StageContext);
}

export function useOpeningBuildGlyphs() {
    return React.useContext(OpeningBuildGlyphsContext);
}

export function useHomeGlyphArrival() {
    return React.useContext(HomeGlyphArrivalContext);
}

/** Prepare the live build effects. The opening's GlyphSurface supplies their painter. */
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

export function skipStepMotion(options?: Readonly<{ focusDestination: boolean }>): void {
    rootStage?.skip(options?.focusDestination === true);
}

export function settleStepMotionOnNativeInput(): void {
    if (Platform.OS !== 'web') rootStage?.nativeTyping();
}
