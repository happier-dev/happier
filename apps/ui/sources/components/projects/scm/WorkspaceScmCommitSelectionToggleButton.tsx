import * as React from 'react';
import { Pressable } from 'react-native';
import { Octicons } from '@expo/vector-icons';
import { useUnistyles } from 'react-native-unistyles';

import type { WorkspaceScopeBase } from '@/sync/domains/workspaces/workspaceScope';
import type { ScmWorkingSnapshot } from '@/sync/domains/state/storageTypes';
import type { ScmFileStatus } from '@/scm/scmStatusFiles';
import type { ScmCommitStrategy } from '@/scm/settings/commitStrategy';
import { isAtomicCommitStrategy } from '@/scm/settings/commitStrategy';
import { evaluateScmOperationPreflight } from '@/scm/core/operationPolicy';
import { getScmUserFacingError } from '@/scm/operations/userFacingErrors';
import { withWorkspaceScmOperationLock } from '@/scm/operations/withOperationLock';
import { reportWorkspaceScmOperation, trackBlockedScmOperation } from '@/scm/operations/reporting';
import { tryShowDaemonUnavailableAlertForScmOperationFailure } from '@/scm/operations/scmDaemonUnavailableAlert';
import { storage } from '@/sync/domains/state/storage';
import { machineScmChangeExclude, machineScmChangeInclude } from '@/sync/ops/scm/machineScm';
import { Modal } from '@/modal';
import { t } from '@/text';
import { tracking } from '@/track';
import { toTestIdSafeValue } from '@/utils/ui/toTestIdSafeValue';
import { ActivitySpinner } from '@/components/ui/feedback/ActivitySpinner';

type OcticonName = keyof typeof Octicons.glyphMap;

export async function applyWorkspaceFileStageAction(input: Readonly<{
    scope: WorkspaceScopeBase;
    filePath: string;
    snapshot: ScmWorkingSnapshot | null;
    scmWriteEnabled: boolean;
    commitStrategy: ScmCommitStrategy;
    stage: boolean;
    surface: 'files';
    onAfterToggle?: () => Promise<void> | void;
}>): Promise<void> {
    const {
        scope,
        filePath,
        snapshot,
        scmWriteEnabled,
        commitStrategy,
        stage,
        surface,
        onAfterToggle,
    } = input;

    if (isAtomicCommitStrategy(commitStrategy)) {
        if (!stage) {
            storage.getState().unmarkWorkspaceScmCommitSelectionPaths(scope, [filePath]);
            storage.getState().removeWorkspaceScmCommitSelectionPatch(scope, filePath);
            reportWorkspaceScmOperation({
                state: storage.getState(),
                scope,
                operation: 'unstage',
                status: 'success',
                path: filePath,
                detail: `${filePath} removed from commit selection`,
                surface,
                tracking,
            });
            return;
        }

        storage.getState().markWorkspaceScmCommitSelectionPaths(scope, [filePath]);
        storage.getState().removeWorkspaceScmCommitSelectionPatch(scope, filePath);
        reportWorkspaceScmOperation({
            state: storage.getState(),
            scope,
            operation: 'stage',
            status: 'success',
            path: filePath,
            detail: `${filePath} selected for commit`,
            surface,
            tracking,
        });
        return;
    }

    const preflight = evaluateScmOperationPreflight({
        intent: stage ? 'stage' : 'unstage',
        scmWriteEnabled,
        sessionPath: scope.rootPath,
        snapshot,
        commitStrategy,
    });
    if (!preflight.allowed) {
        trackBlockedScmOperation({
            operation: stage ? 'stage' : 'unstage',
            reason: 'preflight',
            message: preflight.message,
            surface,
            tracking,
        });
        Modal.alert(t('common.error'), preflight.message);
        return;
    }

    const lockResult = await withWorkspaceScmOperationLock({
        state: storage.getState(),
        scope,
        operation: stage ? 'stage' : 'unstage',
        run: async () => {
            const scmCallOptions = { serverId: scope.serverId };
            const response = stage
                ? await machineScmChangeInclude(scope.machineId, { cwd: scope.rootPath, paths: [filePath] }, scmCallOptions)
                : await machineScmChangeExclude(scope.machineId, { cwd: scope.rootPath, paths: [filePath] }, scmCallOptions);

            if (!response.success) {
                const errorMessage = getScmUserFacingError({
                    errorCode: response.errorCode,
                    error: response.error,
                    fallback: response.error || t('errors.tryAgain'),
                });
                reportWorkspaceScmOperation({
                    state: storage.getState(),
                    scope,
                    operation: stage ? 'stage' : 'unstage',
                    status: 'failed',
                    path: filePath,
                    detail: errorMessage,
                    rawError: response.error,
                    errorCode: response.errorCode,
                    surface,
                    tracking,
                });
                const shownDaemonUnavailable = tryShowDaemonUnavailableAlertForScmOperationFailure({
                    errorCode: response.errorCode,
                    onRetry: () => {
                        void applyWorkspaceFileStageAction(input);
                    },
                    shouldContinue: null,
                });
                if (!shownDaemonUnavailable) {
                    Modal.alert(t('common.error'), errorMessage);
                }
                return;
            }

            reportWorkspaceScmOperation({
                state: storage.getState(),
                scope,
                operation: stage ? 'stage' : 'unstage',
                status: 'success',
                path: filePath,
                detail: filePath,
                surface,
                tracking,
            });

            await onAfterToggle?.();
        },
    });

    if (!lockResult.started) {
        trackBlockedScmOperation({
            operation: stage ? 'stage' : 'unstage',
            reason: 'lock',
            message: lockResult.message,
            surface,
            tracking,
        });
        Modal.alert(t('common.error'), lockResult.message);
    }
}

export type WorkspaceScmCommitSelectionToggleButtonProps = Readonly<{
    scope: WorkspaceScopeBase;
    snapshot: ScmWorkingSnapshot | null;
    scmWriteEnabled: boolean;
    commitStrategy: ScmCommitStrategy;
    file: ScmFileStatus;
    selectedForCommit: boolean;
    onAfterToggle?: () => Promise<void> | void;
}>;

export const WorkspaceScmCommitSelectionToggleButton = React.memo((props: WorkspaceScmCommitSelectionToggleButtonProps) => {
    const { theme } = useUnistyles();
    const [busy, setBusy] = React.useState(false);

    const iconName: OcticonName = props.selectedForCommit ? 'check' : 'plus';
    const iconColor = props.selectedForCommit ? theme.colors.state.success.foreground : theme.colors.text.secondary;
    const supported = React.useMemo(() => {
        if (isAtomicCommitStrategy(props.commitStrategy)) return true;
        const capabilities = props.snapshot?.capabilities;
        if (props.selectedForCommit) return capabilities?.writeExclude === true;
        return capabilities?.writeInclude === true;
    }, [props.commitStrategy, props.selectedForCommit, props.snapshot?.capabilities]);

    const disabled = busy || !props.scmWriteEnabled || !supported;
    const testIdSafePath = React.useMemo(() => toTestIdSafeValue(props.file.fullPath), [props.file.fullPath]);

    return (
        <Pressable
            testID={`scm-commit-selection-toggle-${testIdSafePath}`}
            accessibilityRole="button"
            accessibilityLabel={
                props.selectedForCommit ? t('files.commitSelection.removeFromCommit') : t('files.commitSelection.addToCommit')
            }
            disabled={disabled}
            onPress={(event) => {
                const maybeEvent = event as unknown as {
                    stopPropagation?: () => void;
                    nativeEvent?: { stopPropagation?: () => void };
                };
                try {
                    maybeEvent.stopPropagation?.();
                } catch {}
                try {
                    maybeEvent.nativeEvent?.stopPropagation?.();
                } catch {}
                void (async () => {
                    setBusy(true);
                    try {
                        await applyWorkspaceFileStageAction({
                            scope: props.scope,
                            filePath: props.file.fullPath,
                            snapshot: props.snapshot,
                            scmWriteEnabled: props.scmWriteEnabled,
                            commitStrategy: props.commitStrategy,
                            stage: !props.selectedForCommit,
                            surface: 'files',
                            onAfterToggle: props.onAfterToggle,
                        });
                    } finally {
                        setBusy(false);
                    }
                })();
            }}
            style={{
                width: 28,
                height: 28,
                borderRadius: 10,
                borderWidth: 1,
                borderColor: theme.colors.border.default,
                backgroundColor: theme.colors.surface.base,
                alignItems: 'center',
                justifyContent: 'center',
                opacity: disabled ? 0.55 : 1,
            }}
        >
            {busy ? (
                <ActivitySpinner size="small" color={theme.colors.text.secondary} />
            ) : (
                <Octicons name={iconName} size={14} color={iconColor} />
            )}
        </Pressable>
    );
});
