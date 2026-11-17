import * as React from 'react';
import { View } from 'react-native';
import type { ApprovalProfileV1 } from '@happier-dev/protocol/actions';

import { approvalProfileChipLabel, approvalProfileChoiceId, approvalProfileChoiceValue, buildApprovalProfileChoices,
    type ApprovalProfileMachineDefault } from '@/components/approvals/ApprovalProfileSelect';
import type { AgentInputExtraActionChip, AgentInputExtraActionChipRenderContext } from '@/components/sessions/agentInput/agentInputContracts';
import { AgentInputSelectionListPopover } from '@/components/sessions/agentInput/components/AgentInputSelectionListPopover';
import { AgentInputRailChip } from '@/components/sessions/agentInput/definitions/agentInputChipRowReach';
import { AGENT_INPUT_CHIP_ICON_SIZE_PX, AGENT_INPUT_CHIP_ICON_STYLE, AGENT_INPUT_MENU_ICON_SIZE_PX } from '@/components/sessions/agentInput/definitions/agentInputChipIconMetrics';
import type { SelectionListStep } from '@/components/ui/selectionList';
import { Icon } from '@/components/ui/icons/Icon';
import { normalizeNodeForView } from '@/components/ui/rendering/normalizeNodeForView';
import { Text } from '@/components/ui/text/Text';
import { t } from '@/text';
import { fireAndForget } from '@/utils/system/fireAndForget';

type ChipParams = Readonly<{
    value: string | null | undefined;
    profiles: readonly Pick<ApprovalProfileV1, 'id' | 'name'>[];
    /** The new Session's Machine and its default profile; null until a Machine is chosen. */
    machineDefault: ApprovalProfileMachineDefault;
    ready: boolean;
    displayReady?: boolean;
    requestCatalog?: () => Promise<void>;
    onChange: (value: string | null) => void;
}>;

const CHIP_KEY = 'new-session-approval-profile';

/** The field's own choices (ApprovalProfileSelect's list) as the chip row's one selection step. */
function buildRootStep(params: ChipParams): SelectionListStep {
    const choices = buildApprovalProfileChoices('session', params.profiles, CHIP_KEY, params.machineDefault);
    return {
        id: `${CHIP_KEY}-root`,
        title: t('workflows.triggers.guided.profile.title'),
        sections: [{ kind: 'static', id: CHIP_KEY, options: choices.map(choice => ({
            id: choice.id, label: choice.title, ...(choice.subtitle ? { subtitle: choice.subtitle } : {}),
            onSelect: () => params.ready ? params.onChange(approvalProfileChoiceValue(choice.id)) : false,
        })) }],
    };
}

function chipLabel(params: ChipParams) {
    return approvalProfileChipLabel({ ...params, ready: params.displayReady ?? params.ready });
}

function requestProfiles(params: ChipParams): void {
    if (params.requestCatalog) fireAndForget(params.requestCatalog(), { tag: 'ApprovalProfileChip.catalog' });
}

const ApprovalProfileChip = React.memo(function ApprovalProfileChip(props: ChipParams & Readonly<{ ctx: AgentInputExtraActionChipRenderContext }>) {
    const [open, setOpen] = React.useState(false);
    const anchorRef = React.useRef<React.ElementRef<typeof View> | null>(null);
    const rootStep = React.useMemo(() => buildRootStep(props), [props.profiles, props.onChange, props.ready, props.value, props.machineDefault]); // eslint-disable-line react-hooks/exhaustive-deps
    const { label, chosen } = chipLabel(props);
    return <>
        <View ref={anchorRef} collapsable={false} style={{ alignSelf: 'flex-start' }}>
            <AgentInputRailChip testID={`${CHIP_KEY}-chip`} onPress={() => {
                if (!open) requestProfiles(props);
                setOpen(current => !current);
            }}
                style={(pressed) => props.ctx.chipStyle(Boolean(pressed))} accessibilityRole="button"
                accessibilityLabel={chosen ? `${t('workflows.triggers.guided.profile.title')}: ${label}` : label}>
                {normalizeNodeForView(<Icon name="list-checks" size={AGENT_INPUT_CHIP_ICON_SIZE_PX} color={props.ctx.iconColor} style={AGENT_INPUT_CHIP_ICON_STYLE} />)}
                {props.ctx.showLabel ? <Text numberOfLines={1} style={props.ctx.textStyle}>{label}</Text> : null}
            </AgentInputRailChip>
        </View>
        <AgentInputSelectionListPopover open={open} anchorRef={anchorRef} rootStep={rootStep}
            selectedOptionId={approvalProfileChoiceId('session', props.value)}
            // Each option's own onSelect applies the choice; the popover owns closing (see the storage chip).
            onSelect={() => {}} onRequestClose={() => setOpen(false)} maxHeightCap={320} />
    </>;
});

/**
 * The approval profile as one chip of the New Session chip row (UI refinements 21:36Z, lab composer P3): it names the
 * profile that applies (chosen, or the Machine's default) and opens the field's own choices; the chip row owns
 * placement and overflow.
 */
export function createApprovalProfileComposerChip(params: ChipParams): AgentInputExtraActionChip {
    const title = t('workflows.triggers.guided.profile.title');
    return {
        key: CHIP_KEY,
        controlId: 'approvalProfile',
        onIntent: () => requestProfiles(params),
        placement: { id: 'approvalProfile', title, icon: 'list-checks', defaultPlacement: 'pinned' },
        collapsedOptionsPopover: {
            presentation: 'list', title, label: chipLabel(params).label,
            icon: (tint) => normalizeNodeForView(<Icon name="list-checks" size={AGENT_INPUT_MENU_ICON_SIZE_PX} color={tint} />),
            rootStep: buildRootStep(params),
            selectedOptionId: approvalProfileChoiceId('session', params.value),
            onSelect: () => {},
            maxHeightCap: 320,
        },
        render: (ctx) => <ApprovalProfileChip {...params} ctx={ctx} />,
    };
}
