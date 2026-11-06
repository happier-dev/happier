import type { AgentInputFolderChipState } from './definitions/AgentInputFolderChip';
import * as React from 'react';
import type { ActionListItem } from '@/components/ui/lists/ActionListSection';
import type { AgentInputResolvedControlLines } from './controls/agentInputControlTypes';
import { buildCoreCollapsedControlActions } from './controls/buildCoreCollapsedControlActions';
import { Icon, type IconName } from '@/components/ui/icons/Icon';

/** The visual owner separates actual add operations from the remaining overflow controls. */
export type AgentInputActionMenuAction = ActionListItem & Readonly<{ section: 'add' | 'controls' }>;

export function buildAgentInputActionMenuActions(opts: {
    resolvedControls: AgentInputResolvedControlLines;
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
    extraControlActions?: Readonly<Record<string, ActionListItem | ReadonlyArray<ActionListItem>>>;
    dismiss: () => void;
    blurInput: () => void;
}): AgentInputActionMenuAction[] {
    const controlActionsById: Partial<Record<string, ReadonlyArray<ActionListItem>>> = {
        ...buildCoreCollapsedControlActions({ ...opts, placementIds: opts.resolvedControls.collapsed }),
    };
    for (const [controlId, actionOrActions] of Object.entries(opts.extraControlActions ?? {})) {
        controlActionsById[controlId] = 'id' in actionOrActions ? [actionOrActions] : actionOrActions;
    }

    const overflow = opts.resolvedControls.collapsed;
    const isAdd = (id: string) => id === 'attachments' || id === 'linkedFiles';
    const orderedIds = [...overflow.filter(isAdd), ...overflow.filter((id) => !isAdd(id))];
    const descriptorsById = new Map(opts.resolvedControls.controls.map((control) => [control.id, control]));
    return orderedIds.flatMap((id) => {
        const actions = controlActionsById[id] ?? [];
        const descriptor = descriptorsById.get(id);
        const [controlAction, ...supplementaryActions] = actions;
        const section: AgentInputActionMenuAction['section'] = isAdd(id) ? 'add' : 'controls';
        if (!descriptor || !controlAction) return actions.map(action => ({ ...action, section }));
        const subtitle = [valueBesideName(controlAction.label, descriptor.title), controlAction.subtitle]
            .filter((value, index, values) => value && values.indexOf(value) === index)
            .join(' · ') || descriptor.menu?.description;
        return [{
            ...controlAction,
            label: descriptor.title,
            ...(subtitle ? { subtitle } : {}),
            icon: controlAction.icon ?? (descriptor.icon ? <Icon name={descriptor.icon} size={16} color={opts.tint} /> : null),
            right: controlAction.right ?? (descriptor.menu?.disclosure && controlAction.onPress && !controlAction.disabled
                ? <Icon name="caret-right" size={16} color={opts.tint} /> : null),
        }, ...supplementaryActions].map(action => ({ ...action, section }));
    });
}

const words = (text: string) => text.toLocaleLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean);

/**
 * The row is named by its control; the chip's own label is shown beneath only when it adds a value.
 * A label that merely restates the name ("To" under "Send to", "Link file" under "Linked files") is
 * dropped, and a label that starts with the name keeps only what follows it ("Runs through ChatGPT"
 * under "Runs through" reads "ChatGPT").
 */
function valueBesideName(label: string | undefined, name: string): string | undefined {
    if (!label) return undefined;
    const nameWords = words(name);
    const labelWords = words(label);
    if (labelWords.every((word) => nameWords.some((nameWord) => nameWord.startsWith(word) || word.startsWith(nameWord)))) return undefined;
    if (label.toLocaleLowerCase().startsWith(name.toLocaleLowerCase())) {
        const rest = label.slice(name.length).replace(/^[\s·:–—-]+/u, '');
        return rest || undefined;
    }
    return label;
}
