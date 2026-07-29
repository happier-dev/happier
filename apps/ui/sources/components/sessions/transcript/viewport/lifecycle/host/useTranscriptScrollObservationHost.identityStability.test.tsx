// @vitest-environment jsdom

/**
 * Identity-stability contract for the M6 scroll observation host.
 *
 * The host receives a fresh deps object from ChatList during normal renders. Returned shell
 * callbacks and interaction props must stay stable when the individual dependency fields are
 * unchanged.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

import { renderHook } from '@/dev/testkit';
import type { WebTranscriptScrollMetrics } from '@/components/sessions/transcript/webTranscriptScrollMetrics';
import { createWebDomScrollObservation } from '@/components/sessions/transcript/viewport/driver/webDomObservation';

import { useTranscriptScrollObservationHost } from './useTranscriptScrollObservationHost';

type ScrollObservationHostDeps = Parameters<typeof useTranscriptScrollObservationHost>[0];

function createRef<T>(current: T): { current: T } {
    return { current };
}

function createScrollElement(): HTMLElement {
    return {
        clientHeight: 600,
        scrollHeight: 1200,
        scrollTop: 600,
    } as unknown as HTMLElement;
}

function createStableMembers() {
    const lifecycleHost = {
        planLocalInteractionIntent: vi.fn(() => ({
            localInteractionIntentEffects: [],
            state: { bottomFollowState: { dragSession: null, mode: 'following' } },
        })),
    };
    return {
        activeTargetWindowTargetRef: createRef(null),
        applyBlankRecoveryEffects: vi.fn(),
        applyEntryRestoreOwnerEffects: vi.fn(),
        applyNativeBottomFollowCompletionHostEffects: vi.fn(),
        applyNativeDragActiveMirrorEffectsRef: createRef(() => {}),
        applyNativeMountSettlePassiveDriftRepinObservation: vi.fn(),
        applyNativeUserScrollTakeoverHostEffects: vi.fn(),
        webDomObservation: createWebDomScrollObservation(),
        bottomFollowModeStateRef: createRef({ dragSession: null, mode: 'following' }),
        commitBottomFollowModeState: vi.fn(),
        commitJumpToBottomDistanceForVisibility: vi.fn(),
        commitScrollPinEvent: vi.fn(),
        commitScrollPinState: vi.fn(),
        composerInsetHeightRef: createRef(0),
        currentSessionIdRef: createRef('s1'),
        dispatchViewportLifecycleEvent: vi.fn(() => ({
            effects: [],
            state: { bottomFollowState: { dragSession: null, mode: 'following' } },
        })),
        emitViewportChange: vi.fn(),
        entryRestoreOwner: {
            hasOpenTransaction: vi.fn(() => false),
            visibleDistanceForOpenNativeEntry: vi.fn(() => null),
        },
        firstPaintTelemetryRef: createRef({ recorded: true }),
        getBottomFollowGestureActiveRef: createRef(() => false),
        hasNativeContentMeasurementForCurrentSession: vi.fn(() => false),
        hasNativeInitialViewportAppliedForCurrentSession: vi.fn(() => false),
        lastExplicitWebScrollIntentAtMsRef: createRef(Number.NEGATIVE_INFINITY),
        lastPinOffsetForIntentRef: createRef(null),
        lastRouteJumpProtectionClearingWebMovementAtMsRef: createRef(Number.NEGATIVE_INFINITY),
        lastScrollOffsetForIntentRef: createRef(null),
        lastUserScrollIntentAtMsRef: createRef(Number.NEGATIVE_INFINITY),
        lifecycleHost,
        listContentHeightRef: createRef(0),
        listDataRef: createRef([]),
        listLayoutHeightRef: createRef(0),
        listRef: createRef<ScrollObservationHostDeps['listRef']['current']>(null),
        loadOlderInFlightRef: createRef(false),
        markNativeInitialViewportAppliedForCurrentSession: vi.fn(),
        measurementHost: {
            observeContentSizeChange: vi.fn(() => []),
        },
        nativeBottomFollowRearmedAfterDragRef: createRef(false),
        nativeListDragActiveRef: createRef(false),
        nativeMomentumScrollActiveRef: createRef(false),
        nativeMountSettleDeadlineReachedRef: createRef(false),
        nativePrependTelemetryStateRef: createRef(() => 'closed'),
        nativeTranscriptTouchStartYRef: createRef(null),
        observeMountSettleMetrics: vi.fn(),
        observeNativeBlankRecovery: vi.fn(),
        observeNativeConfirmation: vi.fn(() => false),
        observeNativeEntryRestoreHostFacts: vi.fn(() => []),
        observeNativePrependOwner: vi.fn(),
        observeTranscriptNavigationVisibility: vi.fn(),
        olderPagination: {
            getSnapshot: vi.fn(() => ({ phase: 'idle', suspendedReasons: [] })),
            isNearOlderEdge: vi.fn(() => false),
            isReadyForLoad: vi.fn(() => true),
            onScrollObservation: vi.fn(),
        },
        pendingJumpSeqViewportPromotionRef: createRef(null),
        pinEnabledRef: createRef(true),
        pinThresholdPxRef: createRef(72),
        preemptEntryRestoreTransaction: vi.fn(),
        prependHost: {
            applyNativeEffects: vi.fn(),
            hasOpenNativeTransaction: vi.fn(() => false),
            observeWeb: vi.fn(),
            trustedNativeScroll: vi.fn(() => []),
        },
        promotedJumpSeqViewportProtectionRef: createRef(null),
        promotePendingJumpSeqViewportSnapshot: vi.fn(() => false),
        readCurrentNativeDistanceFromBottom: vi.fn(() => null),
        recordFirstListPaint: vi.fn(),
        recordListLayoutWidth: vi.fn(),
        recordNativeVisibleWindowTelemetry: vi.fn(),
        recordScrollObservedTelemetry: vi.fn(),
        recordStablePaintTelemetry: vi.fn(),
        recordViewportTelemetryEvent: vi.fn(),
        readItemsToNewerEdge: vi.fn<() => number | null>(() => null),
        readItemsToOlderEdge: vi.fn<() => number | null>(() => null),
        resolveEffectiveListPaintMetrics: vi.fn(() => null),
        resolveNativeObservedScrollOffset: vi.fn<ScrollObservationHostDeps['resolveNativeObservedScrollOffset']>(() => null),
        resolveTranscriptMountSettleBottomDistanceNoiseFloorPx: vi.fn(() => null),
        resolveViewportReachedEdge: vi.fn((edge: 'start' | 'end') => edge === 'start' ? 'older' : 'newer'),
        resolveViewportTelemetryMode: vi.fn(() => 'follow-bottom'),
        resolveWebScrollMetrics: vi.fn<() => WebTranscriptScrollMetrics | null>(() => null),
        resolveWebViewportTelemetryDiagnostics: vi.fn(() => ({})),
        runEntryRestoreAttempt: vi.fn(),
        scheduleViewportAnchorCaptureRef: createRef(() => {}),
        scrollPinRef: createRef({ isPinned: true, lastActivityKey: null, newActivityCount: 0 }),
        sessionEntryViewportRef: createRef(null),
        setListContentHeight: vi.fn(),
        setListLayoutHeight: vi.fn(),
        shouldCommitContentHeightState: vi.fn(() => true),
        shouldIgnoreNativeInvalidScrollObservation: vi.fn(() => false),
        shouldSuppressGenericViewportStateForProtectedJumpSeq: vi.fn(() => false),
        targetWindowActiveRef: createRef(false),
        targetWindowEdgeLoadInFlightRef: createRef<'newer' | 'older' | null>(null),
        targetWindowHostFacts: { activeWindowState: null },
        updateNativeInitialViewportPendingObservation: vi.fn(),
        updateNativeViewportPaintObserved: vi.fn(),
        viewportCommandController: { activeOwner: vi.fn(() => 'follow') },
        wantsPinnedRef: createRef(true),
        verifyWebEntryRestoreTransaction: vi.fn(),
    };
}

function buildDeps(members: ReturnType<typeof createStableMembers>): ScrollObservationHostDeps {
    return {
        ...members,
        isLoaded: false,
        isWarmKeepAliveInstance: false,
        latestCommittedActivityKey: 'activity-1',
        nativeMountSettleStable: false,
        pinEnabled: true,
        pinThresholdPx: 72,
        platformOS: 'web',
        routeJumpSeq: null,
        sessionActive: true,
        sessionId: 's1',
        showFirstPaintPlaceholder: false,
        userIntentRecentMs: 500,
    } as unknown as ScrollObservationHostDeps;
}

describe('useTranscriptScrollObservationHost identity stability', () => {
    afterEach(() => {
        document.body.replaceChildren();
        vi.restoreAllMocks();
        vi.unstubAllGlobals();
    });

    it('keeps shell callbacks and interaction props stable across fresh deps object identities', async () => {
        const members = createStableMembers();
        const hook = await renderHook(
            (deps: ScrollObservationHostDeps) => useTranscriptScrollObservationHost(deps),
            { initialProps: buildDeps(members) },
        );

        const first = hook.getCurrent();

        await hook.rerender(buildDeps(members));
        await hook.rerender(buildDeps(members));

        const second = hook.getCurrent();
        expect(second.onLayout).toBe(first.onLayout);
        expect(second.onContentSizeChange).toBe(first.onContentSizeChange);
        expect(second.onScroll).toBe(first.onScroll);
        expect(second.platformInteractionProps).toBe(first.platformInteractionProps);

        await hook.unmount();
    });

    it('re-evaluates ordinary older pagination after a committed projection at exact web top', async () => {
        const members = createStableMembers();
        const element = createScrollElement();
        Object.defineProperties(element, {
            scrollTop: { configurable: true, value: 0 },
            scrollHeight: { configurable: true, value: 1200 },
            clientHeight: { configurable: true, value: 600 },
        });
        members.resolveWebScrollMetrics.mockReturnValue({
            clientHeight: 600,
            element,
            scrollHeight: 1200,
            scrollTop: 0,
        });
        members.wantsPinnedRef.current = false;
        const hook = await renderHook(
            (deps: ScrollObservationHostDeps) => useTranscriptScrollObservationHost(deps),
            { initialProps: { ...buildDeps(members), isLoaded: true } },
        );

        hook.getCurrent().observeCommittedProjectionLayout();

        expect(members.olderPagination.onScrollObservation).toHaveBeenCalledWith({
            itemsToOlderEdge: null,
            offsetY: 0,
            scrollable: true,
            trigger: 'layout-committed',
        });
        await hook.unmount();
    });

    it.each([
        ['standard', (edge: 'start' | 'end') => edge === 'start' ? 'older' as const : 'newer' as const],
        ['inverted', (edge: 'start' | 'end') => edge === 'start' ? 'newer' as const : 'older' as const],
    ])('rechecks canonical older pagination from committed native item-edge facts in %s orientation', async (
        _orientation,
        resolveReachedEdge,
    ) => {
        const members = createStableMembers();
        members.readItemsToOlderEdge.mockReturnValue(0);
        members.listContentHeightRef.current = 1200;
        members.listLayoutHeightRef.current = 600;
        members.listRef.current = {
            getAbsoluteLastScrollOffset: () => 0,
            scrollToIndex: vi.fn(),
            scrollToOffset: vi.fn(),
        };
        members.resolveNativeObservedScrollOffset.mockReturnValue({
            canonicalOffsetY: 0,
            distanceFromLiveTailPx: 600,
        });
        members.wantsPinnedRef.current = false;
        members.bottomFollowModeStateRef.current = { dragSession: null, mode: 'released' };
        const hook = await renderHook(
            (deps: ScrollObservationHostDeps) => useTranscriptScrollObservationHost(deps),
            { initialProps: { ...buildDeps(members), isLoaded: true, platformOS: 'ios' } },
        );

        members.resolveViewportReachedEdge.mockImplementation(resolveReachedEdge);
        hook.getCurrent().observeCommittedProjectionLayout();

        expect(members.olderPagination.onScrollObservation).toHaveBeenCalledWith({
            itemsToOlderEdge: 0,
            offsetY: 0,
            scrollable: true,
            trigger: 'layout-committed',
        });
        await hook.unmount();
    });

    it('does not treat an unknown native committed visible range as edge or exit evidence', async () => {
        const members = createStableMembers();
        members.readItemsToOlderEdge.mockReturnValue(null);
        members.listContentHeightRef.current = 1200;
        members.listLayoutHeightRef.current = 600;
        members.listRef.current = {
            getAbsoluteLastScrollOffset: () => 0,
            scrollToIndex: vi.fn(),
            scrollToOffset: vi.fn(),
        };
        members.resolveNativeObservedScrollOffset.mockReturnValue({
            canonicalOffsetY: 0,
            distanceFromLiveTailPx: 600,
        });
        members.wantsPinnedRef.current = false;
        members.bottomFollowModeStateRef.current = { dragSession: null, mode: 'released' };
        const hook = await renderHook(
            (deps: ScrollObservationHostDeps) => useTranscriptScrollObservationHost(deps),
            { initialProps: { ...buildDeps(members), isLoaded: true, platformOS: 'ios' } },
        );
        members.olderPagination.onScrollObservation.mockClear();

        hook.getCurrent().observeCommittedProjectionLayout();

        expect(members.olderPagination.onScrollObservation).not.toHaveBeenCalled();
        await hook.unmount();
    });

    it('dispatches one captured native committed item-edge fact even if the live reader changes', async () => {
        const members = createStableMembers();
        members.readItemsToOlderEdge
            .mockReturnValueOnce(0)
            .mockReturnValue(null);
        members.listContentHeightRef.current = 1200;
        members.listLayoutHeightRef.current = 600;
        members.listRef.current = {
            getAbsoluteLastScrollOffset: () => 0,
            scrollToIndex: vi.fn(),
            scrollToOffset: vi.fn(),
        };
        members.resolveNativeObservedScrollOffset.mockReturnValue({
            canonicalOffsetY: 0,
            distanceFromLiveTailPx: 600,
        });
        members.wantsPinnedRef.current = false;
        members.bottomFollowModeStateRef.current = { dragSession: null, mode: 'released' };
        const hook = await renderHook(
            (deps: ScrollObservationHostDeps) => useTranscriptScrollObservationHost(deps),
            { initialProps: { ...buildDeps(members), isLoaded: true, platformOS: 'ios' } },
        );
        members.olderPagination.onScrollObservation.mockClear();

        hook.getCurrent().observeCommittedProjectionLayout();

        expect(members.olderPagination.onScrollObservation).toHaveBeenCalledWith({
            itemsToOlderEdge: 0,
            offsetY: 0,
            scrollable: true,
            trigger: 'layout-committed',
        });
        await hook.unmount();
    });

    it('calls wheel stopPropagation with the synthetic event as receiver', async () => {
        const members = createStableMembers();
        const hook = await renderHook(
            (deps: ScrollObservationHostDeps) => useTranscriptScrollObservationHost(deps),
            { initialProps: buildDeps(members) },
        );
        const host = hook.getCurrent();
        const event = {
            deltaY: 24,
            stopped: false,
            stopPropagation(this: { stopped: boolean }) {
                if (this !== event) throw new Error('detached stopPropagation call');
                this.stopped = true;
            },
        };

        const onWheel = host.platformInteractionProps.onWheel as ((nextEvent: unknown) => void) | undefined;
        expect(typeof onWheel).toBe('function');
        onWheel?.(event);

        expect(event.stopped).toBe(true);

        await hook.unmount();
    });

    it('keeps one explicitly interacted transcript as the keyboard owner after its focused row unmounts', async () => {
        const membersA = createStableMembers();
        const membersB = createStableMembers();
        const scrollerA = document.createElement('div');
        const scrollerB = document.createElement('div');
        const focusedRowA = document.createElement('button');
        const rowB = document.createElement('div');
        const outside = document.createElement('button');
        scrollerA.append(focusedRowA);
        scrollerB.append(rowB);
        document.body.append(scrollerA, scrollerB, outside);
        membersA.resolveWebScrollMetrics.mockReturnValue({
            clientHeight: 600,
            element: scrollerA,
            scrollHeight: 1200,
            scrollTop: 600,
        });
        membersB.resolveWebScrollMetrics.mockReturnValue({
            clientHeight: 600,
            element: scrollerB,
            scrollHeight: 1200,
            scrollTop: 600,
        });
        const notifyA = vi.fn();
        const notifyB = vi.fn();
        membersA.listRef.current = {
            notifyViewportInput: notifyA,
            scrollToIndex: vi.fn(),
            scrollToOffset: vi.fn(),
        };
        membersB.listRef.current = {
            notifyViewportInput: notifyB,
            scrollToIndex: vi.fn(),
            scrollToOffset: vi.fn(),
        };
        const addEventListenerSpy = vi.spyOn(document, 'addEventListener');
        const removeEventListenerSpy = vi.spyOn(document, 'removeEventListener');
        const hookA = await renderHook(
            (deps: ScrollObservationHostDeps) => useTranscriptScrollObservationHost(deps),
            { initialProps: { ...buildDeps(membersA), sessionId: 'session-a' } },
        );
        const hookB = await renderHook(
            (deps: ScrollObservationHostDeps) => useTranscriptScrollObservationHost(deps),
            { initialProps: { ...buildDeps(membersB), sessionId: 'session-b' } },
        );

        expect(hookA.getCurrent().platformInteractionProps.onKeyDown).toBeUndefined();
        expect(hookB.getCurrent().platformInteractionProps.onKeyDown).toBeUndefined();
        expect(
            addEventListenerSpy.mock.calls.filter(
                ([type, , options]) => type === 'keydown' && options === true,
            ),
        ).toHaveLength(1);

        focusedRowA.focus();
        expect(document.activeElement).toBe(focusedRowA);
        focusedRowA.remove();
        expect(document.activeElement).toBe(document.body);

        let activeElementObservedBeforeDefault: Element | null = null;
        document.body.addEventListener('keydown', () => {
            activeElementObservedBeforeDefault = document.activeElement;
        }, { once: true });
        document.body.dispatchEvent(new KeyboardEvent('keydown', {
            bubbles: true,
            cancelable: true,
            key: 'PageDown',
        }));

        expect(notifyA).toHaveBeenCalledTimes(1);
        expect(notifyA).toHaveBeenLastCalledWith({
            kind: 'keyboard',
            verticalDirection: 'toward-end',
        });
        expect(notifyB).not.toHaveBeenCalled();
        expect(activeElementObservedBeforeDefault).toBe(scrollerA);
        expect(scrollerA.getAttribute('tabindex')).toBe('-1');

        outside.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true }));
        document.body.dispatchEvent(new KeyboardEvent('keydown', {
            bubbles: true,
            cancelable: true,
            key: 'PageDown',
        }));
        expect(notifyA).toHaveBeenCalledTimes(1);
        expect(notifyB).not.toHaveBeenCalled();

        rowB.dispatchEvent(new KeyboardEvent('keydown', {
            bubbles: true,
            cancelable: true,
            key: 'PageDown',
        }));
        expect(notifyA).toHaveBeenCalledTimes(1);
        expect(notifyB).toHaveBeenCalledTimes(1);
        expect(notifyB).toHaveBeenLastCalledWith({
            kind: 'keyboard',
            verticalDirection: 'toward-end',
        });

        rowB.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true }));
        document.body.dispatchEvent(new KeyboardEvent('keydown', {
            bubbles: true,
            cancelable: true,
            key: 'PageDown',
        }));
        expect(notifyA).toHaveBeenCalledTimes(1);
        expect(notifyB).toHaveBeenCalledTimes(2);
        document.dispatchEvent(new KeyboardEvent('keydown', {
            bubbles: true,
            cancelable: true,
            key: 'PageDown',
        }));
        expect(notifyB).toHaveBeenCalledTimes(3);

        await hookA.unmount();
        await hookB.unmount();
        expect(scrollerA.hasAttribute('tabindex')).toBe(false);
        expect(scrollerB.hasAttribute('tabindex')).toBe(false);
        expect(
            removeEventListenerSpy.mock.calls.filter(
                ([type, , options]) => type === 'keydown' && options === true,
            ),
        ).toHaveLength(1);
    });

    it.each([
        ['textarea', () => document.createElement('textarea')],
        ['contenteditable', () => {
            const element = document.createElement('div');
            element.setAttribute('contenteditable', 'true');
            return element;
        }],
        ['dialog', () => document.createElement('dialog')],
        ['menu', () => {
            const element = document.createElement('div');
            element.setAttribute('role', 'menu');
            return element;
        }],
        ['listbox', () => {
            const element = document.createElement('div');
            element.setAttribute('role', 'listbox');
            return element;
        }],
        ['combobox', () => {
            const element = document.createElement('div');
            element.setAttribute('role', 'combobox');
            return element;
        }],
    ])('does not claim transcript keyboard scrolling from a %s', async (_name, createExcludedElement) => {
        const members = createStableMembers();
        const scroller = document.createElement('div');
        const excludedElement = createExcludedElement();
        scroller.append(excludedElement);
        document.body.append(scroller);
        members.resolveWebScrollMetrics.mockReturnValue({
            clientHeight: 600,
            element: scroller,
            scrollHeight: 1200,
            scrollTop: 600,
        });
        const notifyViewportInput = vi.fn();
        members.listRef.current = {
            notifyViewportInput,
            scrollToIndex: vi.fn(),
            scrollToOffset: vi.fn(),
        };
        const hook = await renderHook(
            (deps: ScrollObservationHostDeps) => useTranscriptScrollObservationHost(deps),
            { initialProps: buildDeps(members) },
        );

        excludedElement.dispatchEvent(new KeyboardEvent('keydown', {
            bubbles: true,
            cancelable: true,
            key: 'PageDown',
        }));
        expect(notifyViewportInput).not.toHaveBeenCalled();

        excludedElement.setAttribute('tabindex', '0');
        excludedElement.focus();
        expect(document.activeElement).toBe(excludedElement);
        document.body.dispatchEvent(new KeyboardEvent('keydown', {
            bubbles: true,
            cancelable: true,
            key: 'PageDown',
        }));
        expect(notifyViewportInput).not.toHaveBeenCalled();

        await hook.unmount();
    });
});
