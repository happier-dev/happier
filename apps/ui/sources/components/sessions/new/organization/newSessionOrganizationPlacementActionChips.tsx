import * as React from 'react';
import { View } from 'react-native';

import type { AgentInputExtraActionChip } from '@/components/sessions/agentInput/agentInputContracts';
import type { SelectionListStep } from '@/components/ui/selectionList';
import { buildSessionTagsMenuContent } from '@/components/sessions/organization/SessionTagsMenuContent';
import { resolveSessionSectionIcon } from '@/components/sessions/organization/sessionSectionIcons';
import { resolveSessionSectionChoiceLabel, type SectionAddress, type SessionSection } from '@/sync/domains/session/organization/sections';
import type { IconName } from '@/components/ui/icons/Icon';
import { Icon } from '@/components/ui/icons/Icon';
import { Text } from '@/components/ui/text/Text';
import { normalizeNodeForView } from '@/components/ui/rendering/normalizeNodeForView';
import { t } from '@/text';
import type { CollectionSpaceIconV1 } from '@happier-dev/protocol/collections/spaces/collectionSpacesV1';
import { CollectionSpaceIcon } from '@/components/ui/lists/collection/CollectionSpaceIcon';
import type { AgentInputControlPlacement } from '@/components/sessions/agentInput/controls/agentInputControlTypes';
import { getNewSessionOrganizationActionChipPlacement, getNewSessionSpaceActionChipPlacement } from '../newSessionActionChipPlacements';
import {
    AGENT_INPUT_CHIP_ICON_SIZE_PX,
    AGENT_INPUT_CHIP_ICON_STYLE,
    AGENT_INPUT_MENU_ICON_SIZE_PX,
} from '@/components/sessions/agentInput/definitions/agentInputChipIconMetrics';
import { AgentInputRailChip } from '@/components/sessions/agentInput/definitions/agentInputChipRowReach';

type PlacementChip = Readonly<{
    key: string;
    /** The section is where the session is filed (location rail); tags describe it (setup rail). */
    controlId: 'organization' | 'tags';
    /** Defaults to the control's own placement; the space chip is a second organization placement. */
    placement?: AgentInputControlPlacement;
    title: string;
    label: string;
    icon: IconName;
    /** Draws the mark instead of `icon` (a space's held Project favicon). */
    renderMark?: (size: number, color: string) => React.ReactNode;
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
        composerPreview: (tint) => ({ mark: normalizeNodeForView(params.renderMark
            ? <View style={AGENT_INPUT_CHIP_ICON_STYLE}>{params.renderMark(AGENT_INPUT_CHIP_ICON_SIZE_PX, tint)}</View>
            : <Icon name={params.icon} size={AGENT_INPUT_CHIP_ICON_SIZE_PX} color={tint} style={AGENT_INPUT_CHIP_ICON_STYLE} />) }),
        collapsedOptionsPopover: {
            presentation: 'list',
            title: params.title,
            label: params.label,
            icon: (tint) => normalizeNodeForView(params.renderMark ? params.renderMark(AGENT_INPUT_MENU_ICON_SIZE_PX, tint)
                : <Icon name={params.icon} size={AGENT_INPUT_MENU_ICON_SIZE_PX} color={tint} />),
            rootStep: params.rootStep,
            selectedOptionId: params.selectedOptionId,
            onSelect: () => {},
            maxHeightCap: 420,
            maxWidthCap: params.maxWidthCap,
        },
        render: (ctx) => (
            <AgentInputRailChip
                ref={ctx.chipAnchorRef}
                testID={`new-session-${params.key}-chip`}
                onPress={() => ctx.toggleCollapsedPopover?.(params.key)}
                style={ctx.chipStyle}
                accessibilityRole="button"
                accessibilityLabel={params.title === params.label ? params.title : `${params.title}: ${params.label}`}
            >
                {normalizeNodeForView(params.renderMark
                    ? <View style={AGENT_INPUT_CHIP_ICON_STYLE}>{params.renderMark(AGENT_INPUT_CHIP_ICON_SIZE_PX, ctx.iconColor)}</View>
                    : <Icon name={params.icon} size={AGENT_INPUT_CHIP_ICON_SIZE_PX} color={ctx.iconColor} style={AGENT_INPUT_CHIP_ICON_STYLE} />)}
                {ctx.showLabel ? <Text numberOfLines={1} style={ctx.textStyle}>{params.label}</Text> : null}
            </AgentInputRailChip>
        ),
    };
}

/** The no-section choice's option id; a section id never takes this value. */
const NO_SECTION_OPTION_ID = 'root';
/** The no-space choice's option id; space ids are Account-catalog ids and never take this value. */
const NO_SPACE_OPTION_ID = 'new-session-no-space';

/** The space a new session starts in: captured from the list at New, changeable or clearable here. */
export type NewSessionSpaceChoice = Readonly<{
    spaces: readonly Readonly<{ id: string; name: string; icon: CollectionSpaceIconV1 }>[];
    selectedSpaceId: string | null;
    onSelect: (spaceId: string | null) => void;
}>;

function createSpaceChip(space: NewSessionSpaceChoice, iconColor: string): AgentInputExtraActionChip {
    const selected = space.selectedSpaceId === null ? null : space.spaces.find(candidate => candidate.id === space.selectedSpaceId) ?? null;
    const label = space.selectedSpaceId === null ? t('sessionsList.spacesNone') : selected?.name ?? t('common.unavailable');
    const optionIcon = (name: IconName) => () => normalizeNodeForView(<Icon name={name} size={AGENT_INPUT_MENU_ICON_SIZE_PX} color={iconColor} />);
    return createPlacementChip({
        key: 'organization-space',
        controlId: 'organization',
        placement: getNewSessionSpaceActionChipPlacement({ chosen: space.selectedSpaceId !== null }),
        title: t('sessionsList.spacesPickerTitle'),
        label,
        icon: 'squares-four',
        ...(selected ? { renderMark: (size: number, color: string) => <CollectionSpaceIcon icon={selected.icon} size={size} color={color} /> } : {}),
        maxWidthCap: 360,
        rootStep: {
            id: 'new-session-space-root',
            title: t('sessionsList.spacesPickerTitle'),
            sections: [{
                kind: 'static',
                id: 'new-session-spaces',
                options: [
                    { id: NO_SPACE_OPTION_ID, label: t('sessionsList.spacesNone'), icon: optionIcon('squares-four'),
                        onSelect: () => space.onSelect(null) },
                    ...space.spaces.map(candidate => ({ id: candidate.id, label: candidate.name,
                        icon: () => normalizeNodeForView(<CollectionSpaceIcon icon={candidate.icon} size={AGENT_INPUT_MENU_ICON_SIZE_PX} color={iconColor} />),
                        onSelect: () => space.onSelect(candidate.id) })),
                ],
            }],
        },
        selectedOptionId: space.selectedSpaceId ?? NO_SPACE_OPTION_ID,
    });
}

export function createNewSessionOrganizationPlacementActionChips(params: Readonly<{
    enabled: boolean;
    /** The selected section on the chosen Home (captured address), or none. */
    sectionAddress: SectionAddress | null;
    tagIds: readonly string[];
    /** Readable sections on the chosen Account; foreign or unavailable ones are not offered. */
    sections: readonly SessionSection[];
    tags: readonly Readonly<{ id: string; label: string }>[];
    iconColor: string;
    onSectionSelect: (next: SectionAddress | null) => void;
    onTagToggle: (tagId: string) => void;
    onTagCreate?: (label: string) => void;
    /** Present while spaces are on for Sessions, or while the draft still carries a space to clear. */
    space?: NewSessionSpaceChoice;
}>): readonly AgentInputExtraActionChip[] {
    if (!params.enabled) return [];
    const unavailableLabel = t('common.unavailable');
    const choices = params.sections.filter(section => section.display.status === 'available');
    const selected = params.sectionAddress
        ? params.sections.find(section => section.address.serverId === params.sectionAddress?.serverId
            && section.address.sectionId === params.sectionAddress.sectionId) ?? null
        : null;
    const sectionLabel = params.sectionAddress === null ? t('sessionsList.noSection')
        : selected ? resolveSessionSectionChoiceLabel(selected, { unavailableLabel }).title : unavailableLabel;
    const sectionRoot: SelectionListStep = {
        id: 'new-session-section-root',
        title: t('sessionsList.sectionTitle'),
        sections: [{
            kind: 'static',
            id: 'new-session-sections',
            options: [
                { id: NO_SECTION_OPTION_ID, label: t('sessionsList.noSection'),
                    icon: () => normalizeNodeForView(<Icon name="folder" size={AGENT_INPUT_MENU_ICON_SIZE_PX} color={params.iconColor} />),
                    onSelect: () => params.onSectionSelect(null) },
                ...choices.map((section) => ({
                    id: section.address.sectionId,
                    label: resolveSessionSectionChoiceLabel(section, { unavailableLabel }).choiceLabel,
                    icon: () => normalizeNodeForView(<Icon name={resolveSessionSectionIcon(section.display.status === 'available'
                        ? section.display.value.icon : null)} size={AGENT_INPUT_MENU_ICON_SIZE_PX} color={params.iconColor} />),
                    onSelect: () => params.onSectionSelect(section.address),
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
    // With no section to choose the picker would offer only "No section"; a chosen section stays
    // reachable so it can be cleared.
    const hasSectionChoice = params.sectionAddress !== null || choices.length > 0;
    return [
        ...(hasSectionChoice ? [createPlacementChip({
            key: 'organization-folder',
            controlId: 'organization',
            title: t('sessionsList.sectionTitle'),
            label: sectionLabel,
            icon: resolveSessionSectionIcon(selected?.display.status === 'available' ? selected.display.value.icon : null),
            maxWidthCap: 520,
            rootStep: sectionRoot,
            selectedOptionId: params.sectionAddress?.sectionId ?? NO_SECTION_OPTION_ID,
            chosen: params.sectionAddress !== null,
        })] : []),
        ...(params.space ? [createSpaceChip(params.space, params.iconColor)] : []),
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
