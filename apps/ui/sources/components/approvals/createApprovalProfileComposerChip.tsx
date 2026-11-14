import * as React from 'react';
import { View } from 'react-native';
import type { ApprovalProfileV1 } from '@happier-dev/protocol/actions';

import { buildApprovalProfileChoices, approvalProfileChoiceId, applyApprovalProfileChoice } from '@/components/approvals/ApprovalProfileSelect';
import type { AgentInputExtraActionChip, AgentInputExtraActionChipRenderContext } from '@/components/sessions/agentInput/agentInputContracts';
import { AgentInputSelectionListPopover } from '@/components/sessions/agentInput/components/AgentInputSelectionListPopover';
import { AgentInputRailChip } from '@/components/sessions/agentInput/definitions/agentInputChipRowReach';
import { AGENT_INPUT_CHIP_ICON_SIZE_PX, AGENT_INPUT_CHIP_ICON_STYLE, AGENT_INPUT_MENU_ICON_SIZE_PX } from '@/components/sessions/agentInput/definitions/agentInputChipIconMetrics';
import type { SelectionListStep } from '@/components/ui/selectionList';
import { Icon } from '@/components/ui/icons/Icon';
import { normalizeNodeForView } from '@/components/ui/rendering/normalizeNodeForView';
import { Text } from '@/components/ui/text/Text';
import { t } from '@/text';

type ChipParams = Readonly<{
    value: string | null | undefined;
    profiles: readonly ApprovalProfileV1[];
    ready: boolean;
    onChange: (value: string | null | undefined) => void;
}>;

const CHIP_KEY = 'new-session-approval-profile';

/** The field's own choices (ApprovalProfileSelect's list) as the chip row's one selection step. */
function buildRootStep(params: ChipParams): SelectionListStep {
    const choices = buildApprovalProfileChoices('authoring', params.profiles, CHIP_KEY);
    return {
        id: `${CHIP_KEY}-root`,
        title: t('workflows.triggers.guided.profile.title'),
        sections: [{ kind: 'static', id: CHIP_KEY, options: choices.map(choice => ({
            id: choice.id, label: choice.title, ...(choice.subtitle ? { subtitle: choice.subtitle } : {}),
            onSelect: () => applyApprovalProfileChoice('authoring', choice.id, params.onChange),
        })) }],
    };
}

/** Until a profile is chosen the chip names its field, as every chip in the row does. */
function chipLabel(params: ChipParams): string {
    if (typeof params.value !== 'string') return t('workflows.triggers.guided.profile.title');
    return buildApprovalProfileChoices('authoring', params.profiles, CHIP_KEY).find(choice => choice.id === params.value)?.title
        ?? t(params.ready ? 'workflows.triggers.guided.profile.title' : 'common.loading');
}

const ApprovalProfileChip = React.memo(function ApprovalProfileChip(props: ChipParams & Readonly<{ ctx: AgentInputExtraActionChipRenderContext }>) {
    const [open, setOpen] = React.useState(false);
    const anchorRef = React.useRef<React.ElementRef<typeof View> | null>(null);
    const rootStep = React.useMemo(() => buildRootStep(props), [props.profiles, props.onChange, props.ready, props.value]); // eslint-disable-line react-hooks/exhaustive-deps
    const label = chipLabel(props);
    return <>
        <View ref={anchorRef} collapsable={false} style={{ alignSelf: 'flex-start' }}>
            <AgentInputRailChip testID={`${CHIP_KEY}-chip`} onPress={() => setOpen(current => !current)}
                style={(pressed) => props.ctx.chipStyle(Boolean(pressed))} accessibilityRole="button"
                accessibilityLabel={typeof props.value === 'string' ? `${t('workflows.triggers.guided.profile.title')}: ${label}` : label}>
                {normalizeNodeForView(<Icon name="list-checks" size={AGENT_INPUT_CHIP_ICON_SIZE_PX} color={props.ctx.iconColor} style={AGENT_INPUT_CHIP_ICON_STYLE} />)}
                {props.ctx.showLabel ? <Text numberOfLines={1} style={props.ctx.textStyle}>{label}</Text> : null}
            </AgentInputRailChip>
        </View>
        <AgentInputSelectionListPopover open={open} anchorRef={anchorRef} rootStep={rootStep}
            selectedOptionId={approvalProfileChoiceId('authoring', props.value)}
            // Each option's own onSelect applies the choice; the popover owns closing (see the storage chip).
            onSelect={() => {}} onRequestClose={() => setOpen(false)} maxHeightCap={320} />
    </>;
});

/**
 * The approval profile as one chip of the New Session chip row (UI refinements 21:36Z, lab composer P3): it names its
 * field until a profile is chosen and opens the field's own choices; the chip row owns placement and overflow.
 */
export function createApprovalProfileComposerChip(params: ChipParams): AgentInputExtraActionChip {
    const title = t('workflows.triggers.guided.profile.title');
    return {
        key: CHIP_KEY,
        controlId: 'approvalProfile',
        placement: { id: 'approvalProfile', title, icon: 'list-checks', defaultPlacement: 'pinned' },
        collapsedOptionsPopover: {
            presentation: 'list', title, label: chipLabel(params),
            icon: (tint) => normalizeNodeForView(<Icon name="list-checks" size={AGENT_INPUT_MENU_ICON_SIZE_PX} color={tint} />),
            rootStep: buildRootStep(params),
            selectedOptionId: approvalProfileChoiceId('authoring', params.value),
            onSelect: () => {},
            maxHeightCap: 320,
        },
        render: (ctx) => <ApprovalProfileChip {...params} ctx={ctx} />,
    };
}
