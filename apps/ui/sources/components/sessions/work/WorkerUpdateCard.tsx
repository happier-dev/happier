import * as React from 'react';
import { View, type StyleProp, type ViewStyle } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import type { WorkerDeliverableReferenceV1, WorkerUpdateV1 } from '@happier-dev/protocol';
import { HAPPIER_WORK_UPDATE_CARD_MARK_SIZE_PX, HappierWorkUpdateCard, type HappierWorkUpdateCardFact, type HappierWorkUpdateCardSurface, joinHappierFacts } from '@happier-dev/plugin-ui/presentation';
import { useWorkTheme, WORK_HOST, workTextStyle } from '@/components/work/map/WorkMapView';

import { hasAgentIconMark } from '@/agents/catalog/catalog';
import { AgentIcon } from '@/agents/registry/AgentIcon';
import { useSessionTranscriptSource } from '@/components/sessions/transcript/source/SessionTranscriptSourceContext';
import { buildSessionExecutionRunRouteHref } from '@/components/sessions/agents/navigation/buildSessionExecutionRunRouteHref';
import { resolveExecutionRunBackendLabel } from '@/components/sessions/runs/resolveExecutionRunBackendLabel';
import { RoundButton } from '@/components/ui/buttons/RoundButton';
import { SurfaceCard } from '@/components/ui/cards/SurfaceCard';
import { Icon } from '@/components/ui/icons/Icon';
import { describeWorkKind, WORKER_KIND_GLYPHS } from './workerKindGlyphs';
import { Text } from '@/components/ui/text/Text';
import { resolveWorkStatusTone } from '@/components/work/status/resolveWorkStatusTone';
import { workStatusWordStyle } from '@/components/work/status/workStatusTreatment';
import { Typography } from '@/constants/Typography';
import { buildScopedSessionRouteHref } from '@/hooks/session/sessionRouteServerScope';
import { useActiveServerAccountScope, useSessionDisplayNameSource, useWorkflowRun } from '@/sync/domains/state/storage';
import { MarkdownView } from '@/components/markdown/MarkdownView';
import { t } from '@/text';
import { getSessionName } from '@/utils/sessions/sessionUtils';
import { formatShortRelativeTime } from '@/utils/time/formatShortRelativeTime';
import { FindHighlightedText } from '@/components/ui/text/FindHighlightedText';
import { StructuredFindText, useStructuredFindState, type StructuredFindTextBlock } from '@/components/sessions/transcript/structured/structuredFindText';
import { useAppPaneScope } from '@/components/appShell/panes/hooks/useAppPaneScope';
import { useOptionalAppPaneContext } from '@/components/appShell/panes/AppPaneProvider';
import { useDestinationPaneScopeId } from '@/components/appShell/workspace/DestinationInstanceHost';
import { createSessionPaneScopeId } from '@/components/sessions/panes/sessionPaneScopeId';
import { AppSessionTranscriptSourceProvider } from '@/components/sessions/transcript/source/appSessionTranscriptSource';
import { SessionPendingPromptCards } from '@/components/tools/shell/permissions/SessionPendingPromptCards';
import { useSessionPendingPrompts } from '@/components/voice/presence/VoiceNeedsYouPrompts';
import { describeWorkflowRunProgress } from '@/components/workflows/presentation/workflowRunProgress';
import { areServerProfileIdentifiersEquivalent } from '@/sync/domains/server/serverProfiles';
import { normalizeSessionAddress, type SessionAddress } from '@/sync/domains/session/sessionAddress';
import { createWorkflowInvocationRoute, createWorkflowRunRoute } from '@/sync/domains/workflows/workflowRunRoute';
import { useDeviceType } from '@/utils/platform/responsive';
import { createSessionPeekDetailsTab } from './createSessionPeekDetailsTab';

const MARK_SIZE = HAPPIER_WORK_UPDATE_CARD_MARK_SIZE_PX;

function buildWorkerUpdateDisplayText(update: WorkerUpdateV1, options: Readonly<{ title?: string; at?: number; canInspect?: boolean }> = {}) {
    const age = options.at === undefined ? '' : formatShortRelativeTime(options.at);
    const kind = describeWorkKind(update.workerKind);
    const engine = update.engine;
    const engineLabel = engine ? resolveExecutionRunBackendLabel({ kind: 'backend', backendId: engine.agentId }) ?? engine.agentId : null;
    return {
        title: options.title ?? update.headline,
        state: resolveWorkStatusTone({ kind: 'worker_update', facts: { update } }).word,
        kind: joinHappierFacts(kind, age),
        result: update.result,
        engine: engineLabel ? joinHappierFacts(engineLabel, engine?.modelId) : null,
        truncated: update.truncated ? t('sessionWork.workerUpdate.truncated') : null,
        inspect: options.canInspect ? (update.transcriptPointer?.kind === 'session' ? t('runs.openSession') : t('runs.openRun')) : null,
    };
}

/** Historical completion rows consume the same human fields as the actual shared worker card. */
export function projectWorkerUpdateFindText(update: WorkerUpdateV1, options: Readonly<{ title?: string; at?: number; canInspect?: boolean }> = {}): readonly StructuredFindTextBlock[] {
    const content = buildWorkerUpdateDisplayText(update, options);
    return Object.entries(content).flatMap(([field, text]) => field !== 'inspect' && text ? [{ id: `structured-worker-${field}`, text }] : []);
}

/** A session worker is named by its own title when this device knows it; a run by its producer's headline. */
function useWorkerTitle(update: WorkerUpdateV1, serverId: string | null | undefined): string {
    const source = useSessionDisplayNameSource(update.workerKind === 'session' ? update.workerId : '', serverId);
    return update.workerKind === 'session' && source ? getSessionName(source, serverId) : update.headline;
}

const WorkerMark = React.memo(function WorkerMark(props: Readonly<{ update: WorkerUpdateV1 }>) {
    const { theme } = useUnistyles();
    const agentId = props.update.workerKind === 'session' ? props.update.engine?.agentId ?? null : null;
    if (agentId && hasAgentIconMark(agentId, theme)) return <AgentIcon agentId={agentId} size={MARK_SIZE} />;
    return <Icon name={WORKER_KIND_GLYPHS[props.update.workerKind]} size={MARK_SIZE} color={theme.colors.text.secondary} />;
});

/** Closed rows do no reads. File destinations own their reads; inline Artifacts recheck access. */
function WorkerDeliverable(props: Readonly<{
    reference: WorkerDeliverableReferenceV1;
    index: number;
    serverId: string | null | undefined;
    enabled: boolean;
}>) {
    const transcriptSource = useSessionTranscriptSource();
    const [preview, setPreview] = React.useState<Readonly<{ title: string; body: string }> | null>(null);
    const [unavailable, setUnavailable] = React.useState(false);
    const operation = React.useRef<Readonly<{ controller: AbortController; dispose: () => void }> | null>(null);
    React.useEffect(() => () => {
        operation.current?.controller.abort();
        operation.current?.dispose();
    }, []);
    const open = async () => {
        operation.current?.controller.abort();
        operation.current?.dispose();
        operation.current = null;
        setPreview(null);
        if (preview) return;
        setUnavailable(false);
        const controller = new AbortController();
        operation.current = { controller, dispose: () => {} };
        let context: Awaited<ReturnType<typeof import('@/sync/ops/actions/actionAccountContext').captureLazyActionAccountContext>> | null = null;
        let keepPreview = false;
        try {
            if (!props.enabled || !props.serverId) throw new Error('content_unavailable');
            if (props.reference.kind === 'workspace_file') {
                if (!transcriptSource.navigate) throw new Error('content_unavailable');
                // The existing Home-qualified file route owns hydration, access and file failures.
                transcriptSource.navigate(buildScopedSessionRouteHref({
                    sessionId: props.reference.sessionId, serverId: props.serverId,
                    suffix: '/file', query: { path: props.reference.path },
                }));
                return;
            }
            const { captureLazyActionAccountContext } = await import('@/sync/ops/actions/actionAccountContext');
            context = await captureLazyActionAccountContext(props.serverId, controller.signal);
            const retirement = context.accountLifetime.onRetire(() => {
                if (!controller.signal.aborted) { setPreview(null); setUnavailable(true); }
            });
            operation.current = { controller, dispose: () => { retirement.dispose(); context?.dispose(); } };
            const artifact = await context.fetchArtifact(props.reference.artifactId);
            if (!artifact?.isDecrypted || (artifact.body !== null && typeof artifact.body !== 'string')) throw new Error('content_unavailable');
            context.assertCurrent();
            setPreview({ title: artifact.title ?? t('artifacts.untitled'), body: artifact.body ?? '' });
            keepPreview = true;
        } catch {
            if (!controller.signal.aborted) { setPreview(null); setUnavailable(true); }
        } finally {
            if (!keepPreview && operation.current?.controller === controller) {
                operation.current.dispose();
                operation.current = null;
            }
        }
    };
    const label = props.reference.kind === 'workspace_file' ? props.reference.path : preview?.title ?? t('artifacts.untitled');
    return <View style={styles.deliverable}>
        <RoundButton testID={`worker-deliverable:${props.index}`} size="small" display="inverted"
            title={label} titleNumberOfLines="complete" action={open} disabled={!props.enabled}
            expanded={preview !== null} />
        {unavailable || !props.enabled ? <Text testID="worker-deliverable-unavailable" style={styles.fact}>{t('common.unavailable')}</Text> : null}
        {preview ? <MarkdownView testID="worker-deliverable-preview" markdown={preview.body} selectable /> : null}
    </View>;
}

/**
 * A worker Session's waiting requests on its needs-you card (ORC S-1, lab `cards-T1`: "Deny · Allow
 * for this session · Allow once"): the real request cards, decided through that Session's own approval
 * custody — the same owner the composer, the peek and the Inbox answer through. Mounted only on a
 * card whose worker needs the person, so the worker's requests are read only while there may be
 * something to decide; once it is answered anywhere, it leaves every card.
 */
const WorkerUpdateAnswers = React.memo(function WorkerUpdateAnswers(props: Readonly<{ address: SessionAddress }>) {
    const { session, prompts } = useSessionPendingPrompts(props.address);
    if (!session || !prompts) return null;
    return (
        <View testID="worker-update-answers" style={styles.answers}>
            {/* The card sits in the lead's transcript; the request, its navigation and its custody are the worker's. */}
            <AppSessionTranscriptSourceProvider sessionId={props.address.sessionId} serverId={props.address.serverId}>
                <SessionPendingPromptCards
                    testID="worker-update-prompts"
                    sessionId={props.address.sessionId}
                    serverId={props.address.serverId}
                    session={session}
                    permissions={prompts.permissions}
                    userActions={prompts.userActions}
                    chrome="inline"
                />
            </AppSessionTranscriptSourceProvider>
        </View>
    );
});

/** Peek, mounted only where a pane host exists: it opens the worker in the lead's Details pane. */
function WorkerUpdatePeekAction(props: Readonly<{ sessionId: string; title: string }>) {
    const transcriptSource = useSessionTranscriptSource();
    const paneScopeId = useDestinationPaneScopeId(createSessionPaneScopeId(transcriptSource.sessionId, transcriptSource.serverId));
    const pane = useAppPaneScope(paneScopeId);
    const peek = () => pane.openDetailsTab(createSessionPeekDetailsTab({ sessionId: props.sessionId, title: props.title }), { intent: 'preview' });
    return <RoundButton testID="worker-update-peek" size="small" display="inverted" title={t('sessionWork.workerUpdate.peek')} onPress={peek} />;
}

/** The card stands on core's inset card material; the frame hands it the tone's ring and tint. */
function renderWorkerUpdateSurface(surface: HappierWorkUpdateCardSurface) {
    return (
        <SurfaceCard testID={surface.testID} tone="muted" padding="none" style={surface.toneStyle as StyleProp<ViewStyle>}>
            {surface.children}
        </SurfaceCard>
    );
}

/**
 * One transcript card for host worker updates and retained historical completions (ORC §3.2, lab
 * `cards-T1`/`T2`), drawn with the shared Work update card (`HappierWorkUpdateCard`, the frame a
 * plugin's own work draws with): head (mark · worker · state word · kind · age), the result, then a
 * footer of facts and the actions its state calls for.
 *
 * - Healthy updates stay neutral with one quiet way in; the tone owner rings and tints the ones that
 *   need the person or failed.
 * - A worker Session that needs the person carries its waiting requests, answered in place, and a
 *   quiet Peek beside the lead.
 * - A workflow run that needs the person carries the one primary: Review, at the step that waits.
 *
 * Ids never show: the actions carry the pointer.
 */
export function WorkerUpdateCard(props: Readonly<{
    update: WorkerUpdateV1;
    serverId?: string | null;
    navigationEnabled?: boolean;
    /** When the update reached the transcript; drives the head's age. */
    at?: number;
    /** Replaces the result body while retaining the shared head, footer and inspection. */
    children?: React.ReactNode;
    /** Extra footer facts a caller owns (a PR, a review outcome), before the card's own. */
    facts?: React.ReactNode;
}>) {
    const transcriptSource = useSessionTranscriptSource();
    const workTheme = useWorkTheme();
    const deviceType = useDeviceType();
    const { update } = props;
    const find = useStructuredFindState();
    const decorate = (field: string, text: string, selectable = false) => {
        const ranges = find.ranges(`structured-worker-${field}`);
        return ranges?.length ? <FindHighlightedText text={text} ranges={ranges} selectable={selectable} /> : text;
    };
    const title = useWorkerTitle(update, props.serverId);
    const engine = update.engine;
    const pointer = update.transcriptPointer;
    const canInspect = update.canInspect && props.navigationEnabled !== false && transcriptSource.navigate !== null && pointer !== undefined;
    const content = buildWorkerUpdateDisplayText(update, { title, at: props.at, canInspect });
    const status = resolveWorkStatusTone({ kind: 'worker_update', facts: { update } });
    const needsYou = status.bucket === 'needs_you';
    const serverId = props.serverId ?? transcriptSource.serverId;

    // The run's own progress, when this device already knows the run in its exact Home (the active
    // store holds only the active Account's runs). A stated fact, never a read the card starts.
    const activeScope = useActiveServerAccountScope();
    const runInActiveHome = update.workerKind === 'workflow_run' && activeScope !== null && Boolean(serverId)
        && areServerProfileIdentifiersEquivalent(activeScope.serverId, serverId ?? '');
    const run = useWorkflowRun(runInActiveHome ? update.workerId : null);
    const progress = run?.summary ? describeWorkflowRunProgress(run.summary.stepProgress) : null;

    const inspect = () => {
        if (!canInspect || !pointer) return;
        if (pointer.kind === 'workflow_run') {
            // The step that waits when the update names it; otherwise the run.
            const route = pointer.invocationRecordId
                ? createWorkflowInvocationRoute(pointer.runId, pointer.invocationRecordId, props.serverId)
                : createWorkflowRunRoute(pointer.runId, props.serverId);
            transcriptSource.navigate?.(route);
            return;
        }
        const href = pointer.kind === 'session'
            ? buildScopedSessionRouteHref({ sessionId: pointer.sessionId, serverId: props.serverId })
            : buildSessionExecutionRunRouteHref({ sessionId: pointer.sessionId, runId: pointer.runId, serverId: props.serverId });
        if (href) transcriptSource.navigate?.(href);
    };

    // Peek: the worker beside the lead, in the lead's own Details pane (lab `session-D`). Offered only
    // where that pane exists: not on a phone (the one way in is the Session itself) and not where the
    // card renders outside a pane host (a run page, a shared transcript).
    const hasPaneHost = useOptionalAppPaneContext() !== null;
    const peekSessionId = canInspect && needsYou && pointer?.kind === 'session' && deviceType !== 'phone' && hasPaneHost
        ? pointer.sessionId : null;

    const answersAddress = needsYou && update.workerKind === 'session' && props.navigationEnabled !== false
        ? normalizeSessionAddress(serverId, update.workerId) : null;
    const resultBody = props.children === undefined
        ? (content.result ? <Text testID="worker-update-result" selectable style={styles.result}>{decorate('result', content.result, true)}</Text> : null)
        : props.children;
    const body = resultBody || update.deliverables?.length || answersAddress ? <>
        {resultBody}
        {update.deliverables?.map((reference, index) => <WorkerDeliverable
            key={JSON.stringify([serverId, reference, index])} reference={reference} index={index}
            serverId={serverId} enabled={props.navigationEnabled !== false && Boolean(serverId)} />)}
        {answersAddress ? <WorkerUpdateAnswers address={answersAddress} /> : null}
    </> : null;

    const facts: HappierWorkUpdateCardFact[] = [];
    if (props.facts !== undefined) facts.push({ id: 'caller', label: props.facts });
    if (progress) facts.push({ id: 'progress', label: progress });
    if (engine) {
        facts.push({ id: 'engine', label: <StructuredFindText blockId="structured-worker-engine" testID="worker-update-engine" numberOfLines={1} style={styles.fact} text={content.engine ?? ''} /> });
    }
    if (content.truncated) {
        facts.push({ id: 'truncated', label: <StructuredFindText blockId="structured-worker-truncated" testID="worker-update-truncated" numberOfLines={1} style={styles.fact} text={content.truncated} /> });
    }

    // One primary at most, and only where the person is the blocker and the card cannot answer in
    // place: a run's review or request is decided on its own page.
    const review = canInspect && needsYou && update.workerKind === 'workflow_run';
    const actions = !content.inspect ? undefined : review ? (
        <RoundButton testID="worker-update-action:review" size="small" display="default" title={t('inboxWork.rows.review')} onPress={inspect} />
    ) : (
        <RoundButton testID="worker-update-inspect" size="small"
            display={needsYou && update.workerKind === 'execution_run' ? 'default' : 'inverted'}
            title={decorate('inspect', content.inspect)} onPress={inspect} />
    );

    return (
        <HappierWorkUpdateCard
            testID={`worker-update:${update.workerId}`}
            slotTestIDPrefix="worker-update"
            tone={status.tone}
            theme={workTheme}
            host={WORK_HOST}
            renderSurface={renderWorkerUpdateSurface}
            mark={<WorkerMark update={update} />}
            title={<StructuredFindText blockId="structured-worker-title" testID="worker-update-title" numberOfLines={1} style={styles.title} text={content.title} />}
            state={<StructuredFindText blockId="structured-worker-state" testID="worker-update-state" numberOfLines={1} style={[styles.word, workStatusWordStyle(status.tone)]} text={status.word} />}
            meta={<StructuredFindText blockId="structured-worker-kind" testID="worker-update-kind" numberOfLines={1} style={styles.kind} text={content.kind} />}
            facts={facts}
            leadingAction={peekSessionId ? <WorkerUpdatePeekAction sessionId={peekSessionId} title={title} /> : undefined}
            actions={actions}
        >{body}</HappierWorkUpdateCard>
    );
}

// The head's text is the shared card's own steps (`HAPPIER_WORK_TEXT`), drawn by the transcript's
// find-aware text so a match in a worker's name or state is marked and revealed.
const styles = StyleSheet.create((theme) => ({
    title: {
        ...workTextStyle('cardTitle'),
        color: theme.colors.text.primary,
    },
    word: {
        ...workTextStyle('cardWord'),
        color: theme.colors.text.secondary,
    },
    kind: {
        ...workTextStyle('cardMeta'),
        color: theme.colors.text.tertiary,
    },
    result: {
        ...Typography.default(),
        color: theme.colors.text.primary,
    },
    deliverable: {
        alignItems: 'flex-start',
        alignSelf: 'stretch',
        gap: theme.margins.xs,
        marginTop: theme.margins.sm,
    },
    answers: {
        alignSelf: 'stretch',
        marginTop: theme.margins.sm,
    },
    fact: {
        ...workTextStyle('cardFact'),
        color: theme.colors.text.secondary,
    },
}));
