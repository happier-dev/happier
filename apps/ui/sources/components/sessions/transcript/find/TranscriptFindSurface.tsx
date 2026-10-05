import * as React from 'react';
import { Platform, TextInput, View } from 'react-native';
import type { FindController } from '@happier-dev/plugin-ui/presentation';
import { resolveHistoricalAgentIdAtSeq, type Message } from '@happier-dev/session-core/messages';

import { FindBar } from '@/components/ui/find/FindBar';
import { ComposerKeyboardFloatingInset } from '@/components/sessions/keyboardAvoidance';
import { ChatFindSeedHost } from '@/components/appShell/panes/fileFindSeedHost';
import { usePluginSurfaceFocusEligibility } from '@/components/ui/presentation/PluginSurfaceFocusEligibility';
import { useFindSurfaceRegistration } from '@/keyboard/KeyboardShortcutProvider';
import { readDocumentFocusReturnTarget, restoreFocusToBestTarget, type FocusReturnTarget } from '@/keyboard/focusReturn';
import { t } from '@/text';
import { useDeviceType } from '@/utils/platform/responsive';
import { useSetting } from '@/sync/domains/state/storage';
import { useSessionDebugInformationEnabled } from '@/sync/runtime/useSessionDebugInformationEnabled';
import { useReviewRunsComments } from '@/components/sessions/reviews/findings/useReviewRunComments';
import { collectStructuredMessageReviewRunIds, structuredMessageFindUsesSessionMessages } from '../structured/StructuredMessageBlock';
import { useWorkflowRunForToolUseId, resolveWorkflowRunHeadlineForToolUseId } from '@/components/sessions/workState/useSessionWorkflowActivity';
import type { WorkflowRunDetailState } from '@/components/sessions/workState/sessionWorkflowActivityTypes';
import type { SessionTranscriptSource } from '../source/types';
import { useSessionTranscriptAgentAttributionIndex } from '../attribution/SessionTranscriptAgentAttributionContext';
import type { TranscriptFindCorpus, TranscriptFindModel } from './useTranscriptFind';
import { TranscriptFindProvider } from './TranscriptFindContext';
import { TranscriptFindRuler, type TranscriptFindMessageLayout } from './TranscriptFindRuler';
import type { TranscriptFindTextContext } from './transcriptFindText';

type Props = Readonly<{
    model: TranscriptFindModel;
    source: SessionTranscriptSource;
    sessionId: string;
    serverId: string | null;
    focused: boolean;
    viewportRef: React.RefObject<React.ElementRef<typeof View> | null>;
    loadedMessages: readonly Message[];
    publishCorpus(corpus: TranscriptFindCorpus): void;
    /** Where a message's row sits in the list content (the list's own layout; no row is mounted). */
    measureMessage: TranscriptFindMessageLayout;
    contentHeight: number;
    children: React.ReactNode;
}>;

/** The surface stays mounted; only the bar and source reader subscribe while Find is open. */
export function TranscriptFindSurface(props: Props) {
    const { model } = props;
    const open = React.useSyncExternalStore(model.subscribe, () => model.getSnapshot().open, () => false);
    const eligible = usePluginSurfaceFocusEligibility() && props.focused;
    const input = React.useRef<TextInput | null>(null);
    const [inputFocused, setInputFocused] = React.useState(false);
    const returnFocus = React.useRef<FocusReturnTarget>(null);
    const containsFocus = () => {
        if (!eligible) return false;
        if (Platform.OS !== 'web') return true;
        const viewport = props.viewportRef.current as unknown as HTMLElement | null;
        const target = typeof document === 'undefined' ? null : document.activeElement;
        if (!viewport || !target) return false;
        if (viewport.contains(target)) return true;
        // Composer is a sibling of the transcript, not an independently findable pane.
        const session = viewport.closest('[data-testid^="session-view-retained-surface:"]');
        const composer = target.closest('[data-testid="agent-input-composer"]');
        return Boolean(session && composer && session.contains(composer));
    };
    const close = () => {
        model.close(); setInputFocused(false);
        restoreFocusToBestTarget(returnFocus);
        returnFocus.current = null;
    };
    const controller: FindController = {
        get query() { return model.query; }, get options() { return model.options; },
        get status() { return model.status; }, get capabilities() { return model.capabilities; },
        setQuery: model.setQuery, setOptions: model.setOptions, step: model.step, stop: model.stop, close,
    };
    const openFind = () => {
        if (!model.getSnapshot().open) {
            if (Platform.OS === 'web' && typeof document !== 'undefined') {
                returnFocus.current = readDocumentFocusReturnTarget(document);
            } else {
                returnFocus.current = TextInput.State.currentlyFocusedInput();
            }
        }
        model.open(); input.current?.focus();
    };
    useFindSurfaceRegistration({
        surfaceId: `transcript:${props.serverId ?? ''}:${props.sessionId}`,
        containsFocus, open: openFind, isOpen: () => open, isInputFocused: () => inputFocused,
        controller,
    });
    return <TranscriptFindProvider store={model.rowStore} enabled={open}>
        {props.children}
        {open ? <TranscriptFindActive {...props} controller={controller} inputRef={input}
            onInputFocus={() => setInputFocused(true)} onInputBlur={() => setInputFocused(false)} /> : null}
        {props.serverId ? <ChatFindSeedHost sessionId={props.sessionId} serverId={props.serverId} active={eligible}>
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
        // Ancestor rows supplied by the canonical list retain their source identity.
        return [...props.loadedMessages.filter((message) => !sourceIds.has(message.id)),
            ...ids.flatMap((id) => byId[id] ? [byId[id]] : [])];
    }, [byId, ids, props.loadedMessages]);
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
    React.useLayoutEffect(() => { props.publishCorpus(corpus); props.model.refresh(); }, [corpus, props.model, props.publishCorpus]);
    const deviceType = useDeviceType();
    const phone = Platform.OS !== 'web' && deviceType === 'phone';
    const coverage = snapshot.status.kind === 'results' ? snapshot.status.coverage : null;
    const bar = <View style={{ maxWidth: 560 }}>
        <FindBar query={snapshot.query} options={snapshot.options} status={snapshot.status}
            capabilities={props.controller.capabilities} surfaceLabel={t('find.surface.chat')}
            presentation={phone ? 'keyboardSeated' : 'inline'} autoFocus inputRef={props.inputRef}
            onInputFocus={props.onInputFocus} onInputBlur={props.onInputBlur}
            onQueryChange={props.controller.setQuery} onOptionsChange={props.controller.setOptions}
            onStep={props.controller.step} onStop={props.controller.stop} onClose={props.controller.close}
            testID="transcript-find"
            // One quiet note under the bar (Find lab ST): what is being searched, why the count is not
            // everything, and its one way forward; Stop takes the action's place while older pages load.
            note={snapshot.status.kind === 'searching' ? { icon: 'history', text: t('find.note.searchingOlder') }
                : coverage === 'partialErrors' ? { icon: 'info', text: t('transcriptFind.partialErrors') }
                : connection === 'offline' ? { icon: 'offline', text: t('find.note.offlineOlder') }
                : history.hasOlder && snapshot.query && snapshot.status.kind === 'results' ? {
                    icon: 'history',
                    text: t('transcriptFind.olderRemaining'),
                    action: { label: t('transcriptFind.searchOlder'), onPress: props.model.searchOlder, testID: 'transcript-find-search-older' },
                }
                : coverage === 'olderRemaining' ? { icon: 'history', text: t('transcriptFind.olderRemaining') } : undefined} />
    </View>;
    return <>
        {workflowMessages.map((message) => <WorkflowFindObservation key={message.id} message={message}
            source={props.source} metadata={metadata} publish={publishWorkflow} />)}
        {/* The phone bar sits on the keyboard and has no ruler (lab F1p); wide surfaces mark the scroll edge. */}
        {phone ? null : <TranscriptFindRuler model={props.model} measureMessage={props.measureMessage}
            contentHeight={props.contentHeight}
            olderRemaining={history.hasOlder && snapshot.query !== '' && snapshot.status.kind !== 'invalidPattern'} />}
        {phone ? <ComposerKeyboardFloatingInset baseBottom={8} style={{ position: 'absolute', left: 8, right: 8 }}>
            {bar}</ComposerKeyboardFloatingInset> : <View pointerEvents="box-none"
                style={{ position: 'absolute', top: 10, right: 14, left: 14, alignItems: 'flex-end' }}>{bar}</View>}
    </>;
}
