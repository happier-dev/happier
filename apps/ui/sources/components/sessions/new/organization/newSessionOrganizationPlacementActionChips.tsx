import * as React from 'react';
import { Pressable } from 'react-native';

import type { AgentInputExtraActionChip } from '@/components/sessions/agentInput/agentInputContracts';
import type { SelectionListStep } from '@/components/ui/selectionList';
import { buildSessionTagsMenuContent } from '@/components/sessions/organization/SessionTagsMenuContent';
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
    title: string;
    label: string;
    icon: 'folder' | 'tag';
    rootStep: SelectionListStep;
    selectedOptionId: string | null;
}>;

function createPlacementChip(params: PlacementChip): AgentInputExtraActionChip {
    return {
        key: params.key,
        collapsedOptionsPopover: {
            presentation: 'list',
            title: params.title,
            label: params.label,
            icon: (tint) => normalizeNodeForView(<Icon name={params.icon} size={AGENT_INPUT_MENU_ICON_SIZE_PX} color={tint} />),
            rootStep: params.rootStep,
            selectedOptionId: params.selectedOptionId,
            onSelect: () => {},
            maxHeightCap: 420,
            maxWidthCap: 520,
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
    const folderLabel = params.folderId
        ? params.folderTargets.find((folder) => folder.folderId === params.folderId)?.title ?? t('common.unavailable')
        : t('sessionsList.moveToWorkspaceRoot');
    const folderRoot: SelectionListStep = {
        id: 'new-session-folder-root',
        title: t('sessionsList.moveToFolder'),
        sections: [{
            kind: 'static',
            id: 'new-session-folders',
            options: [
                { id: 'root', label: t('sessionsList.moveToWorkspaceRoot'), onSelect: () => params.onFolderSelect(null) },
                ...params.folderTargets.map((folder) => ({
                    id: folder.folderId,
                    label: folder.title,
                    onSelect: () => params.onFolderSelect(folder.folderId),
                })),
            ],
        }],
    };
    const tagContent = buildSessionTagsMenuContent({
        tags: params.tags,
        selectedTagIds: params.tagIds,
        iconColor: params.iconColor,
        onToggle: params.onTagToggle,
        ...(params.onTagCreate ? { onCreate: params.onTagCreate } : {}),
    });
    return [
        createPlacementChip({
            key: 'organization-folder',
            title: t('sessionsList.moveToFolder'),
            label: folderLabel,
            icon: 'folder',
            rootStep: folderRoot,
            selectedOptionId: params.folderId ?? 'root',
        }),
        createPlacementChip({
            key: 'organization-tags',
            title: t('sessionTags.editTagsLabel'),
            label: t('sessionTags.editTagsLabel'),
            icon: 'tag',
            rootStep: tagContent.selectionListStep,
            selectedOptionId: null,
        }),
    ];
}
