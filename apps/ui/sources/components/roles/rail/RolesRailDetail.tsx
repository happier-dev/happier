import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';

import { OptionPickerOverlay, type OptionPickerOption } from '@/components/sessions/pickers/OptionPickerOverlay';
import { HappierPressable } from '@happier-dev/plugin-ui/presentation';
import { Text } from '@/components/ui/text/Text';
import { t } from '@/text';

import type { RoleRailItem } from './rolesRailTypes';
import type { WorkflowRoleV1 } from '@happier-dev/protocol';
import { useRoleRailItems } from './useRoleRailItems';

export type RolesRailDetailProps = Readonly<{
    /** The role in effect, or null for none. Controlled: the rail never moves its own check. */
    value: string | null;
    workflowRoles?: readonly WorkflowRoleV1[];
    onChange: (roleId: string) => void;
    /**
     * The one consequence a caller knows and the rail does not — in a live session, a role on
     * another agent "Starts a new session". Null when choosing it changes nothing else.
     */
    describeConsequence?: (item: RoleRailItem) => string | null;
    onManageRoles?: () => void;
    /** A caller's row under the grid (a live session's Hands-off switch for its current role). */
    footer?: React.ReactNode;
}>;

/**
 * The Roles rail's detail pane: every role the reader can use, as the engine popover's grid.
 * The catalog is read here, in the open leaf, so a closed composer chip never subscribes to it.
 */
export function RolesRailDetail(props: RolesRailDetailProps) {
    const roles = useRoleRailItems(props.workflowRoles);
    return <RolesRailDetailView {...props} roles={roles} />;
}

export function RolesRailDetailView(props: RolesRailDetailProps & Readonly<{ roles: ReadonlyArray<RoleRailItem> }>) {
    const { describeConsequence, onChange, roles, value } = props;
    const options = React.useMemo<ReadonlyArray<OptionPickerOption>>(() => roles.map((item) => {
        const consequence = describeConsequence?.(item) ?? null;
        const engineLine = [item.engineLabel ?? t('roles.rail.defaultEngine'), consequence]
            .filter((part): part is string => Boolean(part))
            .join(' · ');
        return {
            value: item.roleId,
            label: item.name,
            description: `${item.purpose}\n${engineLine}`,
            descriptionContent: (
                <RoleRailCardDescription purpose={item.purpose} engineLine={engineLine} engineIcon={item.engineIcon} />
            ),
        };
    }), [describeConsequence, roles]);
    const selected = value === null ? null : roles.find((item) => item.roleId === value) ?? null;
    const effectiveLabel = selected
        ? [selected.name, selected.engineLabel].filter(Boolean).join(' · ')
        : undefined;

    return (
        <View testID="roles-rail-detail" style={styles.container}>
            <OptionPickerOverlay
                title={t('roles.rail.title')}
                effectiveLabel={effectiveLabel}
                options={options}
                selectedValue={value ?? ''}
                onSelect={onChange}
                emptyText={t('roles.rail.empty')}
                searchPlaceholder={t('roles.rail.searchPlaceholder')}
                optionTestIDPrefix="roles-rail-option"
                canEnterCustomValue={false}
                multiColumn
                fillAvailableSpace
            />
            {props.footer ? <View testID="roles-rail-detail.footer">{props.footer}</View> : null}
            <View style={styles.footer}>
                <Text style={styles.footerText}>{t('roles.rail.footer')}</Text>
                {props.onManageRoles ? (
                    <HappierPressable
                        testID="roles-rail-manage"
                        accessibilityRole="link"
                        onPress={props.onManageRoles}
                        style={styles.manage}
                    >
                        <Text style={styles.manageText}>{t('roles.rail.manage')}</Text>
                    </HappierPressable>
                ) : null}
            </View>
        </View>
    );
}

function RoleRailCardDescription(props: Readonly<{ purpose: string; engineLine: string; engineIcon?: React.ReactNode }>) {
    return (
        <View style={styles.description}>
            {props.purpose ? <Text style={styles.purpose} numberOfLines={2}>{props.purpose}</Text> : null}
            <View style={styles.engineRow}>
                {props.engineIcon ? <View style={styles.engineIcon}>{props.engineIcon}</View> : null}
                <Text style={styles.engineText} numberOfLines={1}>{props.engineLine}</Text>
            </View>
        </View>
    );
}

const styles = StyleSheet.create((theme) => ({
    container: {
        flex: 1,
        minHeight: 0,
    },
    description: {
        gap: 4,
    },
    purpose: {
        fontSize: 12,
        color: theme.colors.text.secondary,
    },
    engineRow: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 6,
    },
    engineIcon: {
        width: 12,
        height: 12,
        alignItems: 'center',
        justifyContent: 'center',
    },
    engineText: {
        fontSize: 12,
        color: theme.colors.text.primary,
    },
    footer: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 12,
        paddingTop: 10,
        borderTopWidth: StyleSheet.hairlineWidth,
        borderTopColor: theme.colors.border.default,
    },
    footerText: {
        flex: 1,
        fontSize: 12,
        color: theme.colors.text.secondary,
    },
    manage: {
        paddingVertical: 6,
    },
    manageText: {
        fontSize: 13,
        color: theme.colors.text.primary,
    },
}));
