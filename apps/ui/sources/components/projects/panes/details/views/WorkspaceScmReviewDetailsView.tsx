import * as React from 'react';
import { View } from 'react-native';
import { useUnistyles } from 'react-native-unistyles';

import { Text } from '@/components/ui/text/Text';
import { ReviewCommentsSessionSurface } from '@/components/reviews/ReviewCommentsSessionSurface';
import { Typography } from '@/constants/Typography';
import { t } from '@/text';
import { buildWorkspaceChangedFilesData } from '@/hooks/workspaces/scm/buildWorkspaceChangedFilesData';
import { useWorkspaceScmSnapshotController } from '@/hooks/workspaces/scm/useWorkspaceScmSnapshotController';
import { NotSourceControlRepositoryState } from '@/components/workspaces/scm/states/NotSourceControlRepositoryState';
import { SourceControlUnavailableState } from '@/components/workspaces/scm/states/SourceControlUnavailableState';
import { useSetting } from '@/sync/domains/state/storage';
import { useWorkspaceReviewCommentsDrafts } from '@/sync/domains/state/storage';
import { ChangedFilesReview } from '@/components/workspaces/scm/review/ChangedFilesReview';
import { fetchWorkspaceUnifiedDiffForPath } from '@/scm/diff/fetchWorkspaceUnifiedDiffForPath';
import type { ScmReviewUnifiedDiffFetcher } from '@/components/workspaces/scm/review/scmReviewDiffFetcher';
import { useWorkspaceReviewCommentDraftHandlers } from '@/components/workspaces/files/details/workspaceFileDetails/useWorkspaceReviewCommentDraftHandlers';
import { useFeatureEnabled } from '@/hooks/server/useFeatureEnabled';
import { ActivitySpinner } from '@/components/ui/feedback/ActivitySpinner';
import { createReviewCommentsHttpActionExecutor } from '@/sync/domains/reviews/comments/api';
import { createPluginPermissionGrantActions } from '@/sync/domains/plugins/permissions/actions';
import { createPluginPermissionGrantHttpActionExecutor } from '@/sync/domains/plugins/permissions/api';
import { usePluginPermissionGrants } from '@/sync/domains/plugins/permissions/usePluginPermissionGrants';
import {
    selectPluginPermissionPendingRequests,
} from '@/sync/domains/plugins/permissions/store';
import {
    REVIEW_COMMENTS_DIRECT_WRITE_PERMISSION_CAPABILITY,
    pluginPermissionGrantScopeKey,
    type PluginPermissionGrantListInput,
    type PluginPermissionGrantTargetScope,
} from '@/sync/domains/plugins/permissions/types';

export type WorkspaceScmReviewDetailsViewProps = Readonly<{
    scopeId: string;
    workspaceRefId: string;
    workspaceCacheKey: string;
    machineId: string;
    rootPath: string;
    serverId: string;
    onOpenFile?: (path: string) => void;
    onOpenFilePinned?: (path: string) => void;
}>;

export const WorkspaceScmReviewDetailsView = React.memo((props: WorkspaceScmReviewDetailsViewProps) => {
    const { theme } = useUnistyles();
    const scmReviewMaxFilesSetting = useSetting('scmReviewMaxFiles');
    const scmReviewMaxChangedLinesSetting = useSetting('scmReviewMaxChangedLines');
    const scope = React.useMemo(() => ({
        serverId: props.serverId,
        machineId: props.machineId,
        rootPath: props.rootPath,
    }), [props.machineId, props.rootPath, props.serverId]);
    const reviewCommentsEnabled = useFeatureEnabled('files.reviewComments') === true;
    const reviewCommentDrafts = useWorkspaceReviewCommentsDrafts(scope);
    const reviewDraftHandlers = useWorkspaceReviewCommentDraftHandlers(scope);
    const reviewCommentsExecutor = React.useMemo(() => createReviewCommentsHttpActionExecutor(), []);
    const pluginPermissionGrantExecutor = React.useMemo(() => createPluginPermissionGrantHttpActionExecutor(), []);
    const pluginPermissionGrantActions = React.useMemo(
        () => createPluginPermissionGrantActions({ execute: pluginPermissionGrantExecutor }),
        [pluginPermissionGrantExecutor],
    );
    const { snapshot, loading, error, refresh } = useWorkspaceScmSnapshotController(scope);
    const directWriteGrantScope = React.useMemo<PluginPermissionGrantTargetScope>(() => ({
        kind: 'project',
        projectId: props.workspaceRefId,
    }), [props.workspaceRefId]);
    const pluginPermissionGrantListInput = React.useMemo<PluginPermissionGrantListInput>(() => ({
        capability: REVIEW_COMMENTS_DIRECT_WRITE_PERMISSION_CAPABILITY,
        targetScope: directWriteGrantScope,
    }), [directWriteGrantScope]);
    const pluginPermissionGrants = usePluginPermissionGrants({
        actions: pluginPermissionGrantActions,
        enabled: reviewCommentsEnabled,
        listInput: pluginPermissionGrantListInput,
    });
    const directWriteGrants = pluginPermissionGrants.state.grantIds
        .map((id) => pluginPermissionGrants.state.grantsById[id])
        .filter((grant): grant is NonNullable<typeof grant> => (
            Boolean(grant)
            && grant?.capability === REVIEW_COMMENTS_DIRECT_WRITE_PERMISSION_CAPABILITY
            && pluginPermissionGrantScopeKey(grant.targetScope) === pluginPermissionGrantScopeKey(directWriteGrantScope)
        ));
    const pendingDirectWriteGrantRequests = selectPluginPermissionPendingRequests(pluginPermissionGrants.state, {
        capability: REVIEW_COMMENTS_DIRECT_WRITE_PERMISSION_CAPABILITY,
        targetScope: directWriteGrantScope,
    });

    const maxFiles = React.useMemo(() => {
        const raw = typeof scmReviewMaxFilesSetting === 'number' && Number.isFinite(scmReviewMaxFilesSetting)
            ? scmReviewMaxFilesSetting
            : 25;
        return Math.max(1, Math.floor(raw));
    }, [scmReviewMaxFilesSetting]);
    const maxChangedLines = React.useMemo(() => {
        const raw = typeof scmReviewMaxChangedLinesSetting === 'number' && Number.isFinite(scmReviewMaxChangedLinesSetting)
            ? scmReviewMaxChangedLinesSetting
            : 2000;
        return Math.max(1, Math.floor(raw));
    }, [scmReviewMaxChangedLinesSetting]);
    const changedFiles = React.useMemo(() => buildWorkspaceChangedFilesData({ scmSnapshot: snapshot }), [snapshot]);
    const fetchUnifiedDiffForPath = React.useCallback<ScmReviewUnifiedDiffFetcher>(async (input) => {
        return await fetchWorkspaceUnifiedDiffForPath({
            scope,
            ...input,
        });
    }, [scope]);

    if (loading && !snapshot) {
        return (
            <View style={{ flex: 1, justifyContent: 'center', alignItems: 'center', padding: 16, gap: 10 }}>
                <ActivitySpinner size="small" color={theme.colors.text.secondary} />
                <Text style={{ color: theme.colors.text.secondary, ...Typography.default() }}>
                    {t('common.loading')}
                </Text>
            </View>
        );
    }

    if (error) {
        return (
            <SourceControlUnavailableState
                details={error.message}
                errorCode={error.errorCode}
                onRetry={() => {
                    void refresh();
                }}
            />
        );
    }

    if (snapshot?.repo.isRepo === false) {
        return <NotSourceControlRepositoryState />;
    }

    return (
        <View style={{ flex: 1, minHeight: 0, minWidth: 0, backgroundColor: theme.colors.surface.base }}>
            {reviewCommentsEnabled ? (
                <ReviewCommentsSessionSurface
                    workspaceId={props.workspaceRefId}
                    execute={reviewCommentsExecutor}
                    directWriteGrants={directWriteGrants}
                    pendingDirectWriteGrantRequests={pendingDirectWriteGrantRequests}
                    onGrantDirectWrite={pluginPermissionGrants.grant}
                    onCancelDirectWriteGrant={pluginPermissionGrants.dismissRequest}
                    onRevokeDirectWrite={pluginPermissionGrants.revoke}
                    permissionGrantStatus={pluginPermissionGrants.state.status}
                    permissionGrantError={pluginPermissionGrants.state.error}
                    onRefreshPermissionGrants={() => { void pluginPermissionGrants.refresh(); }}
                    defaultPanelOpen={false}
                    testID="workspace-review-comments"
                />
            ) : null}
            <ChangedFilesReview
                theme={theme}
                sessionId={props.scopeId}
                snapshot={snapshot ?? null}
                changedFilesViewMode="repository"
                attributionReliability="high"
                allRepositoryChangedFiles={changedFiles.allRepositoryChangedFiles}
                turnAttributedFiles={[]}
                turnRepositoryOnlyFiles={[]}
                sessionAttributedFiles={[]}
                repositoryOnlyFiles={changedFiles.allRepositoryChangedFiles}
                suppressedInferredCount={0}
                maxFiles={maxFiles}
                maxChangedLines={maxChangedLines}
                onFilePress={(file) => props.onOpenFile?.(file.fullPath)}
                onFilePressPinned={(file) => props.onOpenFilePinned?.(file.fullPath)}
                rowDensity="compact"
                reviewCommentsEnabled={reviewCommentsEnabled}
                reviewCommentDrafts={reviewCommentDrafts}
                onUpsertReviewCommentDraft={reviewDraftHandlers.onUpsertReviewCommentDraft}
                onDeleteReviewCommentDraft={reviewDraftHandlers.onDeleteReviewCommentDraft}
                onReviewCommentError={reviewDraftHandlers.onReviewCommentError}
                workspaceScope={scope}
                fetchUnifiedDiffForPath={fetchUnifiedDiffForPath}
            />
        </View>
    );
});
