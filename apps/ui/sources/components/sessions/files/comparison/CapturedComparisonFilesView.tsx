import * as React from 'react';
import { View } from 'react-native';
import { useUnistyles } from 'react-native-unistyles';
import type { ScmComparison } from '@happier-dev/protocol/scm/comparison';

import { ChangedFilesReview } from '@/components/workspaces/scm/review/ChangedFilesReview';
import { ScmComparisonHeader } from './ScmComparisonHeader';
import { buildCapturedComparisonFiles } from './capturedComparisonFiles';
import { resolveFilesComparisonLabel } from './filesComparison';
import { scmReviewComparisonOfCaptured } from '@/sync/domains/scm/diffSummary/selection';
import { AttentionBanner } from '@/components/ui/lists/AttentionBanner';
import { SurfaceFreshnessLine } from '@/components/ui/surfaces/SurfaceFreshnessLine';
import { SurfaceStateCard } from '@/components/ui/surfaces/SurfaceStateCard';
import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import { t } from '@/text';
import type { WorkspaceScopeBase } from '@/sync/domains/workspaces/workspaceScope';
import type { ScmReviewedMarks } from './useScmReviewedMarks';
import { useReviewListHunkReview } from '@/components/workspaces/scm/review/hunkReview/useReviewListHunkReview';
import type { ScmDiffSummaryHost } from '@/sync/ops/scmDiffSummary/results';
import { useCapturedComparisonEvidence } from './useCapturedComparisonEvidence';
import { SectionActionButton } from '@/components/ui/lists/SectionActionButton';
import { retainDeep } from '@/sync/domains/state/structuralSharing';

type ReviewProps = React.ComponentProps<typeof ChangedFilesReview>;
const NO_ATTRIBUTED_FILES: ReviewProps['sessionAttributedFiles'] = [];
const NO_FILES: ReviewProps['repositoryOnlyFiles'] = [];
const NO_DRAFTS: NonNullable<ReviewProps['reviewCommentDrafts']> = [];
const doNotOpenWorkingFile = () => {};

/** The Files renderer for immutable captured evidence, shared by PR, branch, commit and pinned routes. */
export function CapturedComparisonFilesView(props: Readonly<{
    comparison: ScmComparison;
    active?: boolean;
    sessionId?: string;
    reviewScopeKey?: string;
    comparisonChrome?: ReviewProps['comparisonChrome'];
    hideViewed?: boolean;
    onShowViewed?: () => void;
    maxFiles: number;
    maxChangedLines: number;
    initialCollapsedPaths?: readonly string[] | null;
    onCollapsedPathsChange?: (paths: string[]) => void;
    initialScrollTop?: number | null;
    onScrollTopChange?: (top: number) => void;
    activeReviewFile?: ReviewProps['activeReviewFile'];
    workspaceScope?: WorkspaceScopeBase | null;
    marks?: ScmReviewedMarks;
    discardEnabled?: boolean;
    onRefresh?: () => void;
    serverId?: string | null;
    host?: ScmDiffSummaryHost;
    comparisonSessionId?: string;
    page?: Readonly<{ totalFiles: number; nextCursor: number | null }> | null;
    onLoadMore?: () => void;
    loadingMore?: boolean;
    error?: string | null;
    reviewComments?: ReviewProps['reviewComments'];
    onUpsertReviewCommentDraft?: ReviewProps['onUpsertReviewCommentDraft'];
    onReviewCommentError?: ReviewProps['onReviewCommentError'];
}>) {
    const { theme } = useUnistyles();
    const host = props.host ?? (props.sessionId ? { sessionId: props.sessionId }
        : props.workspaceScope ? { machineId: props.workspaceScope.machineId } : null);
    const evidence = useCapturedComparisonEvidence(props.comparison, {
        host, serverId: props.serverId ?? props.workspaceScope?.serverId, comparisonSessionId: props.comparisonSessionId,
    });
    const comparison = evidence.comparison ?? props.comparison;
    const evidenceKey = evidence.key;
    const previousProjection = React.useRef<ReturnType<typeof buildCapturedComparisonFiles> | undefined>(undefined);
    const projected = React.useMemo(() => {
        const next = buildCapturedComparisonFiles(comparison);
        next.files = retainDeep(previousProjection.current?.files, next.files);
        next.snapshot = retainDeep(previousProjection.current?.snapshot, next.snapshot);
        previousProjection.current = next;
        return next;
    }, [comparison]);
    const initiallyCollapsed = React.useMemo(() => props.initialCollapsedPaths ?? props.comparison.inventory.files
        .filter((file) => file.generated || file.lockfile).map((file) => file.path), [props.initialCollapsedPaths, props.comparison]);
    const resolvingEvidence = evidence.resolution.kind === 'resolving'
        && comparison.inventory.files.some(file => file.evidence.state === 'deferred');
    const providedNotes = props.comparisonChrome?.renderFileNotes;
    const renderFileNotes = React.useCallback((path: string, placement: 'column' | 'inline') => {
        const reason = projected.unavailableByPath.get(path);
        const notes = providedNotes?.(path, placement);
        return reason || notes ? <View>
            {reason ? <Text testID={`captured-file-unavailable-${path}`} style={{ color: theme.colors.text.secondary, ...Typography.default(), padding: theme.space.s12 }}>
                {t('walkthrough.evidence.unavailable', { reason })}
            </Text> : null}
            {notes}
        </View> : null;
    }, [projected.unavailableByPath, providedNotes, theme.colors.text.secondary]);
    const chrome = React.useMemo<NonNullable<ReviewProps['comparisonChrome']>>(() => {
        const source = scmReviewComparisonOfCaptured(props.comparison);
        const scopeLabel = source ? resolveFilesComparisonLabel(source, null) : t('scmComparison.view.files');
        const renderHeader: NonNullable<ReviewProps['comparisonChrome']>['renderHeader'] = props.comparisonChrome?.renderHeader
            ?? ((coverage, facts) => <ScmComparisonHeader viewLabel={t('scmComparison.view.files')} scopeLabel={scopeLabel} coverage={coverage}
                reviewed={facts?.viewed ?? null} />);
        return { renderBarLeading: () => null,
            indexPlacement: 'stream', ...props.comparisonChrome, rootPath: props.comparison.repository.rootPath, renderFileNotes,
            renderHeader };
    }, [props.comparison, props.comparisonChrome, renderFileNotes, theme.colors.text.secondary]);
    const readEvidence = evidence.read;
    const fetchCapturedDiff = React.useCallback<NonNullable<ReviewProps['fetchUnifiedDiffForPath']>>(async ({ path }) => {
        const response = await readEvidence(path);
        return response.success && typeof response.diff === 'string' ? { success: true, diff: response.diff }
            : { success: false, errorCode: response.errorCode ?? 'invalid_action_output', error: response.error ?? t('scmComparison.unsupportedReason') };
    }, [readEvidence]);
    const unavailableEmpty = comparison.inventory.state !== 'complete' && comparison.inventory.files.length === 0;
    const emptyState = unavailableEmpty ? <SurfaceStateCard testID="captured-comparison-unavailable" kind="error"
        title={comparison.inventory.reasons.join(' · ') || t('hunkReview.noticeUnavailable')}
        action={props.onRefresh ? { label: t('common.retry'), onPress: props.onRefresh } : undefined} /> : undefined;
    const renderReview = (hunkReview?: ReviewProps['hunkReview']) => <ChangedFilesReview activeReviewFile={props.activeReviewFile} theme={theme} sessionId={props.sessionId} hideViewed={props.hideViewed} onShowViewed={props.onShowViewed} fileViewedTotal={props.page?.totalFiles}
            reviewScopeKey={JSON.stringify([props.reviewScopeKey ?? props.sessionId, evidenceKey])}
            snapshot={projected.snapshot} changedFilesViewMode="repository"
            emptyState={emptyState}
            allRepositoryChangedFiles={projected.files} sessionAttributedFiles={NO_ATTRIBUTED_FILES} repositoryOnlyFiles={NO_FILES}
            maxFiles={props.maxFiles} maxChangedLines={props.maxChangedLines} onFilePress={doNotOpenWorkingFile}
            evidenceOnly workspaceScope={props.workspaceScope} hunkReview={hunkReview}
            reviewCommentsEnabled={!!props.onUpsertReviewCommentDraft} reviewCommentDrafts={NO_DRAFTS}
            reviewComments={props.reviewComments}
            onUpsertReviewCommentDraft={props.onUpsertReviewCommentDraft} onReviewCommentError={props.onReviewCommentError}
            comparisonChrome={chrome} providerDiffByPath={projected.diffByPath} fetchUnifiedDiffForPath={fetchCapturedDiff}
            comparisonFiles={comparison.inventory.files}
            initialCollapsedPaths={initiallyCollapsed} onCollapsedPathsChange={props.onCollapsedPathsChange}
            initialScrollTop={props.initialScrollTop} onScrollTopChange={props.onScrollTopChange} rowDensity="compact" />;
    return <View testID="captured-comparison-files" style={{ flex: 1, minHeight: 0 }}>
        {props.error ? <SurfaceFreshnessLine testID="captured-comparison-refresh-error" tone="warning" reason={props.error}
            action={props.onRefresh ? { label: t('common.retry'), onPress: props.onRefresh } : undefined} /> : null}
        {props.comparison.inventory.state !== 'complete' && !unavailableEmpty ? <AttentionBanner presentation="strip" testID="captured-inventory-incomplete" tone="warning"
            title={t('walkthrough.evidence.unavailable', { reason: props.comparison.inventory.reasons.join(' · ') })} /> : null}
        {props.comparison.freshness === 'stale' || props.comparison.freshness === 'unknown' ? <SurfaceFreshnessLine testID="captured-comparison-freshness" tone="warning"
            reason={t(props.comparison.freshness === 'stale' ? 'scmComparison.capturedStale' : 'scmComparison.capturedFreshnessUnknown')} /> : null}
        {resolvingEvidence ? <SurfaceStateCard kind="loading" title={t('common.loading')} />
            : props.workspaceScope ? <CapturedReviewControls scope={props.workspaceScope} comparison={comparison}
            active={props.active !== false}
            sessionId={props.sessionId} marks={props.marks} discard={props.discardEnabled === true}
            refresh={props.onRefresh ?? doNotOpenWorkingFile}>{renderReview}</CapturedReviewControls> : renderReview()}
        {props.page?.nextCursor != null ? <View testID="captured-comparison-pagination">
            <Text>{props.comparison.inventory.files.length} / {props.page.totalFiles}</Text>
            <SectionActionButton testID="captured-comparison-load-more" title={t('common.more')} icon="caret-down"
                loading={props.loadingMore} disabled={props.loadingMore} onPress={() => props.onLoadMore?.()} />
        </View> : null}
    </View>;
}

function CapturedReviewControls(props: Readonly<{
    scope: WorkspaceScopeBase; comparison: ScmComparison; sessionId?: string; marks?: ScmReviewedMarks;
    active?: boolean;
    discard: boolean; refresh: () => void; children: (review: NonNullable<ReviewProps['hunkReview']>) => React.ReactNode;
}>) {
    const review = useReviewListHunkReview(props);
    return props.children(review);
}
