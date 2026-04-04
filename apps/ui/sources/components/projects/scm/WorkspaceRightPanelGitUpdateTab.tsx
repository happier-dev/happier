import * as React from 'react';
import { ScrollView, View } from 'react-native';

import { SourceControlBranchSummary } from '@/components/workspaces/scm/SourceControlBranchSummary';
import { SourceControlRemoteActionsRail, type SourceControlRemoteAction } from '@/components/workspaces/scm/SourceControlRemoteActionsRail';
import { useScrollEdgeFades } from '@/components/ui/scroll/useScrollEdgeFades';
import { ScrollEdgeFades } from '@/components/ui/scroll/ScrollEdgeFades';
import { ScrollEdgeIndicators } from '@/components/ui/scroll/ScrollEdgeIndicators';
import { evaluateScmOperationPreflight } from '@/scm/core/operationPolicy';
import { SCM_COMMIT_STRATEGIES, type ScmCommitStrategy } from '@/scm/settings/commitStrategy';
import type { ScmStatusFiles } from '@/scm/scmStatusFiles';
import { useFeatureEnabled } from '@/hooks/server/useFeatureEnabled';
import { useSetting } from '@/sync/domains/state/storage';
import type { ScmWorkingSnapshot } from '@/sync/domains/state/storageTypes';
import type { WorkspaceScopeBase } from '@/sync/domains/workspaces/workspaceScope';
import { t } from '@/text';
import { tracking } from '@/track';
import { WorkspaceSourceControlBranchMenu } from './WorkspaceSourceControlBranchMenu';
import { executeWorkspaceScmRemoteOperation } from './executeWorkspaceScmRemoteOperation';

function buildScmStatusFilesSummary(snapshot: ScmWorkingSnapshot | null): ScmStatusFiles | null {
    if (!snapshot?.repo.isRepo) return null;
    return {
        includedFiles: [],
        pendingFiles: [],
        changeSetModel: snapshot.capabilities?.changeSetModel ?? 'index',
        branch: snapshot.branch.head,
        upstream: snapshot.branch.upstream,
        ahead: snapshot.branch.ahead,
        behind: snapshot.branch.behind,
        detached: snapshot.branch.detached,
        totalIncluded: snapshot.totals.includedFiles,
        totalPending: snapshot.totals.pendingFiles,
    };
}

export type WorkspaceRightPanelGitUpdateTabProps = Readonly<{
    theme: any;
    scope: WorkspaceScopeBase;
    machineId: string;
    rootPath: string;
    snapshot: ScmWorkingSnapshot | null;
    disabled?: boolean;
    onRefreshSnapshot: () => Promise<void>;
    onOpenWorkspacePath?: (path: string) => void;
    onRequestCreateWorktreeFromAnotherBranch?: () => void;
}>;

export const WorkspaceRightPanelGitUpdateTab = React.memo((props: WorkspaceRightPanelGitUpdateTabProps) => {
    const scrollFades = useScrollEdgeFades({
        enabledEdges: { top: true, bottom: true },
        overflowThreshold: 1,
        edgeThreshold: 1,
    });

    const scmWriteEnabled = useFeatureEnabled('scm.writeOperations') === true;
    const scmCommitStrategySetting = useSetting('scmCommitStrategy');
    const scmRemoteConfirmPolicy = useSetting('scmRemoteConfirmPolicy');
    const scmPushRejectPolicy = useSetting('scmPushRejectPolicy');

    const scmCommitStrategy: ScmCommitStrategy = React.useMemo(() => {
        if (typeof scmCommitStrategySetting !== 'string') return 'atomic';
        return SCM_COMMIT_STRATEGIES.includes(scmCommitStrategySetting as ScmCommitStrategy)
            ? (scmCommitStrategySetting as ScmCommitStrategy)
            : 'atomic';
    }, [scmCommitStrategySetting]);

    const normalizedRemoteConfirmPolicy = React.useMemo(() => {
        return scmRemoteConfirmPolicy === 'always' || scmRemoteConfirmPolicy === 'push_only' || scmRemoteConfirmPolicy === 'never'
            ? scmRemoteConfirmPolicy
            : 'never';
    }, [scmRemoteConfirmPolicy]);

    const normalizedPushRejectPolicy = React.useMemo(() => {
        return scmPushRejectPolicy === 'auto_fetch' || scmPushRejectPolicy === 'prompt_fetch' || scmPushRejectPolicy === 'manual'
            ? scmPushRejectPolicy
            : 'manual';
    }, [scmPushRejectPolicy]);

    const snapshot = props.snapshot;
    const statusSummary = React.useMemo(() => buildScmStatusFilesSummary(snapshot), [snapshot]);
    const pullPreflight = React.useMemo(() => {
        return evaluateScmOperationPreflight({
            intent: 'pull',
            scmWriteEnabled,
            sessionPath: props.rootPath,
            snapshot,
            commitStrategy: scmCommitStrategy,
        });
    }, [props.rootPath, scmCommitStrategy, scmWriteEnabled, snapshot]);
    const pushPreflight = React.useMemo(() => {
        return evaluateScmOperationPreflight({
            intent: 'push',
            scmWriteEnabled,
            sessionPath: props.rootPath,
            snapshot,
            commitStrategy: scmCommitStrategy,
        });
    }, [props.rootPath, scmCommitStrategy, scmWriteEnabled, snapshot]);

    const [scmOperationBusy, setScmOperationBusy] = React.useState(false);
    const [scmOperationStatus, setScmOperationStatus] = React.useState<string | null>(null);
    const disabled = props.disabled === true || scmOperationBusy;

    const actions = React.useMemo((): SourceControlRemoteAction[] => {
        if (scmWriteEnabled !== true) return [];
        if (!snapshot?.repo.isRepo) return [];
        const capabilities = snapshot.capabilities;
        if (!capabilities) return [];

        const out: SourceControlRemoteAction[] = [];

        if (capabilities.writeRemoteFetch === true) {
            out.push({
                key: 'fetch',
                iconName: 'sync',
                label: t('files.sourceControlOperations.actions.fetch'),
                disabled,
                onPress: () => {
                    void executeWorkspaceScmRemoteOperation({
                        kind: 'fetch',
                        scope: props.scope,
                        scmSnapshot: snapshot,
                        scmWriteEnabled,
                        scmCommitStrategy,
                        scmRemoteConfirmPolicy: normalizedRemoteConfirmPolicy,
                        scmPushRejectPolicy: normalizedPushRejectPolicy,
                        refreshScmData: props.onRefreshSnapshot,
                        setScmOperationBusy,
                        setScmOperationStatus,
                        tracking,
                    });
                },
            });
        }

        if (capabilities.writeRemotePull === true) {
            out.push({
                key: 'pull',
                iconName: 'arrow-down',
                label: t('files.sourceControlOperations.actions.pull'),
                disabled: disabled || !pullPreflight.allowed,
                onPress: () => {
                    void executeWorkspaceScmRemoteOperation({
                        kind: 'pull',
                        scope: props.scope,
                        scmSnapshot: snapshot,
                        scmWriteEnabled,
                        scmCommitStrategy,
                        scmRemoteConfirmPolicy: normalizedRemoteConfirmPolicy,
                        scmPushRejectPolicy: normalizedPushRejectPolicy,
                        refreshScmData: props.onRefreshSnapshot,
                        setScmOperationBusy,
                        setScmOperationStatus,
                        tracking,
                    });
                },
            });
        }

        if (capabilities.writeRemotePush === true) {
            out.push({
                key: 'push',
                iconName: 'arrow-up',
                label: t('files.sourceControlOperations.actions.push'),
                disabled: disabled || !pushPreflight.allowed,
                onPress: () => {
                    void executeWorkspaceScmRemoteOperation({
                        kind: 'push',
                        scope: props.scope,
                        scmSnapshot: snapshot,
                        scmWriteEnabled,
                        scmCommitStrategy,
                        scmRemoteConfirmPolicy: normalizedRemoteConfirmPolicy,
                        scmPushRejectPolicy: normalizedPushRejectPolicy,
                        refreshScmData: props.onRefreshSnapshot,
                        setScmOperationBusy,
                        setScmOperationStatus,
                        tracking,
                    });
                },
            });
        }

        return out;
    }, [
        disabled,
        normalizedPushRejectPolicy,
        normalizedRemoteConfirmPolicy,
        props.onRefreshSnapshot,
        props.scope,
        pullPreflight.allowed,
        pushPreflight.allowed,
        scmCommitStrategy,
        scmWriteEnabled,
        snapshot,
    ]);

    const hint = React.useMemo(() => {
        if (scmOperationStatus && scmOperationStatus.trim().length > 0) return scmOperationStatus;
        if (pushPreflight.allowed === false && pushPreflight.message) return pushPreflight.message;
        if (pullPreflight.allowed === false && pullPreflight.message) return pullPreflight.message;
        return null;
    }, [pullPreflight, pushPreflight, scmOperationStatus]);

    const branchTrigger = React.useMemo(() => (
        <WorkspaceSourceControlBranchMenu
            machineId={props.machineId}
            rootPath={props.rootPath}
            currentBranch={statusSummary?.branch ?? null}
            snapshot={snapshot}
            writeEnabled={scmWriteEnabled}
            disabled={disabled}
            onRefreshSnapshot={props.onRefreshSnapshot}
            onOpenWorkspacePath={props.onOpenWorkspacePath}
            onRequestCreateWorktreeFromAnotherBranch={props.onRequestCreateWorktreeFromAnotherBranch}
            testID="scm-branch-menu-trigger"
        />
    ), [
        disabled,
        props.machineId,
        props.onOpenWorkspacePath,
        props.onRefreshSnapshot,
        props.onRequestCreateWorktreeFromAnotherBranch,
        props.rootPath,
        scmWriteEnabled,
        snapshot,
        statusSummary?.branch,
    ]);

    return (
        <View style={{ flex: 1, position: 'relative' }}>
            <ScrollView
                style={{ flex: 1 }}
                contentContainerStyle={{ paddingBottom: 12 }}
                onLayout={scrollFades.onViewportLayout}
                onContentSizeChange={scrollFades.onContentSizeChange}
                onScroll={scrollFades.onScroll}
                scrollEventThrottle={16}
            >
                {statusSummary ? (
                    <SourceControlBranchSummary
                        theme={props.theme}
                        scmStatusFiles={statusSummary}
                        variant="rail"
                        branchTrigger={branchTrigger}
                    />
                ) : null}
                <SourceControlRemoteActionsRail theme={props.theme} actions={actions} hint={hint} />
            </ScrollView>
            <ScrollEdgeFades
                color={props.theme.colors.surface}
                size={18}
                edges={scrollFades.visibility}
            />
            <ScrollEdgeIndicators
                edges={scrollFades.visibility}
                color={props.theme.colors.textSecondary}
                size={14}
                opacity={0.35}
            />
        </View>
    );
});
