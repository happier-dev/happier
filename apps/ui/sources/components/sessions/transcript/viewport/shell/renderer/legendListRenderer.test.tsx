import * as React from 'react';
import { Platform, View } from 'react-native';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react-test-renderer';

import { renderScreen } from '@/dev/testkit';
import { createWebDomScrollObservation } from '@/components/sessions/transcript/viewport/driver/webDomObservation';
import type { WebScrollMovementFact } from '@/components/sessions/transcript/scroll/resolveWebGenuineScrollMovement';
import { resolveRendererAtEndViewportChange } from '@/components/sessions/transcript/scroll/rendererAtEndViewportChange';
import { resetTranscriptViewportDiagnosticsForTests } from '@/components/sessions/transcript/viewport/driver/transcriptViewportWriteDiagnostics';
import {
    resolveMainTranscriptListShellFrame,
    resolveReadOnlyTranscriptListShellFrame,
    resolveSidechainTranscriptListShellFrame,
} from '../transcriptListShellCapabilities';
import type { TranscriptListShellRef } from './types';

let capturedLegendListProps: any = null;
let assignedLegendRef: any = null;
let legendStateOverride: any = null;
let legendStateListeners: Map<string, Set<(value: any) => void>> = new Map();
let rejectNextScroll = false;
let legendScrollableNodeOverride: unknown = null;
let mountedWebDomObservation = createWebDomScrollObservation();
let legendRenderSuspense: Promise<void> | null = null;
let emitLegendItemSizeChangedDuringLayout = false;
const originalPlatformOS = Platform.OS;

function setPlatformOS(value: typeof Platform.OS | 'node'): void {
    Object.defineProperty(Platform, 'OS', { configurable: true, value });
}

function installAnimationFrameQueue(): FrameRequestCallback[] {
    const animationFrames: FrameRequestCallback[] = [];
    vi.stubGlobal('requestAnimationFrame', vi.fn((callback: FrameRequestCallback) => {
        animationFrames.push(callback);
        return animationFrames.length;
    }));
    vi.stubGlobal('cancelAnimationFrame', vi.fn());
    return animationFrames;
}

function installWebScrollerMetrics(params: Readonly<{
    clientHeight: number;
    scrollHeight: number;
    scrollTop: number;
}>) {
    class FakeHTMLElement {
        public clientHeight = params.clientHeight;
        public clientWidth = 800;
        public isConnected = true;
        public parentElement: FakeHTMLElement | null = null;
        public scrollHeight = params.scrollHeight;
        public scrollTop = params.scrollTop;
        public scrollWidth = 800;
        public contains = (candidate: unknown) => candidate === this;
        public querySelector = () => null;
        public querySelectorAll = () => [];
    }
    const root = new FakeHTMLElement();
    vi.stubGlobal('HTMLElement', FakeHTMLElement);
    vi.stubGlobal('document', { getElementById: () => root });
    vi.stubGlobal('window', {
        getComputedStyle: () => ({ overflowX: 'hidden', overflowY: 'auto' }),
    });
    return root;
}

function getShellRef<TItem>(
    ref: React.RefObject<TranscriptListShellRef<TItem> | null>,
): TranscriptListShellRef<TItem> {
    expect(ref.current).not.toBeNull();
    const target = ref.current!;
    return new Proxy(target, {
        get(current, property, receiver) {
            const value = Reflect.get(current, property, receiver);
            if (typeof value !== 'function' || property === 'hasLiveWebHold') return value;
            return (...args: unknown[]) => {
                let result: unknown;
                act(() => {
                    result = value.apply(current, args);
                });
                return result;
            };
        },
    });
}

function captureLegendProps(props: any): any {
    return new Proxy(props, {
        get(current, property, receiver) {
            const value = Reflect.get(current, property, receiver);
            if (typeof property !== 'string'
                || !property.startsWith('on')
                || property === 'onEndReached'
                || property === 'onViewableItemsChanged'
                || (property === 'onWheel' && Platform.OS !== 'web')
                || typeof value !== 'function') {
                return value;
            }
            return (...args: unknown[]) => {
                let result: unknown;
                act(() => {
                    result = value(...args);
                });
                return result;
            };
        },
    });
}

function LegendRenderSuspender(): null {
    if (legendRenderSuspense) throw legendRenderSuspense;
    return null;
}

vi.mock('@legendapp/list/react-native', () => ({
    LegendList: React.forwardRef((props: any, ref: any) => {
        capturedLegendListProps = captureLegendProps(props);
        const data = Array.isArray(props.data) ? props.data : [];
        const dataRef = React.useRef(data);
        dataRef.current = data;
        const instance = React.useMemo(() => {
            const makeScrollMethod = () => vi.fn(() => {
                if (rejectNextScroll) {
                    rejectNextScroll = false;
                    return Promise.reject(new Error('scroll failed'));
                }
                return Promise.resolve();
            });
            return {
                cancelInitialScrollPreservation: vi.fn(),
                clearCaches: vi.fn(),
                getNativeScrollRef: vi.fn(),
                getScrollableNode: vi.fn(() => legendScrollableNodeOverride),
                getScrollResponder: vi.fn(),
                getState: vi.fn(() => ({
                    end: Math.max(0, dataRef.current.length - 1),
                    isAtEnd: true,
                    isNearEnd: true,
                    isWithinMaintainScrollAtEndThreshold: true,
                    positionAtIndex: undefined,
                    sizeAtIndex: undefined,
                    scroll: 0,
                    scrollLength: 0,
                    start: 0,
                    ...legendStateOverride,
                    listen: (key: string, callback: (value: any) => void) => {
                        const listeners = legendStateListeners.get(key) ?? new Set();
                        listeners.add(callback);
                        legendStateListeners.set(key, listeners);
                        return () => listeners.delete(callback);
                    },
                })),
                scrollToEnd: makeScrollMethod(),
                scrollToIndex: makeScrollMethod(),
                scrollToOffset: makeScrollMethod(),
            };
        }, []);
        if (typeof ref === 'function') ref(instance);
        else if (ref && typeof ref === 'object') ref.current = instance;
        assignedLegendRef = instance;
        React.useLayoutEffect(() => {
            if (emitLegendItemSizeChangedDuringLayout) {
                props.onItemSizeChanged?.({ index: 0, previous: 100, size: 550 });
            }
        });
        return React.createElement(
            'LegendList',
            props,
            React.createElement(LegendRenderSuspender),
            props.ListHeaderComponent ?? null,
            data.map((item: any, index: number) => {
                const type = props.getItemType?.(item, index);
                return React.createElement(
                    'LegendListItem',
                    { key: props.keyExtractor?.(item, index) ?? item.id ?? index },
                    props.renderItem?.({ item, index, type }),
                );
            }),
            props.ListFooterComponent ?? null,
        );
    }),
}));

async function mountWebInertiaScenario(options: Readonly<{
    captureAnchor?: boolean;
    directLegendScrollableNode?: boolean;
    frameKind?: 'main' | 'readOnly' | 'sidechain';
    initialScrollTop?: number;
    onEntryPlacementEvent?: (event: unknown) => void;
    onStartReachedThreshold?: number;
    scrollHeight?: number;
}> = {}) {
    let nowMs = 1_000;
    vi.spyOn(Date, 'now').mockImplementation(() => nowMs);
    const animationFrames: FrameRequestCallback[] = [];
    vi.stubGlobal('requestAnimationFrame', vi.fn((callback: FrameRequestCallback) => {
        animationFrames.push(callback);
        return animationFrames.length;
    }));
    vi.stubGlobal('cancelAnimationFrame', vi.fn());

    let anchorTop = 100;
    class FakeHTMLElement {
        public clientHeight = 600;
        public isConnected = true;
        public parentElement: FakeHTMLElement | null = null;
        public scrollHeight = options.scrollHeight ?? 10_000;
        private currentScrollTop = options.initialScrollTop ?? 9_400;
        public get scrollTop() { return this.currentScrollTop; }
        public set scrollTop(value: number) {
            const landed = Math.max(0, Math.min(value, this.scrollHeight - this.clientHeight));
            anchorTop -= landed - this.currentScrollTop;
            this.currentScrollTop = landed;
        }
        public setObservedUserPosition(value: number, nextAnchorTop = 100) {
            this.currentScrollTop = value;
            anchorTop = nextAnchorTop;
        }
        public contains = () => true;
        public getAttribute = (_name: string): string | null => null;
        public getBoundingClientRect = () => ({
            bottom: 600, height: 600, left: 0, right: 800, top: 0, width: 800, x: 0, y: 0, toJSON: () => ({}),
        });
        public querySelector = (selector: string) => {
            if (options.captureAnchor === false) return null;
            if (selector === '[data-testid="transcript-anchor-message-row-1"]') return anchorNode;
            if (selector === '[data-testid="transcript-item-row-1"]') return itemNode;
            return null;
        };
        public querySelectorAll = (selector: string) =>
            options.captureAnchor !== false && selector === '[data-testid]' ? [itemNode, anchorNode] : [];
    }
    const root = new FakeHTMLElement();
    legendScrollableNodeOverride = options.directLegendScrollableNode === true ? root : null;
    const itemNode = new FakeHTMLElement();
    itemNode.parentElement = root;
    itemNode.getAttribute = (name: string) => name === 'data-testid' ? 'transcript-item-row-1' : null;
    itemNode.getBoundingClientRect = () => ({
        bottom: anchorTop + 200, height: 240, left: 0, right: 800, top: anchorTop - 40, width: 800, x: 0, y: anchorTop - 40, toJSON: () => ({}),
    });
    const anchorNode = new FakeHTMLElement();
    anchorNode.parentElement = itemNode;
    anchorNode.getAttribute = (name: string) => name === 'data-testid' ? 'transcript-anchor-message-row-1' : null;
    anchorNode.getBoundingClientRect = () => ({
        bottom: anchorTop + 160, height: 160, left: 0, right: 800, top: anchorTop, width: 800, x: 0, y: anchorTop, toJSON: () => ({}),
    });

    vi.stubGlobal('HTMLElement', FakeHTMLElement);
    vi.stubGlobal('document', { getElementById: () => root });
    vi.stubGlobal('window', {
        getComputedStyle: () => ({ overflowX: 'hidden', overflowY: 'auto' }),
    });

    const { legendListRenderer } = await import('./legendListRenderer');
    const Renderer = legendListRenderer.Component;
    const listRef = React.createRef<TranscriptListShellRef<{ id: string }>>();
    const published: Array<Readonly<{ cause: string; isFollowing: boolean }>> = [];
    const persistedViewportChanges: unknown[] = [];
    const webMovementFacts: WebScrollMovementFact[] = [];
    const resolveFrame = (initialAtEnd: boolean) => {
        if (options.frameKind === 'readOnly') {
            return resolveReadOnlyTranscriptListShellFrame({
                accessKind: 'public',
                bottomNoticeVisible: false,
                platformOS: 'web',
            });
        }
        if (options.frameKind === 'sidechain') {
            return resolveSidechainTranscriptListShellFrame({ platformOS: 'web' });
        }
        return resolveMainTranscriptListShellFrame({
            legendInitialScrollAtEnd: initialAtEnd,
            maintainScrollAtEndThreshold: 0.1,
            nativeID: 'legend-main-native-id',
            platformOS: 'web',
        });
    };
    const render = (dataKey: string, initialAtEnd: boolean) => (
        <Renderer
            key={dataKey}
            webDomObservation={mountedWebDomObservation}
            ref={listRef}
            data={[{ id: 'row-1' }]}
            dataKey={dataKey}
            keyExtractor={(item: { id: string }) => item.id}
            renderItem={({ item }: { item: { id: string } }) => React.createElement('Row', { id: item.id })}
            frame={resolveFrame(initialAtEnd)}
            onRendererAtEndChange={(state, context) => {
                published.push({ cause: context.cause, isFollowing: state.isFollowing });
                const viewportChange = resolveRendererAtEndViewportChange(state, context);
                if (viewportChange) persistedViewportChanges.push(viewportChange);
            }}
            onScroll={(_event, webMovementFact) => {
                if (webMovementFact) webMovementFacts.push(webMovementFact);
            }}
            onEntryPlacementEvent={options.onEntryPlacementEvent}
            onStartReachedThreshold={options.onStartReachedThreshold}
        />
    );
    const screen = await renderScreen(render('inertia-session-a', true));
    act(() => animationFrames.splice(0).forEach((callback) => callback(1)));

    return {
        animationFrames,
        listRef,
        persistedViewportChanges,
        published,
        root,
        webMovementFacts,
        setNowMs(value: number) {
            nowMs = value;
        },
        setLegendScrollableNodeAvailable(available: boolean) {
            legendScrollableNodeOverride = available ? root : null;
        },
        async updateSession(dataKey: string, initialAtEnd: boolean) {
            await screen.update(render(dataKey, initialAtEnd));
        },
    };
}

describe('Legend transcript renderer adapter', () => {
    beforeEach(() => {
        setPlatformOS('web');
        capturedLegendListProps = null;
        assignedLegendRef = null;
        legendStateOverride = null;
        legendStateListeners = new Map();
        rejectNextScroll = false;
        legendScrollableNodeOverride = null;
        mountedWebDomObservation = createWebDomScrollObservation();
        legendRenderSuspense = null;
        emitLegendItemSizeChangedDuringLayout = false;
        resetTranscriptViewportDiagnosticsForTests();
    });

    afterEach(() => {
        setPlatformOS(originalPlatformOS);
        vi.restoreAllMocks();
        vi.unstubAllGlobals();
    });

    it('derives web at-end and maintain-threshold facts from the actual scroller geometry', async () => {
        const { resolveLegendRendererAtEndStateFromWebMetrics } = await import('./legendListRenderer');

        expect(resolveLegendRendererAtEndStateFromWebMetrics({
            metrics: { scrollTop: 16_739, scrollHeight: 17_054, clientHeight: 315 },
            maintainScrollAtEndThreshold: 0.1,
        })).toEqual({
            isAtEnd: true,
            isFollowing: true,
            isNearEnd: true,
            isWithinMaintainScrollAtEndThreshold: true,
        });
        expect(resolveLegendRendererAtEndStateFromWebMetrics({
            metrics: { scrollTop: 16_716, scrollHeight: 17_054, clientHeight: 315 },
            maintainScrollAtEndThreshold: 0.1,
        })).toEqual({
            isAtEnd: false,
            isFollowing: true,
            isNearEnd: true,
            isWithinMaintainScrollAtEndThreshold: true,
        });
        expect(resolveLegendRendererAtEndStateFromWebMetrics({
            metrics: { scrollTop: 16_604, scrollHeight: 17_054, clientHeight: 315 },
            maintainScrollAtEndThreshold: 0.1,
        })).toEqual({
            isAtEnd: false,
            isFollowing: false,
            isNearEnd: false,
            isWithinMaintainScrollAtEndThreshold: false,
        });

    });

    it('reports exact entry placement settlement from the existing held-intent transaction', async () => {
        const placementEvents: unknown[] = [];
        const scenario = await mountWebInertiaScenario({
            initialScrollTop: 500,
            onEntryPlacementEvent: (event) => placementEvents.push(event),
        });
        await scenario.updateSession('entry-placement-session', false);
        const anchor = {
            itemId: 'row-1',
            itemOffsetPx: 100,
            kind: 'item' as const,
            messageId: null,
            reason: 'entry-restore' as const,
        };

        getShellRef(scenario.listRef).scrollToIndex({
            animated: false,
            context: {
                anchor,
                kind: 'entry-placement',
            },
            index: 0,
            viewOffset: 100,
            viewPosition: 0,
        });
        getShellRef(scenario.listRef).holdWebEntryAnchor?.(anchor);
        await act(async () => {
            await Promise.resolve();
        });
        act(() => scenario.animationFrames.splice(0).forEach((callback) => callback(1)));
        scenario.setNowMs(2_601);
        act(() => scenario.animationFrames.splice(0).forEach((callback) => callback(2)));

        expect(placementEvents).toEqual([
            {
                dataKey: 'entry-placement-session',
                itemId: 'row-1',
                platform: 'web',
                type: 'started',
            },
            {
                dataKey: 'entry-placement-session',
                itemId: 'row-1',
                outcome: 'settled',
                platform: 'web',
                type: 'finished',
            },
        ]);
    });

    it('defers native item-size settlement until Legend exposes recalculated positions and preserves late non-entry correction', async () => {
        setPlatformOS('ios');
        let nowMs = 1_000;
        vi.spyOn(Date, 'now').mockImplementation(() => nowMs);
        const animationFrames: FrameRequestCallback[] = [];
        vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
            animationFrames.push(callback);
            return animationFrames.length;
        });
        vi.stubGlobal('cancelAnimationFrame', vi.fn());
        const { legendListRenderer } = await import('./legendListRenderer');
        const Renderer = legendListRenderer.Component;
        const listRef = React.createRef<TranscriptListShellRef<{ id: string }>>();
        let positions = [0, 240, 480, 720, 960];

        legendStateOverride = {
            contentLength: 1_200,
            end: 4,
            isAtEnd: false,
            isNearEnd: false,
            isWithinMaintainScrollAtEndThreshold: false,
            positionAtIndex: (index: number) => positions[index],
            scroll: 440,
            scrollLength: 600,
            sizeAtIndex: () => 240,
            start: 1,
        };
        await renderScreen(
            <Renderer
                webDomObservation={mountedWebDomObservation}
                ref={listRef}
                data={Array.from({ length: 5 }, (_value, index) => ({ id: `row-${index}` }))}
                dataKey="session-test"
                keyExtractor={(item: { id: string }) => item.id}
                renderItem={({ item }: { item: { id: string } }) => React.createElement('Row', { id: item.id })}
                frame={resolveMainTranscriptListShellFrame({
                    legendInitialScrollAtEnd: false,
                    nativeID: 'legend-main-native-id',
                    platformOS: 'ios',
                })}
            />,
        );

        getShellRef(listRef).scrollToIndex({ index: 2, animated: false, viewOffset: 40 });
        expect(assignedLegendRef.scrollToIndex).toHaveBeenCalledWith({
            index: 2,
            animated: false,
            viewOffset: 40,
        });
        assignedLegendRef.scrollToOffset.mockClear();

        // Legend 3.3.3 invokes onItemSizeChanged before updateItemSizesBatch returns and
        // before flushItemSizeUpdates recalculates positions/MVCP. The callback therefore
        // still exposes the old position basis and must not synchronously verify against it.
        legendStateOverride = {
            ...legendStateOverride,
            scroll: 1_000,
        };
        capturedLegendListProps.onItemSizeChanged({ index: 0, previous: 240, size: 3_000 });
        expect(assignedLegendRef.scrollToOffset).not.toHaveBeenCalled();

        positions = [0, 3_000, 3_240, 3_480, 3_720];
        legendStateOverride = {
            ...legendStateOverride,
            contentLength: 3_960,
            scroll: 1_000,
        };
        nowMs = 1_016;
        act(() => animationFrames.shift()?.(nowMs));
        expect(assignedLegendRef.scrollToOffset).toHaveBeenCalledExactlyOnceWith({
            animated: false,
            offset: 3_200,
        });

        // Let the active polling window go quiet while retaining the non-entry identity.
        nowMs = 2_601;
        act(() => animationFrames.shift()?.(nowMs));
        assignedLegendRef.scrollToOffset.mockClear();

        // A later measurement uses the same post-recalculation frame boundary and still
        // repairs the non-entry reading/navigation hold.
        nowMs = 5_000;
        legendStateOverride = {
            ...legendStateOverride,
            scroll: 4_000,
        };
        capturedLegendListProps.onItemSizeChanged({ index: 0, previous: 3_000, size: 5_000 });
        expect(assignedLegendRef.scrollToOffset).not.toHaveBeenCalled();

        positions = [0, 5_000, 5_240, 5_480, 5_720];
        legendStateOverride = {
            ...legendStateOverride,
            contentLength: 5_960,
            scroll: 4_000,
        };
        nowMs = 5_016;
        act(() => animationFrames.shift()?.(nowMs));
        expect(assignedLegendRef.scrollToOffset).toHaveBeenCalledExactlyOnceWith({
            animated: false,
            offset: 5_200,
        });
    });

    it('keeps native entry placement open through a late measured residual before settling', async () => {
        setPlatformOS('ios');
        let nowMs = 1_000;
        vi.spyOn(Date, 'now').mockImplementation(() => nowMs);
        vi.stubGlobal('localStorage', {
            getItem: (key: string) => key === 'happier.debug.viewportHeldIntents' ? '1' : null,
        });
        resetTranscriptViewportDiagnosticsForTests();
        const animationFrames: FrameRequestCallback[] = [];
        vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
            animationFrames.push(callback);
            return animationFrames.length;
        });
        vi.stubGlobal('cancelAnimationFrame', vi.fn());
        const { legendListRenderer } = await import('./legendListRenderer');
        const Renderer = legendListRenderer.Component;
        const listRef = React.createRef<TranscriptListShellRef<{ id: string }>>();
        const placementEvents: unknown[] = [];
        let activeEntryPlacementAtFinish: boolean | null = null;
        let positions = [0, 240, 480, 720, 960];
        let physicalScrollOffset = 440;
        const nativeScrollHost = {
            measure: vi.fn((onSuccess: (x: number, y: number, width: number, height: number, pageX: number, pageY: number) => void) => {
                onSuccess(0, 0, 800, 600, 0, 100);
            }),
        };
        const nativeScrollableHandle = 41;
        const nativeMeasurementWarnings: string[] = [];
        const pendingMeasurements: Array<(
            x: number,
            y: number,
            width: number,
            height: number,
        ) => void> = [];
        const targetElement = {
            measure: vi.fn((onSuccess: (x: number, y: number, width: number, height: number, pageX: number, pageY: number) => void) => {
                onSuccess(0, 0, 800, 240, 0, 100 + 640 - physicalScrollOffset);
            }),
            measureLayout: vi.fn((
                relativeTo: unknown,
                onSuccess: (x: number, y: number, width: number, height: number) => void,
            ) => {
                // Fabric rejects ScrollView#getScrollableNode() because it is a numeric
                // handle. The View host and relative scroll target must be refs from the same
                // renderer.
                if (relativeTo !== nativeScrollHost) {
                    nativeMeasurementWarnings.push(
                        'Warning: ref.measureLayout must be called with a ref to a native component.',
                    );
                    return;
                }
                pendingMeasurements.push(onSuccess);
            }),
        };

        legendStateOverride = {
            contentLength: 1_200,
            elementAtIndex: (index: number) => index === 2 ? targetElement : null,
            end: 4,
            endBuffered: 4,
            isAtEnd: false,
            isNearEnd: false,
            isWithinMaintainScrollAtEndThreshold: false,
            positionAtIndex: (index: number) => positions[index],
            scroll: 440,
            scrollLength: 600,
            sizeAtIndex: () => 240,
            start: 0,
            startBuffered: 0,
        };
        const screen = await renderScreen(
            <Renderer
                webDomObservation={mountedWebDomObservation}
                ref={listRef}
                data={Array.from({ length: 5 }, (_value, index) => ({ id: `row-${index}` }))}
                dataKey="native-entry-presentation"
                keyExtractor={(item: { id: string }) => item.id}
                renderItem={({ item }: { item: { id: string } }) => React.createElement('Row', { id: item.id })}
                frame={resolveMainTranscriptListShellFrame({
                    legendInitialScrollAtEnd: false,
                    nativeID: 'legend-main-native-id',
                    platformOS: 'ios',
                })}
                onEntryPlacementEvent={(event) => {
                    placementEvents.push(event);
                    if (event.type === 'finished') {
                        activeEntryPlacementAtFinish =
                            listRef.current?.hasActiveEntryPlacement?.() ?? null;
                    }
                }}
            />,
        );
        assignedLegendRef.getNativeScrollRef.mockReturnValue({
            getNativeScrollRef: () => nativeScrollHost,
            getScrollableNode: () => nativeScrollableHandle,
        });

        getShellRef(listRef).scrollToIndex({
            animated: false,
            context: {
                anchor: {
                    itemId: 'row-2',
                    itemOffsetPx: 40,
                    kind: 'item',
                    messageId: null,
                    reason: 'entry-restore',
                },
                kind: 'entry-placement',
            },
            index: 2,
            viewOffset: 40,
        });

        expect(placementEvents).toEqual([{
            dataKey: 'native-entry-presentation',
            itemId: 'row-2',
            platform: 'native',
            type: 'started',
        }]);
        expect(getShellRef(listRef).hasActiveEntryPlacement?.()).toBe(true);

        await act(async () => undefined);
        expect(nativeMeasurementWarnings).toEqual([]);
        expect(targetElement.measureLayout).toHaveBeenCalledTimes(1);
        expect(assignedLegendRef.scrollToOffset).not.toHaveBeenCalled();
        expect(placementEvents).toHaveLength(1);
        expect(getShellRef(listRef).hasActiveEntryPlacement?.()).toBe(true);

        // React Native measureLayout completes asynchronously after native rendering. A slow
        // native callback may span several JS animation frames; the settle loop must not queue
        // another read of the same mounted row and later apply those snapshots out of order.
        nowMs = 1_008;
        act(() => animationFrames.shift()?.(nowMs));
        expect(targetElement.measureLayout).toHaveBeenCalledTimes(1);
        expect(pendingMeasurements).toHaveLength(1);
        expect(assignedLegendRef.scrollToOffset).not.toHaveBeenCalled();

        // A new native layout fact starts a new settlement generation. Its measurement may
        // complete before the older native callback; only the newer generation may act.
        capturedLegendListProps.onItemSizeChanged({ index: 0, previous: 240, size: 241 });
        // The new generation joins an already-scheduled frame, so it has not replaced the
        // in-flight request object yet. The old callback must still lose authority directly
        // against the current generation token.
        act(() => pendingMeasurements.shift()?.(0, 740, 800, 240));
        expect(assignedLegendRef.scrollToOffset).not.toHaveBeenCalled();
        nowMs = 1_009;
        act(() => animationFrames.shift()?.(nowMs));
        expect(targetElement.measureLayout).toHaveBeenCalledTimes(2);
        expect(pendingMeasurements).toHaveLength(1);
        act(() => pendingMeasurements.shift()?.(0, 640, 800, 240));

        expect(assignedLegendRef.scrollToOffset).toHaveBeenCalledExactlyOnceWith({
            animated: false,
            offset: 600,
        });
        expect(targetElement.measure).toHaveBeenCalledTimes(2);
        expect(nativeScrollHost.measure).toHaveBeenCalledTimes(2);
        expect(assignedLegendRef.scrollToIndex).toHaveBeenCalledTimes(1);
        expect(placementEvents).toHaveLength(1);
        expect(getShellRef(listRef).hasActiveEntryPlacement?.()).toBe(true);

        expect(assignedLegendRef.scrollToOffset).toHaveBeenCalledTimes(1);

        nowMs = 1_016;
        positions = [0, 240, 640, 720, 960];
        legendStateOverride = {
            ...legendStateOverride,
            positionAtIndex: (index: number) => positions[index],
            scroll: 600,
        };
        act(() => animationFrames.shift()?.(nowMs));
        expect(targetElement.measureLayout).toHaveBeenCalledTimes(3);
        act(() => pendingMeasurements.shift()?.(0, 640, 800, 240));
        // Legend now believes the target offset landed, but the covered native view still
        // displays offset 440. Although state.scroll also says the target is at the 600 px
        // bottom clamp, transformed page coordinates remain 160 px off; exact settlement
        // must replay the same absolute target instead of trusting that model-only clamp.
        expect(assignedLegendRef.scrollToOffset).toHaveBeenCalledTimes(2);
        expect(assignedLegendRef.scrollToOffset).toHaveBeenLastCalledWith({
            animated: false,
            offset: 600,
        });
        expect(placementEvents).toHaveLength(1);

        nowMs = 1_032;
        physicalScrollOffset = 600;
        act(() => animationFrames.shift()?.(nowMs));
        expect(targetElement.measureLayout).toHaveBeenCalledTimes(4);
        act(() => pendingMeasurements.shift()?.(0, 640, 800, 240));
        expect(assignedLegendRef.scrollToOffset).toHaveBeenCalledTimes(2);

        nowMs = 2_520;
        act(() => animationFrames.shift()?.(nowMs));
        expect(placementEvents).toEqual([
            {
                dataKey: 'native-entry-presentation',
                itemId: 'row-2',
                platform: 'native',
                type: 'started',
            },
            {
                dataKey: 'native-entry-presentation',
                itemId: 'row-2',
                outcome: 'settled',
                platform: 'native',
                type: 'finished',
            },
        ]);
        expect(activeEntryPlacementAtFinish).toBe(false);
        expect(getShellRef(listRef).hasActiveEntryPlacement?.()).toBe(false);

        const heldIntentDiagnostics = (
            globalThis as typeof globalThis & {
                __happierViewportDiagnostics?: {
                    heldIntents: Array<{ event: string; intentId: string | null }>;
                };
            }
        ).__happierViewportDiagnostics?.heldIntents ?? [];
        expect(heldIntentDiagnostics.filter((entry) => (
            entry.event === 'hold-release'
            && entry.intentId === 'row-2'
        ))).toHaveLength(1);

        // Publishing the terminal event is also the terminal write-authority boundary. Fresh
        // size and layout evidence cannot revive this entry-specific hold.
        assignedLegendRef.scrollToOffset.mockClear();
        act(() => pendingMeasurements.shift()?.(0, 768, 800, 240));
        expect(assignedLegendRef.scrollToOffset).not.toHaveBeenCalled();
        nowMs = 5_000;
        positions = [0, 5_000, 5_240, 5_480, 5_720];
        legendStateOverride = {
            ...legendStateOverride,
            contentLength: 5_960,
            scroll: 600,
        };
        capturedLegendListProps.onItemSizeChanged({ index: 0, previous: 3_000, size: 5_000 });
        screen.tree.root.findByProps({ nativeID: 'legend-main-native-id' }).props.onLayout({
            nativeEvent: { layout: { height: 600, width: 800, x: 0, y: 0 } },
        });
        act(() => animationFrames.splice(0).forEach((callback) => callback(nowMs)));
        expect(assignedLegendRef.scrollToOffset).not.toHaveBeenCalled();
    });

    it('does not pass native-only scroll lifecycle callbacks to the web Legend DOM owner', async () => {
        const { legendListRenderer } = await import('./legendListRenderer');
        const Renderer = legendListRenderer.Component;

        await renderScreen(
            <Renderer
                webDomObservation={mountedWebDomObservation}
                data={[{ id: 'row-1' }]}
                dataKey="web-scroll-lifecycle-props"
                keyExtractor={(item: { id: string }) => item.id}
                renderItem={({ item }: { item: { id: string } }) => React.createElement('Row', { id: item.id })}
                frame={resolveMainTranscriptListShellFrame({
                    legendInitialScrollAtEnd: true,
                    nativeID: 'legend-web-scroll-lifecycle-props',
                    platformOS: 'web',
                })}
                onMomentumScrollBegin={vi.fn()}
                onMomentumScrollEnd={vi.fn()}
                onScrollBeginDrag={vi.fn()}
                onScrollEndDrag={vi.fn()}
            />,
        );

        expect(capturedLegendListProps).not.toHaveProperty('onMomentumScrollBegin');
        expect(capturedLegendListProps).not.toHaveProperty('onMomentumScrollEnd');
        expect(capturedLegendListProps).not.toHaveProperty('onScrollBeginDrag');
        expect(capturedLegendListProps).not.toHaveProperty('onScrollEndDrag');
    });

    it('maps the read-only shell seam to the Legend non-inverted chat props', async () => {
        setPlatformOS('ios');
        const { legendListRenderer } = await import('./legendListRenderer');
        const Renderer = legendListRenderer.Component;
        const listRef = React.createRef<TranscriptListShellRef<{ id: string; kind: string }>>();
        const onLayout = vi.fn();
        const onContentSizeChange = vi.fn();
        const onScroll = vi.fn();
        const onScrollBeginDrag = vi.fn();
        const onScrollEndDrag = vi.fn();
        const onMomentumScrollBegin = vi.fn();
        const onMomentumScrollEnd = vi.fn();
        const onStartReached = vi.fn();
        const onEndReached = vi.fn();
        const onWheel = vi.fn();
        const onViewableItemsChanged = vi.fn();
        const viewabilityConfig = { itemVisiblePercentThreshold: 55, minimumViewTime: 120 };

        const screen = await renderScreen(
            <Renderer
                webDomObservation={mountedWebDomObservation}
                ref={listRef}
                data={[
                    { id: 'newest', kind: 'message' },
                    { id: 'middle-newer', kind: 'message' },
                    { id: 'middle-older', kind: 'message' },
                    { id: 'oldest', kind: 'message' },
                ]}
                dataKey="session-public-1"
                extraData={2}
                keyExtractor={(item: { id: string }) => item.id}
                getItemType={(item: { kind: string }) => item.kind}
                renderItem={({ item }: { item: { id: string; kind: string } }) => React.createElement('Row', { id: item.id })}
                frame={resolveReadOnlyTranscriptListShellFrame({
                    accessKind: 'public',
                    bottomNoticeVisible: false,
                    platformOS: 'ios',
                })}
                header={React.createElement('HeaderSlot')}
                footer={React.createElement('FooterSlot')}
                onLayout={onLayout}
                onContentSizeChange={onContentSizeChange}
                onScroll={onScroll}
                onScrollBeginDrag={onScrollBeginDrag}
                onScrollEndDrag={onScrollEndDrag}
                onMomentumScrollBegin={onMomentumScrollBegin}
                onMomentumScrollEnd={onMomentumScrollEnd}
                onStartReachedThreshold={0.25}
                onStartReached={onStartReached}
                onEndReachedThreshold={0.5}
                onEndReached={onEndReached}
                onViewableItemsChanged={onViewableItemsChanged}
                viewabilityConfig={viewabilityConfig}
                platformInteractionProps={{ onWheel }}
            />,
        );

        expect(legendListRenderer.kind).toBe('legendList');
        expect(listRef.current).not.toBe(assignedLegendRef);
        expect(capturedLegendListProps).toMatchObject({
            alignItemsAtEnd: true,
            dataKey: 'session-public-1',
            dataVersion: 2,
            estimatedItemSize: 240,
            initialScrollAtEnd: true,
            maintainScrollAtEnd: { animated: false },
            maintainScrollAtEndThreshold: 0.1,
            maintainVisibleContentPosition: { data: true, size: true },
            onScrollBeginDrag: expect.any(Function),
            // Drag-end/momentum handlers are adapter-wrapped (S-D user-scroll evidence
            // tracking); the wrappers must still forward to the shell callbacks below.
            onScrollEndDrag: expect.any(Function),
            onMomentumScrollBegin: expect.any(Function),
            onMomentumScrollEnd: expect.any(Function),
            onStartReachedThreshold: 0.25,
            onStartReached: expect.any(Function),
            onEndReachedThreshold: 0.5,
            onEndReached,
            onViewableItemsChanged: expect.any(Function),
            recycleItems: false,
            viewabilityConfig,
            onWheel,
            scrollEventThrottle: 16,
        });
        const layoutEvent = { nativeEvent: { layout: { height: 600, width: 800, x: 0, y: 0 } } };
        const scrollEvent = { nativeEvent: { contentOffset: { x: 0, y: 0 } } };
        const identityHost = screen.tree.root.findAllByType(View).find((node) => (
            typeof node.props.onLayout === 'function' && node.findAllByType('LegendList' as any).length > 0
        ));
        expect(identityHost).toBeTruthy();
        identityHost!.props.onLayout(layoutEvent);
        capturedLegendListProps.onScroll(scrollEvent);
        capturedLegendListProps.onScrollBeginDrag(scrollEvent);
        capturedLegendListProps.onStartReached();
        expect(onLayout).toHaveBeenCalledWith(layoutEvent);
        expect(onScroll).toHaveBeenCalledWith(scrollEvent);
        expect(onScrollBeginDrag).toHaveBeenCalledWith(scrollEvent);
        capturedLegendListProps.onScrollEndDrag(scrollEvent);
        capturedLegendListProps.onMomentumScrollBegin(scrollEvent);
        capturedLegendListProps.onMomentumScrollEnd(scrollEvent);
        expect(onScrollEndDrag).toHaveBeenCalledWith(scrollEvent);
        expect(onMomentumScrollBegin).toHaveBeenCalledWith(scrollEvent);
        expect(onMomentumScrollEnd).toHaveBeenCalledWith(scrollEvent);
        expect(onStartReached).toHaveBeenCalledTimes(1);
        expect(capturedLegendListProps).not.toHaveProperty('onLayout');
        expect(capturedLegendListProps.data.map((item: any) => item.id)).toEqual([
            'oldest',
            'middle-older',
            'middle-newer',
            'newest',
        ]);
        capturedLegendListProps.onViewableItemsChanged({
            viewableItems: [
                {
                    containerId: 10,
                    index: 0,
                    isViewable: true,
                    item: capturedLegendListProps.data[0],
                    key: 'oldest',
                },
                {
                    containerId: 11,
                    index: 1,
                    isViewable: true,
                    item: capturedLegendListProps.data[1],
                    key: 'middle-older',
                },
            ],
            changed: [
                {
                    containerId: 12,
                    index: 3,
                    isViewable: false,
                    item: capturedLegendListProps.data[3],
                    key: 'newest',
                },
            ],
        });
        expect(onViewableItemsChanged).toHaveBeenCalledWith({
            viewableItems: [
                {
                    containerId: 10,
                    index: 3,
                    isViewable: true,
                    item: { id: 'oldest', kind: 'message' },
                    key: 'oldest',
                },
                {
                    containerId: 11,
                    index: 2,
                    isViewable: true,
                    item: { id: 'middle-older', kind: 'message' },
                    key: 'middle-older',
                },
            ],
            changed: [
                {
                    containerId: 12,
                    index: 0,
                    isViewable: false,
                    item: { id: 'newest', kind: 'message' },
                    key: 'newest',
                },
            ],
        });
        // Shell header/footer are FRAME LIST-SPACE slots (FlashList semantics): on a
        // newest-first (native inverted) frame, `header` is the data-start slot, which
        // FlashList renders at the VISUAL BOTTOM. The adapter re-projects data to
        // chronological standard space, so it must re-project the slots the same way:
        // header -> Legend ListFooterComponent (visual bottom), footer -> ListHeaderComponent.
        // Getting this wrong renders the composer keyboard-inset spacer at the TOP of the
        // transcript and the last row flush under the floating composer (native occlusion,
        // live-measured ~130pt on 2026-07-08).
        expect(capturedLegendListProps.ListFooterComponent.type).toBe(View);
        expect(capturedLegendListProps.ListFooterComponent.props.children.type).toBe('HeaderSlot');
        expect(capturedLegendListProps.ListHeaderComponent.type).toBe('FooterSlot');
        expect(capturedLegendListProps).not.toHaveProperty('inverted');
        expect(capturedLegendListProps).not.toHaveProperty('drawDistance');
        expect(capturedLegendListProps).not.toHaveProperty('startRenderingFromBottom');
        // Layout-commit signalling is owned by the transcript observer wrapper (see dedicated
        // test below), never by a Legend prop.
        expect(capturedLegendListProps).not.toHaveProperty('onCommitLayoutEffect');
    });

    it('hands Legend initial-scroll ownership on web now that app-side web pin retries are gated', async () => {
        const { legendListRenderer } = await import('./legendListRenderer');
        const Renderer = legendListRenderer.Component;

        await renderScreen(
            <Renderer
                webDomObservation={mountedWebDomObservation}
                data={[{ id: 'row-1' }]}
                dataKey="session-test"
                keyExtractor={(item: { id: string }) => item.id}
                renderItem={({ item }: { item: { id: string } }) => React.createElement('Row', { id: item.id })}
                frame={resolveMainTranscriptListShellFrame({
                    legendInitialScrollAtEnd: false,
                    nativeID: 'legend-main-native-id',
                    platformOS: 'web',
                })}
            />,
        );

        expect(capturedLegendListProps.initialScrollAtEnd).toBe(false);
        // alignItemsAtEnd is layout-only (bottom-hugging padding) and stays on for all platforms.
        expect(capturedLegendListProps.alignItemsAtEnd).toBe(true);
    });

    it('keeps edge slots unprojected on oldest-first frames (web standard space)', async () => {
        // On oldest-first frames the shell list-space already IS standard space: header at the
        // visual top, footer (composer inset spacer on main) at the visual bottom. No swap.
        const { legendListRenderer } = await import('./legendListRenderer');
        const Renderer = legendListRenderer.Component;

        await renderScreen(
            <Renderer
                webDomObservation={mountedWebDomObservation}
                data={[{ id: 'row-1' }]}
                dataKey="session-test"
                keyExtractor={(item: { id: string }) => item.id}
                renderItem={({ item }: { item: { id: string } }) => React.createElement('Row', { id: item.id })}
                frame={resolveMainTranscriptListShellFrame({
                    legendInitialScrollAtEnd: false,
                    nativeID: 'legend-main-native-id',
                    platformOS: 'web',
                })}
                header={React.createElement('HeaderSlot')}
                footer={React.createElement('FooterSlot')}
            />,
        );

        expect(capturedLegendListProps.ListHeaderComponent.type).toBe('HeaderSlot');
        expect(capturedLegendListProps.ListFooterComponent.type).toBe(View);
        expect(capturedLegendListProps.ListFooterComponent.props.children.type).toBe('FooterSlot');
    });

    it('synthesizes the shell onContentSizeChange contract that Legend silently drops', async () => {
        // @legendapp/list has NO onContentSizeChange support (zero occurrences in the 3.x dist).
        // FlashList honored this prop; the whole session-open chain depends on it:
        // onContentSizeChange -> setListContentHeight -> sessionOpenLatch leaves 'awaiting-layout'
        // -> initial fill settles -> older pagination's 'fill-not-done' suspension clears.
        // Without a synthesized signal the latch deadlocks and pagination is permanently dead
        // (live root cause of the C1 regression). The adapter must emit the signal itself from
        // Legend's own state (getState().contentLength) on layout commits and item resizes.
        const { legendListRenderer } = await import('./legendListRenderer');
        const Renderer = legendListRenderer.Component;
        const onContentSizeChange = vi.fn();

        legendStateOverride = {
            contentLength: 4200,
            end: 0,
            otherAxisSize: 800,
            positionAtIndex: () => 0,
            scroll: 0,
            scrollLength: 600,
            sizeAtIndex: () => 100,
            start: 0,
        };

        await renderScreen(
            <Renderer
                webDomObservation={mountedWebDomObservation}
                data={[{ id: 'row-1' }]}
                dataKey="session-test"
                keyExtractor={(item: { id: string }) => item.id}
                renderItem={({ item }: { item: { id: string } }) => React.createElement('Row', { id: item.id })}
                frame={resolveMainTranscriptListShellFrame({
                    legendInitialScrollAtEnd: false,
                    nativeID: 'legend-main-native-id',
                    platformOS: 'web',
                })}
                onContentSizeChange={onContentSizeChange}
            />,
        );

        // Initial commit emits the measured content size (width is not part of Legend's
        // public state surface and no transcript consumer reads it — reported as 0).
        expect(onContentSizeChange).toHaveBeenCalledWith(0, 4200);

        // Legend-internal item remeasure (no adapter commit) must also emit.
        legendStateOverride = { ...legendStateOverride, contentLength: 4650 };
        const callsBeforeResize = onContentSizeChange.mock.calls.length;
        capturedLegendListProps.onItemSizeChanged?.({ index: 0, previous: 100, size: 550 });
        expect(onContentSizeChange).toHaveBeenCalledWith(0, 4650);

        // Same size again must dedupe (no spurious re-emissions).
        capturedLegendListProps.onItemSizeChanged?.({ index: 0, previous: 550, size: 550 });
        expect(onContentSizeChange.mock.calls.length).toBe(callsBeforeResize + 1);

        // The raw prop is NOT forwarded to Legend (library ignores it; adapter owns the signal).
        expect(capturedLegendListProps).not.toHaveProperty('onContentSizeChange');
    });

    it('keeps a committed measurement bound to its callback when a newer render suspends', async () => {
        const { legendListRenderer } = await import('./legendListRenderer');
        const Renderer = legendListRenderer.Component;
        const callbackA = vi.fn();
        const callbackB = vi.fn();
        const frame = resolveMainTranscriptListShellFrame({
            legendInitialScrollAtEnd: false,
            nativeID: 'legend-main-native-id',
            platformOS: 'web',
        });
        const render = (revision: number, onContentSizeChange: (width: number, height: number) => void) => (
            <React.Suspense fallback={React.createElement('SuspendedLegend')}>
                <Renderer
                    webDomObservation={mountedWebDomObservation}
                    data={[{ id: 'row-1' }]}
                    dataKey="session-test"
                    extraData={revision}
                    keyExtractor={(item: { id: string }) => item.id}
                    renderItem={({ item }: { item: { id: string } }) => React.createElement('Row', { id: item.id })}
                    frame={frame}
                    onContentSizeChange={onContentSizeChange}
                />
            </React.Suspense>
        );
        legendStateOverride = {
            contentLength: 4200,
            end: 0,
            positionAtIndex: () => 0,
            scroll: 0,
            scrollLength: 600,
            sizeAtIndex: () => 100,
            start: 0,
        };
        const screen = await renderScreen(render(1, callbackA));
        const committedAItemSizeChanged = capturedLegendListProps.onItemSizeChanged;
        callbackA.mockClear();

        legendRenderSuspense = new Promise<void>(() => {});
        await act(async () => {
            React.startTransition(() => {
                screen.tree.update(render(2, callbackB));
            });
            await Promise.resolve();
        });
        expect(capturedLegendListProps.dataVersion).toBe(2);
        expect(screen.findByType('LegendList' as any).props.dataVersion).toBe(1);

        legendStateOverride = { ...legendStateOverride, contentLength: 4650 };
        committedAItemSizeChanged({ index: 0, previous: 100, size: 550 });

        expect(callbackB).not.toHaveBeenCalled();
        expect(callbackA).toHaveBeenCalledWith(0, 4650);
    });

    it('uses the committed render callback for a Legend child layout measurement', async () => {
        const { legendListRenderer } = await import('./legendListRenderer');
        const Renderer = legendListRenderer.Component;
        const callbackA = vi.fn();
        const callbackB = vi.fn();
        const frame = resolveMainTranscriptListShellFrame({
            legendInitialScrollAtEnd: false,
            nativeID: 'legend-main-native-id',
            platformOS: 'web',
        });
        const render = (revision: number, onContentSizeChange: (width: number, height: number) => void) => (
            <Renderer
                webDomObservation={mountedWebDomObservation}
                data={[{ id: 'row-1' }]}
                dataKey="session-test"
                extraData={revision}
                keyExtractor={(item: { id: string }) => item.id}
                renderItem={({ item }: { item: { id: string } }) => React.createElement('Row', { id: item.id })}
                frame={frame}
                onContentSizeChange={onContentSizeChange}
            />
        );
        legendStateOverride = {
            contentLength: 4200,
            end: 0,
            positionAtIndex: () => 0,
            scroll: 0,
            scrollLength: 600,
            sizeAtIndex: () => 100,
            start: 0,
        };
        const screen = await renderScreen(render(1, callbackA));
        callbackA.mockClear();

        legendStateOverride = { ...legendStateOverride, contentLength: 4650 };
        emitLegendItemSizeChangedDuringLayout = true;
        await screen.update(render(2, callbackB));

        expect(callbackA).not.toHaveBeenCalled();
        expect(callbackB).toHaveBeenCalledWith(0, 4650);
    });

    it('routes an earlier Legend continuation through the latest committed callback', async () => {
        const { legendListRenderer } = await import('./legendListRenderer');
        const Renderer = legendListRenderer.Component;
        const callbackA = vi.fn();
        const callbackB = vi.fn();
        const frame = resolveMainTranscriptListShellFrame({
            legendInitialScrollAtEnd: false,
            nativeID: 'legend-main-native-id',
            platformOS: 'web',
        });
        const render = (revision: number, onContentSizeChange: (width: number, height: number) => void) => (
            <Renderer
                webDomObservation={mountedWebDomObservation}
                data={[{ id: 'row-1' }]}
                dataKey="session-test"
                extraData={revision}
                keyExtractor={(item: { id: string }) => item.id}
                renderItem={({ item }: { item: { id: string } }) => React.createElement('Row', { id: item.id })}
                frame={frame}
                onContentSizeChange={onContentSizeChange}
            />
        );
        legendStateOverride = {
            contentLength: 4200,
            end: 0,
            positionAtIndex: () => 0,
            scroll: 0,
            scrollLength: 600,
            sizeAtIndex: () => 100,
            start: 0,
        };
        const screen = await renderScreen(render(1, callbackA));
        const committedAItemSizeChanged = capturedLegendListProps.onItemSizeChanged;
        await screen.update(render(2, callbackB));
        callbackA.mockClear();
        callbackB.mockClear();

        legendStateOverride = { ...legendStateOverride, contentLength: 4750 };
        committedAItemSizeChanged({ index: 0, previous: 550, size: 650 });

        expect(callbackA).not.toHaveBeenCalled();
        expect(callbackB).toHaveBeenCalledWith(0, 4750);
    });

    it('emits synthesized size before the shell callback on transcript-owned layout commits', async () => {
        const { legendListRenderer } = await import('./legendListRenderer');
        const Renderer = legendListRenderer.Component;
        const observationOrder: string[] = [];
        const onContentSizeChange = vi.fn(() => observationOrder.push('content-size'));
        const onCommitLayoutEffect = vi.fn(() => observationOrder.push('shell-commit'));
        legendStateOverride = {
            contentLength: 4200,
            end: 0,
            otherAxisSize: 800,
            positionAtIndex: () => 0,
            scroll: 0,
            scrollLength: 600,
            sizeAtIndex: () => 100,
            start: 0,
        };

        const render = (rowId: string, revision: number) => (
            <Renderer
                webDomObservation={mountedWebDomObservation}
                data={[{ id: rowId }]}
                dataKey="session-test"
                extraData={revision}
                keyExtractor={(item: { id: string }) => item.id}
                renderItem={({ item }: { item: { id: string } }) => React.createElement('Row', { id: item.id })}
                frame={resolveMainTranscriptListShellFrame({
                    nativeID: 'legend-main-native-id',
                    platformOS: 'web',
                })}
                onContentSizeChange={onContentSizeChange}
                onCommitLayoutEffect={onCommitLayoutEffect}
            />
        );
        const screen = await renderScreen(render('row-1', 1));

        // The viewport ownership stack (recordLayoutCommitObserved) depends on this signal firing
        // after child layout effects. Size synthesis and held-intent settlement happen before the
        // shell is told the commit completed.
        expect(observationOrder).toEqual(['content-size', 'shell-commit']);
        const initialCommitCount = onCommitLayoutEffect.mock.calls.length;
        await screen.update(render('row-2', 2));
        expect(onCommitLayoutEffect.mock.calls.length).toBeGreaterThan(initialCommitCount);
        expect(screen.findAllByType('LegendList' as any)[0]?.parent?.parent?.parent?.type).toBe(View);
    });

    it('publishes Legend at-end state changes through the renderer boundary', async () => {
        const { legendListRenderer } = await import('./legendListRenderer');
        const Renderer = legendListRenderer.Component;
        const listRef = React.createRef<TranscriptListShellRef<{ id: string }>>();
        const observationOrder: string[] = [];
        const onRendererAtEndChange = vi.fn((
            _state: unknown,
            context: Readonly<{ cause: string }>,
        ) => observationOrder.push(`renderer:${context.cause}`));
        const onScroll = vi.fn(() => observationOrder.push('scroll'));

        legendStateOverride = {
            contentLength: 1200,
            end: 0,
            isAtEnd: false,
            isNearEnd: false,
            isWithinMaintainScrollAtEndThreshold: false,
            scroll: 240,
            scrollLength: 600,
            start: 0,
        };
        const root = installWebScrollerMetrics({
            clientHeight: 600,
            scrollHeight: 1200,
            scrollTop: 240,
        });

        await renderScreen(
            <Renderer
                webDomObservation={mountedWebDomObservation}
                ref={listRef}
                data={[{ id: 'row-1' }]}
                dataKey="cause-order-session"
                keyExtractor={(item: { id: string }) => item.id}
                renderItem={({ item }: { item: { id: string } }) => React.createElement('Row', { id: item.id })}
                frame={resolveMainTranscriptListShellFrame({
                    legendInitialScrollAtEnd: false,
                    nativeID: 'legend-main-native-id',
                    platformOS: 'web',
                })}
                onRendererAtEndChange={onRendererAtEndChange}
                onScroll={onScroll}
            />,
        );

        expect(onRendererAtEndChange).toHaveBeenCalledWith({
            isAtEnd: false,
            isFollowing: false,
            isNearEnd: false,
            isWithinMaintainScrollAtEndThreshold: false,
        }, { cause: 'layout' });

        legendStateOverride = {
            ...legendStateOverride,
            isAtEnd: true,
            isNearEnd: true,
            isWithinMaintainScrollAtEndThreshold: true,
            scroll: 600,
        };
        root.scrollTop = 600;
        await act(async () => {
            for (const listener of legendStateListeners.get('isAtEnd') ?? []) {
                listener(true);
            }
        });

        expect(onRendererAtEndChange).toHaveBeenLastCalledWith({
            isAtEnd: true,
            isFollowing: true,
            isNearEnd: true,
            isWithinMaintainScrollAtEndThreshold: true,
        }, { cause: 'layout' });

        // The user cause must mutate semantic pin state before the generic onScroll observer
        // reads wantsPinned and decides whether to capture/persist the detached anchor.
        capturedLegendListProps.onScroll({ nativeEvent: { contentOffset: { x: 0, y: 600 } } });
        observationOrder.length = 0;
        getShellRef(listRef).notifyViewportInput?.({
            kind: 'keyboard',
            verticalDirection: 'toward-start',
        });
        legendStateOverride = {
            ...legendStateOverride,
            isAtEnd: false,
            isNearEnd: false,
            isWithinMaintainScrollAtEndThreshold: false,
            scroll: 100,
        };
        root.scrollTop = 100;
        capturedLegendListProps.onScroll({ nativeEvent: { contentOffset: { x: 0, y: 100 } } });
        expect(observationOrder).toEqual(['renderer:user', 'scroll']);
    });

    it('publishes the tail re-pin with a user cause when the flip lands after the first post-wheel scroll event (S-G)', async () => {
        // Live S-G (2026-07-11): re-pinning at the bottom by wheel was only communicated to
        // sync when the at-end flip landed exactly on the FIRST scroll event after a wheel
        // tick (one-shot cause consumption). Chromium smooth-scroll continuation delivers the
        // flip on a LATER scroll event, which was classified 'layout' -> the live-tail intent
        // never reached sync -> the stale persisted detached anchor survived a session switch.
        let nowMs = 1_000;
        vi.spyOn(Date, 'now').mockImplementation(() => nowMs);
        const { legendListRenderer } = await import('./legendListRenderer');
        const Renderer = legendListRenderer.Component;
        const published: Array<{ isFollowing: boolean; cause: string }> = [];
        const onRendererAtEndChange = vi.fn((
            state: Readonly<{ isFollowing: boolean }>,
            context: Readonly<{ cause: string }>,
        ) => published.push({ isFollowing: state.isFollowing, cause: context.cause }));

        legendStateOverride = {
            contentLength: 10_000,
            end: 0,
            isAtEnd: false,
            isNearEnd: false,
            isWithinMaintainScrollAtEndThreshold: false,
            scroll: 3_000,
            scrollLength: 600,
            start: 0,
        };
        const root = installWebScrollerMetrics({
            clientHeight: 600,
            scrollHeight: 10_000,
            scrollTop: 3_000,
        });
        await renderScreen(
            <Renderer
                webDomObservation={mountedWebDomObservation}
                data={[{ id: 'row-1' }]}
                dataKey="s-g-session"
                keyExtractor={(item: { id: string }) => item.id}
                renderItem={({ item }: { item: { id: string } }) => React.createElement('Row', { id: item.id })}
                frame={resolveMainTranscriptListShellFrame({
                    legendInitialScrollAtEnd: false,
                    nativeID: 'legend-main-native-id',
                    platformOS: 'web',
                })}
                onRendererAtEndChange={onRendererAtEndChange}
            />,
        );

        // Wheel toward the tail; the first scroll event is still detached (consumes the
        // one-shot pending cause under the old model).
        capturedLegendListProps.onWheel({ deltaY: 300 });
        root.scrollTop = 3_300;
        capturedLegendListProps.onScroll({ nativeEvent: { contentOffset: { x: 0, y: 3_300 } } });

        // Smooth-scroll continuation reaches the tail 200ms later with NO new wheel event.
        nowMs = 1_200;
        legendStateOverride = {
            ...legendStateOverride,
            isAtEnd: true,
            isNearEnd: true,
            isWithinMaintainScrollAtEndThreshold: true,
            scroll: 9_400,
        };
        root.scrollTop = 9_400;
        capturedLegendListProps.onScroll({ nativeEvent: { contentOffset: { x: 0, y: 9_400 } } });

        const rePin = published.filter((entry) => entry.isFollowing === true).at(-1);
        expect(rePin).toBeDefined();
        expect(rePin!.cause).toBe('user');
    });

    it('publishes a mid-drag threshold exit with a user cause on native (S-I older-load arming)', async () => {
        // Live S-I (2026-07-11): the detach flip during a native drag landed on a scroll event
        // AFTER the first one (which had consumed the one-shot 'user'), so the exit published
        // as 'layout' and was dropped by the semantic owner -> wantsPinned stayed true -> the
        // older-pagination follow gate stayed closed until a lucky scroll-down-then-up re-ran
        // the classification.
        setPlatformOS('ios');
        let nowMs = 1_000;
        vi.spyOn(Date, 'now').mockImplementation(() => nowMs);
        const { legendListRenderer } = await import('./legendListRenderer');
        const Renderer = legendListRenderer.Component;
        const published: Array<{ isFollowing: boolean; cause: string }> = [];
        const onRendererAtEndChange = vi.fn((
            state: Readonly<{ isFollowing: boolean }>,
            context: Readonly<{ cause: string }>,
        ) => published.push({ isFollowing: state.isFollowing, cause: context.cause }));

        legendStateOverride = {
            contentLength: 10_000,
            end: 4,
            isAtEnd: true,
            isNearEnd: true,
            isWithinMaintainScrollAtEndThreshold: true,
            scroll: 9_400,
            scrollLength: 600,
            start: 0,
        };
        await renderScreen(
            <Renderer
                webDomObservation={mountedWebDomObservation}
                data={Array.from({ length: 5 }, (_value, index) => ({ id: `row-${index}` }))}
                dataKey="s-i-session"
                keyExtractor={(item: { id: string }) => item.id}
                renderItem={({ item }: { item: { id: string } }) => React.createElement('Row', { id: item.id })}
                frame={resolveMainTranscriptListShellFrame({
                    legendInitialScrollAtEnd: true,
                    nativeID: 'legend-main-native-id',
                    platformOS: 'ios',
                })}
                onRendererAtEndChange={onRendererAtEndChange}
            />,
        );

        capturedLegendListProps.onScrollBeginDrag({ nativeEvent: { contentOffset: { x: 0, y: 9_400 } } });
        // First drag scroll event: still within the follow threshold.
        nowMs = 1_050;
        capturedLegendListProps.onScroll({ nativeEvent: { contentOffset: { x: 0, y: 9_300 } } });
        // Later drag scroll event exits the threshold while the finger is still down.
        nowMs = 1_200;
        legendStateOverride = {
            ...legendStateOverride,
            isAtEnd: false,
            isNearEnd: false,
            isWithinMaintainScrollAtEndThreshold: false,
            scroll: 7_000,
        };
        capturedLegendListProps.onScroll({ nativeEvent: { contentOffset: { x: 0, y: 7_000 } } });

        const detach = published.filter((entry) => entry.isFollowing === false).at(-1);
        expect(detach).toBeDefined();
        expect(detach!.cause).toBe('user');
    });

    it('classifies growth-driven follow loss as layout even when stale user input evidence is pending (S-K)', async () => {
        // Live S-K (2026-07-11): a wheel tick at the bottom clamp produces NO scroll event, so
        // the pending one-shot 'user' cause was never consumed. A giant streaming commit that
        // exceeded the maintain threshold minutes later flipped isWithinMaintainScrollAtEnd-
        // Threshold via a state listener, which read the stale 'user' cause and published a
        // false user detach -> bottom-follow disengaged while the stream continued.
        let nowMs = 1_000;
        vi.spyOn(Date, 'now').mockImplementation(() => nowMs);
        const { legendListRenderer } = await import('./legendListRenderer');
        const Renderer = legendListRenderer.Component;
        const published: Array<{ isFollowing: boolean; cause: string }> = [];
        const onRendererAtEndChange = vi.fn((
            state: Readonly<{ isFollowing: boolean }>,
            context: Readonly<{ cause: string }>,
        ) => published.push({ isFollowing: state.isFollowing, cause: context.cause }));

        legendStateOverride = {
            contentLength: 10_000,
            end: 0,
            isAtEnd: true,
            isNearEnd: true,
            isWithinMaintainScrollAtEndThreshold: true,
            scroll: 9_400,
            scrollLength: 600,
            start: 0,
        };
        await renderScreen(
            <Renderer
                webDomObservation={mountedWebDomObservation}
                data={[{ id: 'row-1' }]}
                dataKey="s-k-session"
                keyExtractor={(item: { id: string }) => item.id}
                renderItem={({ item }: { item: { id: string } }) => React.createElement('Row', { id: item.id })}
                frame={resolveMainTranscriptListShellFrame({
                    legendInitialScrollAtEnd: true,
                    nativeID: 'legend-main-native-id',
                    platformOS: 'web',
                })}
                onRendererAtEndChange={onRendererAtEndChange}
            />,
        );

        // Wheel-down at the clamp: no scroll event follows (the scroller cannot move further).
        capturedLegendListProps.onWheel({ deltaY: 120 });

        // A giant streaming commit grows content past the maintain threshold 10s later. The
        // scroll offset has not moved: this is renderer-caused geometry, never a user detach.
        nowMs = 11_000;
        legendStateOverride = {
            ...legendStateOverride,
            contentLength: 18_000,
            isAtEnd: false,
            isNearEnd: false,
            isWithinMaintainScrollAtEndThreshold: false,
        };
        await act(async () => {
            for (const listener of legendStateListeners.get('isWithinMaintainScrollAtEndThreshold') ?? []) {
                listener(false);
            }
        });

        const followLoss = published.filter((entry) => entry.isFollowing === false).at(-1);
        expect(followLoss).toBeDefined();
        expect(followLoss!.cause).toBe('layout');
    });

    it('keeps semantic tail ownership through a bottomward wheel without adding an app steady-follow write (S-K)', async () => {
        // Live S-K companion defect: the wheel handler released the held-'end' intent on EVERY
        // wheel, including a bottomward tick at the clamp that produces no scroll event and no
        // at-end state change (so nothing ever re-latched the tail). The next giant streaming
        // commit then had no tail owner: Legend's maintainScrollAtEnd threshold was exceeded
        // and the viewport silently stopped following. A bottomward wheel while holding the
        // tail is follow-affirming input, not a detach.
        let nowMs = 1_000;
        vi.spyOn(Date, 'now').mockImplementation(() => nowMs);
        const animationFrames: FrameRequestCallback[] = [];
        vi.stubGlobal('requestAnimationFrame', vi.fn((callback: FrameRequestCallback) => {
            animationFrames.push(callback);
            return animationFrames.length;
        }));
        vi.stubGlobal('cancelAnimationFrame', vi.fn());

        class FakeHTMLElement {
            public clientHeight = 600;
            public isConnected = true;
            public parentElement: FakeHTMLElement | null = null;
            public scrollHeight = 10_000;
            public scrollLeft = 0;
            public scrollTop = 9_400;
            public contains = () => true;
            public getAttribute = () => null;
            public getBoundingClientRect = () => ({
                bottom: 600, height: 600, left: 0, right: 800, top: 0, width: 800, x: 0, y: 0, toJSON: () => ({}),
            });
            public querySelector = () => null;
            public querySelectorAll = () => [];
            public scrollTo = (options: { top: number }) => { this.scrollTop = options.top; };
        }
        const root = new FakeHTMLElement();
        vi.stubGlobal('HTMLElement', FakeHTMLElement);
        vi.stubGlobal('document', { getElementById: () => root });
        vi.stubGlobal('window', {
            getComputedStyle: () => ({ overflowX: 'hidden', overflowY: 'auto' }),
        });

        const { legendListRenderer } = await import('./legendListRenderer');
        const Renderer = legendListRenderer.Component;
        const listRef = React.createRef<TranscriptListShellRef<{ id: string }>>();
        await renderScreen(
            <Renderer
                webDomObservation={mountedWebDomObservation}
                ref={listRef}
                data={[{ id: 'row-1' }]}
                dataKey="s-k-hold-session"
                keyExtractor={(item: { id: string }) => item.id}
                renderItem={({ item }: { item: { id: string } }) => React.createElement('Row', { id: item.id })}
                frame={resolveMainTranscriptListShellFrame({
                    legendInitialScrollAtEnd: true,
                    nativeID: 'legend-main-native-id',
                    platformOS: 'web',
                })}
            />,
        );
        act(() => animationFrames.splice(0).forEach((callback) => callback(16)));
        expect(root.scrollTop).toBe(9_400);

        // Bottomward wheel at the clamp: nothing can move, no scroll event fires.
        assignedLegendRef.cancelInitialScrollPreservation.mockClear();
        capturedLegendListProps.onWheel({ deltaY: 120 });
        expect(assignedLegendRef.cancelInitialScrollPreservation).not.toHaveBeenCalled();

        // Input quiets; a giant streaming commit grows the content far past the threshold.
        nowMs = 2_000;
        root.scrollHeight = 16_000;
        capturedLegendListProps.onItemSizeChanged({ index: 0, previous: 240, size: 6_240 });
        act(() => animationFrames.splice(0).forEach((callback) => callback(32)));
        // This harness mocks Legend, so it cannot execute maintainScrollAtEnd. The
        // adapter preserves the semantic hold but must not replace Legend with a
        // parallel DOM residual writer.
        expect(root.scrollTop).toBe(9_400);
        expect(getShellRef(listRef).hasLiveWebHold?.({ kind: 'end' })).toBe(true);

        // Regression guard: an upward wheel is a genuine detach and must still release.
        nowMs = 3_000;
        capturedLegendListProps.onWheel({ deltaY: -120 });
        expect(assignedLegendRef.cancelInitialScrollPreservation).toHaveBeenCalledTimes(1);
        root.scrollTop = 15_280;
        capturedLegendListProps.onScroll({ nativeEvent: { contentOffset: { x: 0, y: 15_280 } } });
        nowMs = 4_000;
        root.scrollHeight = 20_000;
        capturedLegendListProps.onItemSizeChanged({ index: 0, previous: 6_240, size: 10_240 });
        act(() => animationFrames.splice(0).forEach((callback) => callback(48)));
        expect(root.scrollTop).toBe(15_280);
        expect(getShellRef(listRef).hasLiveWebHold?.({ kind: 'end' })).toBe(false);
    });

    it('keeps held-end ownership for follow-affirming keyboard and touch input, then releases for movement away from the tail', async () => {
        const { legendListRenderer } = await import('./legendListRenderer');
        const Renderer = legendListRenderer.Component;
        const listRef = React.createRef<TranscriptListShellRef<{ id: string }>>();
        const onTouchStart = vi.fn();
        const onTouchMove = vi.fn();
        legendStateOverride = {
            contentLength: 10_000,
            end: 0,
            isAtEnd: true,
            isNearEnd: true,
            isWithinMaintainScrollAtEndThreshold: true,
            scroll: 9_400,
            scrollLength: 600,
            start: 0,
        };
        installWebScrollerMetrics({
            clientHeight: 600,
            scrollHeight: 10_000,
            scrollTop: 9_400,
        });
        await renderScreen(
            <Renderer
                webDomObservation={mountedWebDomObservation}
                ref={listRef}
                data={[{ id: 'row-1' }]}
                dataKey="keyboard-held-end"
                keyExtractor={(item: { id: string }) => item.id}
                renderItem={({ item }: { item: { id: string } }) => React.createElement('Row', { id: item.id })}
                platformInteractionProps={{ onTouchMove, onTouchStart }}
                frame={resolveMainTranscriptListShellFrame({
                    legendInitialScrollAtEnd: true,
                    nativeID: 'legend-main-native-id',
                    platformOS: 'web',
                })}
            />,
        );

        assignedLegendRef.cancelInitialScrollPreservation.mockClear();
        getShellRef(listRef).notifyViewportInput?.({
            kind: 'keyboard',
            verticalDirection: 'toward-end',
        });
        expect(assignedLegendRef.cancelInitialScrollPreservation).not.toHaveBeenCalled();
        legendStateOverride = {
            ...legendStateOverride,
            contentLength: 16_000,
            isAtEnd: false,
            isNearEnd: false,
            isWithinMaintainScrollAtEndThreshold: false,
        };
        capturedLegendListProps.onItemSizeChanged({ index: 0, previous: 240, size: 6_240 });
        expect(getShellRef(listRef).hasLiveWebHold?.({ kind: 'end' })).toBe(true);
        expect(capturedLegendListProps.maintainScrollAtEnd).toMatchObject({ animated: false });

        getShellRef(listRef).notifyViewportInput?.({
            kind: 'keyboard',
            verticalDirection: 'toward-start',
        });
        expect(assignedLegendRef.cancelInitialScrollPreservation).toHaveBeenCalledTimes(1);
        expect(getShellRef(listRef).hasLiveWebHold?.({ kind: 'end' })).toBe(false);
        expect(capturedLegendListProps.maintainScrollAtEnd).toBe(false);

        act(() => {
            getShellRef(listRef).scrollToEnd?.({ animated: false });
        });
        expect(getShellRef(listRef).hasLiveWebHold?.({ kind: 'end' })).toBe(true);

        // On a direct-touch web viewport, an upward finger movement moves content toward
        // the transcript end. At the physical bottom the browser clamps that movement and
        // emits no scroll, so it must affirm the held tail just like PageDown/wheel-down.
        const touchStartEvent = { nativeEvent: { touches: [{ clientY: 200 }] } };
        const towardEndTouchMove = { nativeEvent: { touches: [{ clientY: 120 }] } };
        capturedLegendListProps.onTouchStart(touchStartEvent);
        capturedLegendListProps.onTouchMove(towardEndTouchMove);
        expect(onTouchStart).toHaveBeenCalledWith(touchStartEvent);
        expect(onTouchMove).toHaveBeenCalledWith(towardEndTouchMove);
        expect(assignedLegendRef.cancelInitialScrollPreservation).toHaveBeenCalledTimes(1);
        expect(getShellRef(listRef).hasLiveWebHold?.({ kind: 'end' })).toBe(true);

        // A separate page-coordinate gesture moving downward moves content toward the
        // transcript start. Takeover must release synchronously before delegation.
        const pageTouchStart = { nativeEvent: { touches: [{ pageY: 120 }] } };
        const towardStartTouchMove = { nativeEvent: { touches: [{ pageY: 180 }] } };
        capturedLegendListProps.onTouchStart(pageTouchStart);
        capturedLegendListProps.onTouchMove(towardStartTouchMove);
        expect(onTouchStart).toHaveBeenLastCalledWith(pageTouchStart);
        expect(assignedLegendRef.cancelInitialScrollPreservation).toHaveBeenCalledTimes(2);
        expect(getShellRef(listRef).hasLiveWebHold?.({ kind: 'end' })).toBe(false);
        expect(onTouchMove).toHaveBeenLastCalledWith(towardStartTouchMove);
        expect(assignedLegendRef.cancelInitialScrollPreservation.mock.invocationCallOrder[1])
            .toBeLessThan(onTouchMove.mock.invocationCallOrder[1]);
    });

    it('re-latches semantic tail ownership when a user scroll lands back inside the follow threshold', async () => {
        // Live report 2026-07-21 (web, paced streaming): after detaching and scrolling back
        // to the bottom, follow held for only a few lines and then silently stopped. The
        // former passive auto-latch required an exactly-at-end observation (dfb <= 1px) with
        // QUIET user input — mutually exclusive during streaming, where reaching the moving
        // tail needs a follow write and quietness arrives only after the tail has moved on. Legend's
        // maintainScrollAtEnd carried the viewport briefly until one large commit exceeded
        // its threshold with no held-'end' owner to correct it. A classified USER movement
        // landing bottomward inside the maintain threshold IS the follow intent and must
        // re-latch the durable held tail immediately.
        let nowMs = 1_000;
        vi.spyOn(Date, 'now').mockImplementation(() => nowMs);
        const animationFrames: FrameRequestCallback[] = [];
        vi.stubGlobal('requestAnimationFrame', vi.fn((callback: FrameRequestCallback) => {
            animationFrames.push(callback);
            return animationFrames.length;
        }));
        vi.stubGlobal('cancelAnimationFrame', vi.fn());

        class FakeHTMLElement {
            public clientHeight = 600;
            public isConnected = true;
            public parentElement: FakeHTMLElement | null = null;
            public scrollHeight = 10_000;
            public scrollLeft = 0;
            public scrollTop = 9_400;
            public contains = () => true;
            public getAttribute = () => null;
            public getBoundingClientRect = () => ({
                bottom: 600, height: 600, left: 0, right: 800, top: 0, width: 800, x: 0, y: 0, toJSON: () => ({}),
            });
            public querySelector = () => null;
            public querySelectorAll = () => [];
            public scrollTo = (options: { top: number }) => { this.scrollTop = options.top; };
        }
        const root = new FakeHTMLElement();
        vi.stubGlobal('HTMLElement', FakeHTMLElement);
        vi.stubGlobal('document', { getElementById: () => root });
        vi.stubGlobal('window', {
            getComputedStyle: () => ({ overflowX: 'hidden', overflowY: 'auto' }),
        });

        // Detached user scrolling arms a keyed reading-anchor hold from the DOM
        // (the scroll handler's detached branch does this on EVERY classified
        // user scroll — including the landing event itself). Give the fake
        // scroller a resolvable anchor so that live-corridor re-arm succeeds.
        const anchorNode = new FakeHTMLElement();
        (anchorNode as unknown as { getAttribute: (name: string) => string | null }).getAttribute =
            (name: string) => (name === 'data-testid' ? 'transcript-anchor-message-row-1' : null);
        anchorNode.getBoundingClientRect = () => ({
            bottom: 260, height: 160, left: 0, right: 800, top: 100, width: 800, x: 0, y: 100, toJSON: () => ({}),
        });
        const itemNode = new FakeHTMLElement();
        (itemNode as unknown as { getAttribute: (name: string) => string | null }).getAttribute =
            (name: string) => (name === 'data-testid' ? 'transcript-item-row-1' : null);
        itemNode.getBoundingClientRect = () => ({
            bottom: 300, height: 240, left: 0, right: 800, top: 60, width: 800, x: 0, y: 60, toJSON: () => ({}),
        });
        (root as unknown as { querySelectorAll: (selector: string) => unknown[] }).querySelectorAll =
            (selector: string) => (selector === '[data-testid]' ? [itemNode, anchorNode] : []);

        const { legendListRenderer } = await import('./legendListRenderer');
        const Renderer = legendListRenderer.Component;
        const listRef = React.createRef<TranscriptListShellRef<{ id: string }>>();
        await renderScreen(
            <Renderer
                webDomObservation={mountedWebDomObservation}
                ref={listRef}
                data={[{ id: 'row-1' }]}
                dataKey="re-latch-session"
                keyExtractor={(item: { id: string }) => item.id}
                renderItem={({ item }: { item: { id: string } }) => React.createElement('Row', { id: item.id })}
                frame={resolveMainTranscriptListShellFrame({
                    legendInitialScrollAtEnd: true,
                    nativeID: 'legend-main-native-id',
                    platformOS: 'web',
                })}
            />,
        );
        act(() => animationFrames.splice(0).forEach((callback) => callback(16)));
        expect(root.scrollTop).toBe(9_400);

        // The user detaches with an upward wheel and reads earlier content.
        nowMs = 2_000;
        capturedLegendListProps.onWheel({ deltaY: -120 });
        root.scrollTop = 7_000;
        capturedLegendListProps.onScroll({ nativeEvent: { contentOffset: { x: 0, y: 7_000 } } });

        // Streaming growth while detached leaves the reading position alone.
        nowMs = 2_500;
        root.scrollHeight = 12_000;
        capturedLegendListProps.onItemSizeChanged({ index: 0, previous: 240, size: 2_240 });
        act(() => animationFrames.splice(0).forEach((callback) => callback(32)));
        expect(root.scrollTop).toBe(7_000);

        // The user wheels back down and lands inside the maintain threshold
        // (dfb 40px <= 0.1 * 600) — a genuine return to the live tail. This must
        // REPLACE the keyed reading anchor with the held-'end' intent (same
        // replacement the jump-to-bottom command performs); keeping the keyed
        // anchor alive here is the duplicate-owner fight: the anchor restores
        // the old position while growth pins to the tail, and follow dies a few
        // lines later (live report 2026-07-21/22).
        nowMs = 3_000;
        capturedLegendListProps.onWheel({ deltaY: 120 });
        root.scrollTop = 11_360;
        capturedLegendListProps.onScroll({ nativeEvent: { contentOffset: { x: 0, y: 11_360 } } });
        expect(getShellRef(listRef).hasLiveWebHold?.({ kind: 'end' })).toBe(true);

        // The mocked Legend cannot execute maintainScrollAtEnd. Growth must not
        // cause the adapter to install a parallel DOM correction writer.
        nowMs = 4_000;
        root.scrollHeight = 18_000;
        capturedLegendListProps.onItemSizeChanged({ index: 0, previous: 2_240, size: 8_240 });
        act(() => animationFrames.splice(0).forEach((callback) => callback(48)));
        expect(root.scrollTop).toBe(11_360);
        expect(getShellRef(listRef).hasLiveWebHold?.({ kind: 'end' })).toBe(true);
    });

    it('transfers late downward inertia to held end before publication without adding an app steady writer', async () => {
        const scenario = await mountWebInertiaScenario();

        scenario.setNowMs(2_000);
        capturedLegendListProps.onWheel({ deltaY: -120 });
        scenario.root.setObservedUserPosition(7_000);
        capturedLegendListProps.onScroll({ nativeEvent: { contentOffset: { x: 0, y: 7_000 } } });

        scenario.setNowMs(2_100);
        capturedLegendListProps.onWheel({ deltaY: 120 });
        scenario.root.setObservedUserPosition(9_000);
        capturedLegendListProps.onScroll({ nativeEvent: { contentOffset: { x: 0, y: 9_000 } } });
        expect(getShellRef(scenario.listRef).hasLiveWebHold?.({ kind: 'end' })).toBe(false);

        scenario.setNowMs(2_200);
        scenario.root.scrollTop = 9_360;
        capturedLegendListProps.onScroll({ nativeEvent: { contentOffset: { x: 0, y: 9_360 } } });
        expect(getShellRef(scenario.listRef).hasLiveWebHold?.({ kind: 'end' })).toBe(true);
        expect(scenario.published.at(-1)).toEqual({ cause: 'user', isFollowing: true });
        expect(scenario.webMovementFacts.at(-1)).toMatchObject({
            direction: 1,
            downwardIntent: true,
            isGenuineUserMovement: true,
        });

        scenario.setNowMs(3_000);
        scenario.root.scrollHeight = 16_000;
        capturedLegendListProps.onItemSizeChanged({ index: 0, previous: 240, size: 6_240 });
        act(() => scenario.animationFrames.splice(0).forEach((callback) => callback(32)));
        expect(scenario.root.scrollTop).toBe(9_360);
        expect(getShellRef(scenario.listRef).hasLiveWebHold?.({ kind: 'end' })).toBe(true);
    });

    it('does not transfer prior user inertia across a committed same-row geometry change', async () => {
        const scenario = await mountWebInertiaScenario();

        scenario.setNowMs(2_000);
        capturedLegendListProps.onWheel({ deltaY: -120 });
        scenario.root.setObservedUserPosition(7_000);
        capturedLegendListProps.onScroll({ nativeEvent: { contentOffset: { x: 0, y: 7_000 } } });

        scenario.setNowMs(2_100);
        capturedLegendListProps.onWheel({ deltaY: 120 });
        scenario.root.setObservedUserPosition(9_000);
        capturedLegendListProps.onScroll({ nativeEvent: { contentOffset: { x: 0, y: 9_000 } } });
        expect(getShellRef(scenario.listRef).hasLiveWebHold?.({ kind: 'end' })).toBe(false);

        // A streaming update commits new geometry for the same keyed row. Legend's later
        // same-direction layout/MVCP movement is not continuation of the prior gesture,
        // even though it lands inside the 60px maintain-at-end threshold within 320ms.
        scenario.root.scrollHeight = 10_020;
        capturedLegendListProps.onItemSizeChanged({ index: 0, previous: 240, size: 260 });
        scenario.published.splice(0);
        scenario.setNowMs(2_200);
        scenario.root.setObservedUserPosition(9_380);
        capturedLegendListProps.onScroll({ nativeEvent: { contentOffset: { x: 0, y: 9_380 } } });

        expect(getShellRef(scenario.listRef).hasLiveWebHold?.({ kind: 'end' })).toBe(false);
        expect(scenario.published).not.toContainEqual({ cause: 'user', isFollowing: true });
        expect(scenario.webMovementFacts.at(-1)).toMatchObject({
            direction: 1,
            isGenuineUserMovement: false,
        });
        act(() => scenario.animationFrames.splice(0).forEach((callback) => callback(24)));
        expect(scenario.root.scrollTop).toBe(9_380);
    });

    it('uses the same post-epoch movement fact for at-end publication instead of the recent-input window', async () => {
        const scenario = await mountWebInertiaScenario({ captureAnchor: false });

        scenario.setNowMs(2_000);
        capturedLegendListProps.onWheel({ deltaY: -120 });
        scenario.root.setObservedUserPosition(7_000);
        capturedLegendListProps.onScroll({ nativeEvent: { contentOffset: { x: 0, y: 7_000 } } });

        scenario.setNowMs(2_100);
        capturedLegendListProps.onWheel({ deltaY: 120 });
        scenario.root.setObservedUserPosition(9_000);
        capturedLegendListProps.onScroll({ nativeEvent: { contentOffset: { x: 0, y: 9_000 } } });

        // The committed size fact ends the prior movement continuation. This cause-less
        // movement reaches the maintain threshold within the old 3.5s raw-input window,
        // but no keyed hold exists to incidentally suppress publication.
        scenario.root.scrollHeight = 10_020;
        capturedLegendListProps.onItemSizeChanged({ index: 0, previous: 240, size: 260 });
        scenario.published.length = 0;
        scenario.persistedViewportChanges.length = 0;
        scenario.setNowMs(2_200);
        scenario.root.setObservedUserPosition(9_380);
        capturedLegendListProps.onScroll({ nativeEvent: { contentOffset: { x: 0, y: 9_380 } } });

        const movementFact = scenario.webMovementFacts.at(-1);
        expect(movementFact).toMatchObject({
            atEndPublicationCause: 'layout',
            direction: 1,
            isGenuineUserMovement: false,
            movedSinceLastObservation: true,
        });
        expect(scenario.published).not.toContainEqual({ cause: 'user', isFollowing: true });
        expect(scenario.persistedViewportChanges).toEqual([]);
    });

    it('does not passively reacquire held end from a quiet web exact-end listener after upward detach', async () => {
        const scenario = await mountWebInertiaScenario({ captureAnchor: false });

        capturedLegendListProps.onScroll({
            nativeEvent: { contentOffset: { x: 0, y: scenario.root.scrollTop } },
        });
        scenario.setNowMs(2_000);
        capturedLegendListProps.onWheel({ deltaY: -120 });
        scenario.root.setObservedUserPosition(7_000);
        capturedLegendListProps.onScroll({ nativeEvent: { contentOffset: { x: 0, y: 7_000 } } });
        expect(scenario.webMovementFacts.at(-1)).toMatchObject({
            atEndPublicationCause: 'user',
            direction: -1,
            isGenuineUserMovement: true,
        });
        expect(getShellRef(scenario.listRef).hasLiveWebHold?.({ kind: 'end' })).toBe(false);

        // A later layout/Legend adjustment makes passive geometry read exact-end after the
        // 250ms write-suppression window. Without a canonical scroll fact this observation
        // may publish layout, but it must never manufacture held-end user intent.
        scenario.setNowMs(2_400);
        scenario.root.setObservedUserPosition(9_400);
        await act(async () => {
            for (const listener of legendStateListeners.get('isAtEnd') ?? []) {
                listener(true);
            }
        });
        expect(getShellRef(scenario.listRef).hasLiveWebHold?.({ kind: 'end' })).toBe(false);
    });

    it('releases a held reading anchor on web when live user input explains an unclassified frame', async () => {
        // Web could NEVER reach a release branch here: the only one was guarded by `!isWebFrame`,
        // so every frame the movement classifier failed to attribute re-asserted the hold and
        // re-opened the 1500ms settle window. A committed geometry change revokes
        // movement-attribution evidence by design, but it does not end the reader's gesture, and
        // the ONE intent owner still attests it.
        const scenario = await mountWebInertiaScenario();

        scenario.setNowMs(3_000);
        capturedLegendListProps.onWheel({ deltaY: -120 });
        scenario.root.setObservedUserPosition(7_000);
        capturedLegendListProps.onScroll({ nativeEvent: { contentOffset: { x: 0, y: 7_000 } } });
        expect(getShellRef(scenario.listRef).hasLiveWebHold?.({ kind: 'item', itemId: 'row-1' })).toBe(true);

        // A committed row-geometry change advances the movement epoch, which correctly revokes
        // per-frame attribution evidence (pending input + inertia chain + streak).
        scenario.setNowMs(3_050);
        capturedLegendListProps.onItemSizeChanged({ index: 0, previous: 240, size: 300 });

        // The SAME wheel gesture continues in the SAME direction. The frame is unclassified, yet
        // it is unmistakably the reader's.
        scenario.setNowMs(3_100);
        scenario.root.setObservedUserPosition(6_500);
        capturedLegendListProps.onScroll({ nativeEvent: { contentOffset: { x: 0, y: 6_500 } } });

        expect(scenario.webMovementFacts.at(-1)).toMatchObject({ isGenuineUserMovement: false });
        expect(getShellRef(scenario.listRef).hasLiveWebHold?.({ kind: 'item', itemId: 'row-1' })).toBe(false);
        act(() => scenario.animationFrames.splice(0).forEach((callback) => callback(32)));
        expect(scenario.root.scrollTop).toBe(6_500);
    });

    it('reacquires held end at a toward-end web clamp but cancels keyed takeover without replacing it', async () => {
        const scenario = await mountWebInertiaScenario();
        const shellRef = getShellRef(scenario.listRef);

        shellRef.releaseWebHeldIntent?.();
        expect(shellRef.hasLiveWebHold?.({ kind: 'end' })).toBe(false);

        // At the physical bottom a bottomward wheel cannot produce a scroll event. Direct
        // input is therefore the canonical acquisition boundary for an otherwise unowned tail.
        capturedLegendListProps.onWheel({ deltaY: 120 });
        expect(shellRef.hasLiveWebHold?.({ kind: 'end' })).toBe(true);

        shellRef.releaseWebHeldIntent?.();
        shellRef.notifyViewportInput?.({
            kind: 'keyboard',
            verticalDirection: 'toward-end',
        });
        expect(shellRef.hasLiveWebHold?.({ kind: 'end' })).toBe(true);

        // A keyed target remains a distinct explicit owner. Toward-end clamp input keeps
        // its existing takeover behavior rather than silently replacing it with held end.
        shellRef.releaseWebHeldIntent?.();
        shellRef.holdWebEntryAnchor?.({
            itemId: 'row-1',
            itemOffsetPx: 100,
            kind: 'message',
            messageId: null,
        });
        expect(shellRef.hasLiveWebHold?.({ kind: 'item', itemId: 'row-1' })).toBe(true);
        shellRef.notifyViewportInput?.({
            kind: 'keyboard',
            verticalDirection: 'toward-end',
        });
        expect(shellRef.hasLiveWebHold?.({ kind: 'end' })).toBe(false);
        expect(shellRef.hasLiveWebHold?.({ kind: 'item', itemId: 'row-1' })).toBe(false);
    });

    it.each(['sidechain', 'readOnly'] as const)(
        'uses the direct Legend DOM scroller for identityless %s web movement facts and downward threshold acquisition',
        async (frameKind) => {
            const scenario = await mountWebInertiaScenario({
                captureAnchor: false,
                directLegendScrollableNode: true,
                frameKind,
            });
            const shellRef = getShellRef(scenario.listRef);

            shellRef.releaseWebHeldIntent?.();
            scenario.root.setObservedUserPosition(9_000);
            capturedLegendListProps.onScroll({
                nativeEvent: { contentOffset: { x: 0, y: 9_000 } },
            });
            scenario.setNowMs(2_000);
            capturedLegendListProps.onWheel({ deltaY: 120 });
            scenario.root.setObservedUserPosition(9_350);
            capturedLegendListProps.onScroll({
                nativeEvent: { contentOffset: { x: 0, y: 9_350 } },
            });

            expect(scenario.webMovementFacts.at(-1)).toMatchObject({
                atEndPublicationCause: 'user',
                direction: 1,
                isGenuineUserMovement: true,
                movedSinceLastObservation: true,
            });
            expect(shellRef.hasLiveWebHold?.({ kind: 'end' })).toBe(true);
        },
    );

    it('fails an identityless web clamp closed without DOM metrics and acquires only at the direct DOM exact end', async () => {
        const scenario = await mountWebInertiaScenario({
            captureAnchor: false,
            frameKind: 'readOnly',
        });
        const shellRef = getShellRef(scenario.listRef);

        // Legend's cached state says isAtEnd, but no current DOM metrics exist. The clamp
        // boundary must fail closed for both affirmation and acquisition.
        capturedLegendListProps.onWheel({ deltaY: 120 });
        expect(shellRef.hasLiveWebHold?.({ kind: 'end' })).toBe(false);
        capturedLegendListProps.onWheel({ deltaY: 120 });
        expect(shellRef.hasLiveWebHold?.({ kind: 'end' })).toBe(false);

        // Once the real Legend web node is available, its current geometry is authoritative.
        scenario.setLegendScrollableNodeAvailable(true);
        scenario.root.setObservedUserPosition(9_300);
        capturedLegendListProps.onWheel({ deltaY: 120 });
        expect(shellRef.hasLiveWebHold?.({ kind: 'end' })).toBe(false);

        // Exact-end wheel/keyboard/touch input can acquire without any scroll callback.
        scenario.root.setObservedUserPosition(9_400);
        capturedLegendListProps.onWheel({ deltaY: 120 });
        expect(shellRef.hasLiveWebHold?.({ kind: 'end' })).toBe(true);

        shellRef.notifyViewportInput?.({
            kind: 'keyboard',
            verticalDirection: 'toward-end',
        });
        expect(shellRef.hasLiveWebHold?.({ kind: 'end' })).toBe(true);

        shellRef.releaseWebHeldIntent?.();
        shellRef.notifyViewportInput?.({
            kind: 'keyboard',
            verticalDirection: 'toward-end',
        });
        expect(shellRef.hasLiveWebHold?.({ kind: 'end' })).toBe(true);

        shellRef.notifyViewportInput?.({
            kind: 'touch',
            verticalDirection: 'toward-end',
        });
        expect(shellRef.hasLiveWebHold?.({ kind: 'end' })).toBe(true);

        shellRef.releaseWebHeldIntent?.();
        shellRef.notifyViewportInput?.({
            kind: 'touch',
            verticalDirection: 'toward-end',
        });
        expect(shellRef.hasLiveWebHold?.({ kind: 'end' })).toBe(true);
        expect(scenario.webMovementFacts).toEqual([]);
    });

    it('keeps held end through a post-epoch layout rollback and releases it for fresh canonical movement', async () => {
        const scenario = await mountWebInertiaScenario();

        // Bottomward input at the clamp is follow-affirming and deliberately keeps held-end
        // ownership. The following committed item epoch invalidates that input as movement
        // authority but the old renderer-local 3.5s timestamp remains recent.
        scenario.setNowMs(2_000);
        capturedLegendListProps.onWheel({ deltaY: 120 });
        expect(getShellRef(scenario.listRef).hasLiveWebHold?.({ kind: 'end' })).toBe(true);
        scenario.setNowMs(2_100);
        capturedLegendListProps.onItemSizeChanged({ index: 0, previous: 240, size: 260 });

        // After the held-settle window closes, a Legend/layout rollback is still inside the
        // obsolete raw-input window. The canonical post-epoch fact is non-user, so it must
        // reassert held end rather than release it.
        scenario.setNowMs(3_700);
        scenario.root.setObservedUserPosition(9_000);
        capturedLegendListProps.onScroll({ nativeEvent: { contentOffset: { x: 0, y: 9_000 } } });
        expect(scenario.webMovementFacts.at(-1)).toMatchObject({
            atEndPublicationCause: 'layout',
            direction: -1,
            isGenuineUserMovement: false,
            movedSinceLastObservation: true,
        });
        expect(getShellRef(scenario.listRef).hasLiveWebHold?.({ kind: 'end' })).toBe(true);

        // Fresh direct evidence is represented by the same fact and wins even though the
        // reasserted held transaction has reopened its settle window.
        scenario.setNowMs(3_800);
        getShellRef(scenario.listRef).notifyViewportInput?.({
            kind: 'touch',
            verticalDirection: 'toward-start',
        });
        scenario.root.setObservedUserPosition(8_500);
        capturedLegendListProps.onScroll({ nativeEvent: { contentOffset: { x: 0, y: 8_500 } } });
        expect(scenario.webMovementFacts.at(-1)).toMatchObject({
            atEndPublicationCause: 'user',
            direction: -1,
            isGenuineUserMovement: true,
            movedSinceLastObservation: true,
        });
        expect(getShellRef(scenario.listRef).hasLiveWebHold?.({ kind: 'end' })).toBe(false);
    });

    it('accepts new direct user evidence after a committed geometry epoch', async () => {
        const scenario = await mountWebInertiaScenario();

        scenario.setNowMs(2_000);
        capturedLegendListProps.onWheel({ deltaY: -120 });
        scenario.root.setObservedUserPosition(7_000);
        capturedLegendListProps.onScroll({ nativeEvent: { contentOffset: { x: 0, y: 7_000 } } });

        scenario.root.scrollHeight = 10_020;
        capturedLegendListProps.onItemSizeChanged({ index: 0, previous: 240, size: 260 });
        scenario.setNowMs(2_100);
        capturedLegendListProps.onWheel({ deltaY: 120 });
        scenario.root.setObservedUserPosition(9_380);
        capturedLegendListProps.onScroll({ nativeEvent: { contentOffset: { x: 0, y: 9_380 } } });

        expect(getShellRef(scenario.listRef).hasLiveWebHold?.({ kind: 'end' })).toBe(true);
        expect(scenario.webMovementFacts.at(-1)).toMatchObject({
            direction: 1,
            downwardIntent: true,
            isGenuineUserMovement: true,
        });
    });

    it('keeps held-end ownership when a zero-input layout scroll enters the top capture threshold', async () => {
        const scenario = await mountWebInertiaScenario({
            initialScrollTop: 826,
            onStartReachedThreshold: 4 / 3,
            scrollHeight: 1_426,
        });

        expect(getShellRef(scenario.listRef).hasLiveWebHold?.({ kind: 'end' })).toBe(true);

        scenario.setNowMs(2_000);
        scenario.root.setObservedUserPosition(798);
        capturedLegendListProps.onScroll({ nativeEvent: { contentOffset: { x: 0, y: 798 } } });

        expect(getShellRef(scenario.listRef).hasLiveWebHold?.({ kind: 'end' })).toBe(true);
        expect(getShellRef(scenario.listRef).hasLiveWebHold?.({ kind: 'item', itemId: 'row-1' })).toBe(false);
        const maintainScrollAtEnd = capturedLegendListProps.maintainScrollAtEnd as {
            animated: boolean;
            isMaintainingScrollAtEnd: () => boolean;
        };
        expect(maintainScrollAtEnd.animated).toBe(false);
        expect(maintainScrollAtEnd.isMaintainingScrollAtEnd()).toBe(true);

        scenario.root.scrollHeight = 1_544;
        if (maintainScrollAtEnd.isMaintainingScrollAtEnd()) {
            scenario.root.setObservedUserPosition(944);
        }
        capturedLegendListProps.onItemSizeChanged({ index: 0, previous: 240, size: 358 });
        expect(scenario.root.scrollHeight - scenario.root.clientHeight - scenario.root.scrollTop).toBe(0);
    });

    it('keeps held-end ownership when Legend directly reports start reached', async () => {
        const scenario = await mountWebInertiaScenario({
            initialScrollTop: 826,
            onStartReachedThreshold: 4 / 3,
            scrollHeight: 1_426,
        });

        scenario.setNowMs(2_000);
        scenario.root.setObservedUserPosition(798);
        capturedLegendListProps.onStartReached();

        expect(getShellRef(scenario.listRef).hasLiveWebHold?.({ kind: 'end' })).toBe(true);
        expect(getShellRef(scenario.listRef).hasLiveWebHold?.({ kind: 'item', itemId: 'row-1' })).toBe(false);
        const maintainScrollAtEnd = capturedLegendListProps.maintainScrollAtEnd as {
            animated: boolean;
            isMaintainingScrollAtEnd: () => boolean;
        };
        expect(maintainScrollAtEnd.animated).toBe(false);
        expect(maintainScrollAtEnd.isMaintainingScrollAtEnd()).toBe(true);

        // A completed jump/restore command uses the explicit seam, not opportunistic
        // capture, and must still be able to replace the tail with its keyed landing.
        getShellRef(scenario.listRef).holdWebEntryAnchor?.({
            itemId: 'row-1',
            itemOffsetPx: 40,
            kind: 'item',
            messageId: null,
        });
        expect(getShellRef(scenario.listRef).hasLiveWebHold?.({ kind: 'end' })).toBe(false);
        expect(getShellRef(scenario.listRef).hasLiveWebHold?.({ kind: 'item', itemId: 'row-1' })).toBe(true);
        expect(capturedLegendListProps.maintainScrollAtEnd).toBe(false);
    });

    it('withholds a state-listener tail arrival until the classified scroll atomically replaces the keyed hold', async () => {
        const scenario = await mountWebInertiaScenario();

        scenario.setNowMs(2_000);
        capturedLegendListProps.onWheel({ deltaY: -120 });
        scenario.root.setObservedUserPosition(7_000);
        capturedLegendListProps.onScroll({ nativeEvent: { contentOffset: { x: 0, y: 7_000 } } });

        scenario.setNowMs(2_100);
        capturedLegendListProps.onWheel({ deltaY: 120 });
        scenario.root.setObservedUserPosition(9_000);
        capturedLegendListProps.onScroll({ nativeEvent: { contentOffset: { x: 0, y: 9_000 } } });
        expect(getShellRef(scenario.listRef).hasLiveWebHold?.({ kind: 'item', itemId: 'row-1' })).toBe(true);
        scenario.published.length = 0;

        // The downward wheel established a genuine detached reading baseline. Installed
        // Legend updates threshold state and invokes these listeners before forwarding the
        // continuation through its public onScroll callback. The keyed reading target remains
        // authoritative until that callback classifies the movement.
        scenario.setNowMs(2_200);
        scenario.root.setObservedUserPosition(9_360);
        act(() => {
            for (
                const listener
                of legendStateListeners.get('isWithinMaintainScrollAtEndThreshold') ?? []
            ) {
                listener(true);
            }
        });
        expect(scenario.published.some((publication) => publication.isFollowing)).toBe(false);
        expect(getShellRef(scenario.listRef).hasLiveWebHold?.({ kind: 'item', itemId: 'row-1' })).toBe(true);

        const publicationCountBeforeClassifiedScroll = scenario.published.length;
        capturedLegendListProps.onScroll({ nativeEvent: { contentOffset: { x: 0, y: 9_360 } } });
        expect(getShellRef(scenario.listRef).hasLiveWebHold?.({ kind: 'end' })).toBe(true);
        expect(scenario.published.slice(publicationCountBeforeClassifiedScroll).some(
            (publication) => publication.isFollowing,
        )).toBe(true);
    });

    it('does not let stale inertia cross an explicit jump command phase', async () => {
        const scenario = await mountWebInertiaScenario();

        scenario.setNowMs(2_000);
        capturedLegendListProps.onWheel({ deltaY: -120 });
        scenario.root.setObservedUserPosition(7_000);
        capturedLegendListProps.onScroll({ nativeEvent: { contentOffset: { x: 0, y: 7_000 } } });
        scenario.setNowMs(2_100);
        capturedLegendListProps.onWheel({ deltaY: 120 });
        scenario.root.setObservedUserPosition(8_000);
        capturedLegendListProps.onScroll({ nativeEvent: { contentOffset: { x: 0, y: 8_000 } } });

        getShellRef(scenario.listRef).releaseWebHeldIntent?.();
        getShellRef(scenario.listRef).scrollToIndex({ animated: false, index: 0 });
        scenario.published.splice(0);

        scenario.setNowMs(2_150);
        scenario.root.setObservedUserPosition(8_100);
        capturedLegendListProps.onScroll({ nativeEvent: { contentOffset: { x: 0, y: 8_100 } } });
        scenario.setNowMs(2_200);
        scenario.root.scrollTop = 9_400;
        capturedLegendListProps.onScroll({ nativeEvent: { contentOffset: { x: 0, y: 9_400 } } });

        expect(getShellRef(scenario.listRef).hasLiveWebHold?.({ kind: 'end' })).toBe(false);
        expect(scenario.published).not.toContainEqual({ cause: 'user', isFollowing: true });
        expect(scenario.webMovementFacts.at(-1)).toMatchObject({
            isGenuineUserMovement: false,
        });
    });

    it('does not let stale inertia cross a logical data-key session phase', async () => {
        const scenario = await mountWebInertiaScenario();

        scenario.setNowMs(2_000);
        capturedLegendListProps.onWheel({ deltaY: -120 });
        scenario.root.setObservedUserPosition(7_000);
        capturedLegendListProps.onScroll({ nativeEvent: { contentOffset: { x: 0, y: 7_000 } } });
        scenario.setNowMs(2_100);
        capturedLegendListProps.onWheel({ deltaY: 120 });
        scenario.root.setObservedUserPosition(8_000);
        capturedLegendListProps.onScroll({ nativeEvent: { contentOffset: { x: 0, y: 8_000 } } });

        await scenario.updateSession('inertia-session-b', false);
        scenario.published.splice(0);
        scenario.setNowMs(2_200);
        scenario.root.scrollTop = 9_400;
        capturedLegendListProps.onScroll({ nativeEvent: { contentOffset: { x: 0, y: 9_400 } } });

        expect(getShellRef(scenario.listRef).hasLiveWebHold?.({ kind: 'end' })).toBe(false);
        expect(scenario.published).not.toContainEqual({ cause: 'user', isFollowing: true });
    });

    it('re-baselines downward inertia that remains detached without latching end', async () => {
        const scenario = await mountWebInertiaScenario();

        scenario.setNowMs(2_000);
        capturedLegendListProps.onWheel({ deltaY: -120 });
        scenario.root.setObservedUserPosition(7_000);
        capturedLegendListProps.onScroll({ nativeEvent: { contentOffset: { x: 0, y: 7_000 } } });
        scenario.setNowMs(2_100);
        capturedLegendListProps.onWheel({ deltaY: 120 });
        scenario.root.setObservedUserPosition(8_000);
        capturedLegendListProps.onScroll({ nativeEvent: { contentOffset: { x: 0, y: 8_000 } } });

        scenario.setNowMs(2_200);
        scenario.root.scrollTop = 8_120;
        capturedLegendListProps.onScroll({ nativeEvent: { contentOffset: { x: 0, y: 8_120 } } });
        expect(getShellRef(scenario.listRef).hasLiveWebHold?.({ kind: 'end' })).toBe(false);

        scenario.setNowMs(3_000);
        capturedLegendListProps.onItemSizeChanged({ index: 0, previous: 240, size: 241 });
        act(() => scenario.animationFrames.splice(0).forEach((callback) => callback(32)));
        expect(scenario.root.scrollTop).toBe(8_120);
        expect(getShellRef(scenario.listRef).hasLiveWebHold?.({ kind: 'end' })).toBe(false);
    });

    it('re-baselines a keyed reading hold at the user rest position instead of correcting the inertia tail back', async () => {
        // Live report 2026-07-23 (web): opening a session and wheel-scrolling up,
        // stopping yanked the viewport back DOWN 50-200px. The detached branch
        // re-arms the reading-anchor hold only on per-event classified USER scrolls;
        // a trackpad-inertia tail can continue past the classification of its last
        // wheel event, so the hold's capture goes stale by the inertia distance and
        // verifyLanding "corrects" the rest position back to the stale capture. User
        // movement during a keyed hold must RE-BASELINE the hold at rest — the hold
        // exists to keep the reader's place stable through remeasures, never to
        // reverse the reader's own movement.
        let nowMs = 1_000;
        vi.spyOn(Date, 'now').mockImplementation(() => nowMs);
        const animationFrames: FrameRequestCallback[] = [];
        vi.stubGlobal('requestAnimationFrame', vi.fn((callback: FrameRequestCallback) => {
            animationFrames.push(callback);
            return animationFrames.length;
        }));
        vi.stubGlobal('cancelAnimationFrame', vi.fn());

        class FakeHTMLElement {
            public clientHeight = 600;
            public isConnected = true;
            public parentElement: FakeHTMLElement | null = null;
            public scrollHeight = 10_000;
            public scrollLeft = 0;
            public scrollTop = 9_400;
            public contains = () => true;
            public getAttribute = () => null;
            public getBoundingClientRect = () => ({
                bottom: 600, height: 600, left: 0, right: 800, top: 0, width: 800, x: 0, y: 0, toJSON: () => ({}),
            });
            public querySelector = () => null;
            public querySelectorAll = () => [];
            public scrollTo = (options: { top: number }) => { this.scrollTop = options.top; };
        }
        const root = new FakeHTMLElement();
        vi.stubGlobal('HTMLElement', FakeHTMLElement);
        vi.stubGlobal('document', { getElementById: () => root });
        vi.stubGlobal('window', {
            getComputedStyle: () => ({ overflowX: 'hidden', overflowY: 'auto' }),
        });

        // The anchor row lives at content-y 6900: its viewport rect tracks the live
        // scrollTop so a stale capture produces a REAL residual (static rects would
        // read "aligned" at any offset and false-pass).
        const anchorNode = new FakeHTMLElement();
        (anchorNode as unknown as { getAttribute: (name: string) => string | null }).getAttribute =
            (name: string) => (name === 'data-testid' ? 'transcript-anchor-message-row-1' : null);
        anchorNode.getBoundingClientRect = () => ({
            bottom: 6_900 - root.scrollTop + 160, height: 160, left: 0, right: 800,
            top: 6_900 - root.scrollTop, width: 800, x: 0, y: 6_900 - root.scrollTop, toJSON: () => ({}),
        });
        const itemNode = new FakeHTMLElement();
        (itemNode as unknown as { getAttribute: (name: string) => string | null }).getAttribute =
            (name: string) => (name === 'data-testid' ? 'transcript-item-row-1' : null);
        itemNode.getBoundingClientRect = () => ({
            bottom: 6_860 - root.scrollTop + 240, height: 240, left: 0, right: 800,
            top: 6_860 - root.scrollTop, width: 800, x: 0, y: 6_860 - root.scrollTop, toJSON: () => ({}),
        });
        (root as unknown as { querySelectorAll: (selector: string) => unknown[] }).querySelectorAll =
            (selector: string) => (selector === '[data-testid]' ? [itemNode, anchorNode] : []);
        (root as unknown as { querySelector: (selector: string) => unknown }).querySelector =
            (selector: string) => {
                if (selector === '[data-testid="transcript-anchor-message-row-1"]') return anchorNode;
                if (selector === '[data-testid="transcript-item-row-1"]') return itemNode;
                return null;
            };

        const { legendListRenderer } = await import('./legendListRenderer');
        const Renderer = legendListRenderer.Component;
        const listRef = React.createRef<TranscriptListShellRef<{ id: string }>>();
        await renderScreen(
            <Renderer
                webDomObservation={mountedWebDomObservation}
                ref={listRef}
                data={[{ id: 'row-1' }]}
                dataKey="inertia-rebaseline-session"
                keyExtractor={(item: { id: string }) => item.id}
                renderItem={({ item }: { item: { id: string } }) => React.createElement('Row', { id: item.id })}
                frame={resolveMainTranscriptListShellFrame({
                    legendInitialScrollAtEnd: true,
                    nativeID: 'legend-main-native-id',
                    platformOS: 'web',
                })}
            />,
        );
        act(() => animationFrames.splice(0).forEach((callback) => callback(16)));

        // First classified wheel detach releases the held tail.
        nowMs = 2_000;
        capturedLegendListProps.onWheel({ deltaY: -120 });
        root.scrollTop = 7_100;
        capturedLegendListProps.onScroll({ nativeEvent: { contentOffset: { x: 0, y: 7_100 } } });
        expect(getShellRef(listRef).hasLiveWebHold?.({ kind: 'end' })).toBe(false);

        // Second classified wheel: the detached branch re-arms the reading-anchor
        // hold, capturing the anchor at st 6_800 (anchor viewport offset 100).
        nowMs = 2_100;
        capturedLegendListProps.onWheel({ deltaY: -120 });
        root.scrollTop = 6_800;
        capturedLegendListProps.onScroll({ nativeEvent: { contentOffset: { x: 0, y: 6_800 } } });
        expect(getShellRef(listRef).hasLiveWebHold?.({ kind: 'item', itemId: 'row-1' })).toBe(true);

        // Inertia tail: the scroll continues WITHOUT a wheel event (no per-event
        // classification), carrying the viewport 150px further up.
        nowMs = 2_200;
        root.scrollTop = 6_650;
        capturedLegendListProps.onScroll({ nativeEvent: { contentOffset: { x: 0, y: 6_650 } } });

        // Input quiets and a routine measurement signal arrives (production always
        // has these: row remeasure/commits). The settle verifier must NOT write the
        // stale 6_800 capture back — the rest position wins and becomes the hold's
        // new baseline.
        nowMs = 3_000;
        capturedLegendListProps.onItemSizeChanged({ index: 0, previous: 240, size: 241 });
        act(() => animationFrames.splice(0).forEach((callback) => callback(32)));
        act(() => animationFrames.splice(0).forEach((callback) => callback(48)));
        expect(root.scrollTop).toBe(6_650);
    });

    it('refreshes a live reading hold identity when the top edge triggers pagination', async () => {
        // A reader DWELLING at the top outlives the 10s hold identity window; the
        // prepend that onStartReached is about to load would then land against an
        // expired, unenforceable hold and the viewport stays at the top edge
        // showing the new content instead of the reader rows (live report
        // 2026-07-23). The trigger refreshes expiry WITHOUT recapturing geometry
        // (DR-030 mid-burst recapture stays excluded).
        let nowMs = 1_000;
        vi.spyOn(Date, 'now').mockImplementation(() => nowMs);
        const { legendListRenderer } = await import('./legendListRenderer');
        const Renderer = legendListRenderer.Component;
        const listRef = React.createRef<TranscriptListShellRef<{ id: string }>>();
        await renderScreen(
            <Renderer
                webDomObservation={mountedWebDomObservation}
                ref={listRef}
                data={[{ id: 'row-1' }]}
                dataKey="dwell-refresh-session"
                keyExtractor={(item: { id: string }) => item.id}
                renderItem={({ item }: { item: { id: string } }) => React.createElement('Row', { id: item.id })}
                frame={resolveMainTranscriptListShellFrame({
                    legendInitialScrollAtEnd: false,
                    nativeID: 'legend-main-native-id',
                    platformOS: 'web',
                })}
            />,
        );
        getShellRef(listRef).holdWebEntryAnchor?.({
            itemId: 'row-1',
            itemOffsetPx: 40,
            kind: 'item',
            messageId: null,
        });
        expect(getShellRef(listRef).hasLiveWebHold?.({ kind: 'item', itemId: 'row-1' })).toBe(true);

        // 9s of dwelling, then the top edge triggers pagination: identity refreshes.
        nowMs = 10_000;
        capturedLegendListProps.onStartReached();

        // 14s after the ORIGINAL arm (past its 10s window) the hold is still live
        // because the pagination trigger refreshed it.
        nowMs = 15_000;
        expect(getShellRef(listRef).hasLiveWebHold?.({ kind: 'item', itemId: 'row-1' })).toBe(true);
    });

    it('releases the held tail for a scrollbar drag away from the end instead of dragging the user back', async () => {
        // Live capture 2026-07-20 (web): with held-'end' latched (jump-to-bottom / pinned
        // follow), scroll movement carrying no classified input evidence is treated as an
        // external rollback and re-corrected to the tail within ~10ms. Wheel, keyboard, and
        // native drag/touch all classify — but a web SCROLLBAR drag produces only a pointer
        // press on the scroller plus scroll events, so the user was dragged back to the
        // bottom while scrolling ("something is fighting us"). A pointer press in the
        // scrollbar band is scroll intent: the drag's movement must release the held tail
        // exactly like a wheel detach, and later growth must leave the viewport stationary.
        let nowMs = 1_000;
        vi.spyOn(Date, 'now').mockImplementation(() => nowMs);
        const animationFrames: FrameRequestCallback[] = [];
        vi.stubGlobal('requestAnimationFrame', vi.fn((callback: FrameRequestCallback) => {
            animationFrames.push(callback);
            return animationFrames.length;
        }));
        vi.stubGlobal('cancelAnimationFrame', vi.fn());

        class FakeHTMLElement {
            public clientHeight = 600;
            public clientWidth = 784;
            public isConnected = true;
            public parentElement: FakeHTMLElement | null = null;
            public scrollHeight = 10_000;
            public scrollLeft = 0;
            public scrollTop = 9_400;
            public contains = () => true;
            public getAttribute = () => null;
            public getBoundingClientRect = () => ({
                bottom: 600, height: 600, left: 0, right: 800, top: 0, width: 800, x: 0, y: 0, toJSON: () => ({}),
            });
            public querySelector = () => null;
            public querySelectorAll = () => [];
            public scrollTo = (options: { top: number }) => { this.scrollTop = options.top; };
        }
        const root = new FakeHTMLElement();
        vi.stubGlobal('HTMLElement', FakeHTMLElement);
        vi.stubGlobal('document', { getElementById: () => root });
        vi.stubGlobal('window', {
            getComputedStyle: () => ({ overflowX: 'hidden', overflowY: 'auto' }),
        });

        const { legendListRenderer } = await import('./legendListRenderer');
        const Renderer = legendListRenderer.Component;
        await renderScreen(
            <Renderer
                webDomObservation={mountedWebDomObservation}
                data={[{ id: 'row-1' }]}
                dataKey="scrollbar-detach-session"
                keyExtractor={(item: { id: string }) => item.id}
                renderItem={({ item }: { item: { id: string } }) => React.createElement('Row', { id: item.id })}
                frame={resolveMainTranscriptListShellFrame({
                    legendInitialScrollAtEnd: true,
                    nativeID: 'legend-main-native-id',
                    platformOS: 'web',
                })}
            />,
        );
        act(() => animationFrames.splice(0).forEach((callback) => callback(16)));
        expect(root.scrollTop).toBe(9_400);

        // Scrollbar-band press: targets the scroller itself with offsetX beyond clientWidth.
        nowMs = 2_000;
        capturedLegendListProps.onPointerDown({
            nativeEvent: { offsetX: 792, offsetY: 300, target: root },
        });
        expect(assignedLegendRef.cancelInitialScrollPreservation).toHaveBeenCalledTimes(1);

        // The thumb drag moves the viewport away from the tail.
        nowMs = 2_100;
        legendStateOverride = {
            isAtEnd: false,
            isNearEnd: false,
            isWithinMaintainScrollAtEndThreshold: false,
            scroll: 5_000,
            scrollLength: 600,
            contentLength: 10_000,
        };
        root.scrollTop = 5_000;
        capturedLegendListProps.onScroll({ nativeEvent: { contentOffset: { x: 0, y: 5_000 } } });

        // Input quiets, streaming growth lands: a surviving held tail would slam the
        // viewport back to the bottom here.
        nowMs = 10_000;
        root.scrollHeight = 16_000;
        capturedLegendListProps.onItemSizeChanged({ index: 0, previous: 240, size: 6_240 });
        act(() => animationFrames.splice(0).forEach((callback) => callback(32)));
        expect(root.scrollTop).toBe(5_000);
    });

    it('adopts an unattributed viewport move under a renderer-captured hold instead of writing the reader back', async () => {
        // Live web scroll-back, reproduced 39/364 trials across 26 sessions (remote-dev sweep,
        // 2026-08-04): the reader scrolls, stops, and the transcript walks back 29-150px
        // (100-300px with a real trackpad). Attributed writer stack:
        //   tryWriteScrollTop <- writeWebScrollTopAndObserve <- recordProgrammaticScrollTopWrite
        //   <- evaluateLanding <- verifyLanding <- monitorHeldIntentThroughLayoutSettle
        // 29/34 (and 106/108 under A/B) of those writes fired with ZERO row remeasure and ZERO
        // content-size change: the renderer had displaced nothing, so there was nothing to
        // correct. A renderer-CAPTURED reading hold is armed at the reader's own position and
        // exists only to keep the renderer from displacing them; viewport movement it cannot
        // attribute to a renderer geometry change is the reader's and must be ADOPTED.
        const scenario = await mountWebInertiaScenario();

        // Wheel detaches; the next scroll frame captures the reading hold at the rest position.
        scenario.setNowMs(2_000);
        capturedLegendListProps.onWheel({ deltaY: -120 });
        scenario.root.setObservedUserPosition(7_000);
        capturedLegendListProps.onScroll({ nativeEvent: { contentOffset: { x: 0, y: 7_000 } } });
        expect(getShellRef(scenario.listRef).hasLiveWebHold?.({ kind: 'item', itemId: 'row-1' })).toBe(true);

        // The viewport moves 116px further with the layout completely static — no row
        // remeasure, no content-size change, no scroll-range change — and past every input
        // evidence window, so the movement classifier cannot attribute the frame at all.
        scenario.setNowMs(2_500);
        scenario.root.scrollTop = 6_884;
        capturedLegendListProps.onScroll({ nativeEvent: { contentOffset: { x: 0, y: 6_884 } } });
        expect(scenario.webMovementFacts.at(-1)).toMatchObject({ isGenuineUserMovement: false });

        // Settle to stability: the corrector must spend nothing.
        act(() => scenario.animationFrames.splice(0).forEach((callback) => callback(32)));
        act(() => scenario.animationFrames.splice(0).forEach((callback) => callback(48)));
        expect(scenario.root.scrollTop).toBe(6_884);
    });

    it('still corrects a renderer-captured hold when renderer geometry displaces its anchor', async () => {
        // The other half of the same contract: the hold exists because row remeasurement and
        // content growth genuinely do displace a parked reader (the 2026-08-04 positive control
        // injected +37px above the viewport and observed rowResize(rel=above) -> rowMove ->
        // content +37). Requiring evidence must not disarm the correction that evidence buys.
        const scenario = await mountWebInertiaScenario();

        scenario.setNowMs(2_000);
        capturedLegendListProps.onWheel({ deltaY: -120 });
        scenario.root.setObservedUserPosition(7_000);
        capturedLegendListProps.onScroll({ nativeEvent: { contentOffset: { x: 0, y: 7_000 } } });
        expect(getShellRef(scenario.listRef).hasLiveWebHold?.({ kind: 'item', itemId: 'row-1' })).toBe(true);

        // A row ABOVE the reader grows 116px: the anchor row moves down in the viewport while
        // the scroll offset stands still, and the content grows with it.
        scenario.setNowMs(2_500);
        scenario.root.scrollHeight = 10_116;
        scenario.root.setObservedUserPosition(7_000, 216);
        capturedLegendListProps.onItemSizeChanged({ index: 0, previous: 240, size: 356 });

        act(() => scenario.animationFrames.splice(0).forEach((callback) => callback(32)));
        act(() => scenario.animationFrames.splice(0).forEach((callback) => callback(48)));
        expect(scenario.root.scrollTop).toBe(7_116);
    });

    it('does not let a stale at-end observation overwrite keyboard takeover before the default scroll lands (AUD-002)', async () => {
        // Live AUD-002 (2026-07-12): from exact tail, trusted PageUp detached the viewport
        // 277px, then the held-tail machinery returned it to ~11px from the tail ~118ms
        // later. Mechanism: keyboard input released the held-'end' intent synchronously
        // (before the browser applied the default scroll), but a still-at-end observation
        // (streaming growth / state tick) landed in that window and re-latched held-'end';
        // the next settle then corrected the viewport back to the tail, overwriting the
        // user's takeover. Passive auto-end latching must hold off after user viewport
        // input until the input's default action has had time to land.
        let nowMs = 1_000;
        vi.spyOn(Date, 'now').mockImplementation(() => nowMs);
        const animationFrames: FrameRequestCallback[] = [];
        vi.stubGlobal('requestAnimationFrame', vi.fn((callback: FrameRequestCallback) => {
            animationFrames.push(callback);
            return animationFrames.length;
        }));
        vi.stubGlobal('cancelAnimationFrame', vi.fn());

        class FakeHTMLElement {
            public clientHeight = 600;
            public isConnected = true;
            public parentElement: FakeHTMLElement | null = null;
            public scrollHeight = 10_000;
            public scrollLeft = 0;
            public scrollTop = 9_400;
            public contains = () => true;
            public getAttribute = () => null;
            public getBoundingClientRect = () => ({
                bottom: 600, height: 600, left: 0, right: 800, top: 0, width: 800, x: 0, y: 0, toJSON: () => ({}),
            });
            public querySelector = () => null;
            public querySelectorAll = () => [];
            public scrollTo = (options: { top: number }) => { this.scrollTop = options.top; };
        }
        const root = new FakeHTMLElement();
        vi.stubGlobal('HTMLElement', FakeHTMLElement);
        vi.stubGlobal('document', { getElementById: () => root });
        vi.stubGlobal('window', {
            getComputedStyle: () => ({ overflowX: 'hidden', overflowY: 'auto' }),
        });

        const { legendListRenderer } = await import('./legendListRenderer');
        const Renderer = legendListRenderer.Component;
        const listRef = React.createRef<TranscriptListShellRef<{ id: string }>>();
        await renderScreen(
            <Renderer
                webDomObservation={mountedWebDomObservation}
                ref={listRef}
                data={[{ id: 'row-1' }]}
                dataKey="s-keyboard-takeover"
                keyExtractor={(item: { id: string }) => item.id}
                renderItem={({ item }: { item: { id: string } }) => React.createElement('Row', { id: item.id })}
                frame={resolveMainTranscriptListShellFrame({
                    legendInitialScrollAtEnd: true,
                    nativeID: 'legend-main-native-id',
                    platformOS: 'web',
                })}
            />,
        );
        act(() => animationFrames.splice(0).forEach((callback) => callback(16)));
        expect(root.scrollTop).toBe(9_400);

        // Trusted PageUp: the host records keyboard takeover synchronously, BEFORE the
        // browser applies the default scroll movement.
        nowMs = 2_000;
        getShellRef(listRef).notifyViewportInput?.({
            kind: 'keyboard',
            verticalDirection: 'toward-start',
        });

        // A still-at-end observation lands in the keydown -> default-scroll window (a
        // Legend state-listener tick; geometry unchanged: the browser has not moved the
        // viewport yet). This is the stale observation that re-latched held-'end'.
        await act(async () => {
            for (const listener of legendStateListeners.get('isWithinMaintainScrollAtEndThreshold') ?? []) {
                listener(true);
            }
        });

        // The browser default PageUp movement lands: 277px detach from the tail.
        nowMs = 2_050;
        root.scrollTop = 9_123;
        capturedLegendListProps.onScroll({ nativeEvent: { contentOffset: { x: 0, y: 9_123 } } });

        // The next settle/growth tick (~118ms later in the live capture) must NOT return
        // the viewport to the tail: the user owns it.
        nowMs = 2_170;
        root.scrollHeight = 10_400;
        capturedLegendListProps.onItemSizeChanged({ index: 0, previous: 9_761, size: 10_161 });
        act(() => animationFrames.splice(0).forEach((callback) => callback(33)));
        expect(root.scrollTop).toBe(9_123);

        // Input quiets past the write-suppression window: the settle corrector resumes.
        // If the stale tick re-latched held-'end', THIS is where the viewport snaps back
        // to the tail, overwriting the user's takeover.
        nowMs = 3_600;
        capturedLegendListProps.onItemSizeChanged({ index: 0, previous: 10_161, size: 10_162 });
        act(() => animationFrames.splice(0).forEach((callback) => callback(49)));
        act(() => animationFrames.splice(0).forEach((callback) => callback(65)));
        expect(root.scrollTop).toBe(9_123);
    });

    it('dedupes unchanged at-end publications (no ResizeObserver/commit re-emit storm)', async () => {
        // Live evidence (USER-REALITY-DIVERGENCE RC-1): on a streaming session the adapter
        // re-published an identical at-end state at ~110Hz (ResizeObserver + commit + state
        // listeners), and every publication cascaded into a sync live-tail mark that reset
        // window state and deleted the durable viewport anchor.
        const { legendListRenderer } = await import('./legendListRenderer');
        const Renderer = legendListRenderer.Component;
        const onRendererAtEndChange = vi.fn();

        legendStateOverride = {
            contentLength: 1200,
            end: 0,
            isAtEnd: false,
            isNearEnd: false,
            isWithinMaintainScrollAtEndThreshold: false,
            scroll: 240,
            scrollLength: 600,
            start: 0,
        };

        await renderScreen(
            <Renderer
                webDomObservation={mountedWebDomObservation}
                data={[{ id: 'row-1' }]}
                dataKey="session-test"
                keyExtractor={(item: { id: string }) => item.id}
                renderItem={({ item }: { item: { id: string } }) => React.createElement('Row', { id: item.id })}
                frame={resolveMainTranscriptListShellFrame({
                    legendInitialScrollAtEnd: false,
                    nativeID: 'legend-main-native-id',
                    platformOS: 'web',
                })}
                onRendererAtEndChange={onRendererAtEndChange}
            />,
        );
        const initialCallCount = onRendererAtEndChange.mock.calls.length;
        expect(initialCallCount).toBeGreaterThan(0);

        // Same facts re-observed (geometry tick without a state change) must not re-publish.
        await act(async () => {
            for (const listener of legendStateListeners.get('isAtEnd') ?? []) listener(false);
            for (const listener of legendStateListeners.get('isNearEnd') ?? []) listener(false);
        });
        expect(onRendererAtEndChange.mock.calls.length).toBe(initialCallCount);

        // A genuine change still publishes exactly once more.
        legendStateOverride = {
            ...legendStateOverride,
            isAtEnd: true,
            isNearEnd: true,
            isWithinMaintainScrollAtEndThreshold: true,
            scroll: 600,
        };
        await act(async () => {
            for (const listener of legendStateListeners.get('isAtEnd') ?? []) listener(true);
        });
        expect(onRendererAtEndChange.mock.calls.length).toBe(initialCallCount + 1);
        await act(async () => {
            for (const listener of legendStateListeners.get('isAtEnd') ?? []) listener(true);
        });
        expect(onRendererAtEndChange.mock.calls.length).toBe(initialCallCount + 1);
    });

    it('does not latch a held tail when the entry frame withholds initial tail placement', async () => {
        // Re-entry to a detached-anchored session: the frame carries initialScrollAtEnd=false.
        // Underfilled mount geometry still reads as physically at-end; latching a held-'end'
        // intent from that observation re-creates the re-entry scroll war against the entry
        // anchor restore (USER-REALITY-DIVERGENCE RC-4).
        const { legendListRenderer } = await import('./legendListRenderer');
        const Renderer = legendListRenderer.Component;

        // Underfilled: contentLength <= scrollLength, physically at end.
        legendStateOverride = {
            contentLength: 400,
            end: 0,
            isAtEnd: true,
            isNearEnd: true,
            isWithinMaintainScrollAtEndThreshold: true,
            scroll: 0,
            scrollLength: 600,
            start: 0,
        };

        const screen = await renderScreen(
            <Renderer
                webDomObservation={mountedWebDomObservation}
                data={[{ id: 'row-1' }]}
                dataKey="session-test"
                keyExtractor={(item: { id: string }) => item.id}
                renderItem={({ item }: { item: { id: string } }) => React.createElement('Row', { id: item.id })}
                frame={resolveMainTranscriptListShellFrame({
                    legendInitialScrollAtEnd: false,
                    nativeID: 'legend-main-native-id',
                    platformOS: 'web',
                })}
                footer={React.createElement('BottomSlot')}
            />,
        );
        const identityHost = screen.tree.root.findByProps({ nativeID: 'legend-main-native-id' });
        assignedLegendRef.scrollToEnd.mockClear();

        // Fill lands, entry restore places the viewport mid-list: geometry changes must stay inert.
        legendStateOverride = {
            ...legendStateOverride,
            contentLength: 1200,
            isAtEnd: false,
            isNearEnd: false,
            isWithinMaintainScrollAtEndThreshold: false,
            scroll: 200,
        };
        identityHost.props.onLayout({ nativeEvent: { layout: { height: 535, width: 800, x: 0, y: 0 } } });
        capturedLegendListProps.ListFooterComponent.props.onLayout({
            nativeEvent: { layout: { height: 352, width: 800, x: 0, y: 0 } },
        });
        capturedLegendListProps.onItemSizeChanged({ index: 0, previous: 100, size: 400 });

        expect(assignedLegendRef.scrollToEnd).not.toHaveBeenCalled();
    });

    it('starts detached after the production-keyed session remount even when the DOM nativeID is reused', async () => {
        // Every production transcript shell is keyed by its session/dataset identity. The
        // remounted adapter must start from the next frame's detached entry rather than the
        // previous session's held tail.
        const { legendListRenderer } = await import('./legendListRenderer');
        const Renderer = legendListRenderer.Component;

        legendStateOverride = {
            contentLength: 1200,
            end: 0,
            isAtEnd: true,
            isNearEnd: true,
            isWithinMaintainScrollAtEndThreshold: true,
            scroll: 600,
            scrollLength: 600,
            start: 0,
        };

        const render = (dataKey: string, initialScrollAtEnd: boolean) => (
            <Renderer
                key={dataKey}
                webDomObservation={mountedWebDomObservation}
                data={[{ id: 'row-1' }]}
                dataKey={dataKey}
                keyExtractor={(item: { id: string }) => item.id}
                renderItem={({ item }: { item: { id: string } }) => React.createElement('Row', { id: item.id })}
                frame={resolveMainTranscriptListShellFrame({
                    legendInitialScrollAtEnd: initialScrollAtEnd,
                    nativeID: 'legend-main-native-id',
                    platformOS: 'web',
                })}
                footer={React.createElement('BottomSlot')}
            />
        );
        const screen = await renderScreen(render('session-a', true));
        // Production-keyed session switch: new instance, detached entry.
        await screen.update(render('session-b', false));
        assignedLegendRef.scrollToEnd.mockClear();

        legendStateOverride = {
            ...legendStateOverride,
            isAtEnd: false,
            isNearEnd: false,
            isWithinMaintainScrollAtEndThreshold: false,
            scroll: 200,
        };
        const identityHost = screen.tree.root.findByProps({ nativeID: 'legend-main-native-id' });
        identityHost.props.onLayout({ nativeEvent: { layout: { height: 535, width: 800, x: 0, y: 0 } } });
        capturedLegendListProps.ListFooterComponent.props.onLayout({
            nativeEvent: { layout: { height: 352, width: 800, x: 0, y: 0 } },
        });
        capturedLegendListProps.onItemSizeChanged({ index: 0, previous: 100, size: 400 });

        expect(assignedLegendRef.scrollToEnd).not.toHaveBeenCalled();
    });

    it('preserves a held web tail across viewport geometry changes without an app steady-follow write', async () => {
        // The frame is the shell's canonical platform basis. A non-web runtime stub must not
        // disable a frame that was resolved for web (the production browser and Vitest differ).
        setPlatformOS('node');
        const { legendListRenderer } = await import('./legendListRenderer');
        const Renderer = legendListRenderer.Component;
        const listRef = React.createRef<TranscriptListShellRef<{ id: string }>>();

        legendStateOverride = {
            contentLength: 1200,
            end: 0,
            isAtEnd: true,
            isNearEnd: true,
            isWithinMaintainScrollAtEndThreshold: true,
            scroll: 600,
            scrollLength: 600,
            start: 0,
        };

        const screen = await renderScreen(
            <Renderer
                webDomObservation={mountedWebDomObservation}
                ref={listRef}
                data={[{ id: 'row-1' }]}
                dataKey="session-test"
                keyExtractor={(item: { id: string }) => item.id}
                renderItem={({ item }: { item: { id: string } }) => React.createElement('Row', { id: item.id })}
                frame={resolveMainTranscriptListShellFrame({
                    nativeID: 'legend-main-native-id',
                    platformOS: 'web',
                })}
                footer={React.createElement('BottomSlot')}
            />,
        );
        const identityHost = screen.tree.root.findByProps({ nativeID: 'legend-main-native-id' });

        assignedLegendRef.scrollToEnd.mockClear();
        identityHost.props.onLayout({ nativeEvent: { layout: { height: 670, width: 800, x: 0, y: 0 } } });
        capturedLegendListProps.ListFooterComponent.props.onLayout({
            nativeEvent: { layout: { height: 40, width: 800, x: 0, y: 0 } },
        });
        expect(assignedLegendRef.scrollToEnd).not.toHaveBeenCalled();

        // The browser recomputes `isAtEnd` from the new geometry before any user scroll.
        // The renderer must preserve the prior held-tail intent across that resize.
        legendStateOverride = {
            ...legendStateOverride,
            isAtEnd: false,
            isNearEnd: false,
            isWithinMaintainScrollAtEndThreshold: false,
            scroll: 200,
        };
        identityHost.props.onLayout({ nativeEvent: { layout: { height: 535, width: 800, x: 0, y: 0 } } });
        capturedLegendListProps.ListFooterComponent.props.onLayout({
            nativeEvent: { layout: { height: 352, width: 800, x: 0, y: 0 } },
        });

        expect(assignedLegendRef.scrollToEnd).not.toHaveBeenCalled();
        expect(getShellRef(listRef).hasLiveWebHold?.({ kind: 'end' })).toBe(true);
    });

    it('does not re-target geometry changes after a genuine detached web scroll', async () => {
        const { legendListRenderer } = await import('./legendListRenderer');
        const Renderer = legendListRenderer.Component;

        legendStateOverride = {
            contentLength: 1200,
            end: 0,
            isAtEnd: true,
            isNearEnd: true,
            isWithinMaintainScrollAtEndThreshold: true,
            scroll: 600,
            scrollLength: 600,
            start: 0,
        };

        const screen = await renderScreen(
            <Renderer
                webDomObservation={mountedWebDomObservation}
                data={[{ id: 'row-1' }]}
                dataKey="session-test"
                keyExtractor={(item: { id: string }) => item.id}
                renderItem={({ item }: { item: { id: string } }) => React.createElement('Row', { id: item.id })}
                frame={resolveMainTranscriptListShellFrame({
                    nativeID: 'legend-main-native-id',
                    platformOS: 'web',
                })}
                footer={React.createElement('BottomSlot')}
            />,
        );
        const identityHost = screen.tree.root.findByProps({ nativeID: 'legend-main-native-id' });

        identityHost.props.onLayout({ nativeEvent: { layout: { height: 670, width: 800, x: 0, y: 0 } } });
        capturedLegendListProps.ListFooterComponent.props.onLayout({
            nativeEvent: { layout: { height: 40, width: 800, x: 0, y: 0 } },
        });
        assignedLegendRef.scrollToEnd.mockClear();

        legendStateOverride = {
            ...legendStateOverride,
            isAtEnd: false,
            isNearEnd: false,
            isWithinMaintainScrollAtEndThreshold: false,
            scroll: 200,
        };
        capturedLegendListProps.onWheel({ deltaY: -300 });
        capturedLegendListProps.onScroll({ nativeEvent: { contentOffset: { x: 0, y: 200 } } });
        identityHost.props.onLayout({ nativeEvent: { layout: { height: 535, width: 800, x: 0, y: 0 } } });
        capturedLegendListProps.ListFooterComponent.props.onLayout({
            nativeEvent: { layout: { height: 352, width: 800, x: 0, y: 0 } },
        });

        expect(assignedLegendRef.scrollToEnd).not.toHaveBeenCalled();
    });

    it('materializes held-tail growth without adding an app steady-follow correction', async () => {
        const { legendListRenderer } = await import('./legendListRenderer');
        const Renderer = legendListRenderer.Component;
        const listRef = React.createRef<TranscriptListShellRef<{ id: string }>>();
        legendStateOverride = {
            contentLength: 1200,
            end: 0,
            isAtEnd: true,
            isNearEnd: true,
            isWithinMaintainScrollAtEndThreshold: true,
            // Legend resolves an offset for every index after a data change, including the
            // appended one it has not mounted yet. The adapter's one-shot materialization
            // targets that resolved offset; without one there is nothing to target and
            // placement stays with the library.
            positionAtIndex: (index: number) => index * 600,
            scroll: 600,
            scrollLength: 600,
            start: 0,
        };

        const render = (data: Array<{ id: string }>) => (
            <Renderer
                webDomObservation={mountedWebDomObservation}
                ref={listRef}
                data={data}
                dataKey="session-test"
                keyExtractor={(item: { id: string }) => item.id}
                renderItem={({ item }: { item: { id: string } }) => React.createElement('Row', { id: item.id })}
                frame={resolveMainTranscriptListShellFrame({ nativeID: 'legend-main-native-id', platformOS: 'web' })}
            />
        );
        const screen = await renderScreen(render([{ id: 'row-1' }]));
        assignedLegendRef.scrollToEnd.mockClear();
        legendStateOverride = {
            ...legendStateOverride,
            isAtEnd: false,
            isNearEnd: false,
            isWithinMaintainScrollAtEndThreshold: false,
            scroll: 200,
        };

        capturedLegendListProps.onItemSizeChanged({ index: 0, previous: 100, size: 400 });
        expect(assignedLegendRef.scrollToEnd).not.toHaveBeenCalled();
        expect(getShellRef(listRef).hasLiveWebHold?.({ kind: 'end' })).toBe(true);

        assignedLegendRef.scrollToEnd.mockClear();
        legendStateOverride = {
            ...legendStateOverride,
            contentLength: 1_440,
            scroll: 600,
        };
        await screen.update(render([{ id: 'row-1' }, { id: 'row-2' }]));
        // The appended final index is not yet inside Legend's reported mounted range, so the
        // tail is materialized once - as Legend's END intent, never as an index frozen at
        // request time. Legend resolves a frozen index against its position table when the
        // deferred request RUNS (`calculateOffsetForIndex` -> `positions[index] || 0`, run
        // regardless of readiness after 800ms), so on a multi-wave hydration it resolves to an
        // interior row or to offset 0 - the HEAD. Measured live 2026-07-30 on session
        // cms4aenky5lnktm72sfmya6uk: 16 scrollToIndex commands per cold open, 8 landing at
        // scrollTop 0 while maxScroll was ~1936, against 0 wrong landings out of 7 for
        // scrollToEnd, which re-derives `data.length - 1` at run time.
        expect(assignedLegendRef.scrollToIndex).not.toHaveBeenCalled();
        expect(assignedLegendRef.scrollToEnd).toHaveBeenCalledWith({ animated: false });
        expect(assignedLegendRef.scrollToEnd).toHaveBeenCalledTimes(1);

        assignedLegendRef.scrollToEnd.mockClear();
        capturedLegendListProps.onWheel({ deltaY: -300 });
        capturedLegendListProps.onItemSizeChanged({ index: 0, previous: 400, size: 500 });
        await screen.update(render([{ id: 'row-1' }, { id: 'row-2' }, { id: 'row-3' }]));
        // One placement transaction per dataset identity: a later hydration wave must not
        // re-arm it, which is exactly what the `${dataLength}:${tailKey}` key did.
        expect(assignedLegendRef.scrollToEnd).not.toHaveBeenCalled();
    });

    it('corrects Legend web MVCP residual error after a large prepend and detached append', async () => {
        let nowMs = 1_000;
        vi.spyOn(Date, 'now').mockImplementation(() => nowMs);
        const animationFrames: FrameRequestCallback[] = [];
        vi.stubGlobal('requestAnimationFrame', vi.fn((callback: FrameRequestCallback) => {
            animationFrames.push(callback);
            return animationFrames.length;
        }));
        vi.stubGlobal('cancelAnimationFrame', vi.fn());

        class FakeHTMLElement {
            public clientHeight = 600;
            public height = 100;
            public isConnected = true;
            public parentElement: FakeHTMLElement | null = null;
            public scrollHeight = 10_000;
            private currentScrollTop = 0;
            public onScrollTopChanged: ((delta: number) => void) | null = null;
            public get scrollTop() { return this.currentScrollTop; }
            public set scrollTop(value: number) {
                const delta = value - this.currentScrollTop;
                this.currentScrollTop = value;
                this.onScrollTopChanged?.(delta);
            }
            public testId: string | null = null;
            public top = 0;
            public contains = () => true;
            public getAttribute = (name: string) => name === 'data-testid' ? this.testId : null;
            public getBoundingClientRect = () => ({
                bottom: this.top + this.height,
                height: this.height,
                left: 0,
                right: 800,
                top: this.top,
                width: 800,
                x: 0,
                y: this.top,
                toJSON: () => ({}),
            });
            public querySelector = (selector: string) => selector.includes('message-m1') ? anchor : selector.includes('item-oldest') ? item : null;
            public querySelectorAll = () => [item, anchor];
        }
        const root = new FakeHTMLElement();
        root.height = 600;
        const item = new FakeHTMLElement();
        item.testId = 'transcript-item-oldest';
        item.top = 100;
        item.clientHeight = 100;
        item.scrollHeight = 100;
        item.parentElement = root;
        const anchor = new FakeHTMLElement();
        anchor.testId = 'transcript-anchor-message-m1';
        anchor.top = 100;
        anchor.clientHeight = 100;
        anchor.scrollHeight = 100;
        anchor.parentElement = item;
        root.onScrollTopChanged = (delta) => {
            item.top -= delta;
            anchor.top -= delta;
        };

        vi.stubGlobal('HTMLElement', FakeHTMLElement);
        vi.stubGlobal('document', { getElementById: () => root });
        vi.stubGlobal('window', {
            getComputedStyle: () => ({ overflowX: 'hidden', overflowY: 'auto' }),
        });

        const { resolveWebTranscriptScrollMetrics } = await import('@/components/sessions/transcript/webTranscriptScrollMetrics');
        const { captureWebTranscriptViewportAnchor } = await import('@/components/sessions/transcript/viewport/prepend/webTranscriptPrependAnchor');
        const metrics = resolveWebTranscriptScrollMetrics({ root: root as unknown as HTMLElement, win: window, minOverflowPx: 0, allowRootFallback: true });
        expect(metrics).not.toBeNull();
        expect(captureWebTranscriptViewportAnchor({ container: metrics!.element })).toMatchObject({
            kind: 'message',
            messageId: 'm1',
        });

        const { legendListRenderer } = await import('./legendListRenderer');
        const Renderer = legendListRenderer.Component;
        const render = (data: Array<{ id: string }>) => (
            <Renderer
                webDomObservation={mountedWebDomObservation}
                data={data}
                dataKey="session-test"
                keyExtractor={(entry: { id: string }) => entry.id}
                renderItem={({ item: entry }: { item: { id: string } }) => React.createElement('Row', { id: entry.id })}
                frame={resolveMainTranscriptListShellFrame({
                    nativeID: 'legend-main-native-id',
                    platformOS: 'web',
                })}
            />
        );

        const screen = await renderScreen(render([{ id: 'newest' }]));
        // Initial hydration can grow the chronological data before the first genuine older-edge
        // request. Generic host scroll ingress can start pagination before Legend's own
        // onStartReached callback, so the adapter must refresh the fallback at the top-edge scroll.
        await screen.update(render([{ id: 'newest' }, { id: 'oldest' }]));
        root.scrollTop = 0;
        anchor.top = 135;
        item.top = 135;
        capturedLegendListProps.onWheel({ deltaY: -300 });
        capturedLegendListProps.onScroll({ nativeEvent: { contentOffset: { x: 0, y: 0 } } });
        capturedLegendListProps.onStartReached();
        // User input quiets before the late load signal (live cold commits land ~270ms after
        // the triggering wheel); corrections never write inside the live input margin (S-D).
        nowMs += 300;

        // The reached-edge signal itself must arm the ONE keyed anchor transaction. Legend can
        // publish a late load/measurement signal before React commits the prepended data; the
        // previous parallel prepend-residual owner ignored that signal because data length had
        // not changed yet, allowing the visible row to drift before the later prepend landed.
        anchor.top += 41;
        item.top += 41;
        capturedLegendListProps.onLoad({});
        act(() => animationFrames.splice(0).forEach((callback) => callback(12)));
        expect(root.scrollTop).toBe(41);

        anchor.top = 293;
        item.top = 293;
        await screen.update(render([{ id: 'older' }, { id: 'newest' }, { id: 'oldest' }]));
        capturedLegendListProps.onItemSizeChanged({ index: 0, previous: 240, size: 9_000 });
        expect(animationFrames.length).toBeGreaterThan(0);
        act(() => animationFrames.splice(0).forEach((callback) => callback(16)));

        expect(root.scrollTop).toBe(199);

        // Large rows can report their final measurement after the first aligned frames. Keep
        // the same prepend transaction available for a later Legend size notification rather
        // than declaring it complete after two temporarily quiet frames.
        act(() => animationFrames.splice(0).forEach((callback) => callback(32)));
        act(() => animationFrames.splice(0).forEach((callback) => callback(48)));
        // Giant rows can finish measuring seconds after data growth; the bounded transaction
        // must outlive Legend's short MVCP window without active polling between signals.
        nowMs += 2_000;
        anchor.top += 55;
        item.top += 55;
        capturedLegendListProps.onItemSizeChanged({ index: 0, previous: 9_000, size: 9_055 });
        act(() => animationFrames.splice(0).forEach((callback) => callback(64)));

        expect(root.scrollTop).toBe(254);

        // Appends below a detached viewport can still make Legend remeasure already-rendered
        // rows. Preserve the same renderer-owned DOM anchor instead of letting that layout
        // residual move the reader while the app-side append writer remains gated.
        capturedLegendListProps.onWheel({ deltaY: -300 });
        anchor.top = 200;
        item.top = 200;
        capturedLegendListProps.onScroll({ nativeEvent: { contentOffset: { x: 0, y: root.scrollTop } } });
        nowMs += 300;
        await screen.update(render([{ id: 'older' }, { id: 'newest' }, { id: 'oldest' }, { id: 'newer' }]));
        anchor.top += 116;
        item.top += 116;
        capturedLegendListProps.onItemSizeChanged({ index: 1, previous: 240, size: 356 });
        act(() => animationFrames.splice(0).forEach((callback) => callback(80)));

        expect(root.scrollTop).toBe(370);
    });

    it('keeps the pre-commit anchor baseline when non-user scroll writes land during a prepend burst', async () => {
        // Live DR-030 session-B failure (2026-07-11): Legend MVCP/estimate corrections emit
        // cause-less scroll events during a giant-row cold-page commit. Re-arming the visible
        // anchor hold from those events adopted displaced geometry as the new baseline, so the
        // held transaction "corrected" to the displaced position and settled 61px off.
        let nowMs = 1_000;
        vi.spyOn(Date, 'now').mockImplementation(() => nowMs);
        const animationFrames: FrameRequestCallback[] = [];
        vi.stubGlobal('requestAnimationFrame', vi.fn((callback: FrameRequestCallback) => {
            animationFrames.push(callback);
            return animationFrames.length;
        }));
        vi.stubGlobal('cancelAnimationFrame', vi.fn());

        class FakeHTMLElement {
            public clientHeight = 600;
            public height = 100;
            public isConnected = true;
            public parentElement: FakeHTMLElement | null = null;
            public scrollHeight = 10_000;
            private currentScrollTop = 0;
            public onScrollTopChanged: ((delta: number) => void) | null = null;
            public get scrollTop() { return this.currentScrollTop; }
            public set scrollTop(value: number) {
                const delta = value - this.currentScrollTop;
                this.currentScrollTop = value;
                this.onScrollTopChanged?.(delta);
            }
            public testId: string | null = null;
            public top = 0;
            public contains = () => true;
            public getAttribute = (name: string) => name === 'data-testid' ? this.testId : null;
            public getBoundingClientRect = () => ({
                bottom: this.top + this.height,
                height: this.height,
                left: 0,
                right: 800,
                top: this.top,
                width: 800,
                x: 0,
                y: this.top,
                toJSON: () => ({}),
            });
            public querySelector = (selector: string) => selector.includes('message-m1') ? anchor : selector.includes('item-oldest') ? item : null;
            public querySelectorAll = () => [item, anchor];
        }
        const root = new FakeHTMLElement();
        root.height = 600;
        const item = new FakeHTMLElement();
        item.testId = 'transcript-item-oldest';
        item.top = 135;
        item.clientHeight = 100;
        item.scrollHeight = 100;
        item.parentElement = root;
        const anchor = new FakeHTMLElement();
        anchor.testId = 'transcript-anchor-message-m1';
        anchor.top = 135;
        anchor.clientHeight = 100;
        anchor.scrollHeight = 100;
        anchor.parentElement = item;
        root.onScrollTopChanged = (delta) => {
            item.top -= delta;
            anchor.top -= delta;
        };

        vi.stubGlobal('HTMLElement', FakeHTMLElement);
        vi.stubGlobal('document', { getElementById: () => root });
        vi.stubGlobal('window', {
            getComputedStyle: () => ({ overflowX: 'hidden', overflowY: 'auto' }),
        });

        const { legendListRenderer } = await import('./legendListRenderer');
        const Renderer = legendListRenderer.Component;
        const render = (data: Array<{ id: string }>) => (
            <Renderer
                webDomObservation={mountedWebDomObservation}
                data={data}
                dataKey="session-test"
                keyExtractor={(entry: { id: string }) => entry.id}
                renderItem={({ item: entry }: { item: { id: string } }) => React.createElement('Row', { id: entry.id })}
                frame={resolveMainTranscriptListShellFrame({
                    nativeID: 'legend-main-native-id',
                    platformOS: 'web',
                })}
            />
        );
        const screen = await renderScreen(render([{ id: 'newest' }, { id: 'oldest' }]));
        // Reset the mount-time end placement so the detached baseline geometry is explicit.
        root.scrollTop = 0;
        item.top = 135;
        anchor.top = 135;

        // User detaches at the boundary; the reached-edge capture arms the anchor at top=135.
        capturedLegendListProps.onWheel({ deltaY: -300 });
        capturedLegendListProps.onScroll({ nativeEvent: { contentOffset: { x: 0, y: 0 } } });
        capturedLegendListProps.onStartReached();
        act(() => animationFrames.splice(0).forEach((callback) => callback(12)));
        expect(root.scrollTop).toBe(0);
        expect(anchor.top).toBe(135);
        // Input quiets before the cold commit lands (S-D: no writes inside the live margin).
        nowMs += 300;

        // Cold page commits: 500px of older content lands ABOVE the reader, so the content grows
        // and the held row's CONTENT-space position moves with it (the geometry a prepend
        // actually produces — modelling it as a bare offset write would be indistinguishable
        // from the reader scrolling, which is the one movement this hold must never fight).
        await screen.update(render([{ id: 'older' }, { id: 'newest' }, { id: 'oldest' }]));
        root.scrollHeight = 10_500;
        item.top += 500;
        anchor.top += 500;
        // Legend's MVCP replay compensates with estimate error: it scrolls 439 instead of 500,
        // leaving the viewport displaced 61px, and emits a cause-less scroll event. That event
        // must NOT re-baseline the live anchor hold.
        root.scrollTop = 439;
        expect(anchor.top).toBe(196);
        capturedLegendListProps.onScroll({ nativeEvent: { contentOffset: { x: 0, y: 439 } } });

        // The next measurement signal resumes the held transaction: it must restore the
        // PRE-COMMIT baseline (anchor back to 135), not adopt the displaced 196px position.
        capturedLegendListProps.onItemSizeChanged({ index: 0, previous: 240, size: 301 });
        act(() => animationFrames.splice(0).forEach((callback) => callback(16)));
        act(() => animationFrames.splice(0).forEach((callback) => callback(32)));

        expect(anchor.top).toBe(135);
        expect(root.scrollTop).toBe(500);
    });

    it('defers viewport-exceeding keyed residual writes until a second read confirms them', async () => {
        // Live DR-030 write attribution (2026-07-11): during a giant cold commit the held
        // transaction read the anchor while scroll compensation and the DOM commit were out of
        // sync and wrote a ~19200px-stale offset, clobbering Legend's own compensation for a
        // frame. A residual that exceeds the viewport must be observed twice before writing;
        // a genuine persistent giant residual still lands one frame later.
        let nowMs = 1_000;
        vi.spyOn(Date, 'now').mockImplementation(() => nowMs);
        const animationFrames: FrameRequestCallback[] = [];
        vi.stubGlobal('requestAnimationFrame', vi.fn((callback: FrameRequestCallback) => {
            animationFrames.push(callback);
            return animationFrames.length;
        }));
        vi.stubGlobal('cancelAnimationFrame', vi.fn());

        class FakeHTMLElement {
            public clientHeight = 600;
            public height = 100;
            public isConnected = true;
            public parentElement: FakeHTMLElement | null = null;
            public scrollHeight = 10_000;
            private currentScrollTop = 0;
            public onScrollTopChanged: ((delta: number) => void) | null = null;
            public get scrollTop() { return this.currentScrollTop; }
            public set scrollTop(value: number) {
                const delta = value - this.currentScrollTop;
                this.currentScrollTop = value;
                this.onScrollTopChanged?.(delta);
            }
            public testId: string | null = null;
            public top = 0;
            public contains = () => true;
            public getAttribute = (name: string) => name === 'data-testid' ? this.testId : null;
            public getBoundingClientRect = () => ({
                bottom: this.top + this.height,
                height: this.height,
                left: 0,
                right: 800,
                top: this.top,
                width: 800,
                x: 0,
                y: this.top,
                toJSON: () => ({}),
            });
            public querySelector = (selector: string) => selector.includes('message-m1') ? anchor : selector.includes('item-oldest') ? item : null;
            public querySelectorAll = () => [item, anchor];
        }
        const root = new FakeHTMLElement();
        root.height = 600;
        const item = new FakeHTMLElement();
        item.testId = 'transcript-item-oldest';
        item.clientHeight = 100;
        item.scrollHeight = 100;
        item.parentElement = root;
        const anchor = new FakeHTMLElement();
        anchor.testId = 'transcript-anchor-message-m1';
        anchor.clientHeight = 100;
        anchor.scrollHeight = 100;
        anchor.parentElement = item;
        root.onScrollTopChanged = (delta) => {
            item.top -= delta;
            anchor.top -= delta;
        };

        vi.stubGlobal('HTMLElement', FakeHTMLElement);
        vi.stubGlobal('document', { getElementById: () => root });
        vi.stubGlobal('window', {
            getComputedStyle: () => ({ overflowX: 'hidden', overflowY: 'auto' }),
        });

        const { legendListRenderer } = await import('./legendListRenderer');
        const Renderer = legendListRenderer.Component;
        const render = (data: Array<{ id: string }>) => (
            <Renderer
                webDomObservation={mountedWebDomObservation}
                data={data}
                dataKey="session-test"
                keyExtractor={(entry: { id: string }) => entry.id}
                renderItem={({ item: entry }: { item: { id: string } }) => React.createElement('Row', { id: entry.id })}
                frame={resolveMainTranscriptListShellFrame({
                    nativeID: 'legend-main-native-id',
                    platformOS: 'web',
                })}
            />
        );
        await renderScreen(render([{ id: 'newest' }, { id: 'oldest' }]));

        // Detached baseline at scrollTop=500 with the anchor captured at top=135.
        root.scrollTop = 500;
        item.top = 135;
        anchor.top = 135;
        capturedLegendListProps.onWheel({ deltaY: -300 });
        capturedLegendListProps.onScroll({ nativeEvent: { contentOffset: { x: 0, y: 500 } } });
        capturedLegendListProps.onStartReached();
        act(() => animationFrames.splice(0).forEach((callback) => callback(12)));
        expect(root.scrollTop).toBe(500);
        // Input quiets before the incoherent pre-commit frame (S-D margin).
        nowMs += 300;

        // Incoherent pre-commit frame: the anchor reads 5000px above its baseline while the
        // compensated scroll has not been followed by the DOM commit. One read must not write.
        item.top = 135 - 5_000;
        anchor.top = 135 - 5_000;
        capturedLegendListProps.onLoad({});
        expect(root.scrollTop).toBe(500);

        // Geometry becomes coherent again on the next frame: still no write required.
        item.top = 135;
        anchor.top = 135;
        act(() => animationFrames.splice(0).forEach((callback) => callback(16)));
        expect(root.scrollTop).toBe(500);
        expect(anchor.top).toBe(135);

        // A genuine persistent viewport-exceeding residual is confirmed by the second read and
        // still lands.
        item.top = 135 + 800;
        anchor.top = 135 + 800;
        capturedLegendListProps.onItemSizeChanged({ index: 0, previous: 240, size: 1_040 });
        act(() => animationFrames.splice(0).forEach((callback) => callback(32)));
        act(() => animationFrames.splice(0).forEach((callback) => callback(48)));
        expect(root.scrollTop).toBe(1_300);
        expect(anchor.top).toBe(135);
    });

    it('suppresses held-target residual writes while the user is actively wheel-scrolling and resumes after quiet', async () => {
        // Live S-D vibration attribution (2026-07-11): every scored scroll reversal traced to
        // verifyLanding writing against active wheel input — the scroll-handler re-armed anchor
        // hold "corrected" estimate churn 24-96px against each wheel tick, and the settle-window
        // reassert fought four consecutive 240px wheel deltas back to the same target. User-scroll
        // windows must fully suppress correction writes (not just cancel the hold); the bounded
        // window stays open and the correction resumes after input quiets.
        let nowMs = 1_000;
        vi.spyOn(Date, 'now').mockImplementation(() => nowMs);
        const animationFrames: FrameRequestCallback[] = [];
        vi.stubGlobal('requestAnimationFrame', vi.fn((callback: FrameRequestCallback) => {
            animationFrames.push(callback);
            return animationFrames.length;
        }));
        vi.stubGlobal('cancelAnimationFrame', vi.fn());

        class FakeHTMLElement {
            public clientHeight = 600;
            public height = 100;
            public isConnected = true;
            public parentElement: FakeHTMLElement | null = null;
            public scrollHeight = 10_000;
            private currentScrollTop = 0;
            public onScrollTopChanged: ((delta: number) => void) | null = null;
            public get scrollTop() { return this.currentScrollTop; }
            public set scrollTop(value: number) {
                const delta = value - this.currentScrollTop;
                this.currentScrollTop = value;
                this.onScrollTopChanged?.(delta);
            }
            public testId: string | null = null;
            public top = 0;
            public contains = () => true;
            public getAttribute = (name: string) => name === 'data-testid' ? this.testId : null;
            public getBoundingClientRect = () => ({
                bottom: this.top + this.height,
                height: this.height,
                left: 0,
                right: 800,
                top: this.top,
                width: 800,
                x: 0,
                y: this.top,
                toJSON: () => ({}),
            });
            public querySelector = (selector: string) => selector.includes('message-m1') ? anchor : selector.includes('item-oldest') ? item : null;
            public querySelectorAll = () => [item, anchor];
        }
        const root = new FakeHTMLElement();
        root.height = 600;
        const item = new FakeHTMLElement();
        item.testId = 'transcript-item-oldest';
        item.top = 135;
        item.clientHeight = 100;
        item.scrollHeight = 100;
        item.parentElement = root;
        const anchor = new FakeHTMLElement();
        anchor.testId = 'transcript-anchor-message-m1';
        anchor.top = 135;
        anchor.clientHeight = 100;
        anchor.scrollHeight = 100;
        anchor.parentElement = item;
        root.onScrollTopChanged = (delta) => {
            item.top -= delta;
            anchor.top -= delta;
        };

        vi.stubGlobal('HTMLElement', FakeHTMLElement);
        vi.stubGlobal('document', { getElementById: () => root });
        vi.stubGlobal('window', {
            getComputedStyle: () => ({ overflowX: 'hidden', overflowY: 'auto' }),
        });

        const { legendListRenderer } = await import('./legendListRenderer');
        const Renderer = legendListRenderer.Component;
        await renderScreen(
            <Renderer
                webDomObservation={mountedWebDomObservation}
                data={[{ id: 'newest' }, { id: 'oldest' }]}
                dataKey="session-test"
                keyExtractor={(entry: { id: string }) => entry.id}
                renderItem={({ item: entry }: { item: { id: string } }) => React.createElement('Row', { id: entry.id })}
                frame={resolveMainTranscriptListShellFrame({
                    nativeID: 'legend-main-native-id',
                    platformOS: 'web',
                })}
            />,
        );
        root.scrollTop = 0;
        item.top = 135;
        anchor.top = 135;

        // User wheels at the top edge; the scroll handler re-arms the visible-anchor hold.
        capturedLegendListProps.onWheel({ deltaY: -300 });
        capturedLegendListProps.onScroll({ nativeEvent: { contentOffset: { x: 0, y: 0 } } });
        capturedLegendListProps.onStartReached();
        act(() => animationFrames.splice(0).forEach((callback) => callback(12)));
        expect(root.scrollTop).toBe(0);

        // 40ms later — the user's wheel evidence is still inside the live input margin —
        // estimate churn displaces the anchor and emits a cause-less scroll plus a measurement
        // signal. The held transaction must NOT write against the live user input window.
        nowMs = 1_040;
        root.scrollTop = 61;
        capturedLegendListProps.onScroll({ nativeEvent: { contentOffset: { x: 0, y: 61 } } });
        capturedLegendListProps.onItemSizeChanged({ index: 0, previous: 240, size: 301 });
        act(() => animationFrames.splice(0).forEach((callback) => callback(16)));
        expect(root.scrollTop).toBe(61);

        // Input quiets; the SAME transaction resumes from the next measurement signal and
        // corrects the churn displacement back to the captured baseline.
        nowMs = 1_400;
        capturedLegendListProps.onScroll({ nativeEvent: { contentOffset: { x: 0, y: 61 } } });
        capturedLegendListProps.onItemSizeChanged({ index: 0, previous: 301, size: 362 });
        act(() => animationFrames.splice(0).forEach((callback) => callback(32)));
        expect(root.scrollTop).toBe(0);
        expect(anchor.top).toBe(135);
    });

    it('suppresses native held-end corrections during user fling momentum and resumes after it ends', async () => {
        // Native leg of S-D: a command-armed hold must not fight decaying user momentum. The
        // command's own write lands, but verifyLanding's residual corrections wait until the
        // user's drag/momentum window is over, then land from settled geometry.
        setPlatformOS('ios');
        let nowMs = 900;
        vi.spyOn(Date, 'now').mockImplementation(() => nowMs);
        const animationFrames = installAnimationFrameQueue();
        const { legendListRenderer } = await import('./legendListRenderer');
        const Renderer = legendListRenderer.Component;
        const listRef = React.createRef<TranscriptListShellRef<{ id: string }>>();

        legendStateOverride = {
            contentLength: 5_000,
            end: 4,
            isAtEnd: false,
            isNearEnd: false,
            isWithinMaintainScrollAtEndThreshold: false,
            scroll: 440,
            scrollLength: 600,
            start: 1,
        };
        await renderScreen(
            <Renderer
                webDomObservation={mountedWebDomObservation}
                ref={listRef}
                data={Array.from({ length: 5 }, (_value, index) => ({ id: `row-${index}` }))}
                dataKey="session-test"
                keyExtractor={(item: { id: string }) => item.id}
                renderItem={({ item }: { item: { id: string } }) => React.createElement('Row', { id: item.id })}
                frame={resolveMainTranscriptListShellFrame({
                    legendInitialScrollAtEnd: false,
                    nativeID: 'legend-main-native-id',
                    platformOS: 'ios',
                })}
            />,
        );

        // User fling: drag begins/ends, momentum keeps scrolling with no further touch evidence.
        capturedLegendListProps.onScrollBeginDrag({ nativeEvent: { contentOffset: { x: 0, y: 440 } } });
        nowMs = 950;
        capturedLegendListProps.onScrollEndDrag({ nativeEvent: { contentOffset: { x: 0, y: 700 } } });
        nowMs = 960;
        capturedLegendListProps.onMomentumScrollBegin({ nativeEvent: { contentOffset: { x: 0, y: 760 } } });

        // Mid-momentum the user taps jump-to-bottom: the semantic command write itself lands.
        nowMs = 1_000;
        getShellRef(listRef).scrollToEnd?.({ animated: false });
        expect(assignedLegendRef.scrollToEnd).toHaveBeenCalledTimes(1);
        assignedLegendRef.scrollToOffset.mockClear();

        // Late growth reports a measured residual while momentum is still decaying: the
        // correction must NOT write against the live momentum.
        nowMs = 1_020;
        legendStateOverride = {
            ...legendStateOverride,
            contentLength: 6_000,
            isAtEnd: false,
            isNearEnd: false,
            isWithinMaintainScrollAtEndThreshold: false,
            scroll: 4_400,
        };
        capturedLegendListProps.onItemSizeChanged({ index: 4, previous: 240, size: 1_240 });
        expect(assignedLegendRef.scrollToOffset).not.toHaveBeenCalled();

        // Momentum ends; after the input margin the same held-end transaction resumes and
        // lands the measured tail residual.
        nowMs = 1_400;
        capturedLegendListProps.onMomentumScrollEnd({ nativeEvent: { contentOffset: { x: 0, y: 4_400 } } });
        nowMs = 1_700;
        capturedLegendListProps.onItemSizeChanged({ index: 4, previous: 1_240, size: 1_240 });
        act(() => animationFrames.shift()?.(nowMs));
        expect(assignedLegendRef.scrollToOffset).toHaveBeenCalledWith({
            animated: false,
            offset: 5_400,
        });
    });

    it('treats a clamp-boundary target with the viewport beyond it as settled by the platform spring', async () => {
        // S-D boundary escalation (2026-07-11): overscrolling past the bottom rubber-bands
        // back "in a very vibrating way" — the held-end corrector wrote scroll-up corrections
        // against the overscrolled position, re-launching the spring each frame. A target
        // already ON the physical clamp with the viewport beyond it settles by itself.
        setPlatformOS('ios');
        let nowMs = 1_000;
        vi.spyOn(Date, 'now').mockImplementation(() => nowMs);
        const animationFrames = installAnimationFrameQueue();
        const { legendListRenderer } = await import('./legendListRenderer');
        const Renderer = legendListRenderer.Component;
        const listRef = React.createRef<TranscriptListShellRef<{ id: string }>>();

        legendStateOverride = {
            contentLength: 5_000,
            end: 4,
            isAtEnd: true,
            isNearEnd: true,
            isWithinMaintainScrollAtEndThreshold: true,
            scroll: 4_400,
            scrollLength: 600,
            start: 1,
        };
        await renderScreen(
            <Renderer
                webDomObservation={mountedWebDomObservation}
                ref={listRef}
                data={Array.from({ length: 5 }, (_value, index) => ({ id: `row-${index}` }))}
                dataKey="session-test"
                keyExtractor={(item: { id: string }) => item.id}
                renderItem={({ item }: { item: { id: string } }) => React.createElement('Row', { id: item.id })}
                frame={resolveMainTranscriptListShellFrame({
                    legendInitialScrollAtEnd: false,
                    nativeID: 'legend-main-native-id',
                    platformOS: 'ios',
                })}
            />,
        );

        getShellRef(listRef).scrollToEnd?.({ animated: false });
        assignedLegendRef.scrollToOffset.mockClear();

        // Rubber-band overscroll past the bottom: current scroll sits BEYOND the clamp the
        // held-end target is on. No quiet-margin input evidence — this isolates the clamp
        // rule. The corrector must not write against the spring.
        nowMs = 2_000;
        legendStateOverride = {
            ...legendStateOverride,
            scroll: 4_460,
        };
        capturedLegendListProps.onItemSizeChanged({ index: 4, previous: 240, size: 240 });
        act(() => animationFrames.shift()?.(nowMs));
        expect(assignedLegendRef.scrollToOffset).not.toHaveBeenCalled();

        // A genuine undershoot below the clamp still corrects normally.
        nowMs = 3_000;
        legendStateOverride = {
            ...legendStateOverride,
            contentLength: 6_000,
            isAtEnd: false,
            isNearEnd: false,
            isWithinMaintainScrollAtEndThreshold: false,
            scroll: 4_400,
        };
        capturedLegendListProps.onItemSizeChanged({ index: 4, previous: 240, size: 1_240 });
        act(() => animationFrames.shift()?.(nowMs));
        expect(assignedLegendRef.scrollToOffset).toHaveBeenCalledWith({
            animated: false,
            offset: 5_400,
        });
    });

    it('holds a driver-restored web entry anchor through post-restore remeasurement', async () => {
        // USER-REALITY-DIVERGENCE symptom 4 residual: the entry restore write lands the anchor
        // exactly (status 'restored'), then Legend remeasures estimated rows above it seconds
        // later and the anchor drifts thousands of px with no owner correcting it. The driver
        // arms this renderer-owned hold after a successful anchor restore; item-size/commit
        // signals re-align the anchor to its restored offset until the bounded hold expires or
        // the user scrolls.
        let nowMs = 1_000;
        vi.spyOn(Date, 'now').mockImplementation(() => nowMs);
        const animationFrames: FrameRequestCallback[] = [];
        vi.stubGlobal('requestAnimationFrame', vi.fn((callback: FrameRequestCallback) => {
            animationFrames.push(callback);
            return animationFrames.length;
        }));
        const cancelAnimationFrame = vi.fn();
        vi.stubGlobal('cancelAnimationFrame', cancelAnimationFrame);

        class FakeHTMLElement {
            public clientHeight = 600;
            public height = 100;
            public isConnected = true;
            public parentElement: FakeHTMLElement | null = null;
            public scrollHeight = 20_000;
            private currentScrollTop = 0;
            public onScrollTopChanged: ((delta: number) => void) | null = null;
            public get scrollTop() { return this.currentScrollTop; }
            public set scrollTop(value: number) {
                const delta = value - this.currentScrollTop;
                this.currentScrollTop = value;
                this.onScrollTopChanged?.(delta);
            }
            public testId: string | null = null;
            public top = 0;
            public contains = () => true;
            public getAttribute = (name: string) => name === 'data-testid' ? this.testId : null;
            public getBoundingClientRect = () => ({
                bottom: this.top + this.height,
                height: this.height,
                left: 0,
                right: 800,
                top: this.top,
                width: 800,
                x: 0,
                y: this.top,
                toJSON: () => ({}),
            });
            public querySelector = (selector: string) => selector.includes('transcript-item-target') ? anchorRow : null;
            public querySelectorAll = () => [anchorRow];
        }
        const root = new FakeHTMLElement();
        root.height = 600;
        const anchorRow = new FakeHTMLElement();
        anchorRow.testId = 'transcript-item-target';
        anchorRow.top = -598;
        anchorRow.height = 742;
        anchorRow.clientHeight = 742;
        anchorRow.scrollHeight = 742;
        anchorRow.parentElement = root;
        root.onScrollTopChanged = (delta) => {
            anchorRow.top -= delta;
        };

        vi.stubGlobal('HTMLElement', FakeHTMLElement);
        vi.stubGlobal('document', { getElementById: () => root });
        vi.stubGlobal('window', {
            getComputedStyle: () => ({ overflowX: 'hidden', overflowY: 'auto' }),
        });

        const { legendListRenderer } = await import('./legendListRenderer');
        const Renderer = legendListRenderer.Component;
        const listRef = React.createRef<TranscriptListShellRef<{ id: string }>>();
        const screen = await renderScreen(
            <Renderer
                webDomObservation={mountedWebDomObservation}
                ref={listRef}
                data={[{ id: 'target' }]}
                dataKey="session-test"
                keyExtractor={(item: { id: string }) => item.id}
                renderItem={({ item }: { item: { id: string } }) => React.createElement('Row', { id: item.id })}
                frame={resolveMainTranscriptListShellFrame({
                    legendInitialScrollAtEnd: false,
                    nativeID: 'legend-main-native-id',
                    platformOS: 'web',
                })}
            />,
        );

        // Driver reports a successful anchor restore at itemOffsetPx -598.
        getShellRef(listRef).holdWebEntryAnchor?.({
            itemId: 'target',
            itemOffsetPx: -598,
            kind: 'message',
            messageId: null,
        });
        // Drain the initial aligned verification frames (anchor still at -598 -> no writes).
        act(() => animationFrames.splice(0).forEach((callback) => callback(1)));
        act(() => animationFrames.splice(0).forEach((callback) => callback(2)));
        act(() => animationFrames.splice(0).forEach((callback) => callback(3)));
        expect(root.scrollTop).toBe(0);

        // Rows above the anchor remeasure much taller: the anchor is pushed 8_315px down.
        anchorRow.top = 7_717;
        capturedLegendListProps.onItemSizeChanged({ index: 0, previous: 240, size: 8_555 });
        expect(animationFrames.length).toBeGreaterThan(0);
        act(() => animationFrames.splice(0).forEach((callback) => callback(16)));
        act(() => animationFrames.splice(0).forEach((callback) => callback(24)));

        // scrollTop grew by the residual (7717 - (-598)); the anchor is back at -598.
        expect(root.scrollTop).toBe(8_315);
        expect(anchorRow.top).toBe(-598);
        expect(mountedWebDomObservation.getState()).toMatchObject({
            observedScrollHeight: 20_000,
            observedScrollTop: 8_315,
        });
        const trustedEcho = mountedWebDomObservation.observeGenuineScrollMovement({
            distanceFromBottom: 20_000 - 600 - 8_315,
            fallbackObservedScrollTop: 8_315,
            isTrusted: true,
            metrics: {
                clientHeight: root.clientHeight,
                element: root as unknown as HTMLElement,
                scrollHeight: root.scrollHeight,
                scrollTop: root.scrollTop,
            },
            pinThresholdPx: 72,
            sustainFrames: 2,
        });
        expect(trustedEcho.isGenuineUserMovement).toBe(false);
        expect(trustedEcho.movedSinceLastObservation).toBe(false);

        // A delayed measurement seconds later is still repaired by the same bounded hold.
        nowMs += 4_000;
        anchorRow.top = -543;
        capturedLegendListProps.onItemSizeChanged({ index: 0, previous: 8_555, size: 8_610 });
        act(() => animationFrames.splice(0).forEach((callback) => callback(32)));
        expect(anchorRow.top).toBe(-598);

        // A keyed index command replaces the anchor variant in the ONE held-target
        // transaction. Later anchor geometry may not keep writing beside the new target.
        getShellRef(listRef).scrollToIndex({ index: 0, animated: false });
        anchorRow.top = -500;
        capturedLegendListProps.onItemSizeChanged({ index: 0, previous: 8_610, size: 8_700 });
        act(() => animationFrames.splice(0).forEach((callback) => callback(40)));
        expect(anchorRow.top).toBe(-500);

        // Re-arm an aligned anchor, then prove genuine wheel input cancels it.
        getShellRef(listRef).holdWebEntryAnchor?.({
            itemId: 'target',
            itemOffsetPx: -500,
            kind: 'message',
            messageId: null,
        });
        act(() => animationFrames.splice(0).forEach((callback) => callback(44)));

        // A genuine wheel cancels the hold: later remeasurement no longer re-aligns.
        capturedLegendListProps.onWheel({ deltaY: -300 });
        anchorRow.top = -100;
        capturedLegendListProps.onItemSizeChanged({ index: 0, previous: 8_610, size: 9_000 });
        act(() => animationFrames.splice(0).forEach((callback) => callback(48)));
        expect(anchorRow.top).toBe(-100);

        // Unmount owns the same scheduler cleanup as end/index. A pending anchor frame must
        // be cancelled rather than writing into a dead session after late measurement.
        getShellRef(listRef).holdWebEntryAnchor?.({
            itemId: 'target',
            itemOffsetPx: -100,
            kind: 'message',
            messageId: null,
        });
        anchorRow.top = -80;
        capturedLegendListProps.onItemSizeChanged({ index: 0, previous: 9_000, size: 9_020 });
        cancelAnimationFrame.mockClear();
        await screen.unmount();
        expect(cancelAnimationFrame).toHaveBeenCalled();
    });

    it('keeps interleaved new input pending while a held-anchor correction echo remains non-user', async () => {
        vi.spyOn(Date, 'now').mockImplementation(() => 1_000);
        const animationFrames: FrameRequestCallback[] = [];
        vi.stubGlobal('requestAnimationFrame', vi.fn((callback: FrameRequestCallback) => {
            animationFrames.push(callback);
            return animationFrames.length;
        }));
        vi.stubGlobal('cancelAnimationFrame', vi.fn());

        class FakeHTMLElement {
            public clientHeight = 600;
            public height = 100;
            public isConnected = true;
            public parentElement: FakeHTMLElement | null = null;
            public scrollHeight = 20_000;
            private currentScrollTop = 500;
            public onScrollTopChanged: ((delta: number) => void) | null = null;
            public get scrollTop() { return this.currentScrollTop; }
            public set scrollTop(value: number) {
                const landed = Math.max(0, Math.min(value, this.scrollHeight - this.clientHeight));
                const delta = landed - this.currentScrollTop;
                this.currentScrollTop = landed;
                this.onScrollTopChanged?.(delta);
            }
            public testId: string | null = null;
            public top = 0;
            public contains = () => true;
            public getAttribute = (name: string) => name === 'data-testid' ? this.testId : null;
            public getBoundingClientRect = () => ({
                bottom: this.top + this.height,
                height: this.height,
                left: 0,
                right: 800,
                top: this.top,
                width: 800,
                x: 0,
                y: this.top,
                toJSON: () => ({}),
            });
            public querySelector = (selector: string) => selector.includes('transcript-item-target') ? anchorRow : null;
            public querySelectorAll = () => [anchorRow];
        }
        const root = new FakeHTMLElement();
        root.height = 600;
        const anchorRow = new FakeHTMLElement();
        anchorRow.testId = 'transcript-item-target';
        anchorRow.top = -598;
        anchorRow.height = 742;
        anchorRow.clientHeight = 742;
        anchorRow.scrollHeight = 742;
        anchorRow.parentElement = root;
        root.onScrollTopChanged = (delta) => {
            anchorRow.top -= delta;
        };

        vi.stubGlobal('HTMLElement', FakeHTMLElement);
        vi.stubGlobal('document', { getElementById: () => root });
        vi.stubGlobal('window', {
            getComputedStyle: () => ({ overflowX: 'hidden', overflowY: 'auto' }),
        });

        const webDomObservation = createWebDomScrollObservation();
        mountedWebDomObservation = webDomObservation;
        webDomObservation.observeGenuineScrollMovement({
            distanceFromBottom: 18_900,
            fallbackObservedScrollTop: null,
            isTrusted: false,
            metrics: {
                clientHeight: root.clientHeight,
                element: root as unknown as HTMLElement,
                scrollHeight: root.scrollHeight,
                scrollTop: root.scrollTop,
            },
            pinThresholdPx: 72,
            sustainFrames: 2,
        });

        const { legendListRenderer } = await import('./legendListRenderer');
        const Renderer = legendListRenderer.Component;
        const listRef = React.createRef<TranscriptListShellRef<{ id: string }>>();
        const webMovementFacts: WebScrollMovementFact[] = [];
        await renderScreen(
            <Renderer
                webDomObservation={mountedWebDomObservation}
                ref={listRef}
                data={[{ id: 'target' }]}
                dataKey="observed-held-correction"
                keyExtractor={(item: { id: string }) => item.id}
                renderItem={({ item }: { item: { id: string } }) => React.createElement('Row', { id: item.id })}
                frame={resolveMainTranscriptListShellFrame({
                    legendInitialScrollAtEnd: false,
                    nativeID: 'legend-main-native-id',
                    platformOS: 'web',
                })}
                onScroll={(_event, webMovementFact) => {
                    if (webMovementFact) webMovementFacts.push(webMovementFact);
                }}
            />,
        );

        // Establish the renderer's former duplicate offset baseline before the correction.
        capturedLegendListProps.onScroll({
            nativeEvent: {
                contentOffset: { x: 0, y: root.scrollTop },
                isTrusted: false,
            },
        });
        getShellRef(listRef).holdWebEntryAnchor?.({
            itemId: 'target',
            itemOffsetPx: -598,
            kind: 'message',
            messageId: null,
        });
        act(() => animationFrames.splice(0).forEach((callback) => callback(1)));

        // Stable-height remeasurement moves the held row upward. The renderer corrects
        // scrollTop 500 -> 300; the mounted observation must see the landed write before
        // Chromium's trusted scroll echo reaches the outer ingress classifier.
        anchorRow.top = -798;
        capturedLegendListProps.onItemSizeChanged({ index: 0, previous: 742, size: 742 });
        act(() => animationFrames.splice(0).forEach((callback) => callback(16)));
        expect(root.scrollTop).toBe(300);
        expect(webDomObservation.getState().observedScrollTop).toBe(300);

        // Fresh trusted input arrives before Chromium dispatches the write echo. The echo
        // cannot borrow that evidence, and consuming the echo must not consume the evidence
        // needed by the user's later physical movement.
        capturedLegendListProps.onWheel({ deltaY: -120 });
        capturedLegendListProps.onScroll({
            nativeEvent: {
                contentOffset: { x: 0, y: root.scrollTop },
                isTrusted: true,
            },
        });
        const preemptEntryRestore = vi.fn();
        const persistDetachedViewport = vi.fn();
        const echo = webMovementFacts.at(-1);
        if (echo?.isGenuineUserMovement) {
            preemptEntryRestore();
            persistDetachedViewport();
        }

        expect(echo).toMatchObject({
            atEndPublicationCause: 'layout',
            direction: null,
            isGenuineUserMovement: false,
            movedSinceLastObservation: false,
            upwardIntent: false,
        });
        expect(preemptEntryRestore).not.toHaveBeenCalled();
        expect(persistDetachedViewport).not.toHaveBeenCalled();
        expect(getShellRef(listRef).hasLiveWebHold?.({ kind: 'item', itemId: 'target' })).toBe(true);

        root.scrollTop = 200;
        capturedLegendListProps.onScroll({
            nativeEvent: {
                contentOffset: { x: 0, y: root.scrollTop },
                isTrusted: true,
            },
        });
        expect(webMovementFacts.at(-1)).toMatchObject({
            atEndPublicationCause: 'user',
            direction: -1,
            isGenuineUserMovement: true,
            movedSinceLastObservation: true,
            upwardIntent: true,
        });
    });

    it('replaces a keyed hold through a Legend bottom command so the old anchor stops fighting it', async () => {
        // Live JTB RED (2026-07-11, post re-arm-guard): the webDom driver's pin-bottom write
        // bypassed the renderer, so the still-live keyed anchor hold treated the jump landing
        // as an external rollback and re-corrected the viewport back to the detach anchor.
        // Command writes must take ownership: the driver latches held-'end' via the shell ref.
        vi.spyOn(Date, 'now').mockImplementation(() => 1_000);
        const animationFrames: FrameRequestCallback[] = [];
        vi.stubGlobal('requestAnimationFrame', vi.fn((callback: FrameRequestCallback) => {
            animationFrames.push(callback);
            return animationFrames.length;
        }));
        vi.stubGlobal('cancelAnimationFrame', vi.fn());

        class FakeHTMLElement {
            public clientHeight = 600;
            public height = 100;
            public isConnected = true;
            public parentElement: FakeHTMLElement | null = null;
            public scrollHeight = 10_000;
            private currentScrollTop = 0;
            public onScrollTopChanged: ((delta: number) => void) | null = null;
            public get scrollTop() { return this.currentScrollTop; }
            public set scrollTop(value: number) {
                const delta = value - this.currentScrollTop;
                this.currentScrollTop = Math.max(0, Math.min(value, this.scrollHeight - this.clientHeight));
                this.onScrollTopChanged?.(delta);
            }
            public testId: string | null = null;
            public top = 0;
            public contains = () => true;
            public getAttribute = (name: string) => name === 'data-testid' ? this.testId : null;
            public getBoundingClientRect = () => ({
                bottom: this.top + this.height,
                height: this.height,
                left: 0,
                right: 800,
                top: this.top,
                width: 800,
                x: 0,
                y: this.top,
                toJSON: () => ({}),
            });
            public querySelector = (selector: string) => selector.includes('item-oldest') ? item : null;
            public querySelectorAll = () => [item];
        }
        const root = new FakeHTMLElement();
        root.height = 600;
        const item = new FakeHTMLElement();
        item.testId = 'transcript-item-oldest';
        item.top = 135;
        item.clientHeight = 100;
        item.scrollHeight = 100;
        item.parentElement = root;
        root.onScrollTopChanged = (delta) => {
            item.top -= delta;
        };

        vi.stubGlobal('HTMLElement', FakeHTMLElement);
        vi.stubGlobal('document', { getElementById: () => root });
        vi.stubGlobal('window', {
            getComputedStyle: () => ({ overflowX: 'hidden', overflowY: 'auto' }),
        });

        const { legendListRenderer } = await import('./legendListRenderer');
        const Renderer = legendListRenderer.Component;
        const listRef = React.createRef<TranscriptListShellRef<{ id: string }>>();
        await renderScreen(
            <Renderer
                webDomObservation={mountedWebDomObservation}
                ref={listRef}
                data={[{ id: 'oldest' }, { id: 'newest' }]}
                dataKey="session-test"
                keyExtractor={(item2: { id: string }) => item2.id}
                renderItem={({ item: entry }: { item: { id: string } }) => React.createElement('Row', { id: entry.id })}
                frame={resolveMainTranscriptListShellFrame({
                    legendInitialScrollAtEnd: false,
                    nativeID: 'legend-main-native-id',
                    platformOS: 'web',
                })}
            />,
        );

        // Live keyed anchor hold at the detach position.
        getShellRef(listRef).holdWebEntryAnchor?.({
            itemId: 'oldest',
            itemOffsetPx: 135,
            kind: 'message',
            messageId: null,
        });
        act(() => animationFrames.splice(0).forEach((callback) => callback(8)));
        expect(root.scrollTop).toBe(0);

        // The bottom command replaces the keyed hold and lands through Legend.
        root.scrollTop = 9_400;
        getShellRef(listRef).scrollToEnd?.({ animated: false });
        expect(assignedLegendRef.scrollToEnd).toHaveBeenCalledWith({ animated: false });
        const maintainScrollAtEnd = capturedLegendListProps.maintainScrollAtEnd as {
            animated: boolean;
            isMaintainingScrollAtEnd: () => boolean;
        };
        expect(maintainScrollAtEnd.animated).toBe(false);
        expect(maintainScrollAtEnd.isMaintainingScrollAtEnd()).toBe(true);
        act(() => animationFrames.splice(0).forEach((callback) => callback(16)));

        // A later measurement signal must keep enforcing END, not resurrect the old anchor.
        capturedLegendListProps.onItemSizeChanged({ index: 0, previous: 240, size: 260 });
        act(() => animationFrames.splice(0).forEach((callback) => callback(24)));
        expect(root.scrollTop).toBe(9_400);
    });

    it('tracks an unmounted held anchor through renderer-data positions until the DOM can confirm', async () => {
        // Live A->B->A RED (2026-07-11): the entry restore landed against ~25938px of
        // estimates; giant-row measurements collapsed the content ~5x in one commit, the
        // browser clamped scrollTop, the restored row left the mounted window, and the
        // DOM-only anchor landing returned not_found forever — the hold went impotent and
        // the session settled near the tail instead of the restored row. While the anchor
        // element is unmounted, the landing must degrade to the renderer-data index position
        // so the hold keeps steering the viewport back toward the identity.
        vi.spyOn(Date, 'now').mockImplementation(() => 1_000);
        const animationFrames: FrameRequestCallback[] = [];
        vi.stubGlobal('requestAnimationFrame', vi.fn((callback: FrameRequestCallback) => {
            animationFrames.push(callback);
            return animationFrames.length;
        }));
        vi.stubGlobal('cancelAnimationFrame', vi.fn());

        let anchorMounted = false;
        class FakeHTMLElement {
            public clientHeight = 600;
            public height = 600;
            public isConnected = true;
            public parentElement: FakeHTMLElement | null = null;
            public scrollHeight = 20_000;
            private currentScrollTop = 0;
            public get scrollTop() { return this.currentScrollTop; }
            public set scrollTop(value: number) {
                const landed = Math.max(0, Math.min(value, this.scrollHeight - this.clientHeight));
                if (anchorMounted) {
                    anchorRow.top -= landed - this.currentScrollTop;
                }
                this.currentScrollTop = landed;
            }
            public testId: string | null = null;
            public top = 0;
            public contains = () => true;
            public getAttribute = (name: string) => name === 'data-testid' ? this.testId : null;
            public getBoundingClientRect = () => ({
                bottom: this.top + this.height,
                height: this.height,
                left: 0,
                right: 800,
                top: this.top,
                width: 800,
                x: 0,
                y: this.top,
                toJSON: () => ({}),
            });
            public querySelector = () => anchorMounted ? anchorRow : null;
            public querySelectorAll = () => anchorMounted ? [anchorRow] : [];
        }
        const root = new FakeHTMLElement();
        const anchorRow = new FakeHTMLElement();
        anchorRow.height = 240;
        anchorRow.testId = 'transcript-anchor-message-target';

        vi.stubGlobal('HTMLElement', FakeHTMLElement);
        vi.stubGlobal('document', { getElementById: () => root });
        vi.stubGlobal('window', {
            getComputedStyle: () => ({ overflowX: 'hidden', overflowY: 'auto' }),
        });

        let anchorPosition = 900;
        legendStateOverride = {
            positionAtIndex: (index: number) => (index === 0 ? anchorPosition : undefined),
            sizeAtIndex: () => 240,
        };

        const { legendListRenderer } = await import('./legendListRenderer');
        const Renderer = legendListRenderer.Component;
        const listRef = React.createRef<TranscriptListShellRef<{ id: string }>>();
        await renderScreen(
            <Renderer
                webDomObservation={mountedWebDomObservation}
                ref={listRef}
                data={[{ id: 'target' }, { id: 'other' }]}
                dataKey="session-test"
                keyExtractor={(item: { id: string }) => item.id}
                renderItem={({ item }: { item: { id: string } }) => React.createElement('Row', { id: item.id })}
                frame={resolveMainTranscriptListShellFrame({
                    legendInitialScrollAtEnd: false,
                    nativeID: 'legend-main-native-id',
                    platformOS: 'web',
                })}
            />,
        );

        root.scrollTop = 500;
        getShellRef(listRef).holdWebEntryAnchor?.({
            itemId: 'target',
            itemOffsetPx: 100,
            kind: 'message',
            messageId: null,
        });
        capturedLegendListProps.onItemSizeChanged({ index: 0, previous: 240, size: 500 });
        act(() => animationFrames.splice(0).forEach((callback) => callback(16)));

        // target = positionAtIndex(0) - itemOffsetPx = 900 - 100 = 800.
        expect(root.scrollTop).toBe(800);

        // Later estimate corrections move the identity; the same hold keeps tracking it.
        anchorPosition = 1_300;
        capturedLegendListProps.onItemSizeChanged({ index: 0, previous: 500, size: 700 });
        act(() => animationFrames.splice(0).forEach((callback) => callback(32)));
        expect(root.scrollTop).toBe(1_200);

        // Estimate positions are NOT confirmation-grade: a viewport-exceeding estimate residual
        // must never be written (live DR-030 cascade RED 2026-07-11: mid-cascade estimates
        // parked the viewport ~12k px away from the user's content and the hold went dormant
        // believing it was aligned). The hold keeps polling; when the DOM can finally measure
        // the anchor, the real correction lands.
        anchorPosition = 14_000; // garbage mid-cascade estimate: raw residual >> viewport
        capturedLegendListProps.onItemSizeChanged({ index: 0, previous: 700, size: 900 });
        act(() => animationFrames.splice(0).forEach((callback) => callback(48)));
        act(() => animationFrames.splice(0).forEach((callback) => callback(64)));
        expect(root.scrollTop).toBe(1_200);
        expect(assignedLegendRef.scrollToIndex).toHaveBeenCalledTimes(1);
        expect(assignedLegendRef.scrollToIndex).toHaveBeenCalledWith({
            animated: false,
            index: 0,
            viewPosition: 0,
        });

        // Materialization is one-shot for this held identity. Once the row mounts, the same
        // transaction switches back to DOM truth and restores the exact within-row offset.
        act(() => animationFrames.splice(0).forEach((callback) => callback(80)));
        expect(assignedLegendRef.scrollToIndex).toHaveBeenCalledTimes(1);
        anchorMounted = true;
        anchorRow.top = 400;
        capturedLegendListProps.onItemSizeChanged({ index: 0, previous: 900, size: 920 });
        act(() => animationFrames.splice(0).forEach((callback) => callback(96)));
        expect(root.scrollTop).toBe(1_500);
        expect(anchorRow.top).toBe(100);
    });

    it('never cancels a Legend geometry compensation with a keyed correction read across the seam', async () => {
        // Live RED (2026-07-30, session cms4aenky5lnktm72sfmya6uk, cold SPA entry with a
        // persisted detached anchor + reading-pace scrolling): Legend's MVCP compensation for a
        // pagination prepend was exact, and this writer cancelled it ~1ms later from a read
        // taken while the compensated offset was already applied but the row geometry commit
        // was not — measured as `scrollTop 31046 -> 30703` against `scrollAdjustBy(+343)`, and
        // as a single `-31,015px` undo of a prepend compensation. A correction must only be
        // spent on geometry that is no longer in motion.
        let nowMs = 1_000;
        vi.spyOn(Date, 'now').mockImplementation(() => nowMs);
        const animationFrames: FrameRequestCallback[] = [];
        vi.stubGlobal('requestAnimationFrame', vi.fn((callback: FrameRequestCallback) => {
            animationFrames.push(callback);
            return animationFrames.length;
        }));
        vi.stubGlobal('cancelAnimationFrame', vi.fn());

        class FakeHTMLElement {
            public clientHeight = 600;
            public height = 240;
            public isConnected = true;
            public parentElement: FakeHTMLElement | null = null;
            public scrollHeight = 20_000;
            private currentScrollTop = 0;
            public get scrollTop() { return this.currentScrollTop; }
            public set scrollTop(value: number) {
                const landed = Math.max(0, Math.min(value, this.scrollHeight - this.clientHeight));
                if (this === root) anchorRow.top -= landed - this.currentScrollTop;
                this.currentScrollTop = landed;
            }
            public testId: string | null = null;
            public top = 0;
            public contains = () => true;
            public getAttribute = (name: string) => name === 'data-testid' ? this.testId : null;
            public getBoundingClientRect = () => ({
                bottom: this.top + this.height,
                height: this.height,
                left: 0,
                right: 800,
                top: this.top,
                width: 800,
                x: 0,
                y: this.top,
                toJSON: () => ({}),
            });
            public querySelector = () => anchorRow;
            public querySelectorAll = () => [anchorRow];
        }
        const root = new FakeHTMLElement();
        root.height = 600;
        const anchorRow = new FakeHTMLElement();
        anchorRow.testId = 'transcript-anchor-message-target';
        anchorRow.parentElement = root;

        vi.stubGlobal('HTMLElement', FakeHTMLElement);
        vi.stubGlobal('document', { getElementById: () => root });
        vi.stubGlobal('window', {
            getComputedStyle: () => ({ overflowX: 'hidden', overflowY: 'auto' }),
        });

        const { legendListRenderer } = await import('./legendListRenderer');
        const Renderer = legendListRenderer.Component;
        const listRef = React.createRef<TranscriptListShellRef<{ id: string }>>();
        await renderScreen(
            <Renderer
                webDomObservation={mountedWebDomObservation}
                ref={listRef}
                data={[{ id: 'target' }, { id: 'newer' }]}
                dataKey="prepend-seam"
                keyExtractor={(item: { id: string }) => item.id}
                renderItem={({ item }: { item: { id: string } }) => React.createElement('Row', { id: item.id })}
                frame={resolveMainTranscriptListShellFrame({
                    legendInitialScrollAtEnd: false,
                    nativeID: 'legend-main-native-id',
                    platformOS: 'web',
                })}
            />,
        );

        // Detached reading position with the anchor exactly where the hold wants it.
        root.scrollTop = 690;
        anchorRow.top = 100;
        capturedLegendListProps.onScroll({ nativeEvent: { contentOffset: { x: 0, y: 690 } } });
        getShellRef(listRef).holdWebEntryAnchor?.({
            itemId: 'target',
            itemOffsetPx: 100,
            kind: 'message',
            messageId: null,
        });
        nowMs += 400;
        act(() => animationFrames.splice(0).forEach((callback) => callback(1)));
        expect(root.scrollTop).toBe(690);

        // Legend compensates a 343px content growth ABOVE the reader (`ScrollAdjustHandler` ->
        // `scrollAdjustBy`). Its own scroll event reaches the renderer while the row-position
        // commit has not landed, so the DOM still reports the anchor at its pre-growth absolute
        // top — a 343px "misalignment" that is the seam, not the reader's geometry. The residual
        // is deliberately BELOW the viewport: the viewport-exceeding confirmation rule cannot
        // see this class, which is why the live capture wrote through it.
        root.scrollHeight = 20_343;
        root.scrollTop = 1_033;
        anchorRow.top = 100 - 343;
        capturedLegendListProps.onScroll({ nativeEvent: { contentOffset: { x: 0, y: 1_033 } } });
        expect(root.scrollTop).toBe(1_033);

        // The commit lands: the anchor is exactly where Legend's compensation put it. Nothing to
        // correct, and nothing was clobbered in the meantime.
        anchorRow.top = 100;
        act(() => animationFrames.splice(0).forEach((callback) => callback(2)));
        expect(root.scrollTop).toBe(1_033);
        expect(anchorRow.top).toBe(100);

        // A residual that OUTLIVES the seam is still corrected by the same transaction: stable
        // geometry, persistent misalignment, one write.
        anchorRow.top = 160;
        act(() => animationFrames.splice(0).forEach((callback) => callback(3)));
        act(() => animationFrames.splice(0).forEach((callback) => callback(4)));
        expect(root.scrollTop).toBe(1_093);
    });

    it('withholds the keyed-identity materialization until the scroller can hold the resolved target', async () => {
        // Live RED (2026-07-30, same session, cold SPA entry with a persisted detached anchor):
        // `scrollToIndex` was issued while the DOM scroller could only accept 813px of what
        // became a 32,878px transcript, so the command landed at that placeholder range's end
        // and the one-shot was already spent. `scrollTo` clamps to the CURRENT range; the
        // end-materialization path already withholds on Legend's unresolved position and the
        // keyed path must withhold on both facts, without consuming its one request.
        vi.spyOn(Date, 'now').mockImplementation(() => 1_000);
        const animationFrames: FrameRequestCallback[] = [];
        vi.stubGlobal('requestAnimationFrame', vi.fn((callback: FrameRequestCallback) => {
            animationFrames.push(callback);
            return animationFrames.length;
        }));
        vi.stubGlobal('cancelAnimationFrame', vi.fn());

        class FakeHTMLElement {
            public clientHeight = 600;
            public height = 600;
            public isConnected = true;
            public parentElement: FakeHTMLElement | null = null;
            public scrollHeight = 1_400;
            private currentScrollTop = 0;
            public get scrollTop() { return this.currentScrollTop; }
            public set scrollTop(value: number) {
                this.currentScrollTop = Math.max(0, Math.min(value, this.scrollHeight - this.clientHeight));
            }
            public testId: string | null = null;
            public top = 0;
            public contains = () => true;
            public getAttribute = (name: string) => name === 'data-testid' ? this.testId : null;
            public getBoundingClientRect = () => ({
                bottom: this.top + this.height,
                height: this.height,
                left: 0,
                right: 800,
                top: this.top,
                width: 800,
                x: 0,
                y: this.top,
                toJSON: () => ({}),
            });
            // The held row is not mounted yet: the landing degrades to Legend's position estimate.
            public querySelector = () => null;
            public querySelectorAll = () => [];
        }
        const root = new FakeHTMLElement();

        vi.stubGlobal('HTMLElement', FakeHTMLElement);
        vi.stubGlobal('document', { getElementById: () => root });
        vi.stubGlobal('window', {
            getComputedStyle: () => ({ overflowX: 'hidden', overflowY: 'auto' }),
        });

        legendStateOverride = {
            positionAtIndex: (index: number) => (index === 0 ? 30_900 : undefined),
            sizeAtIndex: () => 240,
        };

        const { legendListRenderer } = await import('./legendListRenderer');
        const Renderer = legendListRenderer.Component;
        const listRef = React.createRef<TranscriptListShellRef<{ id: string }>>();
        await renderScreen(
            <Renderer
                webDomObservation={mountedWebDomObservation}
                ref={listRef}
                data={[{ id: 'target' }, { id: 'newer' }]}
                dataKey="keyed-materialization-withhold"
                keyExtractor={(item: { id: string }) => item.id}
                renderItem={({ item }: { item: { id: string } }) => React.createElement('Row', { id: item.id })}
                frame={resolveMainTranscriptListShellFrame({
                    legendInitialScrollAtEnd: false,
                    nativeID: 'legend-main-native-id',
                    platformOS: 'web',
                })}
            />,
        );

        getShellRef(listRef).holdWebEntryAnchor?.({
            itemId: 'target',
            itemOffsetPx: 100,
            kind: 'message',
            messageId: null,
        });
        capturedLegendListProps.onItemSizeChanged({ index: 0, previous: 240, size: 500 });
        act(() => animationFrames.splice(0).forEach((callback) => callback(16)));
        act(() => animationFrames.splice(0).forEach((callback) => callback(32)));

        // The scroller can hold 800px of a target 30,800px away: commanding it now would spend
        // the one-shot on a clamped landing.
        expect(assignedLegendRef.scrollToIndex).not.toHaveBeenCalled();
        expect(root.scrollTop).toBe(0);

        // Hydration finishes and the range can hold the target: the withheld request is issued
        // exactly once by the same polling transaction.
        root.scrollHeight = 40_000;
        capturedLegendListProps.onItemSizeChanged({ index: 0, previous: 500, size: 520 });
        act(() => animationFrames.splice(0).forEach((callback) => callback(48)));
        expect(assignedLegendRef.scrollToIndex).toHaveBeenCalledTimes(1);
        expect(assignedLegendRef.scrollToIndex).toHaveBeenCalledWith({
            animated: false,
            index: 0,
            viewPosition: 0,
        });
    });

    it('withholds the keyed-identity materialization while Legend collapses the target position to the head', async () => {
        // The OTHER, independent half of the same guard — and the one its sibling above cannot
        // reach, because that test holds an INDEX-0 anchor, so `index > 0` short-circuits the
        // position branch and only the DOM-range branch runs.
        //
        // Legend resolves the offset from `positions[index] || 0`, so a non-head target whose
        // position has not been laid out yet resolves to 0 — the HEAD, the exact opposite of a
        // saved-anchor restore — and `runWhenReady` dispatches the frozen index anyway after
        // 800ms. Here the DOM range can hold anything, so the collapsed position is the ONLY
        // reason to withhold, and withholding must not spend the one-shot.
        vi.spyOn(Date, 'now').mockImplementation(() => 1_000);
        const animationFrames: FrameRequestCallback[] = [];
        vi.stubGlobal('requestAnimationFrame', vi.fn((callback: FrameRequestCallback) => {
            animationFrames.push(callback);
            return animationFrames.length;
        }));
        vi.stubGlobal('cancelAnimationFrame', vi.fn());

        class FakeHTMLElement {
            public clientHeight = 600;
            public height = 600;
            public isConnected = true;
            public parentElement: FakeHTMLElement | null = null;
            // Fully hydrated range: the DOM-range withhold condition can never fire here.
            public scrollHeight = 40_000;
            private currentScrollTop = 20_000;
            public get scrollTop() { return this.currentScrollTop; }
            public set scrollTop(value: number) {
                this.currentScrollTop = Math.max(0, Math.min(value, this.scrollHeight - this.clientHeight));
            }
            public testId: string | null = null;
            public top = 0;
            public contains = () => true;
            public getAttribute = (name: string) => name === 'data-testid' ? this.testId : null;
            public getBoundingClientRect = () => ({
                bottom: this.top + this.height,
                height: this.height,
                left: 0,
                right: 800,
                top: this.top,
                width: 800,
                x: 0,
                y: this.top,
                toJSON: () => ({}),
            });
            // The held row is not mounted yet: the landing degrades to Legend's position estimate.
            public querySelector = () => null;
            public querySelectorAll = () => [];
        }
        const root = new FakeHTMLElement();

        vi.stubGlobal('HTMLElement', FakeHTMLElement);
        vi.stubGlobal('document', { getElementById: () => root });
        vi.stubGlobal('window', {
            getComputedStyle: () => ({ overflowX: 'hidden', overflowY: 'auto' }),
        });

        let targetPosition = 0;
        legendStateOverride = {
            positionAtIndex: (index: number) => (index === 1 ? targetPosition : 0),
            sizeAtIndex: () => 240,
        };

        const { legendListRenderer } = await import('./legendListRenderer');
        const Renderer = legendListRenderer.Component;
        const listRef = React.createRef<TranscriptListShellRef<{ id: string }>>();
        await renderScreen(
            <Renderer
                webDomObservation={mountedWebDomObservation}
                ref={listRef}
                data={[{ id: 'older' }, { id: 'target' }]}
                dataKey="keyed-materialization-collapsed-position"
                keyExtractor={(item: { id: string }) => item.id}
                renderItem={({ item }: { item: { id: string } }) => React.createElement('Row', { id: item.id })}
                frame={resolveMainTranscriptListShellFrame({
                    legendInitialScrollAtEnd: false,
                    nativeID: 'legend-main-native-id',
                    platformOS: 'web',
                })}
            />,
        );

        getShellRef(listRef).holdWebEntryAnchor?.({
            itemId: 'target',
            itemOffsetPx: 100,
            kind: 'message',
            messageId: null,
        });
        capturedLegendListProps.onItemSizeChanged({ index: 0, previous: 240, size: 500 });
        act(() => animationFrames.splice(0).forEach((callback) => callback(16)));
        act(() => animationFrames.splice(0).forEach((callback) => callback(32)));

        // Legend still answers 0 for index 1: commanding now would land on the head and spend
        // the one request. Nothing is written either — the reader stays where they were.
        expect(assignedLegendRef.scrollToIndex).not.toHaveBeenCalled();
        expect(root.scrollTop).toBe(20_000);

        // The layout resolves; the unspent one-shot is issued exactly once, for the target.
        targetPosition = 900;
        capturedLegendListProps.onItemSizeChanged({ index: 0, previous: 500, size: 520 });
        act(() => animationFrames.splice(0).forEach((callback) => callback(48)));
        expect(assignedLegendRef.scrollToIndex).toHaveBeenCalledTimes(1);
        expect(assignedLegendRef.scrollToIndex).toHaveBeenCalledWith({
            animated: false,
            index: 1,
            viewPosition: 0,
        });
    });

    it('keeps the held web tail semantic after an external rollback without adding an app correction', async () => {
        // USER-REALITY-DIVERGENCE symptom 3 (typing pins below the true bottom): each composer
        // growth produced ONE held-tail correction write, Legend replayed the old offset, and
        // the idempotence guard then swallowed every further reassertion because the
        // (current,target) pair repeated. The guard must treat an external move away from our
        // last LANDED offset as new evidence, while a clamped-but-intact write stays deduped.
        let nowMs = 1_000;
        vi.spyOn(Date, 'now').mockImplementation(() => nowMs);
        const animationFrames: FrameRequestCallback[] = [];
        vi.stubGlobal('requestAnimationFrame', vi.fn((callback: FrameRequestCallback) => {
            animationFrames.push(callback);
            return animationFrames.length;
        }));
        vi.stubGlobal('cancelAnimationFrame', vi.fn());

        class FakeHTMLElement {
            public clientHeight = 600;
            public height = 100;
            public isConnected = true;
            public parentElement: FakeHTMLElement | null = null;
            public scrollHeight = 28_606;
            public scrollLeft = 0;
            private currentScrollTop = 27_936;
            public get scrollTop() { return this.currentScrollTop; }
            public set scrollTop(value: number) {
                this.currentScrollTop = Math.max(0, Math.min(value, this.scrollHeight - this.clientHeight));
            }
            public scrollTo = (params: { top: number }) => { this.scrollTop = params.top; };
            public testId: string | null = null;
            public top = 0;
            public contains = () => true;
            public getAttribute = (name: string) => name === 'data-testid' ? this.testId : null;
            public getBoundingClientRect = () => ({
                bottom: this.top + this.height, height: this.height, left: 0, right: 800,
                top: this.top, width: 800, x: 0, y: this.top, toJSON: () => ({}),
            });
            public querySelector = () => null;
            public querySelectorAll = () => [];
        }
        const root = new FakeHTMLElement();
        root.height = 600;

        vi.stubGlobal('HTMLElement', FakeHTMLElement);
        vi.stubGlobal('document', { getElementById: () => root });
        vi.stubGlobal('window', {
            getComputedStyle: () => ({ overflowX: 'hidden', overflowY: 'auto' }),
        });

        const { legendListRenderer } = await import('./legendListRenderer');
        const Renderer = legendListRenderer.Component;
        const listRef = React.createRef<TranscriptListShellRef<{ id: string }>>();
        await renderScreen(
            <Renderer
                webDomObservation={mountedWebDomObservation}
                ref={listRef}
                data={[{ id: 'row-1' }]}
                dataKey="session-test"
                keyExtractor={(item: { id: string }) => item.id}
                renderItem={({ item }: { item: { id: string } }) => React.createElement('Row', { id: item.id })}
                frame={resolveMainTranscriptListShellFrame({
                    nativeID: 'legend-main-native-id',
                    platformOS: 'web',
                })}
            />,
        );
        // At exact bottom: 28_606 - 600 - 27_936 = 70 -> shrink viewport to open a residual.
        root.scrollTop = 28_006;
        // Composer grows: viewport shrinks by 23px -> dfb becomes 23.
        root.clientHeight = 577;
        listRef.current?.notifyViewportGeometryChanged?.();
        act(() => animationFrames.splice(0).forEach((callback) => callback(16)));
        expect(root.scrollTop).toBe(28_006);
        expect(getShellRef(listRef).hasLiveWebHold?.({ kind: 'end' })).toBe(true);

        // Legend/browser rolls the offset back to the stale pre-resize value.
        root.scrollTop = 28_006;
        capturedLegendListProps.onItemSizeChanged({ index: 0, previous: 240, size: 240 });
        act(() => animationFrames.splice(0).forEach((callback) => callback(32)));

        // The standing semantic hold remains, while Legend owns the physical steady
        // correction in the real package.
        expect(root.scrollTop).toBe(28_006);
        expect(getShellRef(listRef).hasLiveWebHold?.({ kind: 'end' })).toBe(true);
    });

    it('does not treat a post-window offset rollback without user input as a semantic detach', async () => {
        // USER-REALITY-DIVERGENCE symptom 3 terminal mechanism: Legend's internal
        // maintain/adjust path replays a stale-basis bottom offset AFTER the held-intent
        // settle window expires. That scroll event carried no user input, but the adapter
        // classified it as a user detach and RELEASED the held tail - after which nothing
        // ever re-corrected and the viewport stayed pinned below the true bottom. A scroll
        // away from a held tail with no recent wheel/touch/drag/pointer evidence must
        // re-assert the tail instead of releasing it.
        let nowMs = 1_000;
        vi.spyOn(Date, 'now').mockImplementation(() => nowMs);
        const animationFrames: FrameRequestCallback[] = [];
        vi.stubGlobal('requestAnimationFrame', vi.fn((callback: FrameRequestCallback) => {
            animationFrames.push(callback);
            return animationFrames.length;
        }));
        vi.stubGlobal('cancelAnimationFrame', vi.fn());
        const { legendListRenderer } = await import('./legendListRenderer');
        const Renderer = legendListRenderer.Component;
        const listRef = React.createRef<TranscriptListShellRef<{ id: string }>>();

        legendStateOverride = {
            contentLength: 1200,
            end: 0,
            isAtEnd: true,
            isNearEnd: true,
            isWithinMaintainScrollAtEndThreshold: true,
            scroll: 600,
            scrollLength: 600,
            start: 0,
        };
        await renderScreen(
            <Renderer
                webDomObservation={mountedWebDomObservation}
                ref={listRef}
                data={[{ id: 'row-1' }]}
                dataKey="session-test"
                keyExtractor={(item: { id: string }) => item.id}
                renderItem={({ item }: { item: { id: string } }) => React.createElement('Row', { id: item.id })}
                frame={resolveMainTranscriptListShellFrame({
                    nativeID: 'legend-main-native-id',
                    platformOS: 'web',
                })}
            />,
        );
        assignedLegendRef.scrollToEnd.mockClear();

        // Seed a scroll baseline, then move PAST every settle window.
        capturedLegendListProps.onScroll({ nativeEvent: { contentOffset: { x: 0, y: 600 } } });
        nowMs = 20_000;

        // Legend replays a stale bottom offset: at-end facts flip false, no user input seen.
        legendStateOverride = {
            ...legendStateOverride,
            isAtEnd: false,
            isNearEnd: false,
            isWithinMaintainScrollAtEndThreshold: false,
            scroll: 488,
        };
        capturedLegendListProps.onScroll({ nativeEvent: { contentOffset: { x: 0, y: 488 } } });

        // The hold survives, but the adapter does not compete with Legend's
        // steady physical owner.
        expect(assignedLegendRef.scrollToEnd).not.toHaveBeenCalled();
        expect(getShellRef(listRef).hasLiveWebHold?.({ kind: 'end' })).toBe(true);

        // A real wheel afterwards still detaches normally.
        assignedLegendRef.scrollToEnd.mockClear();
        capturedLegendListProps.onWheel({ deltaY: -300 });
        capturedLegendListProps.onScroll({ nativeEvent: { contentOffset: { x: 0, y: 200 } } });
        capturedLegendListProps.onItemSizeChanged({ index: 0, previous: 240, size: 400 });
        expect(assignedLegendRef.scrollToEnd).not.toHaveBeenCalled();
        expect(getShellRef(listRef).hasLiveWebHold?.({ kind: 'end' })).toBe(false);
    });

    it('reopens keyed settlement when a late Legend scroll displaces an aligned jump target to the window end', async () => {
        // Live sequential out-of-window A -> B RED (2026-07-24): the driver landed B at
        // top=24 and armed its keyed hold, then Legend replayed the target-window end after
        // the 1.5s active settle cadence went quiet. Because the resulting viewport was
        // physically at end, the generic moved-away-from-tail branch did not re-open the
        // still-live keyed transaction. The app-side verifier correctly deferred to that
        // hold for its full identity window, leaving B at top=-191 until the jump failed.
        let nowMs = 1_000;
        vi.spyOn(Date, 'now').mockImplementation(() => nowMs);
        const animationFrames: FrameRequestCallback[] = [];
        vi.stubGlobal('requestAnimationFrame', vi.fn((callback: FrameRequestCallback) => {
            animationFrames.push(callback);
            return animationFrames.length;
        }));
        vi.stubGlobal('cancelAnimationFrame', vi.fn());

        class FakeHTMLElement {
            public clientHeight = 600;
            public height = 100;
            public isConnected = true;
            public parentElement: FakeHTMLElement | null = null;
            public scrollHeight = 1_315;
            private currentScrollTop = 500;
            public onScrollTopChanged: ((delta: number) => void) | null = null;
            public get scrollTop() { return this.currentScrollTop; }
            public set scrollTop(value: number) {
                const landed = Math.max(0, Math.min(value, this.scrollHeight - this.clientHeight));
                const delta = landed - this.currentScrollTop;
                this.currentScrollTop = landed;
                this.onScrollTopChanged?.(delta);
            }
            public testId: string | null = null;
            public top = 0;
            public contains = () => true;
            public getAttribute = (name: string) => name === 'data-testid' ? this.testId : null;
            public getBoundingClientRect = () => ({
                bottom: this.top + this.height,
                height: this.height,
                left: 0,
                right: 800,
                top: this.top,
                width: 800,
                x: 0,
                y: this.top,
                toJSON: () => ({}),
            });
            public querySelector = (selector: string) => (
                selector.includes('transcript-item-target') ? targetRow : null
            );
            public querySelectorAll = () => [targetRow];
        }
        const root = new FakeHTMLElement();
        root.height = root.clientHeight;
        const targetRow = new FakeHTMLElement();
        targetRow.testId = 'transcript-item-target';
        targetRow.top = 24;
        targetRow.height = 206;
        targetRow.clientHeight = 206;
        targetRow.scrollHeight = 206;
        targetRow.parentElement = root;
        root.onScrollTopChanged = (delta) => {
            targetRow.top -= delta;
        };

        vi.stubGlobal('HTMLElement', FakeHTMLElement);
        vi.stubGlobal('document', { getElementById: () => root });
        vi.stubGlobal('window', {
            getComputedStyle: () => ({ overflowX: 'hidden', overflowY: 'auto' }),
        });

        const { legendListRenderer } = await import('./legendListRenderer');
        const Renderer = legendListRenderer.Component;
        const listRef = React.createRef<TranscriptListShellRef<{ id: string }>>();
        await renderScreen(
            <Renderer
                webDomObservation={mountedWebDomObservation}
                ref={listRef}
                data={[{ id: 'target' }, { id: 'newer' }]}
                dataKey="sequential-window-jump"
                keyExtractor={(item: { id: string }) => item.id}
                renderItem={({ item }: { item: { id: string } }) => React.createElement('Row', { id: item.id })}
                frame={resolveMainTranscriptListShellFrame({
                    legendInitialScrollAtEnd: false,
                    nativeID: 'legend-main-native-id',
                    platformOS: 'web',
                })}
            />,
        );

        capturedLegendListProps.onScroll({ nativeEvent: { contentOffset: { x: 0, y: 500 } } });
        getShellRef(listRef).holdWebEntryAnchor?.({
            itemId: 'target',
            itemOffsetPx: 24,
            kind: 'item',
            messageId: null,
        });
        act(() => animationFrames.splice(0).forEach((callback) => callback(1)));
        expect(targetRow.top).toBe(24);

        // The active cadence has expired, but the keyed identity is still live.
        nowMs = 3_000;
        act(() => animationFrames.splice(0).forEach((callback) => callback(2)));
        expect(animationFrames).toHaveLength(0);
        expect(getShellRef(listRef).hasLiveWebHold?.({ kind: 'item', itemId: 'target' })).toBe(true);

        // Legend's late window-end replay moves to max scrollTop=715 and emits its own
        // scroll event. The keyed residual owner must resume from this fresh displacement
        // even though the resulting web geometry says "at end".
        root.scrollTop = 715;
        expect(targetRow.top).toBe(-191);
        capturedLegendListProps.onScroll({ nativeEvent: { contentOffset: { x: 0, y: 715 } } });
        // The displacement is confirmed by the settle frame the resumed transaction schedules:
        // a correction is only spent on geometry that is no longer in motion (a single read
        // taken across Legend's own compensation seam is an artifact — live 2026-07-30). One
        // frame later the offset is still 715, so the same correction lands, unchanged.
        act(() => animationFrames.splice(0).forEach((callback) => callback(3)));

        expect(root.scrollTop).toBe(500);
        expect(targetRow.top).toBe(24);
        expect(getShellRef(listRef).hasLiveWebHold?.({ kind: 'item', itemId: 'target' })).toBe(true);
    });

    it('settles the actual keyed materialization after it supersedes the outer bootstrap promise', async () => {
        // Current-bundle hard-open A -> B RED (2026-07-24): the exposed bootstrap
        // scrollToIndex started first, but the anchor hold still saw only estimate geometry
        // and issued its one allowed internal materialization request. Legend superseded the
        // outer request (settling its promise before the target mounted), then the internal
        // request made the only final physical move and mounted the exact row. No subsequent
        // scroll/layout signal existed to wake the held owner when that actual
        // materialization settled.
        let nowMs = 1_000;
        vi.spyOn(Date, 'now').mockImplementation(() => nowMs);
        const animationFrames: FrameRequestCallback[] = [];
        vi.stubGlobal('requestAnimationFrame', vi.fn((callback: FrameRequestCallback) => {
            animationFrames.push(callback);
            return animationFrames.length;
        }));
        vi.stubGlobal('cancelAnimationFrame', vi.fn());

        class FakeHTMLElement {
            public clientHeight = 672;
            public height = 100;
            public isConnected = true;
            public parentElement: FakeHTMLElement | null = null;
            public scrollHeight = 50_099;
            private currentScrollTop = 0;
            public onScrollTopChanged: ((delta: number) => void) | null = null;
            public get scrollTop() { return this.currentScrollTop; }
            public set scrollTop(value: number) {
                const landed = Math.max(0, Math.min(value, this.scrollHeight - this.clientHeight));
                const delta = landed - this.currentScrollTop;
                this.currentScrollTop = landed;
                this.onScrollTopChanged?.(delta);
            }
            public top = 0;
            public contains = () => true;
            public getAttribute: (name: string) => string | null = () => null;
            public getBoundingClientRect = () => ({
                bottom: this.top + this.height,
                height: this.height,
                left: 0,
                right: 800,
                top: this.top,
                width: 800,
                x: 0,
                y: this.top,
                toJSON: () => ({}),
            });
            public querySelector = (selector: string) => (
                targetMounted && selector.includes('transcript-item-msg:cvv0m1h50mu')
                    ? targetRow
                    : null
            );
            public querySelectorAll = () => targetMounted ? [targetRow] : [];
        }
        const root = new FakeHTMLElement();
        root.height = root.clientHeight;
        const targetRow = new FakeHTMLElement();
        targetRow.top = 24_973;
        targetRow.height = 230;
        targetRow.clientHeight = 230;
        targetRow.scrollHeight = 230;
        targetRow.getAttribute = (name: string) => (
            name === 'data-testid' ? 'transcript-item-msg:cvv0m1h50mu' : null
        );
        targetRow.parentElement = root;
        let targetMounted = false;
        root.onScrollTopChanged = (delta) => {
            targetRow.top -= delta;
        };
        legendStateOverride = {
            elementAtIndex: (index: number) => (
                targetMounted && index === 0 ? targetRow : null
            ),
            end: 1,
            isAtEnd: false,
            isNearEnd: false,
            isWithinMaintainScrollAtEndThreshold: false,
            positionAtIndex: (index: number) => index === 0 ? 24_973 : 48_000,
            scroll: 44_703,
            scrollLength: 672,
            start: 0,
        };

        vi.stubGlobal('HTMLElement', FakeHTMLElement);
        vi.stubGlobal('document', { getElementById: () => root });
        vi.stubGlobal('window', {
            getComputedStyle: () => ({ overflowX: 'hidden', overflowY: 'auto' }),
        });

        const { legendListRenderer } = await import('./legendListRenderer');
        const Renderer = legendListRenderer.Component;
        const listRef = React.createRef<TranscriptListShellRef<{ id: string }>>();
        await renderScreen(
            <Renderer
                webDomObservation={mountedWebDomObservation}
                ref={listRef}
                data={[{ id: 'msg:cvv0m1h50mu' }, { id: 'unrelated' }]}
                dataKey="current-hard-open-target-window"
                keyExtractor={(item: { id: string }) => item.id}
                renderItem={({ item }: { item: { id: string } }) => React.createElement('Row', { id: item.id })}
                frame={resolveMainTranscriptListShellFrame({
                    legendInitialScrollAtEnd: false,
                    nativeID: 'legend-main-native-id',
                    platformOS: 'web',
                })}
            />,
        );

        let resolveOuterBootstrap!: () => void;
        let resolveActualMaterialization!: () => void;
        const outerBootstrap = new Promise<void>((resolve) => {
            resolveOuterBootstrap = resolve;
        });
        const actualMaterialization = new Promise<void>((resolve) => {
            resolveActualMaterialization = resolve;
        });
        assignedLegendRef.scrollToIndex
            .mockImplementationOnce(() => outerBootstrap)
            .mockImplementationOnce(() => actualMaterialization);

        // The driver bootstrap starts against the target window, then its estimate write
        // lands and the completed driver command transfers the final exact-offset contract
        // to the renderer's anchor hold.
        getShellRef(listRef).scrollToIndex({ animated: false, index: 0 });
        root.scrollTop = 35_810;
        getShellRef(listRef).holdWebEntryAnchor?.({
            itemId: 'msg:cvv0m1h50mu',
            itemOffsetPx: 24,
            kind: 'item',
            messageId: null,
        });
        expect(assignedLegendRef.scrollToIndex).toHaveBeenCalledTimes(2);

        // Starting the internal materialization supersedes Legend's outer request. Its early
        // completion opens a cadence while the target is still absent, but that cadence
        // expires before the actual materialization finishes.
        await act(async () => {
            resolveOuterBootstrap();
            await Promise.resolve();
        });
        nowMs = 3_000;
        act(() => animationFrames.splice(0).forEach((callback) => callback(0)));
        expect(animationFrames).toHaveLength(0);

        // The actual materialization makes the final physical move and mounts the exact
        // logical row, but emits no later scroll/layout callback. Its own promise settlement
        // must resume the same held owner.
        root.scrollTop = 44_703;
        targetMounted = true;
        expect(targetRow.top).toBe(-19_730);
        await act(async () => {
            resolveActualMaterialization();
            await Promise.resolve();
        });
        act(() => animationFrames.splice(0).forEach((callback) => callback(1)));

        expect(root.scrollTop).toBe(24_949);
        expect(targetRow.top).toBe(24);
        expect(nowMs).toBe(3_000);
    });

    it('leaves native viewport and footer geometry maintenance to Legend', async () => {
        setPlatformOS('ios');
        const { legendListRenderer } = await import('./legendListRenderer');
        const Renderer = legendListRenderer.Component;
        const listRef = React.createRef<TranscriptListShellRef<{ id: string }>>();
        const render = (phase: number) => (
            <Renderer
                webDomObservation={mountedWebDomObservation}
                ref={listRef}
                data={[{ id: 'row-1' }]}
                dataKey="session-test"
                keyExtractor={(item: { id: string }) => item.id}
                renderItem={({ item }: { item: { id: string } }) => React.createElement('Row', { id: item.id })}
                frame={resolveMainTranscriptListShellFrame({
                    nativeID: 'legend-main-native-id',
                    platformOS: 'ios',
                })}
                header={React.createElement('BottomSlot', { phase })}
            />
        );

        legendStateOverride = {
            contentLength: 1200,
            end: 0,
            isAtEnd: true,
            isNearEnd: true,
            isWithinMaintainScrollAtEndThreshold: true,
            scroll: 600,
            scrollLength: 600,
            start: 0,
        };
        const screen = await renderScreen(render(1));
        const identityHost = screen.tree.root.findByProps({ nativeID: 'legend-main-native-id' });
        identityHost.props.onLayout({ nativeEvent: { layout: { height: 670, width: 800, x: 0, y: 0 } } });
        capturedLegendListProps.ListFooterComponent.props.onLayout({
            nativeEvent: { layout: { height: 40, width: 800, x: 0, y: 0 } },
        });
        assignedLegendRef.scrollToEnd.mockClear();
        assignedLegendRef.scrollToOffset.mockClear();

        // Keep a nonzero measured residual while Legend still owns the native threshold
        // phase. Layout, footer, and item-size signals all wake the app held-intent
        // verifier, but none may add an app scrollToOffset beside Legend's maintenance.
        legendStateOverride = {
            ...legendStateOverride,
            contentLength: 2_000,
            isAtEnd: false,
            isNearEnd: true,
            isWithinMaintainScrollAtEndThreshold: true,
        };
        identityHost.props.onLayout({ nativeEvent: { layout: { height: 535, width: 800, x: 0, y: 0 } } });
        capturedLegendListProps.ListFooterComponent.props.onLayout({
            nativeEvent: { layout: { height: 352, width: 800, x: 0, y: 0 } },
        });
        capturedLegendListProps.onItemSizeChanged({ index: 0, previous: 100, size: 400 });
        listRef.current?.notifyViewportGeometryChanged?.();
        await screen.update(render(2));

        expect(assignedLegendRef.scrollToEnd).not.toHaveBeenCalled();
        expect(assignedLegendRef.scrollToOffset).not.toHaveBeenCalled();
    });

    it('re-targets a held native tail when late footer growth exceeds the maintain threshold', async () => {
        setPlatformOS('ios');
        const { legendListRenderer } = await import('./legendListRenderer');
        const Renderer = legendListRenderer.Component;

        legendStateOverride = {
            contentLength: 1200,
            end: 0,
            isAtEnd: true,
            isNearEnd: true,
            isWithinMaintainScrollAtEndThreshold: true,
            scroll: 600,
            scrollLength: 600,
            start: 0,
        };
        const screen = await renderScreen(
            <Renderer
                webDomObservation={mountedWebDomObservation}
                data={[{ id: 'row-1' }]}
                dataKey="session-test"
                keyExtractor={(item: { id: string }) => item.id}
                renderItem={({ item }: { item: { id: string } }) => React.createElement('Row', { id: item.id })}
                frame={resolveMainTranscriptListShellFrame({
                    nativeID: 'legend-main-native-id',
                    platformOS: 'ios',
                })}
                header={React.createElement('BottomSlot')}
            />,
        );
        const identityHost = screen.tree.root.findByProps({ nativeID: 'legend-main-native-id' });
        identityHost.props.onLayout({ nativeEvent: { layout: { height: 670, width: 800, x: 0, y: 0 } } });
        capturedLegendListProps.ListFooterComponent.props.onLayout({
            nativeEvent: { layout: { height: 40, width: 800, x: 0, y: 0 } },
        });
        assignedLegendRef.scrollToEnd.mockClear();

        // The session-open bootstrap race: Legend's initial tail placement completed before the
        // composer inset footer measured. The late footer growth leaves the viewport short of the
        // tail by MORE than the maintain threshold, so Legend will not repair it on its own. The
        // adapter still holds the tail intent (no user scroll happened) and must re-target.
        legendStateOverride = {
            ...legendStateOverride,
            isAtEnd: false,
            isNearEnd: false,
            isWithinMaintainScrollAtEndThreshold: false,
            scroll: 448,
        };
        capturedLegendListProps.ListFooterComponent.props.onLayout({
            nativeEvent: { layout: { height: 192, width: 800, x: 0, y: 0 } },
        });

        expect(assignedLegendRef.scrollToEnd).not.toHaveBeenCalled();
        expect(assignedLegendRef.scrollToOffset).toHaveBeenCalledWith({ animated: false, offset: 600 });
    });

    it('holds the tail through an explicit scrollToEnd command so late footer growth re-targets', async () => {
        setPlatformOS('ios');
        const { legendListRenderer } = await import('./legendListRenderer');
        const Renderer = legendListRenderer.Component;
        const listRef = React.createRef<TranscriptListShellRef<{ id: string }>>();

        // The reader is detached: no at-end observation has latched the held-tail intent.
        legendStateOverride = {
            contentLength: 1200,
            end: 0,
            isAtEnd: false,
            isNearEnd: false,
            isWithinMaintainScrollAtEndThreshold: false,
            scroll: 100,
            scrollLength: 600,
            start: 0,
        };
        const screen = await renderScreen(
            <Renderer
                webDomObservation={mountedWebDomObservation}
                ref={listRef}
                data={[{ id: 'row-1' }]}
                dataKey="session-test"
                keyExtractor={(item: { id: string }) => item.id}
                renderItem={({ item }: { item: { id: string } }) => React.createElement('Row', { id: item.id })}
                frame={resolveMainTranscriptListShellFrame({
                    nativeID: 'legend-main-native-id',
                    platformOS: 'ios',
                })}
                header={React.createElement('BottomSlot')}
            />,
        );
        const identityHost = screen.tree.root.findByProps({ nativeID: 'legend-main-native-id' });
        identityHost.props.onLayout({ nativeEvent: { layout: { height: 670, width: 800, x: 0, y: 0 } } });
        capturedLegendListProps.ListFooterComponent.props.onLayout({
            nativeEvent: { layout: { height: 40, width: 800, x: 0, y: 0 } },
        });
        assignedLegendRef.scrollToEnd.mockClear();

        // An explicit app command (JTB / entry bottom) IS the tail intent — the adapter must
        // hold it immediately instead of waiting for an at-end observation that a concurrent
        // footer growth can prevent from ever arriving.
        getShellRef(listRef).scrollToEnd?.({ animated: false });
        expect(assignedLegendRef.scrollToEnd).toHaveBeenCalledTimes(1);

        capturedLegendListProps.ListFooterComponent.props.onLayout({
            nativeEvent: { layout: { height: 192, width: 800, x: 0, y: 0 } },
        });

        expect(assignedLegendRef.scrollToEnd).toHaveBeenCalledTimes(1);
        expect(assignedLegendRef.scrollToOffset).toHaveBeenCalledWith({ animated: false, offset: 600 });
    });

    it('repairs a native initial-bottom landing by only the measured Legend-state residual', async () => {
        setPlatformOS('ios');
        const animationFrames = installAnimationFrameQueue();
        const { legendListRenderer } = await import('./legendListRenderer');
        const Renderer = legendListRenderer.Component;

        legendStateOverride = {
            contentLength: 2_400,
            end: 9,
            isAtEnd: true,
            isNearEnd: true,
            isWithinMaintainScrollAtEndThreshold: true,
            positionAtIndex: (index: number) => index * 240,
            scroll: 1_800,
            scrollLength: 600,
            sizeAtIndex: () => 240,
            start: 7,
        };
        await renderScreen(
            <Renderer
                webDomObservation={mountedWebDomObservation}
                data={Array.from({ length: 10 }, (_value, index) => ({ id: `row-${index}` }))}
                dataKey="session-test"
                keyExtractor={(item: { id: string }) => item.id}
                renderItem={({ item }: { item: { id: string } }) => React.createElement('Row', { id: item.id })}
                frame={resolveMainTranscriptListShellFrame({
                    nativeID: 'legend-main-native-id',
                    platformOS: 'ios',
                })}
            />,
        );
        assignedLegendRef.scrollToEnd.mockClear();
        assignedLegendRef.scrollToOffset.mockClear();

        // Legend initially lands at the estimate-based tail. Giant rows then report their real
        // sizes, moving the state-owned content end while the native offset remains pages short.
        legendStateOverride = {
            ...legendStateOverride,
            contentLength: 9_000,
            isAtEnd: false,
            isNearEnd: false,
            isWithinMaintainScrollAtEndThreshold: false,
            scroll: 1_800,
        };
        capturedLegendListProps.onItemSizeChanged({ index: 2, previous: 240, size: 6_840 });
        act(() => animationFrames.shift()?.(16));

        expect(assignedLegendRef.scrollToEnd).not.toHaveBeenCalled();
        expect(assignedLegendRef.scrollToOffset).toHaveBeenCalledWith({
            animated: false,
            offset: 8_400,
        });
    });

    it('arms a native visible-anchor hold for an app height commit and keeps the first visible row still', async () => {
        // Live S-C (2026-07-11, both platforms): tool expansion commits re-anchor Legend's
        // mounted window; under Legend `localHeightChangeRestoreOwner` is 'renderer' but no
        // renderer ownership existed. armVisibleAnchorHold installs the keyed index hold on
        // the first visible row before the commit; later growth above it must correct by the
        // measured residual so the row keeps its viewport offset.
        setPlatformOS('ios');
        let nowMs = 1_000;
        vi.spyOn(Date, 'now').mockImplementation(() => nowMs);
        const animationFrames = installAnimationFrameQueue();
        const { legendListRenderer } = await import('./legendListRenderer');
        const Renderer = legendListRenderer.Component;
        const listRef = React.createRef<TranscriptListShellRef<{ id: string }>>();
        let positions = [0, 240, 480, 720, 960];

        legendStateOverride = {
            contentLength: 1_200,
            end: 4,
            isAtEnd: false,
            isNearEnd: false,
            isWithinMaintainScrollAtEndThreshold: false,
            positionAtIndex: (index: number) => positions[index],
            scroll: 500,
            scrollLength: 600,
            sizeAtIndex: () => 240,
            start: 1,
        };
        await renderScreen(
            <Renderer
                webDomObservation={mountedWebDomObservation}
                ref={listRef}
                data={Array.from({ length: 5 }, (_value, index) => ({ id: `row-${index}` }))}
                dataKey="session-test"
                keyExtractor={(item: { id: string }) => item.id}
                renderItem={({ item }: { item: { id: string } }) => React.createElement('Row', { id: item.id })}
                frame={resolveMainTranscriptListShellFrame({
                    legendInitialScrollAtEnd: false,
                    nativeID: 'legend-main-native-id',
                    platformOS: 'ios',
                })}
            />,
        );

        // First visible row at scroll 500 is index 2 (position 480 + size 240 > 500), held
        // with viewOffset = 480 - 500 = -20 so the landing target equals the current offset.
        expect(typeof getShellRef(listRef).armVisibleAnchorHold).toBe('function');
        getShellRef(listRef).armVisibleAnchorHold?.();
        assignedLegendRef.scrollToOffset.mockClear();

        // The expansion commits: a row above the anchor grows by 2,000px and Legend leaves
        // the offset unowned. The hold must restore the anchor row's viewport offset.
        nowMs = 1_400;
        positions = [0, 240, 2_480, 2_720, 2_960];
        legendStateOverride = {
            ...legendStateOverride,
            contentLength: 3_200,
            scroll: 500,
        };
        capturedLegendListProps.onItemSizeChanged({ index: 1, previous: 240, size: 2_240 });
        act(() => animationFrames.shift()?.(nowMs));
        expect(assignedLegendRef.scrollToOffset).toHaveBeenCalledWith({
            animated: false,
            offset: 2_500,
        });
    });

    it('keeps an expansion-armed hold through post-commit movement after a tap (tap is not scroll intent)', async () => {
        // Live native S-C re-run (2026-07-11 09:03): the expansion toggle armed the hold, but
        // the expansion's own offset movement arrived after the settle window while the TAP's
        // touch evidence was still inside the 3.5s detach window — misclassified as a user
        // detach, releasing the hold and leaving the parked viewport ownerless. A bare tap is
        // not scroll intent; only wheel/drag/keyboard evidence may classify a detach.
        setPlatformOS('ios');
        let nowMs = 1_000;
        vi.spyOn(Date, 'now').mockImplementation(() => nowMs);
        const animationFrames = installAnimationFrameQueue();
        const { legendListRenderer } = await import('./legendListRenderer');
        const Renderer = legendListRenderer.Component;
        const listRef = React.createRef<TranscriptListShellRef<{ id: string }>>();
        let positions = [0, 240, 480, 720, 960];
        legendStateOverride = {
            contentLength: 1_200,
            end: 4,
            isAtEnd: false,
            isNearEnd: false,
            isWithinMaintainScrollAtEndThreshold: false,
            positionAtIndex: (index: number) => positions[index],
            scroll: 500,
            scrollLength: 600,
            sizeAtIndex: () => 240,
            start: 1,
        };
        await renderScreen(
            <Renderer
                webDomObservation={mountedWebDomObservation}
                ref={listRef}
                data={Array.from({ length: 5 }, (_value, index) => ({ id: `row-${index}` }))}
                dataKey="session-test"
                keyExtractor={(item: { id: string }) => item.id}
                renderItem={({ item }: { item: { id: string } }) => React.createElement('Row', { id: item.id })}
                frame={resolveMainTranscriptListShellFrame({
                    legendInitialScrollAtEnd: false,
                    nativeID: 'legend-main-native-id',
                    platformOS: 'ios',
                })}
            />,
        );

        // Tap on the tool row: touch start (releases any hold), then the press handler arms.
        capturedLegendListProps.onTouchStart({});
        getShellRef(listRef).armVisibleAnchorHold?.();
        assignedLegendRef.scrollToOffset.mockClear();

        // The expansion commit keeps moving the offset AFTER the 1.5s settle window while the
        // tap evidence is still inside the detach window. The hold must survive.
        nowMs = 2_700;
        legendStateOverride = {
            ...legendStateOverride,
            scroll: 2_273,
            contentLength: 3_200,
        };
        capturedLegendListProps.onScroll({ nativeEvent: { contentOffset: { x: 0, y: 2_273 } } });

        // Measured geometry settles: the surviving hold corrects the anchor row (index 2 at
        // grown position 2,480, viewOffset -20 -> target 2,500).
        nowMs = 3_000;
        positions = [0, 240, 2_480, 2_720, 2_960];
        capturedLegendListProps.onItemSizeChanged({ index: 1, previous: 240, size: 2_240 });
        act(() => animationFrames.shift()?.(nowMs));
        expect(assignedLegendRef.scrollToOffset).toHaveBeenCalledWith({
            animated: false,
            offset: 2_500,
        });
    });

    it('never writes a native hold correction from an unmounted row\'s estimate position beyond the tracking range', async () => {
        // Live native S-C residual (2026-07-11): during the expansion cascade the platform
        // collapses the offset, the anchor row leaves Legend's mounted window, and
        // positionAtIndex returns an estimate-phase cumulative sum while sizeAtIndex keeps
        // serving the sizesKnown CACHE entry. The legend-state landing treated that as
        // measured truth and steered the viewport into the garbage estimate. Estimate-basis
        // landings must obey the same CASCADE-FIX bar as web: never write beyond the
        // viewport tracking range.
        setPlatformOS('ios');
        let nowMs = 1_000;
        vi.spyOn(Date, 'now').mockImplementation(() => nowMs);
        const animationFrames: FrameRequestCallback[] = [];
        vi.stubGlobal('requestAnimationFrame', vi.fn((callback: FrameRequestCallback) => {
            animationFrames.push(callback);
            return animationFrames.length;
        }));
        vi.stubGlobal('cancelAnimationFrame', vi.fn());
        const { legendListRenderer } = await import('./legendListRenderer');
        const Renderer = legendListRenderer.Component;
        const listRef = React.createRef<TranscriptListShellRef<{ id: string }>>();
        let positions = [0, 240, 480, 720, 960];
        legendStateOverride = {
            contentLength: 1_200,
            end: 4,
            isAtEnd: false,
            isNearEnd: false,
            isWithinMaintainScrollAtEndThreshold: false,
            positionAtIndex: (index: number) => positions[index],
            scroll: 500,
            scrollLength: 600,
            sizeAtIndex: () => 240,
            start: 1,
        };
        await renderScreen(
            <Renderer
                webDomObservation={mountedWebDomObservation}
                ref={listRef}
                data={Array.from({ length: 5 }, (_value, index) => ({ id: `row-${index}` }))}
                dataKey="session-test"
                keyExtractor={(item: { id: string }) => item.id}
                renderItem={({ item }: { item: { id: string } }) => React.createElement('Row', { id: item.id })}
                frame={resolveMainTranscriptListShellFrame({
                    legendInitialScrollAtEnd: false,
                    nativeID: 'legend-main-native-id',
                    platformOS: 'ios',
                })}
            />,
        );

        getShellRef(listRef).armVisibleAnchorHold?.();
        assignedLegendRef.scrollToOffset.mockClear();

        // Expansion commit: the offset collapses, the mounted window slides to indices 0..1,
        // and the held row's position becomes a garbage estimate pages away (content grew to
        // 12,000 so the write would NOT be clamp-suppressed).
        nowMs = 1_400;
        positions = [0, 240, 8_020, 8_260, 8_500];
        legendStateOverride = {
            ...legendStateOverride,
            contentLength: 12_000,
            end: 1,
            scroll: 300,
            start: 0,
        };
        capturedLegendListProps.onItemSizeChanged({ index: 1, previous: 240, size: 2_240 });
        act(() => animationFrames.splice(0, animationFrames.length).forEach((callback) => callback(16)));
        // raw residual = (8,020 + 20) - 300 = 7,740 >> viewport 600: estimate basis, no write.
        expect(assignedLegendRef.scrollToOffset).not.toHaveBeenCalled();
    });

    it('keeps an estimate-aligned native hold unconfirmed and corrects when the anchor row remounts', async () => {
        // Live native S-C parking mechanism: after the offset collapse the estimate position
        // happens to read back "aligned" at the parked offset, the landing confirms against
        // its own estimate, polling goes dormant, and the viewport stays parked. An
        // estimate-basis landing must never confirm — the bounded window stays open so the
        // hold corrects with real geometry the moment the row remounts.
        setPlatformOS('ios');
        let nowMs = 1_000;
        vi.spyOn(Date, 'now').mockImplementation(() => nowMs);
        const animationFrames: FrameRequestCallback[] = [];
        vi.stubGlobal('requestAnimationFrame', vi.fn((callback: FrameRequestCallback) => {
            animationFrames.push(callback);
            return animationFrames.length;
        }));
        vi.stubGlobal('cancelAnimationFrame', vi.fn());
        const { legendListRenderer } = await import('./legendListRenderer');
        const Renderer = legendListRenderer.Component;
        const listRef = React.createRef<TranscriptListShellRef<{ id: string }>>();
        let positions = [0, 240, 480, 720, 960];
        legendStateOverride = {
            contentLength: 1_200,
            end: 4,
            isAtEnd: false,
            isNearEnd: false,
            isWithinMaintainScrollAtEndThreshold: false,
            positionAtIndex: (index: number) => positions[index],
            scroll: 500,
            scrollLength: 600,
            sizeAtIndex: () => 240,
            start: 1,
        };
        await renderScreen(
            <Renderer
                webDomObservation={mountedWebDomObservation}
                ref={listRef}
                data={Array.from({ length: 5 }, (_value, index) => ({ id: `row-${index}` }))}
                dataKey="session-test"
                keyExtractor={(item: { id: string }) => item.id}
                renderItem={({ item }: { item: { id: string } }) => React.createElement('Row', { id: item.id })}
                frame={resolveMainTranscriptListShellFrame({
                    legendInitialScrollAtEnd: false,
                    nativeID: 'legend-main-native-id',
                    platformOS: 'ios',
                })}
            />,
        );

        // Hold on row-2 with viewOffset -20 (position 480, scroll 500).
        getShellRef(listRef).armVisibleAnchorHold?.();
        assignedLegendRef.scrollToOffset.mockClear();

        // Collapse: row-2 unmounts, its estimate position (320) reads back aligned at the
        // parked offset 340 (target = 320 - (-20) = 340). Must NOT confirm.
        nowMs = 1_400;
        positions = [0, 240, 320, 560, 800];
        legendStateOverride = {
            ...legendStateOverride,
            contentLength: 3_200,
            end: 1,
            scroll: 340,
            start: 0,
        };
        capturedLegendListProps.onItemSizeChanged({ index: 1, previous: 240, size: 2_240 });
        expect(assignedLegendRef.scrollToOffset).not.toHaveBeenCalled();

        // Estimate-aligned polls must keep the transaction window open on their own (no
        // further external signals arrive while the viewport sits parked). A confirming
        // "aligned" read here lets the signal-opened window (ends 2,900) lapse.
        nowMs = 2_800;
        act(() => animationFrames.splice(0, animationFrames.length).forEach((callback) => callback(16)));
        expect(assignedLegendRef.scrollToOffset).not.toHaveBeenCalled();

        // Past the signal-opened window, inside the estimate-poll-refreshed one: the row
        // remounts with real geometry. The still-open transaction must correct to the true
        // target instead of staying dormant on its earlier estimate-aligned confirmation.
        nowMs = 3_100;
        positions = [0, 240, 2_480, 2_720, 2_960];
        legendStateOverride = {
            ...legendStateOverride,
            end: 4,
            scroll: 340,
            start: 1,
        };
        act(() => animationFrames.splice(0, animationFrames.length).forEach((callback) => callback(16)));
        expect(assignedLegendRef.scrollToOffset).toHaveBeenCalledWith({
            animated: false,
            offset: 2_500,
        });
    });

    it('re-observes the natively displayed offset into Legend state on screen reveal (S-E route-pop desync)', async () => {
        // Live native S-E capture (2026-07-11): after a tool-details route push/pop the
        // transcript shows a persistent blank region — Legend state believes an offset the
        // native scroll view is not at (a write issued/settled while the screen was covered
        // never became native truth), no scroll event arrives to re-observe, and the mounted
        // window is computed for the wrong offset until the user's first swipe delivers a
        // native event. On reveal the adapter must read the natively displayed offset from
        // the Fabric scroll host and feed it back through Legend so the window recomputes
        // where the user is actually looking.
        setPlatformOS('ios');
        const { legendListRenderer } = await import('./legendListRenderer');
        const Renderer = legendListRenderer.Component;
        const listRef = React.createRef<TranscriptListShellRef<{ id: string }>>();
        legendStateOverride = {
            contentLength: 2_013,
            end: 4,
            isAtEnd: true,
            isNearEnd: true,
            isWithinMaintainScrollAtEndThreshold: true,
            scroll: 1_240,
            scrollLength: 773,
            start: 3,
        };
        await renderScreen(
            <Renderer
                webDomObservation={mountedWebDomObservation}
                ref={listRef}
                data={Array.from({ length: 5 }, (_value, index) => ({ id: `row-${index}` }))}
                dataKey="session-test"
                keyExtractor={(item: { id: string }) => item.id}
                renderItem={({ item }: { item: { id: string } }) => React.createElement('Row', { id: item.id })}
                frame={resolveMainTranscriptListShellFrame({
                    legendInitialScrollAtEnd: false,
                    nativeID: 'legend-main-native-id',
                    platformOS: 'ios',
                })}
            />,
        );
        type NativeMeasureCallback = (
            x: number,
            y: number,
            width: number,
            height: number,
            pageX: number,
            pageY: number,
        ) => void;
        const pendingHostMeasurements: NativeMeasureCallback[] = [];
        const pendingInnerMeasurements: NativeMeasureCallback[] = [];
        const nativeScrollHost = {
            measure: vi.fn((onSuccess: NativeMeasureCallback) => {
                pendingHostMeasurements.push(onSuccess);
            }),
        };
        const nativeScrollableHandle = 41;
        const nativeMeasurementWarnings: string[] = [];
        const innerNode = {
            measure: vi.fn((onSuccess: NativeMeasureCallback) => {
                pendingInnerMeasurements.push(onSuccess);
            }),
        };
        assignedLegendRef.getNativeScrollRef = vi.fn(() => ({
            getInnerViewRef: () => innerNode,
            getInnerViewNode: () => innerNode,
            getNativeScrollRef: () => nativeScrollHost,
            getScrollableNode: () => nativeScrollableHandle,
        }));
        assignedLegendRef.scrollToOffset.mockClear();

        expect(typeof getShellRef(listRef).revalidateViewportAfterReveal).toBe('function');
        getShellRef(listRef).revalidateViewportAfterReveal?.();
        getShellRef(listRef).revalidateViewportAfterReveal?.();

        expect(nativeMeasurementWarnings).toEqual([]);
        expect(innerNode.measure).toHaveBeenCalledTimes(2);
        expect(nativeScrollHost.measure).toHaveBeenCalledTimes(2);
        // Complete the newer reveal sample first. Fabric `measure` includes the ScrollView
        // content transform: host pageY 80 minus content pageY -120 is displayed offset 200.
        act(() => {
            pendingInnerMeasurements[1]?.(0, 0, 320, 2_013, 0, -120);
            pendingHostMeasurements[1]?.(0, 0, 320, 773, 0, 80);
        });
        expect(assignedLegendRef.scrollToOffset).toHaveBeenCalledWith({
            animated: false,
            offset: 200,
        });
        // The superseded callbacks report another plausible physical offset but must not
        // overwrite the newer reveal observation.
        act(() => {
            pendingInnerMeasurements[0]?.(0, 0, 320, 2_013, 0, -420);
            pendingHostMeasurements[0]?.(0, 0, 320, 773, 0, 80);
        });
        expect(assignedLegendRef.scrollToOffset).toHaveBeenCalledTimes(1);
    });

    it('leaves an aligned viewport untouched on screen reveal', async () => {
        setPlatformOS('ios');
        const { legendListRenderer } = await import('./legendListRenderer');
        const Renderer = legendListRenderer.Component;
        const listRef = React.createRef<TranscriptListShellRef<{ id: string }>>();
        legendStateOverride = {
            contentLength: 2_013,
            end: 4,
            scroll: 1_240,
            scrollLength: 773,
            start: 3,
        };
        await renderScreen(
            <Renderer
                webDomObservation={mountedWebDomObservation}
                ref={listRef}
                data={Array.from({ length: 5 }, (_value, index) => ({ id: `row-${index}` }))}
                dataKey="session-test"
                keyExtractor={(item: { id: string }) => item.id}
                renderItem={({ item }: { item: { id: string } }) => React.createElement('Row', { id: item.id })}
                frame={resolveMainTranscriptListShellFrame({
                    legendInitialScrollAtEnd: false,
                    nativeID: 'legend-main-native-id',
                    platformOS: 'ios',
                })}
            />,
        );
        const nativeScrollHost = {
            measure: vi.fn((onSuccess: (x: number, y: number, width: number, height: number, pageX: number, pageY: number) => void) => {
                onSuccess(0, 0, 320, 773, 0, 80);
            }),
        };
        const innerNode = {
            measure: vi.fn((onSuccess: (x: number, y: number, width: number, height: number, pageX: number, pageY: number) => void) => {
                onSuccess(0, 0, 320, 2_013, 0, -1_160);
            }),
        };
        assignedLegendRef.getNativeScrollRef = vi.fn(() => ({
            getInnerViewRef: () => innerNode,
            getNativeScrollRef: () => nativeScrollHost,
        }));
        assignedLegendRef.scrollToOffset.mockClear();

        getShellRef(listRef).revalidateViewportAfterReveal?.();

        expect(innerNode.measure).toHaveBeenCalledTimes(1);
        expect(nativeScrollHost.measure).toHaveBeenCalledTimes(1);
        expect(assignedLegendRef.scrollToOffset).not.toHaveBeenCalled();
    });

    it('keeps screen-reveal revalidation off the web frame (DOM reads never lose observation)', async () => {
        const { legendListRenderer } = await import('./legendListRenderer');
        const Renderer = legendListRenderer.Component;
        const listRef = React.createRef<TranscriptListShellRef<{ id: string }>>();
        await renderScreen(
            <Renderer
                webDomObservation={mountedWebDomObservation}
                ref={listRef}
                data={[{ id: 'row-0' }]}
                dataKey="session-test"
                keyExtractor={(item: { id: string }) => item.id}
                renderItem={({ item }: { item: { id: string } }) => React.createElement('Row', { id: item.id })}
                frame={resolveMainTranscriptListShellFrame({
                    nativeID: 'legend-main-native-id',
                    platformOS: 'web',
                })}
            />,
        );
        assignedLegendRef.getNativeScrollRef = vi.fn();
        assignedLegendRef.scrollToOffset.mockClear();

        getShellRef(listRef).revalidateViewportAfterReveal?.();

        expect(assignedLegendRef.getNativeScrollRef).not.toHaveBeenCalled();
        expect(assignedLegendRef.scrollToOffset).not.toHaveBeenCalled();
    });

    it('does not arm a visible-anchor hold over a live tail-following state', async () => {
        setPlatformOS('ios');
        vi.spyOn(Date, 'now').mockImplementation(() => 1_000);
        const animationFrames = installAnimationFrameQueue();
        const { legendListRenderer } = await import('./legendListRenderer');
        const Renderer = legendListRenderer.Component;
        const listRef = React.createRef<TranscriptListShellRef<{ id: string }>>();
        legendStateOverride = {
            contentLength: 1_200,
            end: 4,
            isAtEnd: true,
            isNearEnd: true,
            isWithinMaintainScrollAtEndThreshold: true,
            scroll: 600,
            scrollLength: 600,
            start: 1,
        };
        await renderScreen(
            <Renderer
                webDomObservation={mountedWebDomObservation}
                ref={listRef}
                data={Array.from({ length: 5 }, (_value, index) => ({ id: `row-${index}` }))}
                dataKey="session-test"
                keyExtractor={(item: { id: string }) => item.id}
                renderItem={({ item }: { item: { id: string } }) => React.createElement('Row', { id: item.id })}
                frame={resolveMainTranscriptListShellFrame({
                    nativeID: 'legend-main-native-id',
                    platformOS: 'ios',
                })}
            />,
        );
        // Entry frame is at-end: the held-'end'/maintain machinery owns the pinned case, so
        // arming must not replace it with a keyed index hold.
        getShellRef(listRef).armVisibleAnchorHold?.();
        assignedLegendRef.scrollToOffset.mockClear();
        legendStateOverride = {
            ...legendStateOverride,
            contentLength: 2_000,
            isAtEnd: false,
            isNearEnd: false,
            isWithinMaintainScrollAtEndThreshold: false,
            scroll: 600,
        };
        capturedLegendListProps.onItemSizeChanged({ index: 4, previous: 240, size: 1_040 });
        act(() => animationFrames.shift()?.(1_000));
        // Beyond Legend's threshold, held-'end' corrects to the tail (1,400), not to a
        // captured mid-list anchor.
        expect(assignedLegendRef.scrollToOffset).toHaveBeenCalledWith({
            animated: false,
            offset: 1_400,
        });
    });

    it('keeps native held-end ownership through a bare touch and releases it only when a drag begins', async () => {
        setPlatformOS('ios');
        let nowMs = 1_000;
        vi.spyOn(Date, 'now').mockImplementation(() => nowMs);
        const animationFrames = installAnimationFrameQueue();
        const { legendListRenderer } = await import('./legendListRenderer');
        const Renderer = legendListRenderer.Component;
        const listRef = React.createRef<TranscriptListShellRef<{ id: string }>>();
        const onTouchStart = vi.fn();
        const onScrollBeginDrag = vi.fn();
        legendStateOverride = {
            contentLength: 1_200,
            end: 4,
            isAtEnd: true,
            isNearEnd: true,
            isWithinMaintainScrollAtEndThreshold: true,
            scroll: 600,
            scrollLength: 600,
            start: 1,
        };
        await renderScreen(
            <Renderer
                webDomObservation={mountedWebDomObservation}
                ref={listRef}
                data={Array.from({ length: 5 }, (_value, index) => ({ id: `row-${index}` }))}
                dataKey="native-touch-held-end"
                keyExtractor={(item: { id: string }) => item.id}
                renderItem={({ item }: { item: { id: string } }) => React.createElement('Row', { id: item.id })}
                frame={resolveMainTranscriptListShellFrame({
                    legendInitialScrollAtEnd: true,
                    nativeID: 'legend-main-native-id',
                    platformOS: 'ios',
                })}
                onScrollBeginDrag={onScrollBeginDrag}
                platformInteractionProps={{ onTouchStart }}
            />,
        );

        const touchEvent = { nativeEvent: { pageY: 300 } };
        assignedLegendRef.cancelInitialScrollPreservation.mockClear();
        capturedLegendListProps.onTouchStart(touchEvent);
        expect(onTouchStart).toHaveBeenCalledWith(touchEvent);
        expect(assignedLegendRef.cancelInitialScrollPreservation).not.toHaveBeenCalled();

        nowMs = 2_000;
        assignedLegendRef.scrollToOffset.mockClear();
        legendStateOverride = {
            ...legendStateOverride,
            contentLength: 2_000,
            isAtEnd: false,
            isNearEnd: false,
            isWithinMaintainScrollAtEndThreshold: false,
        };
        capturedLegendListProps.onItemSizeChanged({ index: 4, previous: 240, size: 1_040 });
        act(() => animationFrames.shift()?.(nowMs));
        expect(assignedLegendRef.scrollToOffset).toHaveBeenCalledWith({
            animated: false,
            offset: 1_400,
        });
        expect(capturedLegendListProps.maintainScrollAtEnd).toMatchObject({ animated: false });

        const dragEvent = { nativeEvent: { contentOffset: { x: 0, y: 600 } } };
        capturedLegendListProps.onScrollBeginDrag(dragEvent);
        expect(onScrollBeginDrag).toHaveBeenCalledWith(dragEvent);
        expect(assignedLegendRef.cancelInitialScrollPreservation).toHaveBeenCalledTimes(1);
        expect(capturedLegendListProps.maintainScrollAtEnd).toBe(false);
    });

    it('does not let a bare native touch reuse recent drag evidence for a later layout detach', async () => {
        setPlatformOS('ios');
        let nowMs = 1_000;
        vi.spyOn(Date, 'now').mockImplementation(() => nowMs);
        const { legendListRenderer } = await import('./legendListRenderer');
        const Renderer = legendListRenderer.Component;
        const listRef = React.createRef<TranscriptListShellRef<{ id: string }>>();
        const published: Array<{ cause: string; isFollowing: boolean }> = [];
        legendStateOverride = {
            contentLength: 1_200,
            end: 4,
            isAtEnd: true,
            isNearEnd: true,
            isWithinMaintainScrollAtEndThreshold: true,
            scroll: 600,
            scrollLength: 600,
            start: 1,
        };
        await renderScreen(
            <Renderer
                webDomObservation={mountedWebDomObservation}
                ref={listRef}
                data={Array.from({ length: 5 }, (_value, index) => ({ id: `row-${index}` }))}
                dataKey="native-touch-cause"
                keyExtractor={(item: { id: string }) => item.id}
                renderItem={({ item }: { item: { id: string } }) => React.createElement('Row', { id: item.id })}
                frame={resolveMainTranscriptListShellFrame({
                    legendInitialScrollAtEnd: true,
                    nativeID: 'legend-main-native-id',
                    platformOS: 'ios',
                })}
                onRendererAtEndChange={(state, context) => {
                    published.push({ cause: context.cause, isFollowing: state.isFollowing });
                }}
            />,
        );
        capturedLegendListProps.onScroll({ nativeEvent: { contentOffset: { x: 0, y: 600 } } });

        const dragEvent = { nativeEvent: { contentOffset: { x: 0, y: 600 } } };
        capturedLegendListProps.onScrollBeginDrag(dragEvent);
        expect(capturedLegendListProps.maintainScrollAtEnd).toBe(false);
        capturedLegendListProps.onScroll(dragEvent);
        capturedLegendListProps.onScrollEndDrag(dragEvent);

        nowMs = 1_300;
        await act(async () => {
            for (const listener of legendStateListeners.get('isAtEnd') ?? []) {
                listener(true);
            }
        });
        expect(capturedLegendListProps.maintainScrollAtEnd).toMatchObject({ animated: false });

        published.length = 0;
        capturedLegendListProps.onTouchStart({ nativeEvent: { pageY: 300 } });
        nowMs = 1_400;
        legendStateOverride = {
            ...legendStateOverride,
            contentLength: 2_000,
            isAtEnd: false,
            isNearEnd: false,
            isWithinMaintainScrollAtEndThreshold: false,
            scroll: 500,
        };
        capturedLegendListProps.onScroll({ nativeEvent: { contentOffset: { x: 0, y: 500 } } });

        expect(published).not.toContainEqual({ cause: 'user', isFollowing: false });
        expect(capturedLegendListProps.maintainScrollAtEnd).toMatchObject({ animated: false });
    });

    it('repairs a native entry-anchor landing when preceding giant rows grow after the index command', async () => {
        setPlatformOS('ios');
        let nowMs = 1_000;
        vi.spyOn(Date, 'now').mockImplementation(() => nowMs);
        const animationFrames = installAnimationFrameQueue();
        const { legendListRenderer } = await import('./legendListRenderer');
        const Renderer = legendListRenderer.Component;
        const listRef = React.createRef<TranscriptListShellRef<{ id: string }>>();
        let positions = [0, 240, 480, 720, 960];

        legendStateOverride = {
            contentLength: 1_200,
            end: 4,
            isAtEnd: false,
            isNearEnd: false,
            isWithinMaintainScrollAtEndThreshold: false,
            positionAtIndex: (index: number) => positions[index],
            scroll: 440,
            scrollLength: 600,
            sizeAtIndex: () => 240,
            start: 1,
        };
        await renderScreen(
            <Renderer
                webDomObservation={mountedWebDomObservation}
                ref={listRef}
                data={Array.from({ length: 5 }, (_value, index) => ({ id: `row-${index}` }))}
                dataKey="session-test"
                keyExtractor={(item: { id: string }) => item.id}
                renderItem={({ item }: { item: { id: string } }) => React.createElement('Row', { id: item.id })}
                frame={resolveMainTranscriptListShellFrame({
                    legendInitialScrollAtEnd: false,
                    nativeID: 'legend-main-native-id',
                    platformOS: 'ios',
                })}
            />,
        );

        getShellRef(listRef).scrollToIndex({ index: 2, animated: false, viewOffset: 40 });
        expect(assignedLegendRef.scrollToIndex).toHaveBeenCalledWith({
            index: 2,
            animated: false,
            viewOffset: 40,
        });
        assignedLegendRef.scrollToOffset.mockClear();

        positions = [0, 3_000, 3_240, 3_480, 3_720];
        legendStateOverride = {
            ...legendStateOverride,
            contentLength: 3_960,
            scroll: 440,
        };
        capturedLegendListProps.onItemSizeChanged({ index: 0, previous: 240, size: 3_000 });
        act(() => animationFrames.shift()?.(nowMs));

        expect(assignedLegendRef.scrollToOffset).toHaveBeenCalledWith({
            animated: false,
            offset: 3_200,
        });

        // Identity survives a quiet polling window and resumes from fresh settle evidence.
        // The former fixed 1.5s expiry discarded this late giant-row measurement entirely.
        nowMs += 4_000;
        positions = [0, 5_000, 5_240, 5_480, 5_720];
        legendStateOverride = {
            ...legendStateOverride,
            contentLength: 5_960,
            scroll: 3_200,
        };
        capturedLegendListProps.onItemSizeChanged({ index: 0, previous: 3_000, size: 5_000 });
        act(() => animationFrames.shift()?.(nowMs));
        expect(assignedLegendRef.scrollToOffset).toHaveBeenLastCalledWith({
            animated: false,
            offset: 5_200,
        });
    });

    it('lets keyboard input cancel a held native target before later layout correction', async () => {
        setPlatformOS('ios');
        const { legendListRenderer } = await import('./legendListRenderer');
        const Renderer = legendListRenderer.Component;
        const listRef = React.createRef<TranscriptListShellRef<{ id: string }>>();
        legendStateOverride = {
            contentLength: 1_200,
            end: 0,
            isAtEnd: true,
            isNearEnd: true,
            isWithinMaintainScrollAtEndThreshold: true,
            scroll: 600,
            scrollLength: 600,
            start: 0,
        };
        await renderScreen(
            <Renderer
                webDomObservation={mountedWebDomObservation}
                ref={listRef}
                data={[{ id: 'row-1' }]}
                dataKey="keyboard-session"
                keyExtractor={(item: { id: string }) => item.id}
                renderItem={({ item }: { item: { id: string } }) => React.createElement('Row', { id: item.id })}
                frame={resolveMainTranscriptListShellFrame({
                    nativeID: 'legend-main-native-id',
                    platformOS: 'ios',
                })}
            />,
        );
        getShellRef(listRef).notifyViewportInput?.({
            kind: 'keyboard',
            verticalDirection: 'toward-start',
        });
        assignedLegendRef.scrollToOffset.mockClear();
        legendStateOverride = {
            ...legendStateOverride,
            contentLength: 9_000,
            isAtEnd: false,
            isNearEnd: false,
            isWithinMaintainScrollAtEndThreshold: false,
            scroll: 1_800,
        };
        capturedLegendListProps.onItemSizeChanged({ index: 0, previous: 240, size: 7_800 });
        expect(assignedLegendRef.scrollToOffset).not.toHaveBeenCalled();
    });

    it('repairs a far native jump-to-bottom again when a later giant-row measurement moves the tail', async () => {
        setPlatformOS('ios');
        const animationFrames = installAnimationFrameQueue();
        const { legendListRenderer } = await import('./legendListRenderer');
        const Renderer = legendListRenderer.Component;
        const listRef = React.createRef<TranscriptListShellRef<{ id: string }>>();

        legendStateOverride = {
            contentLength: 2_400,
            end: 9,
            isAtEnd: false,
            isNearEnd: false,
            isWithinMaintainScrollAtEndThreshold: false,
            positionAtIndex: (index: number) => index * 240,
            scroll: 200,
            scrollLength: 600,
            sizeAtIndex: () => 240,
            start: 0,
        };
        await renderScreen(
            <Renderer
                webDomObservation={mountedWebDomObservation}
                ref={listRef}
                data={Array.from({ length: 10 }, (_value, index) => ({ id: `row-${index}` }))}
                dataKey="session-test"
                keyExtractor={(item: { id: string }) => item.id}
                renderItem={({ item }: { item: { id: string } }) => React.createElement('Row', { id: item.id })}
                frame={resolveMainTranscriptListShellFrame({
                    legendInitialScrollAtEnd: false,
                    nativeID: 'legend-main-native-id',
                    platformOS: 'ios',
                })}
            />,
        );

        getShellRef(listRef).scrollToEnd?.({ animated: false });
        assignedLegendRef.scrollToOffset.mockClear();
        legendStateOverride = {
            ...legendStateOverride,
            contentLength: 12_000,
            scroll: 1_800,
        };
        capturedLegendListProps.onLoad({ elapsedTimeInMs: 20 });
        expect(assignedLegendRef.scrollToOffset).toHaveBeenLastCalledWith({
            animated: false,
            offset: 11_400,
        });

        // The transaction stays available for later measurement signals within its bounded
        // window, but writes only the newly observed residual rather than replaying the jump.
        legendStateOverride = {
            ...legendStateOverride,
            contentLength: 13_000,
            scroll: 11_400,
        };
        capturedLegendListProps.onItemSizeChanged({ index: 8, previous: 240, size: 1_240 });
        act(() => animationFrames.shift()?.(16));
        expect(assignedLegendRef.scrollToOffset).toHaveBeenLastCalledWith({
            animated: false,
            offset: 12_400,
        });
        expect(assignedLegendRef.scrollToEnd).toHaveBeenCalledTimes(1);
    });

    it('does not re-target native geometry changes after a genuine user drag detach', async () => {
        setPlatformOS('ios');
        const { legendListRenderer } = await import('./legendListRenderer');
        const Renderer = legendListRenderer.Component;
        const onScrollBeginDrag = vi.fn();

        legendStateOverride = {
            contentLength: 1200,
            end: 0,
            isAtEnd: true,
            isNearEnd: true,
            isWithinMaintainScrollAtEndThreshold: true,
            scroll: 600,
            scrollLength: 600,
            start: 0,
        };
        const screen = await renderScreen(
            <Renderer
                webDomObservation={mountedWebDomObservation}
                data={[{ id: 'row-1' }]}
                dataKey="session-test"
                keyExtractor={(item: { id: string }) => item.id}
                renderItem={({ item }: { item: { id: string } }) => React.createElement('Row', { id: item.id })}
                frame={resolveMainTranscriptListShellFrame({
                    nativeID: 'legend-main-native-id',
                    platformOS: 'ios',
                })}
                header={React.createElement('BottomSlot')}
                onScrollBeginDrag={onScrollBeginDrag}
            />,
        );
        const identityHost = screen.tree.root.findByProps({ nativeID: 'legend-main-native-id' });
        identityHost.props.onLayout({ nativeEvent: { layout: { height: 670, width: 800, x: 0, y: 0 } } });
        capturedLegendListProps.ListFooterComponent.props.onLayout({
            nativeEvent: { layout: { height: 40, width: 800, x: 0, y: 0 } },
        });
        assignedLegendRef.scrollToEnd.mockClear();

        // A genuine user drag away from the tail releases the held intent; later beyond-threshold
        // geometry changes must stay renderer-inert for the detached reader.
        const dragEvent = { nativeEvent: { contentOffset: { x: 0, y: 600 } } };
        capturedLegendListProps.onScrollBeginDrag(dragEvent);
        expect(onScrollBeginDrag).toHaveBeenCalledWith(dragEvent);
        legendStateOverride = {
            ...legendStateOverride,
            isAtEnd: false,
            isNearEnd: false,
            isWithinMaintainScrollAtEndThreshold: false,
            scroll: 200,
        };
        capturedLegendListProps.onScroll({ nativeEvent: { contentOffset: { x: 0, y: 200 } } });
        capturedLegendListProps.ListFooterComponent.props.onLayout({
            nativeEvent: { layout: { height: 192, width: 800, x: 0, y: 0 } },
        });

        expect(assignedLegendRef.scrollToEnd).not.toHaveBeenCalled();
    });

    it('preserves a held tail through visual-bottom slot renders without an app steady write', async () => {
        const { legendListRenderer } = await import('./legendListRenderer');
        const Renderer = legendListRenderer.Component;
        const listRef = React.createRef<TranscriptListShellRef<{ id: string }>>();
        const render = (phase: number) => (
            <Renderer
                webDomObservation={mountedWebDomObservation}
                ref={listRef}
                data={[{ id: 'row-1' }]}
                dataKey="session-test"
                keyExtractor={(item: { id: string }) => item.id}
                renderItem={({ item }: { item: { id: string } }) => React.createElement('Row', { id: item.id })}
                frame={resolveMainTranscriptListShellFrame({
                    nativeID: 'legend-main-native-id',
                    platformOS: 'web',
                })}
                footer={React.createElement('BottomSlot', { phase })}
            />
        );

        legendStateOverride = {
            contentLength: 1200,
            end: 0,
            isAtEnd: true,
            isNearEnd: true,
            isWithinMaintainScrollAtEndThreshold: true,
            scroll: 600,
            scrollLength: 600,
            start: 0,
        };
        const screen = await renderScreen(render(1));
        assignedLegendRef.scrollToEnd.mockClear();

        legendStateOverride = {
            ...legendStateOverride,
            isAtEnd: false,
            isNearEnd: false,
            isWithinMaintainScrollAtEndThreshold: false,
            scroll: 200,
        };
        await screen.update(render(2));

        expect(assignedLegendRef.scrollToEnd).not.toHaveBeenCalled();
        expect(getShellRef(listRef).hasLiveWebHold?.({ kind: 'end' })).toBe(true);

        capturedLegendListProps.onWheel({ deltaY: -300 });
        capturedLegendListProps.onScroll({ nativeEvent: { contentOffset: { x: 0, y: 200 } } });
        assignedLegendRef.scrollToEnd.mockClear();
        await screen.update(render(3));
        expect(assignedLegendRef.scrollToEnd).not.toHaveBeenCalled();
        expect(getShellRef(listRef).hasLiveWebHold?.({ kind: 'end' })).toBe(false);
    });

    it('keeps host viewport-geometry notifications semantic under Legend-owned web follow', async () => {
        const { legendListRenderer } = await import('./legendListRenderer');
        const Renderer = legendListRenderer.Component;
        const listRef = React.createRef<TranscriptListShellRef<{ id: string }>>();

        legendStateOverride = {
            contentLength: 1200,
            end: 0,
            isAtEnd: true,
            isNearEnd: true,
            isWithinMaintainScrollAtEndThreshold: true,
            scroll: 600,
            scrollLength: 600,
            start: 0,
        };
        await renderScreen(
            <Renderer
                webDomObservation={mountedWebDomObservation}
                ref={listRef}
                data={[{ id: 'row-1' }]}
                dataKey="session-test"
                keyExtractor={(item: { id: string }) => item.id}
                renderItem={({ item }: { item: { id: string } }) => React.createElement('Row', { id: item.id })}
                frame={resolveMainTranscriptListShellFrame({
                    nativeID: 'legend-main-native-id',
                    platformOS: 'web',
                })}
            />,
        );

        assignedLegendRef.scrollToEnd.mockClear();
        legendStateOverride = {
            ...legendStateOverride,
            isAtEnd: false,
            isNearEnd: false,
            isWithinMaintainScrollAtEndThreshold: false,
            scroll: 200,
        };
        listRef.current?.notifyViewportGeometryChanged?.();
        expect(assignedLegendRef.scrollToEnd).not.toHaveBeenCalled();
        expect(getShellRef(listRef).hasLiveWebHold?.({ kind: 'end' })).toBe(true);

        capturedLegendListProps.onWheel({ deltaY: -300 });
        capturedLegendListProps.onScroll({ nativeEvent: { contentOffset: { x: 0, y: 200 } } });
        assignedLegendRef.scrollToEnd.mockClear();
        listRef.current?.notifyViewportGeometryChanged?.();
        expect(assignedLegendRef.scrollToEnd).not.toHaveBeenCalled();
        expect(getShellRef(listRef).hasLiveWebHold?.({ kind: 'end' })).toBe(false);
    });

    it('keeps the semantic web tail through layout settle without app retries and cancels on user detach', async () => {
        let nowMs = 1_000;
        vi.spyOn(Date, 'now').mockImplementation(() => nowMs);
        const animationFrames: FrameRequestCallback[] = [];
        const requestAnimationFrame = vi.fn((callback: FrameRequestCallback) => {
            animationFrames.push(callback);
            return animationFrames.length;
        });
        const cancelAnimationFrame = vi.fn();
        vi.stubGlobal('requestAnimationFrame', requestAnimationFrame);
        vi.stubGlobal('cancelAnimationFrame', cancelAnimationFrame);
        const { legendListRenderer } = await import('./legendListRenderer');
        const Renderer = legendListRenderer.Component;
        const listRef = React.createRef<TranscriptListShellRef<{ id: string }>>();
        const onWheel = vi.fn();

        legendStateOverride = {
            contentLength: 1200,
            end: 0,
            isAtEnd: true,
            isNearEnd: true,
            isWithinMaintainScrollAtEndThreshold: true,
            scroll: 600,
            scrollLength: 600,
            start: 0,
        };
        await renderScreen(
            <Renderer
                webDomObservation={mountedWebDomObservation}
                ref={listRef}
                data={[{ id: 'row-1' }]}
                dataKey="session-test"
                keyExtractor={(item: { id: string }) => item.id}
                renderItem={({ item }: { item: { id: string } }) => React.createElement('Row', { id: item.id })}
                frame={resolveMainTranscriptListShellFrame({
                    nativeID: 'legend-main-native-id',
                    platformOS: 'web',
                })}
                platformInteractionProps={{ onWheel }}
            />,
        );

        assignedLegendRef.scrollToEnd.mockClear();
        listRef.current?.notifyViewportGeometryChanged?.();
        expect(assignedLegendRef.scrollToEnd).not.toHaveBeenCalled();
        expect(requestAnimationFrame).toHaveBeenCalledTimes(1);

        act(() => animationFrames.shift()?.(16));
        expect(requestAnimationFrame).toHaveBeenCalledTimes(2);
        legendStateOverride = {
            ...legendStateOverride,
            isAtEnd: false,
            isNearEnd: true,
            isWithinMaintainScrollAtEndThreshold: true,
            scroll: 200,
        };
        // Live Chromium/Legend can replay the pre-resize offset just over one second after
        // the last composer layout change. The held-tail transaction must still own that
        // late rollback so an effective-20Hz observer never sees the stale bottom.
        nowMs = 2_100;
        act(() => animationFrames.shift()?.(32));
        expect(assignedLegendRef.scrollToEnd).not.toHaveBeenCalled();
        expect(getShellRef(listRef).hasLiveWebHold?.({ kind: 'end' })).toBe(true);
        expect(requestAnimationFrame).toHaveBeenCalledTimes(3);

        capturedLegendListProps.onScroll({ nativeEvent: { contentOffset: { x: 0, y: 200 } } });
        expect(assignedLegendRef.scrollToEnd).not.toHaveBeenCalled();
        expect(getShellRef(listRef).hasLiveWebHold?.({ kind: 'end' })).toBe(true);
        act(() => animationFrames.shift()?.(48));
        expect(assignedLegendRef.scrollToEnd).not.toHaveBeenCalled();

        capturedLegendListProps.onWheel({ type: 'wheel' });
        expect(onWheel).toHaveBeenCalledWith({ type: 'wheel' });
        assignedLegendRef.scrollToEnd.mockClear();
        listRef.current?.notifyViewportGeometryChanged?.();
        expect(assignedLegendRef.scrollToEnd).not.toHaveBeenCalled();
        expect(getShellRef(listRef).hasLiveWebHold?.({ kind: 'end' })).toBe(false);
    });

    it('materializes a held web tail once without adding a second offset correction', async () => {
        const { legendListRenderer } = await import('./legendListRenderer');
        const Renderer = legendListRenderer.Component;
        legendStateOverride = {
            contentLength: 1_200,
            end: 0,
            endBuffered: 0,
            isAtEnd: true,
            isNearEnd: true,
            isWithinMaintainScrollAtEndThreshold: true,
            // Legend resolves an offset for every index after a data change, including the
            // appended one it has not mounted yet. The adapter's one-shot materialization
            // targets that resolved offset; without one there is nothing to target and
            // placement stays with the library.
            positionAtIndex: (index: number) => index * 600,
            scroll: 600,
            scrollLength: 600,
            start: 0,
            startBuffered: 0,
        };
        const render = (data: Array<{ id: string }>) => (
            <Renderer
                webDomObservation={mountedWebDomObservation}
                data={data}
                dataKey="materialization-owner-session"
                keyExtractor={(item: { id: string }) => item.id}
                renderItem={({ item }: { item: { id: string } }) => React.createElement('Row', { id: item.id })}
                frame={resolveMainTranscriptListShellFrame({
                    nativeID: 'legend-main-native-id',
                    platformOS: 'web',
                })}
            />
        );
        const screen = await renderScreen(render([{ id: 'row-1' }]));
        assignedLegendRef.scrollToEnd.mockClear();
        assignedLegendRef.scrollToIndex.mockClear();
        assignedLegendRef.scrollToOffset.mockClear();

        await screen.update(render([{ id: 'row-1' }, { id: 'row-2' }]));
        // Materialization is commanded by Legend's END intent, which re-derives the tail index
        // at run time. A frozen index is resolved when the deferred request runs and collapses
        // to offset 0 - the HEAD - whenever the position table cannot place it (8 such landings
        // per cold open, measured 2026-07-30).
        expect(assignedLegendRef.scrollToIndex).not.toHaveBeenCalled();
        expect(assignedLegendRef.scrollToEnd).toHaveBeenCalledWith({ animated: false });
        expect(assignedLegendRef.scrollToEnd).toHaveBeenCalledTimes(1);

        assignedLegendRef.scrollToEnd.mockClear();
        assignedLegendRef.scrollToIndex.mockClear();
        legendStateOverride = { ...legendStateOverride, end: 1, endBuffered: 1, scroll: 840 };
        capturedLegendListProps.onItemSizeChanged({ index: 1, previous: 100, size: 400 });
        expect(assignedLegendRef.scrollToEnd).not.toHaveBeenCalled();
        expect(assignedLegendRef.scrollToIndex).not.toHaveBeenCalled();
        expect(assignedLegendRef.scrollToOffset).not.toHaveBeenCalled();
    });

    it('enables Legend steady maintenance only while held-end owns positioning', async () => {
        const { legendListRenderer } = await import('./legendListRenderer');
        const Renderer = legendListRenderer.Component;
        const listRef = React.createRef<TranscriptListShellRef<{ id: string }>>();
        await renderScreen(
            <Renderer
                webDomObservation={mountedWebDomObservation}
                ref={listRef}
                data={[{ id: 'row-1' }, { id: 'row-2' }]}
                dataKey="phase-owner-session"
                keyExtractor={(item: { id: string }) => item.id}
                renderItem={({ item }: { item: { id: string } }) => React.createElement('Row', { id: item.id })}
                frame={resolveMainTranscriptListShellFrame({
                    legendInitialScrollAtEnd: true,
                    nativeID: 'legend-main-native-id',
                    platformOS: 'web',
                })}
            />,
        );
        expect(capturedLegendListProps.maintainScrollAtEnd).toMatchObject({ animated: false });

        act(() => {
            getShellRef(listRef).scrollToIndex?.({ animated: false, index: 0 });
        });
        expect(capturedLegendListProps.maintainScrollAtEnd).toBe(false);

        act(() => {
            getShellRef(listRef).releaseWebHeldIntent?.();
        });
        expect(capturedLegendListProps.maintainScrollAtEnd).toBe(false);

        const firstOperation = Symbol('first-jump');
        const secondOperation = Symbol('second-jump');
        let releaseFirstOperation: (() => void) | undefined;
        let releaseSecondOperation: (() => void) | undefined;
        assignedLegendRef.cancelInitialScrollPreservation.mockClear();
        act(() => {
            releaseFirstOperation = (getShellRef(listRef).beginExplicitJumpTakeover as
                | ((operation: symbol) => (() => void) | undefined)
                | undefined)?.(firstOperation);
        });
        expect(assignedLegendRef.cancelInitialScrollPreservation).toHaveBeenCalledTimes(1);
        expect(getShellRef(listRef).hasLiveWebHold?.({ kind: 'end' })).toBe(false);
        expect(capturedLegendListProps.maintainScrollAtEnd).toBe(false);

        act(() => {
            releaseSecondOperation = (getShellRef(listRef).beginExplicitJumpTakeover as
                | ((operation: symbol) => (() => void) | undefined)
                | undefined)?.(secondOperation);
        });
        expect(capturedLegendListProps.maintainScrollAtEnd).toBe(false);

        act(() => {
            getShellRef(listRef).scrollToEnd?.({ animated: false });
        });
        expect(capturedLegendListProps.maintainScrollAtEnd).toBe(false);

        act(() => {
            releaseFirstOperation?.();
        });
        expect(capturedLegendListProps.maintainScrollAtEnd).toBe(false);

        act(() => {
            releaseSecondOperation?.();
        });
        expect(capturedLegendListProps.maintainScrollAtEnd).toMatchObject({ animated: false });
    });

    it('contains async Legend ref methods behind the synchronous shell ref contract', async () => {
        const { legendListRenderer } = await import('./legendListRenderer');
        const Renderer = legendListRenderer.Component;
        const listRef = React.createRef<TranscriptListShellRef<{ id: string }>>();

        await renderScreen(
            <Renderer
                webDomObservation={mountedWebDomObservation}
                ref={listRef}
                data={[{ id: 'row-1' }, { id: 'row-2' }]}
                dataKey="session-test"
                keyExtractor={(item: { id: string }) => item.id}
                renderItem={({ item }: { item: { id: string } }) => React.createElement('Row', { id: item.id })}
                frame={resolveReadOnlyTranscriptListShellFrame({
                    accessKind: 'public',
                    bottomNoticeVisible: false,
                    platformOS: 'web',
                })}
            />,
        );

        const shellRef = getShellRef(listRef);
        expect(shellRef.scrollToIndex?.({ index: 1, animated: false })).toBeUndefined();
        expect(shellRef.scrollToOffset?.({ offset: 120, animated: false })).toBeUndefined();
        expect(shellRef.scrollToEnd?.({ animated: false })).toBeUndefined();
        expect(assignedLegendRef.scrollToIndex).toHaveBeenCalledWith({ index: 1, animated: false });
        expect(assignedLegendRef.scrollToOffset).toHaveBeenCalledWith({ offset: 120, animated: false });
        expect(assignedLegendRef.scrollToEnd).toHaveBeenCalledWith({ animated: false });
        expect(shellRef.computeVisibleIndices?.()).toEqual({ startIndex: 0, endIndex: 1 });
        expect(shellRef.getAbsoluteLastScrollOffset?.()).toBe(0);
        expect(shellRef.getFirstVisibleIndex?.()).toBe(0);
        expect(shellRef.getLayout?.(1)).toBeUndefined();

        rejectNextScroll = true;
        expect(shellRef.scrollToOffset?.({ offset: 240, animated: false })).toBeUndefined();
        await Promise.resolve();
    });

    it('keeps rejected Legend index commands in the keyed transaction instead of fabricating recovery math', async () => {
        const { legendListRenderer } = await import('./legendListRenderer');
        const Renderer = legendListRenderer.Component;
        const listRef = React.createRef<TranscriptListShellRef<{ id: string }>>();
        const onScrollToIndexFailed = vi.fn();

        legendStateOverride = {
            end: 2,
            positionAtIndex: (index: number) => index * 120,
            scroll: 0,
            scrollLength: 360,
            sizeAtIndex: () => 120,
            start: 0,
        };

        await renderScreen(
            <Renderer
                webDomObservation={mountedWebDomObservation}
                ref={listRef}
                data={[{ id: 'newest' }, { id: 'middle' }, { id: 'oldest' }]}
                dataKey="session-test"
                keyExtractor={(item: { id: string }) => item.id}
                renderItem={({ item }: { item: { id: string } }) => React.createElement('Row', { id: item.id })}
                frame={resolveMainTranscriptListShellFrame({
                    nativeID: 'legend-main-native-id',
                    platformOS: 'ios',
                })}
                onScrollToIndexFailed={onScrollToIndexFailed}
            />,
        );

        rejectNextScroll = true;
        expect(getShellRef(listRef).scrollToIndex?.({ index: 0, animated: false })).toBeUndefined();
        await Promise.resolve();

        expect(assignedLegendRef.scrollToIndex).toHaveBeenCalledWith({ index: 2, animated: false });
        expect(onScrollToIndexFailed).not.toHaveBeenCalled();
    });

    it('hosts the shell identity on an adapter-owned wrapper because Legend does not forward it to the DOM', async () => {
        // @legendapp/list 3.3.0 never renders nativeID/testID onto any DOM node (zero
        // occurrences in the dist). On web the entire viewport ownership stack resolves its
        // scroll container from document.getElementById(nativeID) and descends to the
        // scrollable — so the adapter must render the identity on its own wrapper View that
        // is an ancestor of the Legend scroller. Passing identity into LegendList props is a
        // silent no-op and is intentionally NOT done (avoids future duplicate-id risk).
        const { legendListRenderer } = await import('./legendListRenderer');
        const Renderer = legendListRenderer.Component;

        const screen = await renderScreen(
            <Renderer
                webDomObservation={mountedWebDomObservation}
                data={[{ id: 'row-1' }]}
                dataKey="session-test"
                keyExtractor={(item: { id: string }) => item.id}
                renderItem={({ item }: { item: { id: string } }) => React.createElement('Row', { id: item.id })}
                frame={resolveMainTranscriptListShellFrame({
                    nativeID: 'legend-main-native-id',
                    platformOS: 'web',
                })}
            />,
        );

        const identityHost = screen.tree.root.findByProps({ nativeID: 'legend-main-native-id' });
        expect(identityHost.props.testID).toBe('transcript-chat-list');
        // The Legend list must render INSIDE the identity host so getElementById(nativeID)
        // followed by scrollable-descendant resolution finds the Legend scroller.
        expect(identityHost.findByType('LegendList' as any)).toBeTruthy();
        // Identity is not passed into Legend props (library ignores it; wrapper owns it).
        expect(capturedLegendListProps.nativeID).toBeUndefined();
        expect(capturedLegendListProps.testID).toBeUndefined();
    });

    it('maps shell source-index commands and visible facts across chronological Legend data', async () => {
        const { legendListRenderer } = await import('./legendListRenderer');
        const Renderer = legendListRenderer.Component;
        const listRef = React.createRef<TranscriptListShellRef<{ id: string }>>();
        const renderItemCalls: Array<{ id: string; index: number }> = [];
        const getItemTypeCalls: Array<{ id: string; index: number }> = [];

        legendStateOverride = {
            end: 1,
            positionAtIndex: (index: number) => index * 100,
            scroll: 120,
            scrollLength: 300,
            sizeAtIndex: () => 100,
            start: 0,
        };

        await renderScreen(
            <Renderer
                webDomObservation={mountedWebDomObservation}
                ref={listRef}
                data={[
                    { id: 'newest' },
                    { id: 'middle' },
                    { id: 'oldest' },
                ]}
                dataKey="session-test"
                keyExtractor={(item: { id: string }) => item.id}
                getItemType={(item: { id: string }, index: number) => {
                    getItemTypeCalls.push({ id: item.id, index });
                    return 'message';
                }}
                renderItem={({ item, index }: { item: { id: string }; index: number }) =>
                {
                    renderItemCalls.push({ id: item.id, index });
                    return React.createElement('Row', { id: item.id, sourceIndex: index });
                }}
                frame={resolveReadOnlyTranscriptListShellFrame({
                    accessKind: 'public',
                    bottomNoticeVisible: false,
                    platformOS: 'ios',
                })}
            />,
        );

        expect(capturedLegendListProps.data.map((item: any) => item.id)).toEqual(['oldest', 'middle', 'newest']);
        expect(getItemTypeCalls).toEqual([
            { id: 'oldest', index: 2 },
            { id: 'middle', index: 1 },
            { id: 'newest', index: 0 },
        ]);
        expect(renderItemCalls).toEqual([
            { id: 'oldest', index: 2 },
            { id: 'middle', index: 1 },
            { id: 'newest', index: 0 },
        ]);
        expect(assignedLegendRef.scrollToIndex).not.toHaveBeenCalled();

        const shellRef = getShellRef(listRef);
        shellRef.scrollToIndex?.({ index: 0, animated: false, viewPosition: 1 });

        expect(assignedLegendRef.scrollToIndex).toHaveBeenCalledWith({
            index: 2,
            animated: false,
            viewPosition: 1,
        });
        expect(shellRef.computeVisibleIndices?.()).toEqual({ startIndex: 1, endIndex: 2 });
        expect(shellRef.getFirstVisibleIndex?.()).toBe(2);
        expect(shellRef.getLayout?.(2)).toEqual({ x: 0, y: 0, width: 0, height: 100 });
        expect(shellRef.getLayout?.(0)).toEqual({ x: 0, y: 200, width: 0, height: 100 });
    });

    it('captures one native physical viewport fact with source-order identity and invalidates it at a command boundary', async () => {
        setPlatformOS('ios');
        const { legendListRenderer } = await import('./legendListRenderer');
        const Renderer = legendListRenderer.Component;
        const listRef = React.createRef<TranscriptListShellRef<{ id: string }>>();
        const measureNode = (height: number, pageY: number) => ({
            measure: (callback: (
                x: number,
                y: number,
                width: number,
                measuredHeight: number,
                pageX: number,
                measuredPageY: number,
            ) => void) => callback(0, 0, 320, height, 0, pageY),
        });
        const rowNodes = [
            measureNode(300, -300),
            measureNode(500, 50),
        ];
        legendStateOverride = {
            elementAtIndex: (index: number) => rowNodes[index],
            end: 1,
            endBuffered: 1,
            start: 0,
            startBuffered: 0,
        };

        await renderScreen(
            <Renderer
                webDomObservation={mountedWebDomObservation}
                ref={listRef}
                data={[
                    { id: 'newest' },
                    { id: 'middle' },
                    { id: 'oldest' },
                ]}
                dataKey="session-test"
                keyExtractor={(item: { id: string }) => item.id}
                renderItem={({ item }: { item: { id: string } }) => React.createElement('Row', { id: item.id })}
                frame={resolveMainTranscriptListShellFrame({
                    nativeID: 'legend-main-native-id',
                    platformOS: 'ios',
                })}
            />,
        );

        const contentHost = measureNode(4_000, -1_000);
        const scrollHost = measureNode(600, 100);
        assignedLegendRef.getNativeScrollRef.mockReturnValue({
            getInnerViewRef: () => contentHost,
            getNativeScrollRef: () => scrollHost,
        });
        const onComplete = vi.fn();
        const shellRef = getShellRef(listRef);

        expect(shellRef.observeNativePhysicalViewport?.({
            focusOffsetPx: 108,
            onComplete,
        })).toEqual({ status: 'pending' });
        expect(onComplete).toHaveBeenCalledExactlyOnceWith({
            capturedAtMs: expect.any(Number),
            dataKey: 'session-test',
            itemIndex: 1,
            itemKey: 'middle',
            itemOffsetPx: -50,
            offsetY: 2_300,
        });
        expect(shellRef.observeNativePhysicalViewport?.({ focusOffsetPx: 108 })).toEqual({
            capture: expect.objectContaining({
                dataKey: 'session-test',
                itemIndex: 1,
                itemKey: 'middle',
                itemOffsetPx: -50,
                offsetY: 2_300,
            }),
            status: 'captured',
        });

        shellRef.scrollToOffset?.({ animated: false, offset: 500 });

        expect(shellRef.observeNativePhysicalViewport?.({ focusOffsetPx: 108 }))
            .toEqual({ status: 'unavailable' });
    });
});
