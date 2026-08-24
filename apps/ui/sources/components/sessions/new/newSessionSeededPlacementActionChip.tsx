import * as React from 'react';
import { Pressable } from 'react-native';

import type { PluginUiSessionPlacementCandidateV1 } from '@happier-dev/protocol/plugins/ui';

import type {
    AgentInputExtraActionChip,
    AgentInputExtraActionChipRenderContext,
} from '@/components/sessions/agentInput/agentInputContracts';
import type { SelectionListStep } from '@/components/ui/selectionList';
import { normalizeNodeForView } from '@/components/ui/rendering/normalizeNodeForView';
import { Icon } from '@/components/ui/icons/Icon';
import { Text } from '@/components/ui/text/Text';
import { t } from '@/text';
import {
    AGENT_INPUT_CHIP_ICON_SIZE_PX,
    AGENT_INPUT_CHIP_ICON_STYLE,
    AGENT_INPUT_MENU_ICON_SIZE_PX,
} from '@/components/sessions/agentInput/definitions/agentInputChipIconMetrics';

const CHIP_KEY = 'new-session-seeded-placement';

/**
 * Projects an unresolved plugin placement into the New Session screen's
 * existing action-chip overlay. It carries no route state or selected value:
 * selecting an item calls the screen owner, which uses the incumbent
 * server/machine/path route fields and clears this one-shot input.
 */
export function createNewSessionSeededPlacementActionChip(params: Readonly<{
    candidates: readonly PluginUiSessionPlacementCandidateV1[];
    onSelect: (candidate: PluginUiSessionPlacementCandidateV1) => void;
}>): AgentInputExtraActionChip | null {
    if (params.candidates.length === 0) return null;

    const rootStep: SelectionListStep = {
        id: 'new-session-seeded-placement-root',
        title: t('newSession.selectWorkingDirectoryTitle'),
        sections: [{
            kind: 'static',
            id: 'new-session-seeded-placement-candidates',
            options: params.candidates.map((candidate, index) => ({
                id: `new-session-seeded-placement:${index}`,
                label: candidate.label ?? candidate.rootPath,
                subtitle: `${candidate.machineId} · ${candidate.serverId}`,
                onSelect: () => params.onSelect(candidate),
            })),
        }],
    };

    const label = t('newSession.selectWorkingDirectoryTitle');
    return {
        key: CHIP_KEY,
        collapsedOptionsPopover: {
            presentation: 'list',
            title: label,
            label,
            icon: (tint) => normalizeNodeForView(
                <Icon name="folder" size={AGENT_INPUT_MENU_ICON_SIZE_PX} color={tint} />,
            ),
            rootStep,
            selectedOptionId: null,
            // List-mode mutations are owned by each option's `onSelect`.
            onSelect: () => {},
            maxHeightCap: 420,
            maxWidthCap: 680,
        },
        render: (ctx: AgentInputExtraActionChipRenderContext) => (
            <Pressable
                ref={ctx.chipAnchorRef}
                testID="new-session-seeded-placement-chip"
                onPress={() => ctx.toggleCollapsedPopover?.(CHIP_KEY)}
                hitSlop={{ top: 5, bottom: 10, left: 0, right: 0 }}
                style={({ pressed }) => ctx.chipStyle(pressed)}
                accessibilityRole="button"
                accessibilityLabel={label}
            >
                {normalizeNodeForView(
                    <Icon
                        name="folder"
                        size={AGENT_INPUT_CHIP_ICON_SIZE_PX}
                        color={ctx.iconColor}
                        style={AGENT_INPUT_CHIP_ICON_STYLE}
                    />,
                )}
                {ctx.showLabel ? (
                    <Text numberOfLines={1} style={ctx.textStyle}>{label}</Text>
                ) : null}
            </Pressable>
        ),
    };
}
