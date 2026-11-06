import type { AgentInputFolderChipState } from '../definitions/AgentInputFolderChip';
import * as React from 'react';

import { getAgentCore } from '@/agents/catalog/catalog';
import { AgentIcon } from '@/agents/registry/AgentIcon';
import { getAgentPickerIconScale } from '@/agents/registry/registryUi';
import type { ActionListItem } from '@/components/ui/lists/ActionListSection';
import { hapticsLight } from '@/components/ui/theme/haptics';
import { t } from '@/text';

import type { AgentInputControlId } from './agentInputControlTypes';
import { resolveSessionModeChipPresentation } from './resolveSessionModeChipPresentation';
import { formatResumeChipLabel, RESUME_CHIP_ICON_NAME, RESUME_CHIP_ICON_SIZE } from '../layout/ResumeChip';
import { Icon, type IconName, ICON_SIZE } from '@/components/ui/icons/Icon';
import { resolveAgentInputFolderChipState } from '../definitions/AgentInputFolderChip';

/**
 * An externally installed Agent has no bundled display-name key; its own id is
 * the honest label rather than a borrowed one.
 */
function resolveAgentDisplayLabel<T extends string | null | undefined>(agentId: T): string | T {
    const displayNameKey = getAgentCore(agentId ?? '')?.displayNameKey;
    return displayNameKey ? t(displayNameKey) : agentId;
}

export function buildCoreCollapsedControlActions(opts: Readonly<{
    tint: string;
    agentId: string;
    agentIdentityIcon?: React.ReactNode;
    profileLabel: string | null;
    profileIcon: IconName;
    envVarsCount?: number;
    agentLabel?: string | null;
    engineLabel?: string | null;
    machineName?: string | null;
    currentPath?: string | null;
    folderChipState?: AgentInputFolderChipState;
    onRemoveFolder?: () => void;
    resumeSessionId?: string | null;
    sessionId?: string;
    onProfileClick?: () => void;
    onEnvVarsClick?: () => void;
    onAgentClick?: () => void;
    permissionLabel?: string | null;
    onPermissionClick?: () => void;
    sessionModeLabel?: string | null;
    onSessionModeClick?: () => void;
    onMachineClick?: () => void;
    onPathClick?: () => void;
    onResumeClick?: () => void;
    onFileViewerPress?: () => void;
    placementIds: readonly string[];
    dismiss: () => void;
    blurInput: () => void;
}>): Partial<Record<AgentInputControlId, ReadonlyArray<ActionListItem>>> {
    const controlActionsById: Partial<Record<AgentInputControlId, ReadonlyArray<ActionListItem>>> = {};
    const overflowIds = new Set(opts.placementIds);

    if (overflowIds.has('permission') && opts.onPermissionClick) {
        controlActionsById.permission = [{
            id: 'permission',
            label: opts.permissionLabel ?? t('newSession.wizardSection.permission'),
            icon: <Icon name="shield-check" size={16} color={opts.tint} />,
            onPress: () => {
                hapticsLight();
                opts.dismiss();
                opts.onPermissionClick?.();
            },
        }];
    }

    if (overflowIds.has('profile') && opts.onProfileClick) {
        controlActionsById.profile = [{
            id: 'profile',
            label: opts.profileLabel ?? t('profiles.noProfile'),
            icon: <Icon name={opts.profileIcon} size={16} color={opts.tint} />,
            onPress: () => {
                hapticsLight();
                opts.dismiss();
                opts.onProfileClick?.();
            },
        }];
    }

    if (overflowIds.has('env') && opts.onEnvVarsClick) {
        controlActionsById.env = [{
            id: 'env-vars',
            label:
                opts.envVarsCount === undefined
                    ? t('agentInput.envVars.title')
                    : t('agentInput.envVars.titleWithCount', { count: opts.envVarsCount }),
            icon: <Icon name="list" size={16} color={opts.tint} />,
            onPress: () => {
                hapticsLight();
                opts.dismiss();
                opts.onEnvVarsClick?.();
            },
        }];
    }

    if (overflowIds.has('engine')) {
        const resolvedEngineLabel = opts.engineLabel
            ?? opts.agentLabel
            ?? resolveAgentDisplayLabel(opts.agentId);
        controlActionsById.engine = resolvedEngineLabel ? [{
            id: 'agent',
            label: resolvedEngineLabel,
            icon: opts.agentIdentityIcon ?? (
                <AgentIcon
                    agentId={opts.agentId}
                    size={16}
                    color={opts.tint}
                    style={{ transform: [{ scale: getAgentPickerIconScale(opts.agentId) }] }}
                    testID="agent-input-agent-action-logo"
                />
            ),
            ...(opts.onAgentClick ? {
                onPress: () => {
                    hapticsLight();
                    opts.dismiss();
                    opts.onAgentClick?.();
                },
            } : { disabled: true }),
        }] : [];
    }

    if (overflowIds.has('mode') && opts.sessionModeLabel && opts.onSessionModeClick) {
        const sessionModePresentation = resolveSessionModeChipPresentation({
            options: [],
            selectedId: opts.sessionModeLabel,
            label: opts.sessionModeLabel,
        });
        controlActionsById.mode = [{
            id: 'mode',
            label: opts.sessionModeLabel,
            icon: <Icon name={sessionModePresentation.iconName} size={ICON_SIZE.sm} color={opts.tint} />,
            onPress: () => {
                hapticsLight();
                opts.dismiss();
                opts.onSessionModeClick?.();
            },
        }];
    }

    if (overflowIds.has('machine') && opts.onMachineClick) {
        const machineLabel = opts.machineName === null
            ? t('agentInput.runOn')
            : (typeof opts.machineName === 'string' && opts.machineName.length > 0
                ? opts.machineName
                : t('newSession.selectMachineTitle'));
        controlActionsById.machine = [{
            id: 'machine',
            label: machineLabel,
            icon: <Icon name="desktop" size={16} color={opts.tint} />,
            onPress: () => {
                hapticsLight();
                opts.dismiss();
                opts.onMachineClick?.();
            },
        }];
    }

    if (overflowIds.has('path') && opts.onPathClick) {
        // The menu entry mirrors the folder chip (one state owner), and offers removal as its own row.
        const folderState = resolveAgentInputFolderChipState(opts.currentPath, opts.folderChipState);
        const labelState = folderState.kind === 'machine_unavailable' ? folderState.label : folderState;
        const pathLabel = labelState.kind === 'folder'
            ? labelState.path
            : labelState.kind === 'none'
                ? t('newSession.folder.addFolder')
                : labelState.lastKnownPath ?? t('newSession.folder.a11y.loading');
        const pathActions: ActionListItem[] = [{
            id: 'path',
            label: pathLabel,
            icon: <Icon name={labelState.kind === 'none' ? 'folder-plus' : 'folder'} size={16} color={opts.tint} />,
            disabled: folderState.kind === 'machine_unavailable',
            onPress: () => {
                hapticsLight();
                opts.dismiss();
                opts.onPathClick?.();
            },
        }];
        if (folderState.kind === 'folder' && opts.onRemoveFolder) {
            const onRemoveFolder = opts.onRemoveFolder;
            pathActions.push({
                id: 'path-remove',
                label: t('newSession.folder.removeFolder'),
                icon: <Icon name="x" size={16} color={opts.tint} />,
                onPress: () => {
                    hapticsLight();
                    opts.dismiss();
                    onRemoveFolder();
                },
            });
        }
        controlActionsById.path = pathActions;
    }

    if (overflowIds.has('resume') && opts.onResumeClick) {
        const resumeAgentLabel = opts.agentLabel
            ?? resolveAgentDisplayLabel(opts.agentId);
        const resumeChipTitle = t('newSession.resume.chipOptional', { agent: resumeAgentLabel });
        controlActionsById.resume = [{
            id: 'resume',
            label: formatResumeChipLabel({
                resumeSessionId: opts.resumeSessionId,
                labelTitle: resumeChipTitle,
                labelOptional: resumeChipTitle,
            }),
            icon: <Icon name={RESUME_CHIP_ICON_NAME} size={RESUME_CHIP_ICON_SIZE} color={opts.tint} />,
            onPress: () => {
                hapticsLight();
                opts.dismiss();
                opts.blurInput();
                opts.onResumeClick?.();
            },
        }];
    }

    if (overflowIds.has('files') && opts.sessionId && opts.onFileViewerPress) {
        controlActionsById.files = [{
            id: 'files',
            label: t('agentInput.actionMenu.files'),
            icon: <Icon name="files" size={16} color={opts.tint} />,
            onPress: () => {
                hapticsLight();
                opts.dismiss();
                opts.onFileViewerPress?.();
            },
        }];
    }

    return controlActionsById;
}
