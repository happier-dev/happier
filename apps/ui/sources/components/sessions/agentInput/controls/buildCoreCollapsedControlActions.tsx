import * as React from 'react';

import type { AgentId } from '@/agents/catalog/catalog';
import { getAgentCore } from '@/agents/catalog/catalog';
import { AgentIcon } from '@/agents/registry/AgentIcon';
import { getAgentPickerIconScale } from '@/agents/registry/registryUi';
import type { ActionListItem } from '@/components/ui/lists/ActionListSection';
import { hapticsLight } from '@/components/ui/theme/haptics';
import { t } from '@/text';

import type { AgentInputControlId } from './agentInputControlTypes';
import { resolveSessionModeChipPresentation } from './resolveSessionModeChipPresentation';
import { formatResumeChipLabel, RESUME_CHIP_ICON_NAME, RESUME_CHIP_ICON_SIZE } from '../layout/ResumeChip';
import { Icon, ICON_SIZE } from '@/components/ui/icons/Icon';

export function buildCoreCollapsedControlActions(opts: Readonly<{
    tint: string;
    agentId: AgentId;
    profileLabel: string | null;
    profileIcon: string;
    envVarsCount?: number;
    engineLabel?: string | null;
    agentType?: AgentId;
    machineName?: string | null;
    currentPath?: string | null;
    resumeSessionId?: string | null;
    sessionId?: string;
    onProfileClick?: () => void;
    onEnvVarsClick?: () => void;
    onAgentClick?: () => void;
    sessionModeLabel?: string | null;
    onSessionModeClick?: () => void;
    onMachineClick?: () => void;
    onPathClick?: () => void;
    onResumeClick?: () => void;
    onFileViewerPress?: () => void;
    canStop?: boolean;
    onStop?: () => void;
    dismiss: () => void;
    blurInput: () => void;
}>): Partial<Record<AgentInputControlId, ReadonlyArray<ActionListItem>>> {
    const controlActionsById: Partial<Record<AgentInputControlId, ReadonlyArray<ActionListItem>>> = {};

    if (opts.onProfileClick) {
        controlActionsById.profile = [{
            id: 'profile',
            label: opts.profileLabel ?? t('profiles.noProfile'),
            icon: <Icon name={opts.profileIcon as any} size={16} color={opts.tint} />,
            onPress: () => {
                hapticsLight();
                opts.dismiss();
                opts.onProfileClick?.();
            },
        }];
    }

    if (opts.onEnvVarsClick) {
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

    if (opts.agentType && opts.onAgentClick) {
        controlActionsById.engine = [{
            id: 'agent',
            label: opts.engineLabel ?? t(getAgentCore(opts.agentType).displayNameKey),
            icon: (
                // `agentId`, not `agentType`: this row IS the engine chip, collapsed, so it
                // draws the mark the chip draws — which follows an armed Agent switch.
                <AgentIcon
                    agentId={opts.agentId}
                    size={16}
                    color={opts.tint}
                    style={{ transform: [{ scale: getAgentPickerIconScale(opts.agentId) }] }}
                    testID="agent-input-agent-action-logo"
                />
            ),
            onPress: () => {
                hapticsLight();
                opts.dismiss();
                opts.onAgentClick?.();
            },
        }];
    }

    if (opts.sessionModeLabel && opts.onSessionModeClick) {
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

    if (opts.onMachineClick) {
        const machineLabel = opts.machineName === null
            ? t('agentInput.noMachinesAvailable')
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

    if (opts.onPathClick) {
        const pathLabel = (typeof opts.currentPath === 'string' && opts.currentPath.length > 0)
            ? opts.currentPath
            : t('newSession.selectPathTitle');
        controlActionsById.path = [{
            id: 'path',
            label: pathLabel,
            icon: <Icon name="folder" size={16} color={opts.tint} />,
            onPress: () => {
                hapticsLight();
                opts.dismiss();
                opts.onPathClick?.();
            },
        }];
    }

    if (opts.onResumeClick) {
        const resumeAgentLabel = t(getAgentCore(opts.agentType ?? opts.agentId).displayNameKey);
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

    if (opts.sessionId && opts.onFileViewerPress) {
        controlActionsById.files = [{
            id: 'files',
            label: t('agentInput.actionMenu.files'),
            icon: <Icon name="git-branch" size={16} color={opts.tint} />,
            onPress: () => {
                hapticsLight();
                opts.dismiss();
                opts.onFileViewerPress?.();
            },
        }];
    }

    if (opts.canStop && opts.onStop) {
        controlActionsById.stop = [{
            id: 'stop',
            label: t('agentInput.actionMenu.stop'),
            icon: <Icon name="stop" size={16} color={opts.tint} />,
            onPress: () => {
                opts.dismiss();
                opts.onStop?.();
            },
        }];
    }

    return controlActionsById;
}
