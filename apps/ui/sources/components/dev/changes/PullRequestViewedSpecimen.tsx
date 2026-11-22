import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { ChangedFilesReview, type ChangedFilesReviewCoverage, type ChangedFilesReviewHeaderFacts } from '@/components/workspaces/scm/review/ChangedFilesReview';
import { ScmComparisonHeader } from '@/components/sessions/files/comparison/ScmComparisonHeader';
import { ScmComparisonHeaderToggle } from '@/components/sessions/files/comparison/ScmComparisonBar';
import { buildCapturedComparisonFiles } from '@/components/sessions/files/comparison/capturedComparisonFiles';
import { createScmFileViewedState, type ScmFileViewedSource } from '@/sync/domains/scm/fileViewed';
import { t } from '@/text';
import { PR_SPECIMEN_COMPARISON } from './pullRequestSpecimenFixture';
import type { WalkthroughSpecimenFrame } from './WalkthroughSpecimen';

/**
 * Dev-only: the captured PR Files stream with GitHub's Viewed marks from a static source (viewed,
 * unviewed, dismissed, one file the source has not answered for, one refused write), so the file headers
 * and the header count can be judged without a GitHub token. The real source is `useScmFileViewed`.
 */
type ViewedMode = 'ready' | 'loading' | 'error' | 'none' | 'all';

function specimenViewedSource(mode: ViewedMode): ScmFileViewedSource {
    const state = createScmFileViewedState();
    const paths = PR_SPECIMEN_COMPARISON.inventory.files.map((file) => file.path);
    if (mode === 'loading') state.beginRead();
    else if (mode === 'error') state.fail('insufficient_scope');
    else if (mode === 'none' || mode === 'all') state.applyRead({ kind: 'ready', headOid: PR_SPECIMEN_COMPARISON.endpoints.after,
        files: paths.map((path) => ({ path, state: mode === 'all' ? 'viewed' : 'unviewed' })) });
    else state.applyRead({ kind: 'ready', headOid: PR_SPECIMEN_COMPARISON.endpoints.after,
        files: paths.slice(0, -1).map((path, index) => ({ path, state: index < 3 ? 'viewed' : index === 3 ? 'dismissed' : 'unviewed' })) });
    const refused = paths[4];
    return {
        getFile: state.getFile, subscribeFile: state.subscribeFile, getSnapshot: state.getSnapshot,
        subscribeStatus: state.subscribeStatus, subscribeChanges: state.subscribeChanges, getViewedPaths: state.getViewedPaths,
        getViewedPathsRevision: state.getViewedPathsRevision,
        getChangedSinceViewedCount: state.getChangedSinceViewedCount,
        refresh: async () => {},
        setViewed: async (path, viewed) => {
            const previous = state.getFile(path);
            if (previous.state === null || previous.pending) return false;
            state.applyFile(path, { ...previous, pending: true, errorCode: null });
            await new Promise((resolve) => setTimeout(resolve, 900));
            if (path === refused) { state.applyFile(path, { ...previous, pending: false, errorCode: 'permission' }); return false; }
            state.applyFile(path, { state: viewed ? 'viewed' : 'unviewed', pending: false, errorCode: null });
            return true;
        },
    };
}

/** `hideViewed`: the Review's Changes, which add Hide viewed beside the count (ideas-1118-reviews scene 2 `files-review`). */
function PullRequestViewedFrame(props: Readonly<{ phone: boolean; mode: ViewedMode; hideViewed?: boolean }>) {
    const { theme } = useUnistyles();
    const [hidden, setHidden] = React.useState(props.hideViewed === true);
    const showViewed = React.useCallback(() => setHidden(false), []);
    const comparison = PR_SPECIMEN_COMPARISON;
    const source = React.useMemo(() => specimenViewedSource(props.mode), [props.mode]);
    const projected = React.useMemo(() => buildCapturedComparisonFiles(comparison), [comparison]);
    const hunkReview = React.useMemo(() => ({ source: { kind: 'captured' as const, comparison }, host: null, serverId: null,
        fileViewed: source }), [comparison, source]);
    // The Review page's Changes column is wider than the rail bound, so its frames draw the rail.
    const chrome = React.useMemo(() => ({ renderBarLeading: () => null,
        indexPlacement: props.phone ? 'phone' as const : props.hideViewed === undefined ? 'stream' as const : 'rail' as const,
        rootPath: comparison.repository.rootPath,
        renderHeader: (coverage: ChangedFilesReviewCoverage, facts?: ChangedFilesReviewHeaderFacts) => (
            <ScmComparisonHeader viewLabel={t('scmComparison.view.files')} scopeLabel="#2481" coverage={coverage}
                reviewed={facts?.viewed ?? null} changedSinceViewedCount={facts?.changedSinceViewedCount} stacked={props.phone} accessory={props.hideViewed === undefined ? undefined
                    : <ScmComparisonHeaderToggle testID="review-changes:hide-viewed" icon="eye-slash" label={t('hunkReview.hideViewed')}
                        value={hidden} onChange={setHidden} />} />
        ) }), [comparison, props.phone, props.hideViewed, hidden]);
    const fetchDiff = React.useCallback(async ({ path }: Readonly<{ path: string }>) => {
        const diff = projected.diffByPath.get(path);
        return typeof diff === 'string' ? { success: true as const, diff } : { success: false as const, error: 'unavailable' };
    }, [projected]);
    return <View style={styles.fill}>
        <ChangedFilesReview theme={theme} sessionId="specimen-session" reviewScopeKey={`viewed-${props.mode}`}
            snapshot={projected.snapshot} changedFilesViewMode="repository" allRepositoryChangedFiles={projected.files}
            sessionAttributedFiles={[]} repositoryOnlyFiles={[]} maxFiles={50} maxChangedLines={5000} onFilePress={() => {}}
            evidenceOnly hunkReview={hunkReview} comparisonChrome={chrome} providerDiffByPath={projected.diffByPath}
            fetchUnifiedDiffForPath={fetchDiff} comparisonFiles={comparison.inventory.files} rowDensity="compact"
            {...(props.hideViewed === undefined ? {} : { hideViewed: hidden, onShowViewed: showViewed })} />
    </View>;
}

export const PULL_REQUEST_VIEWED_SPECIMEN_FRAMES: readonly WalkthroughSpecimenFrame[] = [
    { id: 'PRViewed', title: 'F3 · PR Files with GitHub Viewed', render: (phone) => <PullRequestViewedFrame phone={phone} mode="ready" /> },
    { id: 'PRViewedLoading', title: 'F3 · Viewed reading', render: (phone) => <PullRequestViewedFrame phone={phone} mode="loading" /> },
    { id: 'PRViewedError', title: 'F3 · Viewed unavailable', render: (phone) => <PullRequestViewedFrame phone={phone} mode="error" /> },
    { id: 'ReviewViewedSome', title: 'Review Changes · some viewed, one changed since viewed', render: (phone) => <PullRequestViewedFrame phone={phone} mode="ready" hideViewed={false} /> },
    { id: 'ReviewViewedHidden', title: 'Review Changes · Hide viewed on', render: (phone) => <PullRequestViewedFrame phone={phone} mode="ready" hideViewed /> },
    { id: 'ReviewViewedNone', title: 'Review Changes · none viewed', render: (phone) => <PullRequestViewedFrame phone={phone} mode="none" hideViewed={false} /> },
    { id: 'ReviewViewedAllHidden', title: 'Review Changes · all viewed, Hide viewed on', render: (phone) => <PullRequestViewedFrame phone={phone} mode="all" hideViewed /> },
];

const styles = StyleSheet.create((theme) => ({ fill: { flex: 1, minHeight: 0, backgroundColor: theme.colors.surface.base } }));
