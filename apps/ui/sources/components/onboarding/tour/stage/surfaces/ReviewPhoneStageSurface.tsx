import * as React from 'react';
import { useUnistyles } from 'react-native-unistyles';
import { createScmCapabilities } from '@happier-dev/protocol/scm/capabilities';
import type { ScmWorkingSnapshot } from '@happier-dev/protocol/scm/workingSnapshot';

import { WorkspaceScmReviewBody } from '@/components/projects/scm/WorkspaceScmReviewBody';
import { resolveFilesComparisonLabel, type FilesComparisonScopeOption } from '@/components/sessions/files/comparison/filesComparison';
import { SessionFullscreenPaneSafeAreaView } from '@/components/sessions/panes/SessionFullscreenPaneSafeAreaView';
import type { SessionScmReviewComparison, SessionScmReviewView } from '@/components/sessions/panes/details/sessionDetailsTabBuilders';
import { ChangedFilesReview } from '@/components/workspaces/scm/review/ChangedFilesReview';
import type { ScmReviewUnifiedDiffFetcher } from '@/components/workspaces/scm/review/scmReviewDiffFetcher';
import { DEMO_NOW_MS, DEMO_PROJECT_PATH, DEMO_REVIEW_SESSION_ID } from '@/demoMode/world/constants';
import { useScmReviewLimits } from '@/scm/review/useScmReviewLimits';
import { scmFileStatusFromChange } from '@/scm/scmStatusFiles';
import { useSessionReviewCommentsDrafts } from '@/sync/domains/state/storage';

import type { StageDevice } from '../DeviceFrame';

const REVIEW_PATH = 'apps/ui/sources/components/sessions/mobile/SessionMobileHeader.tsx';
// Capture-only source evidence, admitted at the real review renderer's diff boundary.
// The line numbers match the existing demo world's review comment anchors.
const REVIEW_DIFF = [
    `diff --git a/${REVIEW_PATH} b/${REVIEW_PATH}`,
    `--- a/${REVIEW_PATH}`,
    `+++ b/${REVIEW_PATH}`,
    '@@ -53,7 +53,11 @@ export function SessionMobileHeader({ title, unreadCount }) {',
    '   return (',
    '     <View style={styles.header}>',
    '-      <Text>{title}</Text>',
    '+      <View style={styles.headerRow}>',
    '+        <Text numberOfLines={1}',
    '+          ellipsizeMode="tail">{title}</Text>',
    '+        {unreadCount > 0 ? <UnreadBadge count={unreadCount} /> : null}',
    '+      </View>',
    '       <SessionActions />',
    '     </View>',
    '   );',
    ' }',
    '',
].join('\n');
const REVIEW_FILES = [scmFileStatusFromChange({ path: REVIEW_PATH, changeKind: 'modified', added: 5, removed: 1 })];
const NO_FILES: [] = [];
const REVIEW_DIFFS = new Map([[REVIEW_PATH, REVIEW_DIFF]]);
const REVIEW_COMPARISON = { kind: 'branch', base: 'main', head: 'fix/mobile-header' } satisfies SessionScmReviewComparison;
const REVIEW_VIEWS: readonly SessionScmReviewView[] = ['files'];
const REVIEW_SNAPSHOT = {
    projectKey: `demo-review:${DEMO_PROJECT_PATH}`,
    fetchedAt: DEMO_NOW_MS,
    repo: { isRepo: true, rootPath: DEMO_PROJECT_PATH, backendId: 'git', mode: '.git', worktrees: [], remotes: [] },
    branch: { head: 'fix/mobile-header', upstream: null, ahead: 0, behind: 0, detached: false },
    hasConflicts: false,
    entries: [{ path: REVIEW_PATH, previousPath: null, kind: 'modified', includeStatus: ' ', pendingStatus: 'M',
        hasIncludedDelta: false, hasPendingDelta: true,
        stats: { includedAdded: 0, includedRemoved: 0, pendingAdded: 5, pendingRemoved: 1, isBinary: false } }],
    totals: { includedFiles: 0, pendingFiles: 1, untrackedFiles: 0,
        includedAdded: 0, includedRemoved: 0, pendingAdded: 5, pendingRemoved: 1 },
    capabilities: createScmCapabilities({ readStatus: true }),
} satisfies ScmWorkingSnapshot;

const fetchReviewDiff: ScmReviewUnifiedDiffFetcher = async () => ({ success: true, diff: REVIEW_DIFF });
function keepCaptureSelection(): void {}
function noWalkthrough(): null { return null; }

/** The phone Details route's real comparison chrome and inline diff, over local capture evidence. */
export function ReviewPhoneStageSurface(_props: Readonly<{ device: StageDevice }>): React.ReactElement {
    const { theme } = useUnistyles();
    const limits = useScmReviewLimits();
    const drafts = useSessionReviewCommentsDrafts(DEMO_REVIEW_SESSION_ID);
    const scopeLabel = resolveFilesComparisonLabel(REVIEW_COMPARISON, null);
    const scopeOptions: readonly FilesComparisonScopeOption[] = [{ comparison: REVIEW_COMPARISON,
        sourceKind: 'branch', group: 'explainOnly', label: scopeLabel, subtitle: '', fileCount: REVIEW_FILES.length }];

    return <SessionFullscreenPaneSafeAreaView testID="demo-stage-review-detail">
        <WorkspaceScmReviewBody comparison={REVIEW_COMPARISON} view="files" views={REVIEW_VIEWS}
            scopeLabel={scopeLabel} scopeOptions={scopeOptions} onSelectComparison={keepCaptureSelection}
            onSelectView={keepCaptureSelection} rootPath={DEMO_PROJECT_PATH} fileCount={REVIEW_FILES.length}
            explain={false} onExplainChange={keepCaptureSelection} renderWalkthrough={noWalkthrough}
            renderFiles={chrome => <ChangedFilesReview theme={theme} sessionId={DEMO_REVIEW_SESSION_ID}
                reviewScopeKey="demo-phone-review" snapshot={REVIEW_SNAPSHOT} evidenceOnly
                comparisonChrome={chrome} changedFilesViewMode="repository" allRepositoryChangedFiles={REVIEW_FILES}
                sessionAttributedFiles={NO_FILES} repositoryOnlyFiles={NO_FILES} {...limits}
                onFilePress={keepCaptureSelection} rowDensity="compact" diffAutoRefreshIntervalMs={0}
                providerDiffByPath={REVIEW_DIFFS} fetchUnifiedDiffForPath={fetchReviewDiff}
                reviewCommentsEnabled reviewCommentDrafts={drafts} />}
        />
    </SessionFullscreenPaneSafeAreaView>;
}
