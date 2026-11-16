import * as React from 'react';
import { Platform, TextInput, View, type LayoutChangeEvent } from 'react-native';
import type { FindController } from '@happier-dev/plugin-ui/presentation';
import { resolveHistoricalAgentIdAtSeq, type Message } from '@happier-dev/session-core/messages';

import { FindBar } from '@/components/ui/find/FindBar';
import { FindBarPlacement, useFindBarPresence, useFindBarPresentation, findBarBandFromLayout } from '@/components/ui/find/FindBarPlacement';
import { useFindSurfaceFocusReturn } from '@/components/ui/find/useFindSurfaceFocusReturn';
import { useFindComposerSlotReplacing } from '@/components/ui/find/FindComposerSlot';
import { ChatFindSeedHost } from '@/components/appShell/panes/fileFindSeedHost';
import { allSignals, usePluginSurfaceFocusEligibilitySignal } from '@/components/ui/presentation/PluginSurfaceFocusEligibility';
import { useSessionScreenFocusSignal } from '@/components/sessions/shell/useSessionScreenIsFocused';
import { useFindSurfaceRegistration } from '@/keyboard/KeyboardShortcutProvider';
import { isFindSurfaceTarget } from '@/keyboard/findSurfaceTarget';
import { t } from '@/text';
import { useSetting } from '@/sync/domains/state/storage';
import { useSessionDebugInformationEnabled } from '@/sync/runtime/useSessionDebugInformationEnabled';
import { useReviewRunsComments } from '@/components/sessions/reviews/findings/useReviewRunComments';
import { collectStructuredMessageReviewRunIds, structuredMessageFindUsesSessionMessages } from '../structured/StructuredMessageBlock';
import { useWorkflowRunForToolUseId, resolveWorkflowRunHeadlineForToolUseId } from '@/components/sessions/workState/useSessionWorkflowActivity';
import type { WorkflowRunDetailState } from '@/components/sessions/workState/sessionWorkflowActivityTypes';
import type { SessionTranscriptSource } from '../source/types';
import type { ChatTranscriptListItem } from '../chatListTypes';
import { collectTranscriptNavigationMessageIdsForItem } from '../viewport/lifecycle/transcriptRowClassification';
import { useSessionTranscriptAgentAttributionIndex } from '../attribution/SessionTranscriptAgentAttributionContext';
import type { TranscriptFindCorpus, TranscriptFindModel } from './useTranscriptFind';
import { TranscriptFindProvider } from './TranscriptFindContext';
import { TranscriptFindRuler, type TranscriptFindMessageLayout } from './TranscriptFindRuler';
import type { TranscriptFindTextContext } from './transcriptFindText';
import { TRANSCRIPT_TOP_GUTTER_PX } from '../_constants';

type Props = Readonly<{
    model: TranscriptFindModel;
    source: SessionTranscriptSource;
    sessionId: string;
    serverId: string | null;
    viewportRef: React.RefObject<React.ElementRef<typeof View> | null>;
    /** Canonical list items before viewport windowing, including collapsed groups. */
    items: readonly ChatTranscriptListItem[];
    loadedMessages: readonly Message[];
    publishCorpus(corpus: TranscriptFindCorpus): void;
    /** Where a message's row sits in the list content (the list's own layout; no row is mounted). */
    measureMessage: TranscriptFindMessageLayout;
    contentHeight: number;
    /** Reports the top band the open inline capsule covers (0 when closed or seated on a phone). */
    onClearanceChange?(clearancePx: number): void;
    /**
     * The list's older-page read failed. While Find is open its note says so, with the list's own Retry,
     * and the transcript's failure banner stands down (one truthful line, never two stacked notices).
     */
    olderLoadFailed?: boolean;
    onRetryOlderLoad?(): void;
    children: React.ReactNode;
}>;

/** The surface stays mounted; only the bar and source reader subscribe while Find is open. */
export function TranscriptFindSurface(props: Props) {
    const { model } = props;
    const open = React.useSyncExternalStore(model.subscribe, () => model.getSnapshot().open, () => false);
    // Find belongs to the focused Session screen. Eligibility is followed by subscription (registration) and
    // read when acting, so neither this surface nor the list it wraps renders when focus moves.
    const eligibility = usePluginSurfaceFocusEligibilitySignal();
    const screenFocus = useSessionScreenFocusSignal();
    const eligible = React.useMemo(() => allSignals(eligibility, screenFocus), [eligibility, screenFocus]);
    const input = React.useRef<TextInput | null>(null);
    const [inputFocused, setInputFocused] = React.useState(false);
    const focusReturn = useFindSurfaceFocusReturn();
    const composerReplaced = useFindComposerSlotReplacing();
    const containsTarget = (target: unknown) => {
        if (!eligible.get() || Platform.OS !== 'web') return false;
        // On phones the bar moves into the composer slot, outside this viewport.
        if (isFindSurfaceTarget(input.current as unknown as HTMLElement | null, target)) return true;
        const viewport = props.viewportRef.current as unknown as HTMLElement | null;
        if (isFindSurfaceTarget(viewport, target)) return true;
        // Composer is a sibling of the transcript, not an independently findable pane.
        const session = viewport?.closest('[data-testid^="session-view-retained-surface:"]');
        return isFindSurfaceTarget(session?.querySelector('[data-testid="agent-input-composer"]'), target);
    };
    const containsFocus = () => eligible.get() && (Platform.OS !== 'web'
        || containsTarget(typeof document === 'undefined' ? null : document.activeElement));
    const close = () => {
        model.close(); setInputFocused(false);
    };
    React.useEffect(() => {
        // The phone slot must commit the composer's visibility before DOM focus can return.
        if (!open && !composerReplaced) focusReturn.restore();
    }, [open, composerReplaced, focusReturn.restore]);
    const controller: FindController = {
        get query() { return model.query; }, get options() { return model.options; },
        get status() { return model.status; }, get capabilities() { return model.capabilities; },
        setQuery: model.setQuery, setOptions: model.setOptions, step: model.step, stop: model.stop, close,
    };
    const openFind = () => {
        focusReturn.capture(model.getSnapshot().open);
        model.open(); input.current?.focus();
    };
    useFindSurfaceRegistration({
        surfaceId: `transcript:${props.serverId ?? ''}:${props.sessionId}`,
        containsFocus, containsTarget, open: openFind, isOpen: () => open, isInputFocused: () => inputFocused,
        controller,
    }, eligible);
    const [measuredClearance, setMeasuredClearance] = React.useState(0);
    const clearance = open ? measuredClearance : 0;
    const onClearanceChange = props.onClearanceChange;
    const publishedClearance = React.useRef(0);
    React.useEffect(() => {
        const changed = publishedClearance.current !== clearance;
        publishedClearance.current = clearance;
        onClearanceChange?.(clearance);
        // Header growth preserves the old visible position. Re-seat through the same jump
        // owner after publishing the new band, rather than leaving the first result covered.
        if (changed && clearance > 0 && eligible.get()) void model.revealCurrent();
    }, [clearance, onClearanceChange, model, eligible]);
    // The bar stays through its exit; the model is already closed and focus already returned.
    const presence = useFindBarPresence(open);
    return <TranscriptFindProvider store={model.rowStore} enabled={open} clearancePx={clearance}>
        {props.children}
        {presence.present ? <TranscriptFindActive {...props} visible={open} controller={controller} inputRef={input} onClearance={setMeasuredClearance}
            onInputFocus={() => setInputFocused(true)} onInputBlur={() => setInputFocused(false)} /> : null}
        {props.serverId ? <ChatFindSeedHost sessionId={props.sessionId} serverId={props.serverId} eligible={eligibility}>
            {({ findSeed, consumeFindSeed }) => <TranscriptFindSeed model={model} seed={findSeed} consume={consumeFindSeed} open={openFind} />}
        </ChatFindSeedHost> : null}
    </TranscriptFindProvider>;
}

function TranscriptFindSeed(props: Readonly<{
    model: TranscriptFindModel;
    seed: Parameters<TranscriptFindModel['applySeed']>[0] | null;
    consume(): void;
    open(): void;
}>) {
    const applying = React.useRef<typeof props.seed>(null);
    React.useEffect(() => {
        if (!props.seed || applying.current === props.seed) return;
        applying.current = props.seed;
        props.open();
        void props.model.applySeed(props.seed).then(props.consume);
    }, [props.model, props.seed, props.consume, props.open]);
    return null;
}

function WorkflowFindObservation(props: Readonly<{
    source: SessionTranscriptSource; message: Extract<Message, { kind: 'tool-call' }>;
    metadata: ReturnType<SessionTranscriptSource['useMetadata']>;
    publish(messageId: string, detail: WorkflowRunDetailState | null): void;
}>) {
    const { detail } = useWorkflowRunForToolUseId({ sessionId: props.source.sessionId,
        serverId: props.source.serverId ?? undefined, metadata: props.metadata, toolUseId: props.message.tool.id });
    React.useEffect(() => { props.publish(props.message.id, detail); }, [detail, props.message.id, props.publish]);
    return null;
}

function TranscriptFindActive(props: Props & Readonly<{
    controller: FindController; inputRef: React.RefObject<TextInput | null>;
    onInputFocus(): void; onInputBlur(): void;
    onClearance(clearancePx: number): void;
    /** False while the bar leaves after Find closed: nothing is published or measured any more. */
    visible: boolean;
}>) {
    const snapshot = React.useSyncExternalStore(props.model.subscribe, props.model.getSnapshot, props.model.getSnapshot);
    const history = props.source.history.useState();
    const ids = props.source.useMessageIdsOldestFirst();
    const byId = props.source.useMessagesById();
    const metadata = props.source.useMetadata();
    const { viewerScope: accountScope } = props.source.useAuthorship();
    const { permissionDisabledReason, canSendMessages, canOpenFiles } = props.source.useInteraction();
    const workspacePath = props.source.useWorkspacePath();
    const attribution = useSessionTranscriptAgentAttributionIndex();
    const connection = props.source.useConnectionState();
    const thinkingDisplayMode = useSetting('sessionThinkingDisplayMode');
    const toolViewTimelineChromeMode = useSetting('toolViewTimelineChromeMode');
    const debugInformationEnabled = useSessionDebugInformationEnabled();
    const [workflowDetails, setWorkflowDetails] = React.useState<ReadonlyMap<string, WorkflowRunDetailState | null>>(() => new Map());
    const publishWorkflow = React.useCallback((id: string, detail: WorkflowRunDetailState | null) => {
        setWorkflowDetails((previous) => {
            if (previous.has(id) && previous.get(id) === detail) return previous;
            const next = new Map(previous); next.set(id, detail); return next;
        });
    }, []);
    const messages = React.useMemo(() => {
        const sourceIds = new Set(ids);
        const transcriptIds = new Set(props.items.flatMap(collectTranscriptNavigationMessageIdsForItem));
        // Ancestor rows supplied by the canonical list retain their source identity.
        // The list also owns pending crossover: a queued card's committed twin has
        // no transcript row to reveal or mark until that crossover completes.
        return [...props.loadedMessages.filter((message) => !sourceIds.has(message.id)),
            ...ids.flatMap((id) => transcriptIds.has(id) && byId[id] ? [byId[id]] : [])];
    }, [byId, ids, props.items, props.loadedMessages]);
    const workflowMessages = React.useMemo(() => messages.filter((message): message is Extract<Message, {kind:'tool-call'}> =>
        props.source.kind === 'app' && message.kind === 'tool-call'
        && resolveWorkflowRunHeadlineForToolUseId(metadata, message.tool.id) !== null), [messages, metadata, props.source.kind]);
    const reviewRunIds = React.useMemo(() => collectStructuredMessageReviewRunIds(messages, {
        canNavigate: props.source.navigate !== null, debugInformationEnabled,
    }), [messages, props.source.navigate, debugInformationEnabled]);
    // Full transcript cards share their already-loaded scoped comments. Find never
    // creates an ambient Account read or starts a second review-loading path.
    const reviewSnapshots = useReviewRunsComments({ scope: accountScope, sessionId: props.sessionId,
        runIds: reviewRunIds, enabled: false });
    const reviewComments = React.useMemo(() => new Map(reviewRunIds.map((id, index) => [id, reviewSnapshots[index]])),
        [reviewRunIds, reviewSnapshots]);
    const readReviewComments = React.useCallback((runId: string) => reviewComments.get(runId), [reviewComments]);
    const displayContexts = React.useMemo(() => {
        const next = new Map<string, TranscriptFindTextContext>();
        for (const message of messages) {
            const usesSessionMessages = structuredMessageFindUsesSessionMessages(message, debugInformationEnabled);
            const detail = workflowDetails.get(message.id);
            const context: TranscriptFindTextContext = {
                thinkingDisplayMode, debugInformationEnabled,
                sessionId: props.sessionId, serverId: props.serverId,
                canNavigate: props.source.navigate !== null, canSendMessages, canOpenFiles: canOpenFiles === true,
                canJumpToAnchor: canOpenFiles === true && props.source.navigate !== null,
                hasWorkspacePath: Boolean(workspacePath),
                ...(usesSessionMessages ? { sessionMessages: messages } : {}),
                ...(usesSessionMessages && props.source.navigate === null ? { readReviewComments } : {}),
                ...(message.kind === 'tool-call' ? { metadata, accountScope, permissionDisabledReason,
                    toolViewTimelineChromeMode,
                    historicalAgentId: resolveHistoricalAgentIdAtSeq(attribution, message.seq),
                    messages: message.children,
                    workflowRun: detail?.state === 'loaded' ? detail.snapshot : null } : {}),
            };
            next.set(message.id, context);
        }
        return next;
    }, [messages, thinkingDisplayMode, debugInformationEnabled, props.sessionId, props.serverId, props.source.navigate,
        canSendMessages, canOpenFiles, workspacePath, readReviewComments, workflowDetails, metadata, accountScope,
        permissionDisabledReason, attribution, toolViewTimelineChromeMode]);
    const corpus = React.useMemo<TranscriptFindCorpus>(() => ({
        messages, history, displayContexts,
        hasPendingText: workflowMessages.some((message) => !workflowDetails.get(message.id) || workflowDetails.get(message.id)?.state === 'loading')
            || reviewRunIds.some((id) => !reviewComments.get(id) || ['idle', 'loading'].includes(reviewComments.get(id)!.status)),
        hasUnreadableText: workflowMessages.some((message) => workflowDetails.get(message.id)?.state === 'missing')
            || reviewRunIds.some((id) => reviewComments.get(id)?.status === 'failed'),
    }), [messages, history, displayContexts, workflowDetails, workflowMessages, reviewRunIds, reviewComments]);
    const visible = props.visible;
    React.useLayoutEffect(() => {
        if (!visible) return;
        props.publishCorpus(corpus); props.model.refresh();
    }, [corpus, props.model, props.publishCorpus, visible]);
    const phone = useFindBarPresentation() === 'keyboardSeated';
    const coverage = snapshot.status.kind === 'results' ? snapshot.status.coverage : null;
    const onClearance = props.onClearance;
    // The capsule floats over the transcript: its bottom edge plus one gutter is the band content keeps clear.
    const measureClearance = React.useCallback((event: LayoutChangeEvent) => {
        onClearance(findBarBandFromLayout(event.nativeEvent.layout, TRANSCRIPT_TOP_GUTTER_PX));
    }, [onClearance]);
    React.useEffect(() => { if (phone) onClearance(0); }, [onClearance, phone]);
    React.useEffect(() => () => onClearance(0), [onClearance]);
    const bar = <FindBarPlacement visible={visible} onLayout={phone ? undefined : measureClearance}>{(presentation) =>
        <FindBar query={snapshot.query} options={snapshot.options} status={snapshot.status}
            capabilities={props.controller.capabilities} surfaceLabel={t('find.surface.chat')}
            presentation={presentation} autoFocus inputRef={props.inputRef}
            onInputFocus={props.onInputFocus} onInputBlur={props.onInputBlur}
            onQueryChange={props.controller.setQuery} onOptionsChange={props.controller.setOptions}
            onStep={props.controller.step} onStop={props.controller.stop} onClose={props.controller.close}
            testID="transcript-find"
            // One quiet note under the bar (Find lab ST): what is being searched, why the count is not
            // everything, and its one way forward; Stop takes the action's place while older pages load.
            note={snapshot.status.kind === 'searching' ? { icon: 'history', text: t('find.note.searchingOlder') }
                : coverage === 'partialErrors' ? { icon: 'info', text: t('transcriptFind.partialErrors'),
                    ...(history.hasOlder && connection !== 'offline' ? {
                        action: { label: t('common.retry'), onPress: props.model.searchOlder, testID: 'transcript-find-retry' },
                    } : {}) }
                : connection === 'offline' ? { icon: 'offline', text: t('find.note.offlineOlder') }
                : props.olderLoadFailed && props.onRetryOlderLoad ? { icon: 'info', text: t('session.transcript.olderLoadFailedTitle'),
                    action: { label: t('common.retry'), onPress: props.onRetryOlderLoad, testID: 'transcript-find-older-load-retry' } }
                : history.hasOlder && snapshot.query && snapshot.status.kind === 'results' ? {
                    icon: 'history',
                    text: t('transcriptFind.olderRemaining'),
                    action: { label: t('transcriptFind.searchOlder'), onPress: props.model.searchOlder, testID: 'transcript-find-search-older' },
                }
                : coverage === 'olderRemaining' ? { icon: 'history', text: t('transcriptFind.olderRemaining') } : undefined} />
    }</FindBarPlacement>;
    return <>
        {visible ? workflowMessages.map((message) => <WorkflowFindObservation key={message.id} message={message}
            source={props.source} metadata={metadata} publish={publishWorkflow} />) : null}
        {/* The phone bar sits on the keyboard and has no ruler (lab F1p); wide surfaces mark the scroll edge. */}
        {phone || !visible ? null : <TranscriptFindRuler model={props.model} measureMessage={props.measureMessage}
            contentHeight={props.contentHeight}
            olderRemaining={history.hasOlder && snapshot.query !== '' && snapshot.status.kind !== 'invalidPattern'} />}
        {bar}
    </>;
}
