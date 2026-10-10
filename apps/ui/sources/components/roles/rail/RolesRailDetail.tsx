import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';

import { OptionPickerOverlay, type OptionPickerOption } from '@/components/sessions/pickers/OptionPickerOverlay';
import { HappierPressable, joinHappierFacts } from '@happier-dev/plugin-ui/presentation';
import { Text } from '@/components/ui/text/Text';
import { t } from '@/text';

import type { RoleRailItem } from './rolesRailTypes';
import type { WorkflowRoleV1 } from '@happier-dev/protocol';
import { readSessionRolesV1 } from '@happier-dev/protocol/prompts/roles/sessionRolesSnapshot';
import { useSessionMetadata } from '@/sync/domains/state/storage';
import { useRoleRailCatalog } from './useRoleRailItems';

export type RolesRailDetailProps = Readonly<{
    serverId?: string | null;
    /** The role in effect, or null for none. Controlled: the rail never moves its own check. */
    value: string | null;
    workflowRoles?: readonly WorkflowRoleV1[];
    /** Session detail is read only while this rail is open. */
    sessionId?: string;
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
    const metadata = useSessionMetadata(props.sessionId ?? '', props.serverId);
    const sessionRoles = React.useMemo(() => props.sessionId ? readSessionRolesV1(metadata) ?? undefined : undefined, [metadata, props.sessionId]);
    const catalog = useRoleRailCatalog(props.workflowRoles, props.serverId, sessionRoles, props.sessionId !== undefined);
    return <RolesRailDetailView {...props} roles={catalog.items} status={catalog.status} />;
}

export function RolesRailDetailView(props: RolesRailDetailProps & Readonly<{ roles: ReadonlyArray<RoleRailItem>; status?: 'loading' | 'ready' | 'failed' }>) {
    const { describeConsequence, onChange, onManageRoles, roles, value } = props;
    const options = React.useMemo<ReadonlyArray<OptionPickerOption>>(() => roles.map((item) => {
        // A role that cannot be chosen as it stands keeps its place and says why, with its way out:
        // an engine this Account has not enabled is chosen in Manage roles; a role no layer resolves
        // any more has none here.
        const reason = item.unavailable === 'role' ? t('roles.rail.unavailableRole')
            : item.unavailable === 'engine' ? t('roles.rail.chooseEngine') : null;
        const consequence = reason ?? describeConsequence?.(item) ?? null;
        // A role that names no engine runs on the agent it is started with: saying "Default agent" on
        // every such card says nothing. The engine is named only when the role pins one.
        const engineLine = joinHappierFacts(item.engineLabel, consequence);
        const recover = item.unavailable === 'engine' ? onManageRoles : undefined;
        return {
            value: item.roleId,
            label: item.name,
            description: [item.purpose, engineLine].filter(Boolean).join('\n'),
            descriptionContent: (
                <RoleRailCardDescription purpose={item.purpose} engineLine={engineLine} engineIcon={item.engineIcon} />
            ),
            ...(recover ? { onActivate: recover } : item.unavailable ? { disabled: true } : {}),
        };
    }), [describeConsequence, onManageRoles, roles]);
    const selected = value === null ? null : roles.find((item) => item.roleId === value) ?? null;
    const effectiveLabel = selected
        ? joinHappierFacts(selected.name, selected.engineLabel)
        : undefined;

    return (
        <View testID="roles-rail-detail" style={styles.container}>
            <OptionPickerOverlay
                title={t('roles.rail.title')}
                effectiveLabel={effectiveLabel}
                options={options}
                selectedValue={value ?? ''}
                onSelect={onChange}
                // No roles at all is an empty state that says how to add one, never "no match" (DESIGN-9 N50).
                emptyText={t(props.status === 'loading' ? 'common.loading' : props.status === 'failed' ? 'roles.settings.loadFailed'
                    : props.onManageRoles ? 'roles.rail.emptyWithManage' : 'roles.rail.empty')}
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
            {props.engineLine ? (
                <View style={styles.engineRow}>
                    {props.engineIcon ? <View style={styles.engineIcon}>{props.engineIcon}</View> : null}
                    <Text style={styles.engineText} numberOfLines={1}>{props.engineLine}</Text>
                </View>
            ) : null}
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
    // On the grid's own inset (the picker's title and cards start 7 px in), so the note and
    // "Manage roles" line up with the title above them and never run into the frame's edge.
    footer: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 12,
        paddingHorizontal: 7,
        paddingTop: 10,
        borderTopWidth: StyleSheet.hairlineWidth,
        borderTopColor: theme.colors.border.default,
    },
    footerText: {
        flex: 1,
        minWidth: 0,
        fontSize: 12,
        color: theme.colors.text.secondary,
    },
    manage: {
        flexShrink: 0,
        paddingVertical: 6,
    },
    manageText: {
        fontSize: 13,
        color: theme.colors.text.primary,
    },
}));
