import * as React from 'react';
import { Pressable, View } from 'react-native';
import { type AssignableSessionRole, type AssignableSessionRoleProfileV1 } from '@happier-dev/protocol';

import type { AgentInputExtraActionChip, AgentInputExtraActionChipRenderContext } from '@/components/sessions/agentInput/agentInputContracts';
import { AgentInputSelectionListPopover } from '@/components/sessions/agentInput/components/AgentInputSelectionListPopover';
import type { SelectionListStep } from '@/components/ui/selectionList';
import { normalizeNodeForView } from '@/components/ui/rendering/normalizeNodeForView';
import { Text } from '@/components/ui/text/Text';
import { Icon } from '@/components/ui/icons/Icon';
import { t } from '@/text';
import { resolveAssignableSessionRoleProfileDisplayName } from '@/components/sessions/roles/sessionRoleLabels';
import { listUiAssignableSessionRoleProfiles } from '@/components/sessions/roles/sessionRoleProfileOrder';
import { AGENT_INPUT_CHIP_ICON_SIZE_PX, AGENT_INPUT_CHIP_ICON_STYLE, AGENT_INPUT_MENU_ICON_SIZE_PX } from './agentInputChipIconMetrics';

const NO_ROLE_OPTION_ID = 'none';

function resolveRoleProfileLabel(profile: AssignableSessionRoleProfileV1): string {
    return resolveAssignableSessionRoleProfileDisplayName(profile);
}

function resolveRoleChipLabel(role: AssignableSessionRole | null, profiles: readonly AssignableSessionRoleProfileV1[]): string {
    if (!role) return t('sessionRole.label');
    const profile = profiles.find((candidate) => candidate.id === role);
    return profile ? resolveRoleProfileLabel(profile) : t('sessionRole.label');
}

/** Shared root step for the inline chip and the collapsed action-menu route. */
function buildSessionRoleRootStep(
    profiles: readonly AssignableSessionRoleProfileV1[],
    onRoleChange: (next: AssignableSessionRole | null) => void,
): SelectionListStep {
    return {
        id: 'session-role-root',
        title: t('sessionRole.label'),
        sections: [
            {
                kind: 'static',
                id: 'session-role',
                options: [
                    ...profiles.map((profile) => ({
                        id: profile.id,
                        label: resolveRoleProfileLabel(profile),
                        onSelect: () => onRoleChange(profile.id),
                    })),
                    { id: NO_ROLE_OPTION_ID, label: t('sessionRole.none'), onSelect: () => onRoleChange(null) },
                ],
            },
        ],
    };
}

type SessionRoleChipProps = Readonly<{
    role: AssignableSessionRole | null;
    profiles: readonly AssignableSessionRoleProfileV1[];
    onRoleChange: (next: AssignableSessionRole | null) => void;
    ctx: AgentInputExtraActionChipRenderContext;
}>;

const SessionRoleChip = React.memo(function SessionRoleChip(props: SessionRoleChipProps) {
    const [open, setOpen] = React.useState(false);
    const anchorRef = React.useRef<React.ElementRef<typeof View> | null>(null);
    const rootStep = React.useMemo(() => buildSessionRoleRootStep(props.profiles, props.onRoleChange), [props.onRoleChange, props.profiles]);
    const label = resolveRoleChipLabel(props.role, props.profiles);
    const roleColor = props.profiles.find((profile) => profile.id === props.role)?.color ?? props.ctx.iconColor;

    return (
        <>
            <View ref={anchorRef} collapsable={false} style={{ alignSelf: 'flex-start' }}>
                <Pressable
                    testID="agent-input-session-role-chip"
                    onPress={() => setOpen((current) => !current)}
                    hitSlop={{ top: 5, bottom: 10, left: 0, right: 0 }}
                    style={({ pressed }) => props.ctx.chipStyle(Boolean(pressed))}
                    accessibilityRole="button"
                    accessibilityLabel={`${t('sessionRole.label')}: ${props.role ? label : t('sessionRole.none')}`}
                >
                    {normalizeNodeForView(
                        <Icon name="user-circle" size={AGENT_INPUT_CHIP_ICON_SIZE_PX} color={roleColor} style={AGENT_INPUT_CHIP_ICON_STYLE} />,
                    )}
                    {props.ctx.showLabel ? (
                        <Text numberOfLines={1} style={props.ctx.textStyle}>{label}</Text>
                    ) : null}
                </Pressable>
            </View>
            <AgentInputSelectionListPopover
                open={open}
                anchorRef={anchorRef}
                rootStep={rootStep}
                selectedOptionId={props.role ?? NO_ROLE_OPTION_ID}
                // Per-option onSelect owns the change; the popover owns closing.
                onSelect={() => undefined}
                onRequestClose={() => setOpen(false)}
                maxHeightCap={320}
            />
        </>
    );
});

/** Optional explicit role for a new session; defaults to No role and is never inferred. */
export function createSessionRoleActionChip(params: Readonly<{
    role: AssignableSessionRole | null;
    profiles?: readonly AssignableSessionRoleProfileV1[];
    onRoleChange: (next: AssignableSessionRole | null) => void;
}>): AgentInputExtraActionChip {
    const profiles = params.profiles ?? listUiAssignableSessionRoleProfiles(null);
    const roleColor = profiles.find((profile) => profile.id === params.role)?.color ?? null;
    return {
        key: 'new-session-role',
        controlId: 'sessionRole',
        collapsedOptionsPopover: {
            presentation: 'list',
            title: t('sessionRole.label'),
            label: resolveRoleChipLabel(params.role, profiles),
            icon: (tint) => normalizeNodeForView(<Icon name="user-circle" size={AGENT_INPUT_MENU_ICON_SIZE_PX} color={roleColor ?? tint} />),
            rootStep: buildSessionRoleRootStep(profiles, params.onRoleChange),
            selectedOptionId: params.role ?? NO_ROLE_OPTION_ID,
            // List-mode changes run through each option's onSelect.
            onSelect: () => undefined,
            maxHeightCap: 320,
        },
        render: (ctx) => <SessionRoleChip role={params.role} profiles={profiles} onRoleChange={params.onRoleChange} ctx={ctx} />,
    };
}
