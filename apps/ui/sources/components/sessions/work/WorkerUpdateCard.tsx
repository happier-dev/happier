import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import type { WorkerDeliverableReferenceV1, WorkerUpdateV1 } from '@happier-dev/protocol';

import { hasAgentIconMark } from '@/agents/catalog/catalog';
import { AgentIcon } from '@/agents/registry/AgentIcon';
import { useSessionTranscriptSource } from '@/components/sessions/transcript/source/SessionTranscriptSourceContext';
import { buildSessionExecutionRunRouteHref } from '@/components/sessions/agents/navigation/buildSessionExecutionRunRouteHref';
import { resolveExecutionRunBackendLabel } from '@/components/sessions/runs/resolveExecutionRunBackendLabel';
import { RoundButton } from '@/components/ui/buttons/RoundButton';
import { SurfaceCard } from '@/components/ui/cards/SurfaceCard';
import { Icon, type IconName } from '@/components/ui/icons/Icon';
import { Text } from '@/components/ui/text/Text';
import { resolveWorkStatusTone } from '@/components/work/status/resolveWorkStatusTone';
import { describeWorkStatusBucket } from '@/components/work/status/workStatusBuckets';
import { workStatusSurfaceStyle, workStatusWordStyle } from '@/components/work/status/workStatusTreatment';
import { Typography } from '@/constants/Typography';
import { buildScopedSessionRouteHref } from '@/hooks/session/sessionRouteServerScope';
import { useSessionDisplayNameSource } from '@/sync/domains/state/storage';
import { MarkdownView } from '@/components/markdown/MarkdownView';
import { t } from '@/text';
import { getSessionName } from '@/utils/sessions/sessionUtils';
import { formatShortRelativeTime } from '@/utils/time/formatShortRelativeTime';
import { FindHighlightedText } from '@/components/ui/text/FindHighlightedText';
import { StructuredFindText, useStructuredFindState, type StructuredFindTextBlock } from '@/components/sessions/transcript/structured/structuredFindText';

const MARK_SIZE = 15;

function readOwnerWord(update: WorkerUpdateV1): string {
    if (update.workerKind === 'workflow_run') return t(`workflows.runState.${update.ownerState}`);
    switch (update.ownerState) {
        case 'settled': return t('sessionWork.workerUpdate.settled');
        case 'needs_input': return describeWorkStatusBucket('needs_you');
        case 'stalled': return t('sessionWork.workerUpdate.stalled');
        case 'published': return t('sessionWork.workerUpdate.published');
        case 'timeout': return t('sessionAgentActivity.status.timedOut');
        case 'failed': return t('workflows.runState.failed');
        case 'cancelled': return t('workflows.runState.cancelled');
        case 'succeeded': return t('workflows.runState.succeeded');
    }
}

const KIND_LABEL_KEYS = {
    session: 'sessionWork.kinds.session',
    execution_run: 'sessionWork.kinds.backgroundRun',
    workflow_run: 'sessionWork.kinds.workflowRun',
} as const satisfies Record<WorkerUpdateV1['workerKind'], string>;

function buildWorkerUpdateDisplayText(update: WorkerUpdateV1, options: Readonly<{ title?: string; at?: number; canInspect?: boolean }> = {}) {
    const age = options.at === undefined ? '' : formatShortRelativeTime(options.at);
    const kind = t(KIND_LABEL_KEYS[update.workerKind]);
    const engine = update.engine;
    const engineLabel = engine ? resolveExecutionRunBackendLabel({ kind: 'backend', backendId: engine.agentId }) ?? engine.agentId : null;
    return {
        title: options.title ?? update.headline,
        state: readOwnerWord(update),
        kind: age ? `${kind} · ${age}` : kind,
        result: update.result,
        engine: engineLabel ? `${engineLabel}${engine?.modelId ? ` · ${engine.modelId}` : ''}` : null,
        truncated: update.truncated ? t('sessionWork.workerUpdate.truncated') : null,
        inspect: options.canInspect ? (update.transcriptPointer?.kind === 'session' ? t('runs.openSession') : t('runs.openRun')) : null,
    };
}

/** Historical completion rows consume the same human fields as the actual shared worker card. */
export function projectWorkerUpdateFindText(update: WorkerUpdateV1, options: Readonly<{ title?: string; at?: number; canInspect?: boolean }> = {}): readonly StructuredFindTextBlock[] {
    const content = buildWorkerUpdateDisplayText(update, options);
    return Object.entries(content).flatMap(([field, text]) => field !== 'inspect' && text ? [{ id: `structured-worker-${field}`, text }] : []);
}

/** A run has no agent of its own to show, so it is marked by its kind (Work rows use the same glyphs). */
const KIND_GLYPHS = {
    session: 'sparkle',
    execution_run: 'play-circle',
    workflow_run: 'stack-simple',
} as const satisfies Record<WorkerUpdateV1['workerKind'], IconName>;

/** A session worker is named by its own title when this device knows it; a run by its producer's headline. */
function useWorkerTitle(update: WorkerUpdateV1, serverId: string | null | undefined): string {
    const source = useSessionDisplayNameSource(update.workerKind === 'session' ? update.workerId : '', serverId);
    return update.workerKind === 'session' && source ? getSessionName(source, serverId) : update.headline;
}

const WorkerMark = React.memo(function WorkerMark(props: Readonly<{ update: WorkerUpdateV1 }>) {
    const { theme } = useUnistyles();
    const agentId = props.update.workerKind === 'session' ? props.update.engine?.agentId ?? null : null;
    if (agentId && hasAgentIconMark(agentId, theme)) return <AgentIcon agentId={agentId} size={MARK_SIZE} />;
    return <Icon name={KIND_GLYPHS[props.update.workerKind]} size={MARK_SIZE} color={theme.colors.text.secondary} />;
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
 * One transcript card for host worker updates and retained historical completions (ORC §3.2, lab
 * `cards-T1`/`T2`): head (mark · worker · state word · kind · age), the result, then a footer of facts
 * with the inspect action. Healthy updates stay neutral; the tone owner rings and tints the ones
 * that need the person. Ids never show: the inspect action carries the pointer.
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
    const status = resolveWorkStatusTone({ kind: 'worker_update', facts: { update, word: content.state } });
    const inspect = () => {
        if (!canInspect || !pointer) return;
        if (pointer.kind === 'workflow_run') {
            const query = props.serverId ? `?serverId=${encodeURIComponent(props.serverId)}` : '';
            transcriptSource.navigate?.(`/workflows/runs/${encodeURIComponent(pointer.runId)}${query}`);
            return;
        }
        const href = pointer.kind === 'session'
            ? buildScopedSessionRouteHref({ sessionId: pointer.sessionId, serverId: props.serverId })
            : buildSessionExecutionRunRouteHref({ sessionId: pointer.sessionId, runId: pointer.runId, serverId: props.serverId });
        if (href) transcriptSource.navigate?.(href);
    };
    const resultBody = props.children === undefined
        ? (content.result ? <Text testID="worker-update-result" selectable style={styles.result}>{decorate('result', content.result, true)}</Text> : null)
        : props.children;
    const deliverableServerId = props.serverId ?? transcriptSource.serverId;
    const body = resultBody || update.deliverables?.length ? <>
        {resultBody}
        {update.deliverables?.map((reference, index) => <WorkerDeliverable
            key={JSON.stringify([deliverableServerId, reference, index])} reference={reference} index={index}
            serverId={deliverableServerId} enabled={props.navigationEnabled !== false && Boolean(deliverableServerId)} />)}
    </> : null;
    const hasFooter = props.facts !== undefined || engine !== undefined || update.truncated === true || canInspect;
    return (
        <SurfaceCard testID={`worker-update:${update.workerId}`} tone="muted" padding="none" style={workStatusSurfaceStyle(status.tone)}>
            <View style={[styles.head, body ? null : styles.headAlone]}>
                <WorkerMark update={update} />
                <StructuredFindText blockId="structured-worker-title" testID="worker-update-title" numberOfLines={1} style={styles.title} text={content.title} />
                <StructuredFindText blockId="structured-worker-state" testID="worker-update-state" numberOfLines={1} style={[styles.word, workStatusWordStyle(status.tone)]} text={status.word} />
                <View style={styles.grow} />
                <StructuredFindText blockId="structured-worker-kind" testID="worker-update-kind" numberOfLines={1} style={styles.kind} text={content.kind} />
            </View>
            {body ? <View style={styles.body}>{body}</View> : null}
            {hasFooter ? (
                <View testID="worker-update-footer" style={styles.footer}>
                    {props.facts}
                    {engine ? <StructuredFindText blockId="structured-worker-engine" testID="worker-update-engine" numberOfLines={1} style={styles.fact} text={content.engine ?? ''} /> : null}
                    {content.truncated ? <StructuredFindText blockId="structured-worker-truncated" testID="worker-update-truncated" numberOfLines={1} style={styles.fact} text={content.truncated} /> : null}
                    <View style={styles.grow} />
                    {content.inspect ? <RoundButton testID="worker-update-inspect" size="small" display="inverted" title={decorate('inspect', content.inspect)} onPress={inspect} /> : null}
                </View>
            ) : null}
        </SurfaceCard>
    );
}

const styles = StyleSheet.create((theme) => ({
    head: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 8,
        minWidth: 0,
        paddingHorizontal: theme.margins.md,
        paddingTop: theme.margins.md,
        paddingBottom: theme.margins.xs,
    },
    title: {
        ...Typography.rowTitle(),
        color: theme.colors.text.primary,
        flexShrink: 1,
    },
    word: {
        ...Typography.default(),
        color: theme.colors.text.secondary,
        flexShrink: 1,
    },
    headAlone: {
        paddingBottom: theme.margins.md,
    },
    grow: {
        flexGrow: 1,
    },
    kind: {
        ...Typography.rowMeta(),
        ...Typography.tabular(),
        color: theme.colors.text.tertiary,
        flexShrink: 1,
    },
    body: {
        paddingHorizontal: theme.margins.md,
        paddingBottom: theme.margins.md,
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
    footer: {
        flexDirection: 'row',
        flexWrap: 'wrap',
        alignItems: 'center',
        gap: theme.margins.sm,
        minWidth: 0,
        paddingLeft: theme.margins.md,
        paddingRight: theme.margins.sm,
        paddingVertical: theme.margins.xs,
        borderTopWidth: StyleSheet.hairlineWidth,
        borderTopColor: theme.colors.border.default,
    },
    fact: {
        ...Typography.rowMeta(),
        color: theme.colors.text.secondary,
        flexShrink: 1,
    },
}));
