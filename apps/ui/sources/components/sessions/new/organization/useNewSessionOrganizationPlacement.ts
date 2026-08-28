import * as React from 'react';
import type { SessionExecutionTargetV1, SessionOrganizationPlacementV1 } from '@happier-dev/protocol';
import { useUnistyles } from 'react-native-unistyles';

import { useFeatureEnabled } from '@/hooks/server/useFeatureEnabled';
import { useSessionOrganizationProjection } from '@/sync/domains/state/storage';
import { buildSessionOrganizationListViewState } from '@/sync/domains/session/organization/viewState';
import { buildSessionOrganizationTagLabelById } from '@/sync/domains/session/organization/tagLabels';
import {
    buildSessionFolderWorkspaceTargets,
    normalizeSessionFolderWorkspaceRef,
    selectAvailableSessionFolders,
} from '@/sync/domains/session/folders';
import {
    createSessionOrganizationTagWithLabel,
    resolveSessionOrganizationMutationScope,
} from '@/sync/ops/sessionOrganization';
import { Modal } from '@/modal';
import { t } from '@/text';
import type { AgentInputExtraActionChip } from '@/components/sessions/agentInput/agentInputContracts';

import {
    isNewSessionOrganizationPlacementAvailable,
    normalizeNewSessionOrganizationPlacement,
    reconcileNewSessionOrganizationPlacementForWorkspace,
} from './newSessionOrganizationPlacementState';
import { createNewSessionOrganizationPlacementActionChips } from './newSessionOrganizationPlacementActionChips';

export function useNewSessionOrganizationPlacement(params: Readonly<{
    executionTarget: SessionExecutionTargetV1 | null;
    directory: string;
    initialPlacement?: SessionOrganizationPlacementV1 | null;
}>): Readonly<{
    enabled: boolean;
    valid: boolean;
    placement: SessionOrganizationPlacementV1;
    actionChips: readonly AgentInputExtraActionChip[];
    setFolderId: (folderId: string | null) => void;
    setTagIds: (tagIds: readonly string[]) => void;
}> {
    const { theme } = useUnistyles();
    const enabled = useFeatureEnabled('sessions.folders');
    const serverId = params.executionTarget?.serverId ?? '';
    const projection = useSessionOrganizationProjection(serverId);
    const viewState = React.useMemo(() => buildSessionOrganizationListViewState({ serverId, projection }), [projection, serverId]);
    const folders = viewState.sessionFoldersV1.folders;
    const availableFolders = React.useMemo(
        () => selectAvailableSessionFolders(viewState.sessionFoldersV1),
        [viewState.sessionFoldersV1],
    );
    const workspace = React.useMemo(() => params.executionTarget
        ? normalizeSessionFolderWorkspaceRef({
            t: 'workspaceScope',
            serverId: params.executionTarget.serverId,
            machineId: params.executionTarget.machineId,
            rootPath: params.directory,
        })
        : null, [params.directory, params.executionTarget]);
    const folderTargets = React.useMemo(
        () => workspace
            ? buildSessionFolderWorkspaceTargets({ folders: availableFolders, workspace })
            : [],
        [availableFolders, workspace],
    );
    const tags = React.useMemo(() => {
        const labels = buildSessionOrganizationTagLabelById(projection?.tagsById ?? {});
        return Object.entries(labels).map(([id, label]) => ({ id, label }));
    }, [projection]);
    const [placement, setPlacement] = React.useState(() => normalizeNewSessionOrganizationPlacement(params.initialPlacement));

    React.useEffect(() => {
        setPlacement((current) => {
            if (!enabled) return current;
            return reconcileNewSessionOrganizationPlacementForWorkspace({
                placement: current,
                executionTarget: params.executionTarget,
                directory: params.directory,
                folders: folders.map((folder) => ({ folderId: folder.id, workspace: folder.workspace })),
            });
        });
    }, [enabled, folders, params.directory, params.executionTarget]);

    const setFolderId = React.useCallback((folderId: string | null) => {
        setPlacement((current) => normalizeNewSessionOrganizationPlacement({ ...current, folderId }));
    }, []);
    const setTagIds = React.useCallback((tagIds: readonly string[]) => {
        setPlacement((current) => normalizeNewSessionOrganizationPlacement({ ...current, tagIds }));
    }, []);
    const toggleTagId = React.useCallback((tagId: string) => {
        setPlacement((current) => normalizeNewSessionOrganizationPlacement({
            ...current,
            tagIds: current.tagIds.includes(tagId)
                ? current.tagIds.filter((candidate) => candidate !== tagId)
                : [...current.tagIds, tagId],
        }));
    }, []);
    const createTag = React.useCallback((label: string) => {
        void (async () => {
            const scopeResult = await resolveSessionOrganizationMutationScope(serverId);
            if (!scopeResult.ok) throw new Error(scopeResult.reason);
            const tag = await createSessionOrganizationTagWithLabel({
                credentials: scopeResult.scope.credentials,
                serverId: scopeResult.scope.serverId,
                serverUrl: scopeResult.scope.serverUrl,
                label,
            });
            setPlacement((current) => normalizeNewSessionOrganizationPlacement({
                ...current,
                tagIds: [...current.tagIds, tag.tagId],
            }));
        })().catch(() => {
            Modal.alert(t('common.error'), t('errors.unknownError'));
        });
    }, [serverId]);
    const actionChips = React.useMemo(() => createNewSessionOrganizationPlacementActionChips({
        enabled,
        folderId: placement.folderId,
        tagIds: placement.tagIds,
        folderTargets,
        tags,
        iconColor: theme.colors.text.secondary,
        onFolderSelect: setFolderId,
        onTagToggle: toggleTagId,
        onTagCreate: createTag,
    }), [createTag, enabled, folderTargets, placement.folderId, placement.tagIds, setFolderId, tags, theme.colors.text.secondary, toggleTagId]);
    const valid = isNewSessionOrganizationPlacementAvailable({
        featureEnabled: enabled,
        placement,
    });

    return { enabled, valid, placement, actionChips, setFolderId, setTagIds };
}
