import * as React from 'react';
import { useUnistyles } from 'react-native-unistyles';

import type { AgentInputChipPickerOption } from '@/components/sessions/agentInput/components/AgentInputChipPickerTypes';
import { deferAgentInputPopoverClose } from '@/components/sessions/agentInput/selection/deferAgentInputPopoverClose';
import { Icon } from '@/components/ui/icons/Icon';
import { t } from '@/text';

import { RolesRailDetail, RolesRailDetailView, type RolesRailDetailProps } from './RolesRailDetail';
import type { RoleRailItem } from './rolesRailTypes';

export const ROLES_RAIL_PICKER_OPTION_ID = 'roles';

function RolesRailIcon(props: Readonly<{ size?: number }>) {
    const { theme } = useUnistyles();
    return <Icon name="users" size={props.size ?? 12} color={theme.colors.text.primary} />;
}

function RolesRailActiveMark(props: Readonly<{ size?: number }>) {
    const { theme } = useUnistyles();
    return <Icon name="check" size={props.size ?? 14} color={theme.colors.text.primary} />;
}

export type RolesRailPickerOptionParams = Omit<RolesRailDetailProps, 'onChange'> & Readonly<{
    onChange: (roleId: string) => void;
    /**
     * Roles supplied by a caller that already holds them (a workflow draft's portable roles).
     * Omitted, the open rail reads the reader's catalog itself.
     */
    roles?: ReadonlyArray<RoleRailItem>;
}>;

/**
 * The Roles rail: one controlled row at the head of the engine popover. `value` is the role in
 * effect and `onChange` receives the chosen role id; what a choice means (a live session's
 * `session.role.set`, a workflow draft's role arm) belongs to the caller.
 */
export function buildRolesRailPickerOption(params: RolesRailPickerOptionParams): AgentInputChipPickerOption {
    const { onChange, roles, value, describeConsequence, onManageRoles, footer, workflowRoles, serverId } = params;
    return {
        id: ROLES_RAIL_PICKER_OPTION_ID,
        sectionId: ROLES_RAIL_PICKER_OPTION_ID,
        label: t('roles.rail.label'),
        icon: <RolesRailIcon />,
        ...(value !== null ? {
            statusMarker: <RolesRailActiveMark />,
            accessibilityLabel: t('roles.rail.activeAccessibilityLabel'),
        } : {}),
        closeOnSelectImmediate: false,
        preserveFocusOnExternalSelectionChange: true,
        renderDetailContent: ({ onRequestClose }) => {
            const detailProps: RolesRailDetailProps = {
                serverId,
                value,
                workflowRoles,
                describeConsequence,
                footer,
                onManageRoles: onManageRoles === undefined ? undefined : () => {
                    onManageRoles();
                    deferAgentInputPopoverClose(onRequestClose);
                },
                onChange: (roleId) => {
                    onChange(roleId);
                    deferAgentInputPopoverClose(onRequestClose);
                },
            };
            return roles === undefined
                ? <RolesRailDetail {...detailProps} />
                : <RolesRailDetailView {...detailProps} roles={roles} />;
        },
    };
}
