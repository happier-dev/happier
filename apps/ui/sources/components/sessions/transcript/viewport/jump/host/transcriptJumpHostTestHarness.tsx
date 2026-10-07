import * as React from 'react';
import { JSDOM } from 'jsdom';
import { onTestFinished } from 'vitest';
import { SessionMessagesPageV1Schema, SessionMessageV1Schema, FeaturesResponseSchema } from '@happier-dev/protocol';
import type { Message } from '@happier-dev/session-core/messages';
import { createSessionFixture, createSessionMessagesFixture, renderHook } from '@/dev/testkit';
import { restoreServerAccountForTest } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { createHomeHubArtifactHttpBoundary } from '@/dev/testkit/harness/homeHubArtifactHttpBoundary';
import { AppSessionTranscriptSourceProvider } from '@/components/sessions/transcript/source/appSessionTranscriptSource';
import { useSessionTranscriptSource } from '@/components/sessions/transcript/source/SessionTranscriptSourceContext';
import { getStorage } from '@/sync/domains/state/storageStore';
import { settingsDefaults } from '@/sync/domains/settings/settings';
import { sync } from '@/sync/sync';
import type { ChatTranscriptListItem, TranscriptViewportChangeState } from '../../../chatListTypes';
import type { TranscriptBottomFollowModeState, TranscriptScrollPinState } from '../../../scroll/transcriptBottomFollowMode';
import { reduceTranscriptScrollPinState } from '../../../scroll/transcriptBottomFollowMode';
import { createTranscriptLifecycleHost } from '../../lifecycle/lifecycleHost';
import { useExplicitJumpWriteBarrier } from '../../bottomFollow/explicitJumpWriteBarrier';
import { useTranscriptLiveTailIntentHost } from '../../bottomFollow/host/useTranscriptLiveTailIntentHost';
import { useCommittedTranscriptRef } from '../../lifecycle/host/useCommittedTranscriptRef';
import { createTranscriptViewportCommandController } from '../../createTranscriptViewportCommandController';
import { performNativeStandardListViewportCommand } from '../../driver/nativeStandardList';
import { performWebDomViewportCommand } from '../../driver/webDom';
import { createWebDomScrollObservation } from '../../driver/webDomObservation';
import { createTranscriptUserScrollIntentOwner } from '../../driver/userScrollIntentOwner';
import type { TranscriptViewportDriverDeps } from '../../driver/types';
import type { ScrollableChatListRef } from '../../transcriptScrollableListTypes';
import type { TranscriptListShellRef } from '../../shell/renderer/types';
import type { TranscriptViewportCommand } from '../../transcriptViewportTypes';
import { resolveTranscriptRenderWindowProjection } from '../../window/resolveTranscriptRenderWindowProjection';
import { stampViewportAnchorForEmit } from '../../entryRestore/stampViewportAnchorForEmit';
import type { WebTranscriptScrollMetrics } from '../../../webTranscriptScrollMetrics';
import { useTranscriptJumpHost, type TranscriptJumpHostDeps } from './useTranscriptJumpHost';

const ref = <T,>(current: T) => ({ current });
let environmentSequence = 0;

export function transcriptJumpPage(seq: number, id = 'message-' + seq) {
    return SessionMessagesPageV1Schema.parse({
        messages: [SessionMessageV1Schema.parse({ id, seq, localId: null, sidechainId: null,
            content: { t: 'plain', v: { role: 'user', content: { type: 'text', text: 'Prompt ' + seq } } },
            createdAt: seq, updatedAt: seq })],
        hasMore: false, nextBeforeSeq: null, nextAfterSeq: null,
    });
}
export function emptyTranscriptJumpPage() {
    return SessionMessagesPageV1Schema.parse({ messages: [], hasMore: false, nextBeforeSeq: null, nextAfterSeq: null });
}

export async function restoreTranscriptJumpEnvironment(
    requestMessages: (url: URL) => Response | Promise<Response> = () => Response.json(emptyTranscriptJumpPage()),
) {
    const boundary = createHomeHubArtifactHttpBoundary('jump-account');
    const connection = await restoreServerAccountForTest({
        serverUrl: 'http://transcript-jump-' + (++environmentSequence) + '.test',
        accountId: 'jump-account',
        request: async (input, init) => {
            const url = new URL(String(input));
            if (url.pathname.endsWith('/messages')) return requestMessages(url);
            if (url.pathname === '/v1/features') return Response.json(FeaturesResponseSchema.parse({
                features: { encryption: { plaintextStorage: { enabled: true }, accountOptOut: { enabled: true } } },
            }));
            return boundary.request(input, init);
        },
    });
    getStorage().setState({
        sessions: Object.fromEntries(['s1', 's2', 'session-landing'].map(id => [id,
            createSessionFixture({ id, serverId: connection.home.id, encryptionMode: 'plain', active: true })])),
        sessionMessages: Object.fromEntries(['s1', 's2', 'session-landing'].map(id => [id,
            createSessionMessagesFixture({ isLoaded: true })])),
        settings: { ...settingsDefaults },
        settingsScope: { serverId: connection.home.id, accountId: 'jump-account' },
        profileScope: { serverId: connection.home.id, accountId: 'jump-account' },
    });
    return connection;
}

/** Actual DOM; only the browser's external layout measurements are supplied by the fixture. */
export function createTranscriptJumpWebMetrics(params: Readonly<{
    rows?: readonly { id: string; top: number; height?: number }[];
    scrollTop?: number; scrollHeight?: number; clientHeight?: number;
}> = {}): WebTranscriptScrollMetrics {
    const dom = new JSDOM('<!doctype html><html><body></body></html>');
    onTestFinished(() => { dom.window.close(); });
    // The repository's jsdom declaration is untyped; narrow its genuine external document here.
    const document: Document = dom.window.document;
    const element = document.createElement('div');
    document.body.appendChild(element);
    const clientHeight = params.clientHeight ?? 500;
    const scrollHeight = params.scrollHeight ?? 2000;
    Object.defineProperties(element, {
        clientHeight: { value: clientHeight },
        scrollHeight: { value: scrollHeight },
    });
    element.scrollTop = params.scrollTop ?? 200;
    element.getBoundingClientRect = () => new dom.window.DOMRect(0, 0, 800, clientHeight);
    for (const row of params.rows ?? []) {
        const child = document.createElement('div');
        child.dataset.testid = 'transcript-item-' + row.id;
        child.getBoundingClientRect = () => new dom.window.DOMRect(0, row.top, 800, row.height ?? 100);
        element.appendChild(child);
    }
    return { element, clientHeight, scrollHeight, scrollTop: element.scrollTop };
}

/**
 * Both jump suites compose the actual app source, lifecycle, barrier, live-tail and command
 * owners. This assembly supplies typed renderer/HTTP boundary facts and records emitted
 * observations; it does not supply jump, history, lifecycle or viewport decisions.
 */
export function createTranscriptJumpHostTestHarness(options: Readonly<{
    sessionId?: string; rows?: readonly ChatTranscriptListItem[];
    messages?: Readonly<Record<string, Message>>; isPinned?: boolean;
}> = {}) {
    const sessionId = options.sessionId ?? 's1';
    const pinned = options.isPinned ?? true;
    const rows = ref<readonly ChatTranscriptListItem[]>(options.rows ?? []);
    const messages = ref<Readonly<Record<string, Message>>>(options.messages ?? {});
    const native: {
        distance: number | null;
        visibleRange: { startIndex: number; endIndex: number } | null;
        indexWrites: Parameters<ScrollableChatListRef['scrollToIndex']>[0][];
        offsetWrites: Parameters<ScrollableChatListRef['scrollToOffset']>[0][];
        acquisitions: symbol[]; releases: symbol[]; activeOperation: symbol | null;
    } = {
        distance: null, visibleRange: null, indexWrites: [], offsetWrites: [],
        acquisitions: [], releases: [], activeOperation: null,
    };
    const renderer: ScrollableChatListRef & TranscriptListShellRef = {
        scrollToIndex: request => { native.indexWrites.push(request); },
        scrollToOffset: request => { native.offsetWrites.push(request); },
        readVisibleSourceIndexRange: () => native.visibleRange,
        beginExplicitJumpTakeover(operation) {
            native.acquisitions.push(operation);
            native.activeOperation = operation;
            return () => {
                native.releases.push(operation);
                if (native.activeOperation === operation) native.activeOperation = null;
            };
        },
    };
    const listRef = ref<ScrollableChatListRef | null>(renderer);
    const lifecycleHost = createTranscriptLifecycleHost();
    lifecycleHost.enterSession({ sessionId, platform: 'native', shouldFollowLiveTail: pinned });
    const controller = createTranscriptViewportCommandController();
    controller.resetForSession({ sessionId, openEntryTransaction: false });
    const viewport: TranscriptViewportChangeState[] = [];
    const settledRoutes: string[] = [];
    const bottomFollow = ref<TranscriptBottomFollowModeState>({ dragSession: null, mode: pinned ? 'following' : 'released' });
    const scrollPin = ref<TranscriptScrollPinState>({ isPinned: pinned, lastActivityKey: null, newActivityCount: 0 });
    const currentSessionId = ref(sessionId);
    const wantsPinned = ref(pinned);
    const isPinned = ref(pinned);
    const lastPinOffset = ref<number | null>(null);
    const lastNativeRestore = ref<TranscriptJumpHostDeps['lastNativeRestoreIndexCommandRef']['current']>(null);
    const metrics = ref<WebTranscriptScrollMetrics | null>(null);
    const scheduler = ref({ explicitJumpActive: false, gestureActive: false });
    const visibilityCommit = ref<(distance: number) => void>(() => {});
    const userScrollIntent = createTranscriptUserScrollIntentOwner();
    const resolveJumpIndex = ref<TranscriptJumpHostDeps['resolveJumpToSeqIndexForCommandRef']['current']>(() => null);
    const emptyEffects = () => {};
    const resolveSeq = (id: string) => messages.current[id]?.seq
        ?? getStorage().getState().sessionMessages[currentSessionId.current]?.messagesById[id]?.seq ?? null;
    const commitPin = (next: TranscriptScrollPinState) => { scrollPin.current = next; };
    const commitBottom = (next: TranscriptBottomFollowModeState) => { bottomFollow.current = next; };
    const emitViewport = (state: TranscriptViewportChangeState) => {
        viewport.push(state);
        sync.onSessionViewportChange(currentSessionId.current, state);
        return true;
    };
    const driver: TranscriptViewportDriverDeps = {
        listRef, listDataRef: rows, listContentHeightRef: ref(1000), listLayoutHeightRef: ref(500),
        lastPinOffsetForIntentRef: lastPinOffset, lastNativeRestoreIndexCommandRef: lastNativeRestore,
        nativeMountSettleStable: true, telemetryPlatform: 'ios', webDomObservation: createWebDomScrollObservation(),
        resolveRendererDataTarget(command) {
            if (command.kind !== 'jump-to-seq') return null;
            const index = resolveJumpIndex.current(command.seq, command.routeMessageId,
                command.transcriptBlockIndex, command.role);
            if (index == null) return null;
            const projection = resolveTranscriptRenderWindowProjection({
                items: rows.current, sessionId: currentSessionId.current, listOrientation: 'standard',
                targetWindowState: sync.getSessionTargetWindowState(currentSessionId.current),
                createWindowGapItem: (gap): ChatTranscriptListItem => ({ ...gap, kind: 'transcript-window-gap' }),
            });
            return projection.indexMap.resolveRendererTargetForItemId(rows.current[index]!.id);
        },
        resolveWebScrollMetrics: () => metrics.current,
        recordViewportTelemetryEvent: emptyEffects, recordRestoreDecisionTelemetry: emptyEffects,
        resolveWebViewportTelemetryDiagnostics: () => ({}),
    };
    const execute = (command: TranscriptViewportCommand) => controller.execute(command, {
        perform: next => metrics.current
            ? performWebDomViewportCommand(next, driver)
            : performNativeStandardListViewportCommand(next, driver),
        recordRejectedWrite: emptyEffects,
    });
    const base: TranscriptJumpHostDeps = {
        activeTargetWindowTargetRef: ref(null),
        // This fixture begins after entry/prepend settlement, so no such transaction is active.
        applyExplicitJumpTakeoverApplyEffects: emptyEffects,
        beginExplicitJumpWriteBarrier: emptyEffects, endExplicitJumpWriteBarrier: emptyEffects,
        canonicalWindowedItemsRef: rows, itemsRef: rows,
        committedMessagesCount: rows.current.length, commitBottomFollowModeState: commitBottom,
        commitExplicitReturnToLiveTailState: emptyEffects, commitScrollPinState: commitPin,
        currentSessionIdRef: currentSessionId, emitViewportChange: emitViewport,
        executeViewportCommand: execute, executeViewportCommandWithAnimation: execute,
        forkedTranscriptEnabled: false, hasMoreOlderRef: ref(false), observeOlderLoadResult: emptyEffects,
        invalidateViewportAnchorCapture: emptyEffects, isLoaded: true, isPinnedRef: isPinned,
        jumpToSeq: null, lastPinOffsetForIntentRef: lastPinOffset, lastNativeRestoreIndexCommandRef: lastNativeRestore,
        lastRouteJumpProtectionClearingWebMovementAtMsRef: ref(Number.NEGATIVE_INFINITY),
        lastScrollOffsetForIntentRef: ref(null), lifecycleHost,
        listContentHeight: 1000, listContentHeightRef: driver.listContentHeightRef,
        listData: rows.current, listLayoutHeight: 500, listRef, messagesById: messages.current,
        onRouteJumpSettled: id => { settledRoutes.push(id); }, onViewportChangeRef: ref(undefined),
        pendingJumpSeqViewportPromotionRef: ref(null), pinThresholdPx: 72, pinThresholdPxRef: ref(72),
        pinToBottom: () => execute(controller.resolve({ type: 'jump-to-bottom', sessionId: currentSessionId.current })),
        platformOS: 'ios', promotedJumpSeqViewportProtectionRef: ref(null),
        readCurrentNativeDistanceFromBottom: () => native.distance,
        resolveJumpToSeqIndexForCommandRef: resolveJumpIndex, resolveSeqForMessageId: resolveSeq,
        resolveSyncLoadOlderOptions: () => undefined,
        resolveTargetWindowItemSeq: item => {
            const row = rows.current.find(candidate => candidate.id === item.id);
            return row && 'seq' in row ? row.seq : null;
        },
        resolveViewportCommand: controller.resolve, resolveWebScrollMetrics: () => metrics.current,
        scrollPin: scrollPin.current, scrollPinRef: scrollPin, sessionId,
        stampViewportAnchorForEmit: anchor => stampViewportAnchorForEmit({
            anchor, items: rows.current, messagesById: messages.current,
            stateMessagesById: getStorage().getState().sessionMessages[currentSessionId.current]?.messagesById ?? {},
        }),
        targetWindowHasMoreNewer: false, targetWindowHasNewerBeyondRenderedWindow: false,
        transcriptNavigationEntries: [], transcriptNavigationRuntimeAnchorsRef: ref([]),
        waitForNextVisualUpdate: () => Promise.resolve(), wantsPinnedRef: wantsPinned,
    };
    function props(patch: Partial<TranscriptJumpHostDeps> = {}): TranscriptJumpHostDeps {
        return { ...base, listData: rows.current, messagesById: messages.current, scrollPin: scrollPin.current, ...patch };
    }
    function useOwner(deps: TranscriptJumpHostDeps) {
        const source = useSessionTranscriptSource();
        source.history.useState();
        const [begin, end] = useExplicitJumpWriteBarrier({ applyEffects: emptyEffects, schedulerStateRef: scheduler });
        const liveTail = useTranscriptLiveTailIntentHost({
            commitBottomFollowModeState: commitBottom, commitJumpToBottomDistanceForVisibilityRef: visibilityCommit,
            commitScrollPinEvent: event => commitPin(reduceTranscriptScrollPinState(scrollPin.current, event)),
            commitScrollPinState: commitPin, emitViewportChange: emitViewport,
            isPinnedRef: isPinned, lastPinOffsetForIntentRef: lastPinOffset, lifecycleHost,
            scrollPinRef: scrollPin, sessionId: deps.sessionId, transcriptScrollPinEnabled: true,
            userScrollIntent, wantsPinnedRef: wantsPinned,
        });
        const result = useTranscriptJumpHost({ ...deps, beginExplicitJumpWriteBarrier: begin,
            endExplicitJumpWriteBarrier: end, commitExplicitReturnToLiveTailState: liveTail.commitExplicitReturnToLiveTailState });
        useCommittedTranscriptRef(visibilityCommit, result.commitJumpToBottomDistanceForVisibility);
        useCommittedTranscriptRef(deps.pinThresholdPxRef, deps.pinThresholdPx);
        return result;
    }
    async function render(patch: Partial<TranscriptJumpHostDeps> = {}) {
        let wrapperSessionId = patch.sessionId ?? sessionId;
        const hook = await renderHook(useOwner, {
            initialProps: props(patch),
            wrapper: ({ children }) => <AppSessionTranscriptSourceProvider sessionId={wrapperSessionId}>{children}</AppSessionTranscriptSourceProvider>,
        });
        return { ...hook, rerender: (next = props()) => {
            wrapperSessionId = next.sessionId;
            if (currentSessionId.current !== next.sessionId) {
                lifecycleHost.enterSession({ sessionId: next.sessionId,
                    platform: next.platformOS === 'web' ? 'web' : 'native', shouldFollowLiveTail: wantsPinned.current });
            }
            currentSessionId.current = next.sessionId;
            controller.setCurrentSessionId(next.sessionId);
            return hook.rerender(next);
        } };
    }
    return { base, props, render, rows, messages, native, renderer, listRef, metrics, lifecycleHost,
        viewport, settledRoutes, bottomFollow, scrollPin, scheduler, currentSessionId, wantsPinned, isPinned };
}
