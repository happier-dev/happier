import * as React from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import * as LegendNative from '@legendapp/list/react-native';
import { Platform } from 'react-native';

import { createWebDomScrollObservation } from '@/components/sessions/transcript/viewport/driver/webDomObservation';
import {
    assertShippedNativeLegendRuntime,
    createShippedNativeNodeMock,
    readShippedNativeModuleFacts,
} from '@/dev/testkit/legend/shippedNativeLegendRuntime';
import { resolveMainTranscriptListShellFrame } from '../transcriptListShellCapabilities';
import { legendListRenderer } from './legendListRenderer';
import type { TranscriptListShellRef } from './types';

/**
 * IDLE FRAME COST of the held-intent settle window (shipped native path).
 *
 * The transcript's `end` hold is DURABLE by design: `finishHeldIntentSettle` closes the polling
 * window but deliberately does not clear the intent, so a reader parked at the tail keeps a live
 * held intent for the whole session. Every call to `requestHeldIntentSettle` therefore re-opens a
 * `LEGEND_HELD_INTENT_SETTLE_MS` (1500 ms) window that re-arms `requestAnimationFrame` once per
 * frame until its deadline - roughly 90 frames at 60 Hz.
 *
 * MEASURED HERE (shipped native Legend 3.3.3, New Architecture, `Platform.OS === 'ios'`):
 *
 *   - at true rest, with no commit, the mounted transcript schedules ZERO animation frames. The
 *     list's own tickers (`ensureBootstrapInitialScrollFrameTicker`, the imperative-scroll
 *     readiness poll, `queuedMVCPRecalculate`) are all mount- or command-scoped and do not idle.
 *   - ONE content-free React commit costs 94 `requestAnimationFrame` calls - a whole settle window.
 *
 * So idle animation-frame cost in this app is a function of transcript COMMIT rate, not of any
 * resting loop: ~94 frames per commit, capped at the frame rate once commits are closer together
 * than the settle window.
 *
 * `LayoutCommitObserver`'s `onCommitLayoutEffect` is a `useLayoutEffect` with no dependency array
 * (`@shopify/flash-list/dist/recyclerview/LayoutCommitObserver.js`), so it fires on EVERY commit of
 * the renderer subtree and unconditionally requests a settle. Gating that on real content-height
 * news was tried and reverted: `handleLegendScroll` reads an open settle window
 * (`heldIntentSettleInFlight`) to distinguish a renderer/layout offset rollback from a reader
 * detach, so closing those windows made a bare touch plus content growth drop the tail hold. The
 * ceiling below is therefore what this lane enforces - one commit may never cost MORE than one
 * settle window - rather than a floor that would forbid a future cheaper design.
 *
 * The second test pins the caller-identity class that DID get fixed: a caller rendering an inline
 * `keyExtractor` used to churn `resolveHeldIntentIndex` -> `readHeldIntentLanding` ->
 * `requestHeldIntentSettle`, so the dataset layout effect re-opened the window on every commit on
 * top of the observer's. The third pins the geometry-carrying direction so neither fix can silently
 * disable the corrector.
 *
 * The last test pins the OTHER per-commit cost this file measures: the identity of the maintenance
 * props handed to the native list. `react-native-unistyles` installs `nativeProps_DEPRECATED`
 * stickily, so a fresh object on a styled family deep-copies on every commit - a content-free
 * commit must therefore hand the list the SAME `maintainScrollAtEnd` and
 * `maintainVisibleContentPosition` values it handed it before.
 */

type Row = string;

const ROW_HEIGHT = 100;
const VIEWPORT_HEIGHT = 400;
const ROW_COUNT = 12;
const FRAME_MS = 16;
/** `LEGEND_HELD_INTENT_SETTLE_MS` plus a full frame of slack. */
const SETTLE_WINDOW_OBSERVATION_MS = 1600;

const SESSION_ID = 'idle-frame-cost';

let rafCallCount = 0;
/**
 * `advanceMovementEpoch` -> `webDomObservation.invalidateUserMovementAuthority()`. The renderer
 * advances a movement epoch for a DATASET or geometry epoch, never for a bare re-render, so this
 * counter discriminates the caller-identity churn that animation-frame totals cannot.
 */
let movementAuthorityInvalidationCount = 0;

function buildRows(count: number): Row[] {
    return Array.from({ length: count }, (_value, index) => `row-${index}`);
}

type IdleHarnessController = Readonly<{
    /** A React commit that carries no data, size or layout news. */
    commitWithoutGeometryNews: () => void;
    /** A commit that grows the dataset, exactly as a new transcript row does. */
    appendRow: () => void;
}>;

type IdleHarnessProps = Readonly<{
    controllerRef: React.MutableRefObject<IdleHarnessController | null>;
    /** `true` reproduces a caller that renders an inline `keyExtractor` arrow. */
    unstableKeyExtractor?: boolean;
    shellRef: React.RefObject<TranscriptListShellRef<Row> | null>;
}>;

function IdleHarness(props: IdleHarnessProps): React.ReactElement {
    const Renderer = legendListRenderer.Component;
    const [rows, setRows] = React.useState<readonly Row[]>(() => buildRows(ROW_COUNT));
    const [renderRevision, setRenderRevision] = React.useState(0);
    // Both are memoized by every production mount (`TranscriptList.tsx:80`,
    // `ChainTranscriptList.tsx:393`, `ChatListInternal.tsx:533`). Re-creating either per render
    // would churn the renderer's own callback identities and manufacture the very settle requests
    // this lane measures.
    const webDomObservation = React.useMemo(() => {
        const observation = createWebDomScrollObservation();
        const invalidate = observation.invalidateUserMovementAuthority.bind(observation);
        return {
            ...observation,
            invalidateUserMovementAuthority: () => {
                movementAuthorityInvalidationCount += 1;
                invalidate();
            },
        };
    }, []);
    const frame = React.useMemo(() => resolveMainTranscriptListShellFrame({
        legendInitialScrollAtEnd: true,
        maintainScrollAtEndThreshold: 0.1,
        nativeID: SESSION_ID,
        platformOS: 'ios',
    }), []);
    // Stable in every production main-transcript mount (`useTranscriptItemsPipeline.tsx:392`,
    // `TranscriptList.tsx:177`). An inline arrow here would churn `resolveHeldIntentIndex` ->
    // `readHeldIntentLanding` -> `requestHeldIntentSettle`, and the dataset layout effect would
    // re-open the settle window on every commit for a reason the shipped surface does not have.
    const stableKeyExtractor = React.useCallback((item: Row) => item, []);
    const keyExtractor = props.unstableKeyExtractor === true
        ? (item: Row) => item
        : stableKeyExtractor;
    const renderItem = React.useCallback(
        ({ item }: { item: Row }) => <React.Fragment>{item}</React.Fragment>,
        [],
    );

    props.controllerRef.current = {
        appendRow: () => setRows((previous) => [...previous, `row-appended-${previous.length}`]),
        commitWithoutGeometryNews: () => setRenderRevision((previous) => previous + 1),
    };
    // Read so the state is not dead code; it must NOT reach `extraData`, whose identity is a
    // data-news signal the renderer already acts on independently.
    void renderRevision;

    return (
        <Renderer
            data={rows}
            dataKey={SESSION_ID}
            extraData={rows.length}
            frame={frame}
            keyExtractor={keyExtractor}
            ref={props.shellRef}
            renderItem={renderItem}
            webDomObservation={webDomObservation}
        />
    );
}

async function flushLayouts(screen: ReactTestRenderer): Promise<void> {
    await act(async () => {
        const layoutNodes = screen.root.findAll(
            (node) => typeof node.props.onLayout === 'function',
        );
        for (const node of layoutNodes) {
            node.props.onLayout({
                nativeEvent: { layout: { height: ROW_HEIGHT, width: 800, x: 0, y: 0 } },
            });
        }
        await Promise.resolve();
    });
}

async function advance(ms: number): Promise<void> {
    await act(async () => {
        vi.advanceTimersByTime(ms);
        await Promise.resolve();
    });
}

describe('Legend transcript renderer idle frame cost', () => {
    let screen: ReactTestRenderer | null = null;

    beforeEach(() => {
        rafCallCount = 0;
        movementAuthorityInvalidationCount = 0;
        vi.useFakeTimers();
        vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
            rafCallCount += 1;
            return setTimeout(() => callback(Date.now()), FRAME_MS) as unknown as number;
        });
        vi.stubGlobal('cancelAnimationFrame', (handle: number) => clearTimeout(handle));
    });

    afterEach(() => {
        if (screen) {
            const current = screen;
            act(() => current.unmount());
            screen = null;
        }
        vi.clearAllTimers();
        vi.unstubAllGlobals();
        vi.useRealTimers();
    });

    async function mountIdleTranscript(options?: Readonly<{
        unstableKeyExtractor?: boolean;
    }>): Promise<Readonly<{
        controller: IdleHarnessController;
        screen: ReactTestRenderer;
    }>> {
        const controllerRef: React.MutableRefObject<IdleHarnessController | null> = { current: null };
        const shellRef = React.createRef<TranscriptListShellRef<Row>>();
        const nodes = createShippedNativeNodeMock({
            rowHeight: ROW_HEIGHT,
            viewportHeight: VIEWPORT_HEIGHT,
        });
        let created: ReactTestRenderer | null = null;
        await act(async () => {
            created = create(
                <IdleHarness
                    controllerRef={controllerRef}
                    shellRef={shellRef}
                    unstableKeyExtractor={options?.unstableKeyExtractor === true}
                />,
                { createNodeMock: nodes.createNodeMock },
            );
        });
        const mounted = created as unknown as ReactTestRenderer;
        screen = mounted;
        await act(async () => {
            mounted.root.findByType('ScrollView' as never).props.onLayout({
                nativeEvent: { layout: { height: VIEWPORT_HEIGHT, width: 800, x: 0, y: 0 } },
            });
            await Promise.resolve();
        });
        await flushLayouts(mounted);
        assertShippedNativeLegendRuntime(
            mounted,
            readShippedNativeModuleFacts(LegendNative, Platform),
        );
        // Drain every mount-time settle window, bootstrap ticker and readiness poll.
        await advance(6_000);
        const controller = controllerRef.current;
        if (!controller) throw new Error('Expected the idle harness controller to be published');
        return { controller, screen: mounted };
    }

    it('schedules no animation frames at rest and at most one settle window per commit', async () => {
        const { controller } = await mountIdleTranscript();

        rafCallCount = 0;
        await advance(3_000);
        const framesWhileUntouched = rafCallCount;

        rafCallCount = 0;
        await act(async () => {
            controller.commitWithoutGeometryNews();
            await Promise.resolve();
        });
        await advance(SETTLE_WINDOW_OBSERVATION_MS);
        const framesAfterContentFreeCommit = rafCallCount;

        expect(framesWhileUntouched).toBe(0);
        // Observed: 94 - exactly one LEGEND_HELD_INTENT_SETTLE_MS window at the harness frame
        // interval. A one-sided ceiling: stacking windows or a poll that outlives its deadline
        // fails here, a cheaper design does not.
        expect(framesAfterContentFreeCommit).toBeLessThanOrEqual(100);
    });

    it('does not advance a movement epoch on a content-free commit, whatever identity the caller gives keyExtractor', async () => {
        const { controller } = await mountIdleTranscript({ unstableKeyExtractor: true });

        movementAuthorityInvalidationCount = 0;
        await act(async () => {
            controller.commitWithoutGeometryNews();
            await Promise.resolve();
        });
        await advance(SETTLE_WINDOW_OBSERVATION_MS);

        expect(movementAuthorityInvalidationCount).toBe(0);
    });

    it('advances a movement epoch when a commit carries new rows', async () => {
        const { controller } = await mountIdleTranscript();

        movementAuthorityInvalidationCount = 0;
        await act(async () => {
            controller.appendRow();
            await Promise.resolve();
        });
        await advance(SETTLE_WINDOW_OBSERVATION_MS);

        expect(movementAuthorityInvalidationCount).toBeGreaterThan(0);
    });

    it('hands the native list the same maintenance prop identities across a content-free commit', async () => {
        const { controller, screen: mounted } = await mountIdleTranscript();
        const readMaintenanceProps = () => {
            const listProps = mounted.root.findByType(LegendNative.LegendList as never).props as Readonly<{
                maintainScrollAtEnd: unknown;
                maintainVisibleContentPosition: unknown;
            }>;
            return listProps;
        };

        const before = readMaintenanceProps();
        // The transcript opens at the tail, so maintenance is live: this is the shape whose
        // identity actually reaches the native list, not the `false` short-circuit.
        expect(before.maintainScrollAtEnd).toMatchObject({ animated: false });

        await act(async () => {
            controller.commitWithoutGeometryNews();
            await Promise.resolve();
        });
        await advance(SETTLE_WINDOW_OBSERVATION_MS);

        const after = readMaintenanceProps();
        // `maintainVisibleContentPosition` is the already-hoisted sibling: it proves this harness
        // can observe identity at all, so the `maintainScrollAtEnd` assertion is discriminating.
        expect(after.maintainVisibleContentPosition).toBe(before.maintainVisibleContentPosition);
        expect(after.maintainScrollAtEnd).toBe(before.maintainScrollAtEnd);
        expect((after.maintainScrollAtEnd as { isMaintainingScrollAtEnd: () => boolean })
            .isMaintainingScrollAtEnd()).toBe(true);
    });

    it('still opens the settle window when a commit carries new rows', async () => {
        const { controller } = await mountIdleTranscript();

        rafCallCount = 0;
        await act(async () => {
            controller.appendRow();
            await Promise.resolve();
        });
        await advance(SETTLE_WINDOW_OBSERVATION_MS);

        expect(rafCallCount).toBeGreaterThan(1);
    });
});
