import * as React from 'react';
import { View } from 'react-native';
import { useUnistyles } from 'react-native-unistyles';
import type { ScmComparison, ScmComparisonFile } from '@happier-dev/protocol/scm/comparison';

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
import { readCapturedScmFileForSession } from '@/sync/ops/scmDiffSummary/generate';
import type { ScmDiffSummaryHost } from '@/sync/ops/scmDiffSummary/results';
import { useServerCredentialAccountScopeBinding } from '@/sync/domains/scope/useServerCredentialAccountScopes';
import { SectionActionButton } from '@/components/ui/lists/SectionActionButton';

type ReviewProps = React.ComponentProps<typeof ChangedFilesReview>;
const NO_ATTRIBUTED_FILES: ReviewProps['sessionAttributedFiles'] = [];
const NO_FILES: ReviewProps['repositoryOnlyFiles'] = [];
const doNotOpenWorkingFile = () => {};

/** The Files renderer for immutable captured evidence, shared by PR, branch, commit and pinned routes. */
export function CapturedComparisonFilesView(props: Readonly<{
    comparison: ScmComparison;
    sessionId?: string;
    reviewScopeKey?: string;
    comparisonChrome?: ReviewProps['comparisonChrome'];
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
    page?: Readonly<{ totalFiles: number; nextCursor: number | null }> | null;
    onLoadMore?: () => void;
    loadingMore?: boolean;
    error?: string | null;
}>) {
    const { theme } = useUnistyles();
    const { binding, resolution } = useServerCredentialAccountScopeBinding(props.serverId ?? props.workspaceScope?.serverId);
    const scope = resolution.kind === 'bound' ? resolution.scope : null;
    const evidenceKey = JSON.stringify([scope?.serverId, scope?.accountId, props.comparison.id]);
    const [hydrated, setHydrated] = React.useState<Readonly<{ key: string; files: ReadonlyMap<string, ScmComparisonFile> }> | null>(null);
    const comparison = React.useMemo(() => hydrated?.key === evidenceKey ? { ...props.comparison,
        inventory: { ...props.comparison.inventory, files: props.comparison.inventory.files.map(file => hydrated.files.get(file.path) ?? file) } }
        : props.comparison, [props.comparison, hydrated, evidenceKey]);
    const projected = React.useMemo(() => buildCapturedComparisonFiles(comparison), [comparison]);
    const initiallyCollapsed = React.useMemo(() => props.initialCollapsedPaths ?? comparison.inventory.files
        .filter((file) => file.generated || file.lockfile).map((file) => file.path), [props.initialCollapsedPaths, comparison]);
    const resolvingEvidence = resolution.kind === 'resolving'
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
            ?? ((coverage) => <ScmComparisonHeader viewLabel={t('scmComparison.view.files')} scopeLabel={scopeLabel} coverage={coverage} />);
        return { renderBarLeading: () => null,
            indexPlacement: 'stream', ...props.comparisonChrome, rootPath: props.comparison.repository.rootPath, renderFileNotes,
            renderHeader };
    }, [props.comparison, props.comparisonChrome, renderFileNotes, theme.colors.text.secondary]);
    const fetchCapturedDiff = React.useCallback<NonNullable<ReviewProps['fetchUnifiedDiffForPath']>>(async ({ path }) => {
        const file = props.comparison.inventory.files.find(file => file.path === path);
        if (typeof file?.evidence.unifiedDiff === 'string') return { success: true, diff: file.evidence.unifiedDiff };
        if (file?.evidence.state !== 'deferred' || !binding?.isCurrent()) return {
            success: false, error: file?.evidence.state === 'unavailable' ? file.evidence.reason : t('scmComparison.unsupportedReason') };
        const host = props.host ?? (props.sessionId ? { sessionId: props.sessionId }
            : props.workspaceScope ? { machineId: props.workspaceScope.machineId } : null);
        if (!host) return { success: false, error: t('scmComparison.unsupportedReason') };
        const response = await readCapturedScmFileForSession({ ...host, scope: binding.scope,
            serverId: binding.scope.serverId, shouldContinue: binding.isCurrent,
            input: { cwd: props.comparison.repository.rootPath, comparisonId: props.comparison.id,
                source: props.comparison.source, path } });
        if (response.success && response.capturedFile && binding.isCurrent()) {
            const capturedFile = response.capturedFile;
            setHydrated(previous => ({ key: evidenceKey,
                files: new Map(previous?.key === evidenceKey ? previous.files : []).set(path, capturedFile) }));
        }
        return response.success && typeof response.diff === 'string' ? { success: true, diff: response.diff }
            : { success: false, error: response.error ?? t('scmComparison.unsupportedReason') };
    }, [props.comparison, props.host, props.sessionId, props.workspaceScope, binding, evidenceKey]);
    const renderReview = (hunkReview?: ReviewProps['hunkReview']) => <ChangedFilesReview activeReviewFile={props.activeReviewFile} theme={theme} sessionId={props.sessionId}
            reviewScopeKey={JSON.stringify([props.reviewScopeKey ?? props.sessionId, evidenceKey])}
            snapshot={projected.snapshot} changedFilesViewMode="repository"
            allRepositoryChangedFiles={projected.files} sessionAttributedFiles={NO_ATTRIBUTED_FILES} repositoryOnlyFiles={NO_FILES}
            maxFiles={props.maxFiles} maxChangedLines={props.maxChangedLines} onFilePress={doNotOpenWorkingFile}
            evidenceOnly workspaceScope={props.workspaceScope} hunkReview={hunkReview}
            comparisonChrome={chrome} providerDiffByPath={projected.diffByPath} fetchUnifiedDiffForPath={fetchCapturedDiff}
            comparisonFiles={comparison.inventory.files}
            initialCollapsedPaths={initiallyCollapsed} onCollapsedPathsChange={props.onCollapsedPathsChange}
            initialScrollTop={props.initialScrollTop} onScrollTopChange={props.onScrollTopChange} rowDensity="compact" />;
    return <View testID="captured-comparison-files" style={{ flex: 1, minHeight: 0 }}>
        {props.error ? <SurfaceFreshnessLine testID="captured-comparison-refresh-error" tone="warning" reason={props.error}
            action={props.onRefresh ? { label: t('common.retry'), onPress: props.onRefresh } : undefined} /> : null}
        {props.comparison.inventory.state !== 'complete' ? <AttentionBanner presentation="strip" testID="captured-inventory-incomplete" tone="warning"
            title={t('walkthrough.evidence.unavailable', { reason: props.comparison.inventory.reasons.join(' · ') })} /> : null}
        {props.comparison.freshness === 'stale' || props.comparison.freshness === 'unknown' ? <SurfaceFreshnessLine testID="captured-comparison-freshness" tone="warning"
            reason={t(props.comparison.freshness === 'stale' ? 'scmComparison.capturedStale' : 'scmComparison.capturedFreshnessUnknown')} /> : null}
        {resolvingEvidence ? <SurfaceStateCard kind="loading" title={t('common.loading')} />
            : props.workspaceScope ? <CapturedReviewControls scope={props.workspaceScope} comparison={comparison}
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
    discard: boolean; refresh: () => void; children: (review: NonNullable<ReviewProps['hunkReview']>) => React.ReactNode;
}>) {
    const review = useReviewListHunkReview(props);
    return props.children(review);
}
