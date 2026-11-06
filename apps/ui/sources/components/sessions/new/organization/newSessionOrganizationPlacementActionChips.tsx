import { getNewSessionOrganizationActionChipPlacement } from '../newSessionActionChipPlacements';
import type { AgentInputControlPlacement } from '@/components/sessions/agentInput/controls/agentInputControlTypes';
import * as React from 'react';
import { Pressable } from 'react-native';

import type { AgentInputExtraActionChip } from '@/components/sessions/agentInput/agentInputContracts';
import type { SelectionListStep } from '@/components/ui/selectionList';
import { buildSessionTagsMenuContent } from '@/components/sessions/organization/SessionTagsMenuContent';
import {
    SESSION_FOLDER_SELECTION_ROOT_ID,
    buildSessionFolderSelectionOptions,
    resolveSessionFolderSelectionLabel,
} from '@/components/sessions/organization/sessionFolderSelectionOptions';
import { Icon } from '@/components/ui/icons/Icon';
import { Text } from '@/components/ui/text/Text';
import { normalizeNodeForView } from '@/components/ui/rendering/normalizeNodeForView';
import { t } from '@/text';
import {
    AGENT_INPUT_CHIP_ICON_SIZE_PX,
    AGENT_INPUT_CHIP_ICON_STYLE,
    AGENT_INPUT_MENU_ICON_SIZE_PX,
} from '@/components/sessions/agentInput/definitions/agentInputChipIconMetrics';

type PlacementChip = Readonly<{
    key: string;
    /** The folder is where the session lives (location rail); tags describe it (setup rail). */
    controlId: 'organization' | 'tags';
    placement?: AgentInputControlPlacement;
    title: string;
    label: string;
    icon: 'folder' | 'tag';
    maxWidthCap: number;
    rootStep: SelectionListStep;
    selectedOptionId: string | null;
    chosen?: boolean;
}>;

function createPlacementChip(params: PlacementChip): AgentInputExtraActionChip {
    return {
        key: params.key,
        controlId: params.controlId,
        placement: params.placement ?? getNewSessionOrganizationActionChipPlacement(params.controlId, { chosen: params.chosen }),
        collapsedOptionsPopover: {
            presentation: 'list',
            title: params.title,
            label: params.label,
            icon: (tint) => normalizeNodeForView(<Icon name={params.icon} size={AGENT_INPUT_MENU_ICON_SIZE_PX} color={tint} />),
            rootStep: params.rootStep,
            selectedOptionId: params.selectedOptionId,
            onSelect: () => {},
            maxHeightCap: 420,
            maxWidthCap: params.maxWidthCap,
        },
        render: (ctx) => (
            <Pressable
                ref={ctx.chipAnchorRef}
                testID={`new-session-${params.key}-chip`}
                onPress={() => ctx.toggleCollapsedPopover?.(params.key)}
                hitSlop={{ top: 5, bottom: 10, left: 0, right: 0 }}
                style={({ pressed }) => ctx.chipStyle(pressed)}
                accessibilityRole="button"
                accessibilityLabel={params.title === params.label ? params.title : `${params.title}: ${params.label}`}
            >
                {normalizeNodeForView(<Icon name={params.icon} size={AGENT_INPUT_CHIP_ICON_SIZE_PX} color={ctx.iconColor} style={AGENT_INPUT_CHIP_ICON_STYLE} />)}
                {ctx.showLabel ? <Text numberOfLines={1} style={ctx.textStyle}>{params.label}</Text> : null}
            </Pressable>
        ),
    };
}

export function createNewSessionOrganizationPlacementActionChips(params: Readonly<{
    enabled: boolean;
    folderId: string | null;
    tagIds: readonly string[];
    folderTargets: readonly Readonly<{ folderId: string; title: string; depth: number }>[];
    tags: readonly Readonly<{ id: string; label: string }>[];
    iconColor: string;
    onFolderSelect: (folderId: string | null) => void;
    onTagToggle: (tagId: string) => void;
    onTagCreate?: (label: string) => void;
}>): readonly AgentInputExtraActionChip[] {
    if (!params.enabled) return [];
    const folderLabel = resolveSessionFolderSelectionLabel(params.folderId, params.folderTargets);
    const folderRoot: SelectionListStep = {
        id: 'new-session-folder-root',
        title: t('sessionsList.moveToFolder'),
        sections: [{
            kind: 'static',
            id: 'new-session-folders',
            options: buildSessionFolderSelectionOptions(params.folderTargets).map((option) => ({
                id: option.id,
                label: option.label,
                onSelect: () => params.onFolderSelect(option.folderId),
            })),
        }],
    };
    const tagContent = buildSessionTagsMenuContent({
        tags: params.tags,
        selectedTagIds: params.tagIds,
        iconColor: params.iconColor,
        onToggle: params.onTagToggle,
        ...(params.onTagCreate ? { onCreate: params.onTagCreate } : {}),
    });
    // With no folder to move to the picker would offer only the root it is already in; a chosen
    // folder stays reachable so it can be cleared.
    const hasFolderChoice = params.folderId !== null || params.folderTargets.length > 0;
    return [
        ...(hasFolderChoice ? [createPlacementChip({
            key: 'organization-folder',
            controlId: 'organization',
            title: t('sessionsList.moveToFolder'),
            label: folderLabel,
            icon: 'folder',
            maxWidthCap: 520,
            rootStep: folderRoot,
            selectedOptionId: params.folderId ?? SESSION_FOLDER_SELECTION_ROOT_ID,
            chosen: params.folderId !== null,
        })] : []),
        createPlacementChip({
            key: 'organization-tags',
            controlId: 'tags',
            title: t('sessionTags.editTagsLabel'),
            label: t('sessionTags.editTagsLabel'),
            // Tag names are short: the list stays compact under its chip instead of spanning the composer.
            icon: 'tag',
            maxWidthCap: 360,
            rootStep: tagContent.selectionListStep,
            selectedOptionId: null,
        }),
    ];
}
