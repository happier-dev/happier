import * as React from 'react';
import { View } from 'react-native';
import { HappierPressable } from '@happier-dev/plugin-ui/presentation';
import { StyleSheet } from 'react-native-unistyles';
import type { ReviewCommentCreateResponseV1 } from '@happier-dev/protocol/reviews/comments/actions';
import type { ReviewCommentV1 } from '@happier-dev/protocol/reviews/comments/v1';
import type { ReviewRoundComparisonCaptureV1 } from '@happier-dev/protocol/reviews/reviewArtifactV1';

import { useMountedActionExecution } from '@/components/approvals/useMountedActionExecution';
import { useHydrateSession } from '@/hooks/session/useHydrateSessionForRoute';
import { WorkspaceScmReviewBody, type ScmReviewComparisonChrome, type ScmReviewViewContext } from '@/components/projects/scm/WorkspaceScmReviewBody';
import { CapturedComparisonFilesView } from '@/components/sessions/files/comparison/CapturedComparisonFilesView';
import { ScmComparisonHeaderToggle } from '@/components/sessions/files/comparison/ScmComparisonBar';
import { resolveFilesComparisonLabel } from '@/components/sessions/files/comparison/filesComparison';
import { useCapturedScmComparison } from '@/components/sessions/files/comparison/useCapturedScmComparison';
import type { useScmDiffSummaryBinding } from '@/components/sessions/files/comparison/useScmDiffSummaryBinding';
import { useSessionScmDiffSummaryBinding } from '@/components/sessions/files/comparison/useSessionScmDiffSummaryBinding';
import { useWorkspaceScmDiffSummaryBinding } from '@/components/projects/scm/useWorkspaceScmDiffSummaryBinding';
import { useScmReviewedMarks } from '@/components/sessions/files/comparison/useScmReviewedMarks';
import { ScmWalkthroughView } from '@/components/sessions/files/walkthrough/ScmWalkthroughView';
import type { SessionScmReviewComparison, SessionScmReviewView } from '@/components/sessions/panes/details/sessionDetailsTabBuilders';
import { SurfaceStateCard } from '@/components/ui/surfaces/SurfaceStateCard';
import { resolveItemGroupContentHorizontalInsetPx } from '@/components/ui/lists/itemGroupSpacing';
import { useLayoutPresentationActive } from '@/components/ui/presentation/PluginSurfaceFocusEligibility';
import { Text } from '@/components/ui/text/Text';
import { useCheckoutReachability, describeCheckoutUnreachable } from '@/components/workspaces/reachability/checkoutReachabilityModel';
import { requestActiveReviewFileForComparison } from '@/components/workspaces/scm/review/activeReviewFile';
import { Modal } from '@/modal';
import { useScmReviewLimits } from '@/scm/review/useScmReviewLimits';
import type { ReviewCommentDraft } from '@/sync/domains/input/reviewComments/reviewCommentTypes';
import { createReviewCommentsActions } from '@/sync/domains/reviews/comments/actions';
import { submitDurableReviewCommentDraft } from '@/sync/domains/reviews/comments/promoteDraft';
import { recordReviewCommentWrites } from '@/sync/domains/reviews/comments/reviewRunComments';
import { scmReviewComparisonOfSource } from '@/sync/domains/scm/diffSummary/selection';
import { areServerAccountScopesEqual, type ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';
import { useServerCredentialAccountScopeBinding } from '@/sync/domains/scope/useServerCredentialAccountScopes';
import type { ScmDiffSummaryHost } from '@/sync/ops/scmDiffSummary/results';
import { t } from '@/text';

import { reviewSeverityLabel } from '@/components/sessions/reviews/findings/reviewFindingPresentation';
import { ReviewFindingCode } from './finding/ReviewFindingBody';

import { ReviewCommentSnapshotView } from './ReviewCommentSnapshotView';
import { resolveReviewCommentBodyText, resolveReviewCommentSnapshot, splitReviewCommentBody } from './content';
import { buildReviewCommentLabels } from './sessionSurfaceLabels';
import { ReviewFindingAnchorContext } from './ReviewFindingAnchor';

type ReviewChangesView = 'files' | 'walkthrough';

/** Hide viewed on a Review's Files: the Host's one state, changed only through its current-context command. */
export type ReviewViewedFilter = Readonly<{ hidden: boolean; onHiddenChange: (hidden: boolean) => void }>;

export type ReviewChangesHostProps = Readonly<{
    reviewId: string;
    roundOrdinal: number;
    scope: ServerAccountScope;
    capture: ReviewRoundComparisonCaptureV1 | null;
    /** Hydrated comments already filtered by the detail's selected round and reviewers. */
    comments: readonly ReviewCommentV1[];
    view: ReviewChangesView;
    /** Offered when the round's source keeps Viewed marks (a pull request). */
    viewedFilter?: ReviewViewedFilter;
    onSelectView: (view: ReviewChangesView) => void;
    onOpenComment: (commentId: string) => void;
    /** The opened Review's finding rows, sharing its decisions and row identities. */
    renderFileNotes?: ScmReviewComparisonChrome['renderFileNotes'];
    onOpenFile?: (path: string) => void;
    active?: boolean;
}>;

const ignore = () => {};
const NO_SCOPE_OPTIONS = [] as const;

function reportCommentError(error: string) {
    Modal.alert(t('common.error'), error);
}

/**
 * Without the full changes, each finding keeps its sealed code excerpt (lab `detail-nomachine`): the
 * finding's title and severity, then the captured lines in the shared code frame under their file.
 */
function ReviewEvidenceExcerpts(props: Pick<ReviewChangesHostProps, 'comments' | 'onOpenComment'>) {
    const labels = buildReviewCommentLabels();
    const excerpts = props.comments.flatMap(comment => {
        const snapshot = resolveReviewCommentSnapshot(comment.snapshot);
        return snapshot?.kind === 'none' ? [] : [{ comment, snapshot }];
    });
    if (excerpts.length === 0) return null;
    return <View testID="review-changes-sealed-excerpts" style={excerptStyles.list}>
        {excerpts.map(({ comment, snapshot }) => {
            // A finding's own title names its excerpt; a plain comment falls back to its body's title line.
            const title = comment.finding?.title ?? splitReviewCommentBody(resolveReviewCommentBodyText(comment.body, labels)).title;
            const path = 'filePath' in comment.anchor ? comment.anchor.filePath : null;
            const line = 'startLine' in comment.anchor ? comment.anchor.startLine : null;
            return <View key={comment.id} style={excerptStyles.item}>
                <HappierPressable testID={`review-changes-excerpt:${comment.id}`} accessibilityRole="button"
                    onPress={() => props.onOpenComment(comment.id)} style={excerptStyles.head}>
                    <Text variant="label" emphasis="semiBold" style={excerptStyles.title} numberOfLines={2}>
                        {title ?? path ?? t('common.open')}
                    </Text>
                    {comment.findingSeverity ? <Text variant="label" style={excerptStyles.severity}>
                        {reviewSeverityLabel(comment.findingSeverity)}</Text> : null}
                </HappierPressable>
                {snapshot?.kind === 'text' ? <ReviewFindingCode {...capturedExcerpt(snapshot, path, line)} path={path} /> : null}
                <ReviewCommentSnapshotView comment={comment} labels={labels} />
            </View>;
        })}
    </View>;
}

/**
 * A captured excerpt as the finding's Where draws code: its lines numbered from where they sit in the file, the
 * lines the finding is about banded. The lines go in as one context hunk under the file's diff header; a row's id
 * is `c:<raw line index>`, so the excerpt's first line follows the two file lines and the hunk header.
 */
function capturedExcerpt(snapshot: Readonly<{ beforeContext: readonly string[]; selectedLines: readonly string[]; afterContext: readonly string[] }>,
    path: string | null, startLine: number | null) {
    const lines = [...snapshot.beforeContext, ...snapshot.selectedLines, ...snapshot.afterContext];
    const first = Math.max(1, (startLine ?? 1) - snapshot.beforeContext.length);
    const file = path ?? 'excerpt';
    const header = [`--- a/${file}`, `+++ b/${file}`, `@@ -${first},${lines.length} +${first},${lines.length} @@`];
    const unifiedDiff = [...header, ...lines.map(text => ` ${text}`)].join('\n');
    const highlightLineIds = new Set(snapshot.selectedLines.map((_, index) => `c:${header.length + snapshot.beforeContext.length + index}`));
    return { unifiedDiff, highlightLineIds };
}

/** The round's changes are on a Machine this viewer can't reach: say where to open them, then the excerpts. */
export function ReviewChangesUnavailable(props: Pick<ReviewChangesHostProps, 'comments' | 'onOpenComment'> & Readonly<{ reason: string | null }>) {
    return <View style={[excerptStyles.list, excerptStyles.inset]}>
        <SurfaceStateCard testID="review-changes-unavailable" kind="empty" layout="inline"
            title={t('reviewWalkthrough.detail.noMachineTitle')}
            reason={props.reason ?? t('reviewWalkthrough.detail.noMachineReason')} />
        <ReviewEvidenceExcerpts comments={props.comments} onOpenComment={props.onOpenComment} />
    </View>;
}

const excerptStyles = StyleSheet.create((theme) => ({
    list: { gap: theme.space.s16 },
    // On the Review page's sheet edge, with the glance and tabs above it.
    inset: { paddingHorizontal: resolveItemGroupContentHorizontalInsetPx() },
    item: { gap: theme.space.s6 },
    head: { flexDirection: 'row', alignItems: 'baseline', gap: theme.space.s8, flexWrap: 'wrap' },
    title: { color: theme.colors.text.primary, flexShrink: 1 },
    severity: { color: theme.colors.text.secondary },
}));

export function ReviewChangesHost(props: ReviewChangesHostProps) {
    const presented = useLayoutPresentationActive();
    if (props.active === false || !presented) return null;
    // A finding under its line opens the finding on this page.
    return <ReviewFindingAnchorContext.Provider value={props.onOpenComment}>
        <ScopedReviewChanges {...props} />
    </ReviewFindingAnchorContext.Provider>;
}

function ScopedReviewChanges(props: ReviewChangesHostProps) {
    const { resolution } = useServerCredentialAccountScopeBinding(props.scope.serverId);
    if (resolution.kind === 'resolving') return <SurfaceStateCard kind="loading" title={t('common.loading')} />;
    if (resolution.kind !== 'bound' || !areServerAccountScopesEqual(resolution.scope, props.scope)) return null;
    const capture = props.capture;
    const comparison = capture && scmReviewComparisonOfSource(capture.input.source, capture.input.comparisonId);
    if (!capture || !comparison) return <ReviewChangesUnavailable reason={null} comments={props.comments} onOpenComment={props.onOpenComment} />;
    const identity = JSON.stringify([props.scope.serverId, props.scope.accountId, props.reviewId, props.roundOrdinal, capture.input.comparisonId]);
    return <BoundReviewChanges key={identity} {...props} identity={identity} capture={capture} comparison={comparison} />;
}

function BoundReviewChanges(props: ReviewChangesHostProps & Readonly<{
    identity: string;
    capture: ReviewRoundComparisonCaptureV1;
    comparison: SessionScmReviewComparison;
}>) {
    const { capture, comparison, identity, scope } = props;
    const { machineId } = capture.target;
    const { cwd, sessionId } = capture.input;
    const { serverId } = scope;
    const host: ScmDiffSummaryHost = React.useMemo(() => ({ machineId }), [machineId]);
    const machine = React.useMemo(() => ({ machineId, basePath: cwd }), [machineId, cwd]);
    const workspaceScope = React.useMemo(() => ({ serverId, machineId, rootPath: cwd }), [serverId, machineId, cwd]);
    const reachability = useCheckoutReachability(workspaceScope);
    const [indexPageSize, setIndexPageSize] = React.useState<number | null>(null);
    const activeReviewFile = React.useMemo(() => ({ key: identity, presented: true, externalLifecycle: true }), [identity]);
    const index = useCapturedScmComparison({ host, comparisonSessionId: sessionId, machine, identity: machine,
        serverId, comparison, active: props.view === 'files' && !reachability.unreachable, indexPageSize });
    const marks = useScmReviewedMarks({ host, serverId, comparisonSessionId: sessionId, comparison: props.view === 'files' ? index.comparison : null,
        observation: 'keyed' });
    const limits = useScmReviewLimits();
    const { executeValue } = useMountedActionExecution(scope);
    const actions = React.useMemo(() => createReviewCommentsActions({ execute: executeValue }), [executeValue]);
    const saveGutterComment = React.useCallback(async (draft: ReviewCommentDraft) => {
        const result = await submitDurableReviewCommentDraft({ reviewId: props.reviewId, roundOrdinal: props.roundOrdinal, draft, clientMutationId: draft.id,
            actions: { create: async (input) => await actions.create(input) as ReviewCommentCreateResponseV1 } });
        recordReviewCommentWrites([result.comment], scope);
    }, [actions, props.reviewId, props.roundOrdinal, scope]);
    const openFile = React.useCallback((path: string) => {
        if (props.onOpenFile) props.onOpenFile(path);
        else requestActiveReviewFileForComparison(identity, path, comparison);
    }, [comparison, identity, props.onOpenFile]);
    const selectView = React.useCallback((view: SessionScmReviewView) => {
        if (view !== 'commits') props.onSelectView(view);
    }, [props.onSelectView]);
    const scopeLabel = resolveFilesComparisonLabel(comparison, null);
    const unavailable = reachability.unreachable ? describeCheckoutUnreachable(reachability) : index.error;
    const excerpts = <ReviewEvidenceExcerpts comments={props.comments} onOpenComment={props.onOpenComment} />;
    const viewedFilter = props.view === 'files' ? props.viewedFilter : undefined;
    const onViewedHiddenChange = viewedFilter?.onHiddenChange;
    const showViewed = React.useMemo(() => onViewedHiddenChange ? () => onViewedHiddenChange(false) : undefined, [onViewedHiddenChange]);
    // Keyed on the Host's memoized filter, so the shared header chrome rebuilds only when Hide viewed changes.
    const hideViewedToggle = React.useMemo(() => viewedFilter ? <ScmComparisonHeaderToggle testID="review-changes:hide-viewed"
        icon="eye-slash" label={t('hunkReview.hideViewed')} value={viewedFilter.hidden} onChange={viewedFilter.onHiddenChange} />
        : null, [viewedFilter]);
    if (reachability.unreachable) return <ReviewChangesUnavailable reason={unavailable} comments={props.comments} onOpenComment={props.onOpenComment} />;
    const filesState = index.comparison ? null : unavailable ? <>
        <SurfaceStateCard size="line" kind="error" title={unavailable} action={{ label: t('common.retry'), onPress: index.retry }} />
        {excerpts}
    </> : <SurfaceStateCard kind="loading" title={t('common.loading')} />;
    // The changes keep the page's column, on the edge its sections and tabs stand on.
    return <View style={excerptStyles.inset}><WorkspaceScmReviewBody hosted comparison={comparison} view={props.view} scopeLabel={scopeLabel}
        scopeOptions={NO_SCOPE_OPTIONS} onSelectComparison={ignore} onSelectView={selectView} rootPath={cwd}
        activeReviewFile={activeReviewFile} onVisibleFileRowCountChange={setIndexPageSize} headerAccessory={hideViewedToggle}
        explain={false} onExplainChange={ignore} filesState={filesState}
        renderFiles={(chrome) => index.comparison ? <CapturedComparisonFilesView comparison={index.comparison}
            hideViewed={viewedFilter?.hidden} onShowViewed={showViewed}
            comparisonChrome={props.renderFileNotes ? { ...chrome, renderFileNotes: props.renderFileNotes } : chrome}
            host={host} comparisonSessionId={sessionId} serverId={serverId}
            workspaceScope={workspaceScope} activeReviewFile={activeReviewFile} marks={marks}
            reviewComments={props.comments}
            {...limits} page={index.page} onLoadMore={index.loadMore} loadingMore={index.loading} error={index.error}
            onRefresh={index.retry} onUpsertReviewCommentDraft={saveGutterComment} onReviewCommentError={reportCommentError} /> : null}
        renderWalkthrough={(context) => <ReviewChangesWalkthrough context={context} capture={capture} comparison={comparison}
            scopeLabel={scopeLabel} serverId={serverId} machine={machine} onOpenFile={openFile} />} /></View>;
}

type ReviewChangesWalkthroughProps = Readonly<{
    context: ScmReviewViewContext;
    capture: ReviewRoundComparisonCaptureV1;
    comparison: SessionScmReviewComparison;
    scopeLabel: string;
    serverId: string;
    machine: Readonly<{ machineId: string; basePath: string }>;
    onOpenFile: (path: string) => void;
}>;

function ReviewChangesWalkthrough(props: ReviewChangesWalkthroughProps) {
    const sessionId = props.capture.input.sessionId;
    return sessionId ? <SessionReviewChangesWalkthrough {...props} sessionId={sessionId} />
        : <WorkspaceReviewChangesWalkthrough {...props} />;
}

function SessionReviewChangesWalkthrough(props: ReviewChangesWalkthroughProps & Readonly<{ sessionId: string }>) {
    useHydrateSession(props.sessionId, 'ReviewChangesWalkthrough', { serverId: props.serverId, hydrateMessages: false });
    const bound = useSessionScmDiffSummaryBinding({ sessionId: props.sessionId, serverId: props.serverId,
        comparison: props.comparison, output: 'walkthrough' });
    return <ReviewChangesWalkthroughView {...props} bound={bound} />;
}

function WorkspaceReviewChangesWalkthrough(props: ReviewChangesWalkthroughProps) {
    const bound = useWorkspaceScmDiffSummaryBinding({ machineId: props.machine.machineId, rootPath: props.machine.basePath,
        serverId: props.serverId, comparison: props.comparison, output: 'walkthrough' });
    return <ReviewChangesWalkthroughView {...props} bound={bound} />;
}

function ReviewChangesWalkthroughView(props: ReviewChangesWalkthroughProps & Readonly<{ bound: ReturnType<typeof useScmDiffSummaryBinding> }>) {
    return <ScmWalkthroughView {...props.context} bound={props.bound} comparison={props.comparison} scopeLabel={props.scopeLabel}
        sessionId={props.capture.input.sessionId} displayMachineId={props.machine.machineId} serverId={props.serverId} onOpenFile={props.onOpenFile} />;
}
