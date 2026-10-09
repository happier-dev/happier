import * as React from 'react';

import { useFeatureEnabled } from '@/hooks/server/useFeatureEnabled';
import { useWorkspaceScmSnapshotController } from '@/hooks/workspaces/scm/useWorkspaceScmSnapshotController';
import { evaluateScmOperationPreflight } from '@/scm/core/operationPolicy';
import { resolveCommitAdjacentPushActionState } from '@/scm/operations/commitAdjacentPushAction';
import { confirmCommitAdjacentPush } from '@/scm/operations/commitAdjacentPushConfirmation';
import { buildCommitSelectionPathHints } from '@/scm/operations/commitSelectionHints';
import { formatRemoteTargetForDisplay } from '@/scm/operations/remoteFeedback';
import { isAtomicCommitStrategy, SCM_COMMIT_STRATEGIES, type ScmCommitStrategy } from '@/scm/settings/commitStrategy';
import type { ScmPushRejectPolicy } from '@/scm/settings/preferences';
import { normalizeScmRemoteConfirmPolicy } from '@/scm/settings/remoteConfirmationPolicy';
import { useScmCommitMessageSuggestion } from '@/scm/operations/useScmCommitMessageSuggestion';
import { findWorkspaceRefByScope } from '@/sync/domains/workspaces/workspaceRefs';
import { workspaceAddressFromRefV1 } from '@happier-dev/protocol/workspaces/workspaceRefResolutionV1';
import {
    storage,
    useSetting,
    useSettingMutable,
    useWorkspaceScmCommitSelectionPatches,
    useWorkspaceScmCommitSelectionPaths,
    useWorkspaceScmInFlightOperation,
    useWorkspaceRefs,
} from '@/sync/domains/state/storage';
import type { WorkspaceScopeBase } from '@/sync/domains/workspaces/workspaceScope';
import { t } from '@/text';

import { executeWorkspaceScmCommit } from './executeWorkspaceScmCommit';
import { executeWorkspaceScmRemoteOperation } from './executeWorkspaceScmRemoteOperation';

/**
 * A checkout's manual commit and push, as one owner: the snapshot, the commit draft, the current
 * selection and the policy preflights, and the commit / commit-adjacent push effects through the
 * canonical workspace SCM executors. The Project Git pane and the Overview's Local changes widget
 * (plan 14 §2) both draw from it, so the two can never disagree about what Commit or Push would do.
 */
export function useWorkspaceScmCommitControls(scope: WorkspaceScopeBase) {
    const [commitDraftMessage, setCommitDraftMessage] = React.useState('');
    const [localScmOperationBusy, setScmOperationBusy] = React.useState(false);
    const [scmOperationStatus, setScmOperationStatus] = React.useState<string | null>(null);
    const inFlightOperation = useWorkspaceScmInFlightOperation(scope);
    const scmOperationBusy = localScmOperationBusy || Boolean(inFlightOperation);
    const { snapshot, loading, error, refresh } = useWorkspaceScmSnapshotController(scope);
    const commitSelectionPaths = useWorkspaceScmCommitSelectionPaths(scope);
    const commitSelectionPatches = useWorkspaceScmCommitSelectionPatches(scope);
    const scmCommitStrategySetting = useSetting('scmCommitStrategy');
    const [scmRemoteConfirmPolicySetting, setScmRemoteConfirmPolicy] = useSettingMutable('scmRemoteConfirmPolicy');
    const scmPushRejectPolicySetting = useSetting('scmPushRejectPolicy');
    const scmCommitStrategy: ScmCommitStrategy = React.useMemo(() => {
        if (typeof scmCommitStrategySetting !== 'string') return 'atomic';
        return SCM_COMMIT_STRATEGIES.includes(scmCommitStrategySetting as ScmCommitStrategy)
            ? (scmCommitStrategySetting as ScmCommitStrategy)
            : 'atomic';
    }, [scmCommitStrategySetting]);
    const normalizedRemoteConfirmPolicy = React.useMemo(
        () => normalizeScmRemoteConfirmPolicy(scmRemoteConfirmPolicySetting),
        [scmRemoteConfirmPolicySetting],
    );
    const normalizedPushRejectPolicy: ScmPushRejectPolicy = React.useMemo(() => {
        return scmPushRejectPolicySetting === 'auto_fetch'
            || scmPushRejectPolicySetting === 'prompt_fetch'
            || scmPushRejectPolicySetting === 'manual'
            ? scmPushRejectPolicySetting
            : 'manual';
    }, [scmPushRejectPolicySetting]);
    const scmWriteEnabled = useFeatureEnabled('scm.writeOperations');

    const commitSelectionPathHints = React.useMemo(() => {
        return buildCommitSelectionPathHints({
            commitSelectionPaths,
            commitSelectionPatches,
        });
    }, [commitSelectionPatches, commitSelectionPaths]);
    const workspaceRefs = useWorkspaceRefs();
    const workspaceRef = findWorkspaceRefByScope(workspaceRefs, scope);
    const commitMessageHost = React.useMemo(() => workspaceRef
        ? { kind: 'workspace' as const, workspace: workspaceAddressFromRefV1(workspaceRef) }
        : null, [workspaceRef]);
    const suggestionContextKey = JSON.stringify([
        scope.serverId, scope.machineId, scope.rootPath, snapshot?.branch.headOid,
        commitSelectionPaths, commitSelectionPatches,
    ]);
    const commitMessageSuggestion = useScmCommitMessageSuggestion(commitMessageHost, commitSelectionPathHints, suggestionContextKey);

    const commitPreflight = React.useMemo(() => {
        return evaluateScmOperationPreflight({
            intent: 'commit',
            scmWriteEnabled,
            sessionPath: scope.rootPath,
            snapshot,
            commitStrategy: scmCommitStrategy,
            commitSelectionPaths: commitSelectionPathHints,
        });
    }, [commitSelectionPathHints, scmCommitStrategy, scmWriteEnabled, scope.rootPath, snapshot]);
    const pushPreflight = React.useMemo(() => {
        return evaluateScmOperationPreflight({
            intent: 'push',
            scmWriteEnabled,
            sessionPath: scope.rootPath,
            snapshot,
            commitStrategy: scmCommitStrategy,
        });
    }, [scmCommitStrategy, scmWriteEnabled, scope.rootPath, snapshot]);
    const commitAllowed = commitPreflight.allowed;
    const commitBlockedMessage = commitPreflight.allowed ? null : commitPreflight.message;
    const handleClearSelection = React.useCallback(() => {
        storage.getState().clearWorkspaceScmCommitSelectionPaths(scope);
        storage.getState().clearWorkspaceScmCommitSelectionPatches(scope);
    }, [scope]);

    const handleCommitFromMessage = React.useCallback((message: string) => {
        const trimmed = String(message ?? '').trim();
        if (!trimmed) return;
        void executeWorkspaceScmCommit({
            scope,
            commitMessage: trimmed,
            scmCommitStrategy,
            commitSelectionPaths: [...commitSelectionPaths],
            commitSelectionPatches: [...commitSelectionPatches],
            refreshScmData: refresh,
            setScmOperationBusy,
            setScmOperationStatus,
            tracking: null,
        });
    }, [commitSelectionPatches, commitSelectionPaths, refresh, scmCommitStrategy, scope]);

    const commitAdjacentPushState = React.useMemo(() => {
        return resolveCommitAdjacentPushActionState({
            snapshot,
            pushPreflight,
            scmWriteEnabled,
            sessionPath: scope.rootPath,
            scmOperationBusy,
            hasGlobalOperationInFlight: false,
            isLockedByOtherSession: false,
        });
    }, [pushPreflight, scmOperationBusy, scmWriteEnabled, scope.rootPath, snapshot]);

    const onCommitAdjacentPush = React.useCallback(() => {
        if (!commitAdjacentPushState.visible) return;
        void (async () => {
            const confirmed = await confirmCommitAdjacentPush({
                target: commitAdjacentPushState.target,
                policy: normalizedRemoteConfirmPolicy,
                setRemoteConfirmPolicy: setScmRemoteConfirmPolicy,
                detachedHeadLabel: t('files.detachedHead'),
            });
            if (!confirmed) return;
            await executeWorkspaceScmRemoteOperation({
                kind: 'push',
                scope,
                scmSnapshot: snapshot,
                scmWriteEnabled,
                scmCommitStrategy,
                scmRemoteConfirmPolicy: normalizedRemoteConfirmPolicy,
                scmPushRejectPolicy: normalizedPushRejectPolicy,
                refreshScmData: refresh,
                setScmOperationBusy,
                setScmOperationStatus,
                tracking: null,
                skipConfirmation: true,
            });
        })();
    }, [
        commitAdjacentPushState,
        normalizedPushRejectPolicy,
        normalizedRemoteConfirmPolicy,
        refresh,
        scmCommitStrategy,
        scmWriteEnabled,
        scope,
        setScmRemoteConfirmPolicy,
        snapshot,
    ]);

    const commitAdjacentPushAction = React.useMemo(() => {
        if (!commitAdjacentPushState.visible) return null;
        const displayTarget = formatRemoteTargetForDisplay(
            commitAdjacentPushState.target,
            t('files.detachedHead'),
        );
        return {
            label: t('files.commitAdjacentPush.accessibilityLabel', { target: displayTarget }),
            disabled: commitAdjacentPushState.disabled,
            busy: commitAdjacentPushState.busy,
            onPress: onCommitAdjacentPush,
        };
    }, [commitAdjacentPushState, onCommitAdjacentPush]);


    return {
        snapshot, loading, error, refresh,
        commitDraftMessage, setCommitDraftMessage, scmOperationBusy, scmOperationStatus,
        commitSelectionPaths, commitSelectionPatches, scmCommitStrategy, scmWriteEnabled,
        commitAllowed, commitBlockedMessage, handleCommitFromMessage, commitAdjacentPushAction,
        handleClearSelection: isAtomicCommitStrategy(scmCommitStrategy) ? handleClearSelection : undefined,
        commitMessageGeneratorEnabled: commitMessageSuggestion.enabled,
        generateCommitMessageSuggestion: commitMessageSuggestion.generate,
        cancelCommitMessageSuggestion: commitMessageSuggestion.cancel,
        suggestionContextKey: commitMessageSuggestion.contextKey,
    };
}
