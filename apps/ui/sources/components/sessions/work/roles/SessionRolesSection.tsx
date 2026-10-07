import { happierPageTextMetrics } from '@happier-dev/plugin-ui/presentation';
import * as React from 'react';
import { Platform, View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import {
    readSessionRolesV1,
    type ResolvedRoleV1,
    type RoleArtifactV1,
    type RoleEngineV1,
    type RoleInstructionsOverrideV1,
    type SessionRolesV1,
} from '@happier-dev/protocol';

import { useRoleCatalog } from '@/components/roles/catalog/useRoleCatalog';
import { useRoleEnginePresentation } from '@/components/roles/catalog/useRoleEnginePresentation';
import { RoleEngineField } from '@/components/roles/engine/RoleEngineField';
import { SessionRolePopover, settleSessionRoleWrite, useSessionRoleSelection } from '@/components/roles/session/sessionRole';
import { RowActionRevealSlot } from '@/components/sessions/transcript/messageActions/RowActionRevealSlot';
import { WorkSection } from '@/components/sessions/work/WorkSection';
import { IconButton } from '@/components/ui/buttons/IconButton';
import { RoundButton } from '@/components/ui/buttons/RoundButton';
import { FieldTextInput } from '@/components/ui/forms/FieldTextInput';
import { Icon } from '@/components/ui/icons/Icon';
import { ActionListSection } from '@/components/ui/lists/ActionListSection';
import { Item } from '@/components/ui/lists/Item';
import { SegmentedTabBar } from '@/components/ui/navigation/SegmentedTabBar';
import { FloatingOverlay } from '@/components/ui/overlays/FloatingOverlay';
import { Popover } from '@/components/ui/popover';
import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import type { RoleCatalogEntry } from '@/sync/domains/roles/roleCatalog';
import { useSessionMetadata } from '@/sync/domains/state/storage';
import { sessionAddressKey } from '@/sync/domains/session/sessionAddress';
import { roleActions } from '@/sync/ops/roles/roleActions';
import { t } from '@/text';

const EMPTY_SESSION_ROLES: SessionRolesV1 = { overrides: {}, sessionRoles: {}, notes: '' };

export type SessionRolesSectionProps = Readonly<{
    sessionId: string;
    serverId?: string | null;
    /** Explains where the worker's initial configuration came from, not a write restriction. */
    copiedAtSpawn?: boolean;
}>;

function useSessionRolesConfiguration(sessionId: string, serverId?: string | null): SessionRolesV1 {
    const metadata = useSessionMetadata(sessionId, serverId);
    return React.useMemo(() => readSessionRolesV1(metadata) ?? EMPTY_SESSION_ROLES, [metadata]);
}

/**
 * Work › Roles (lab `convo-W9`): a flat page section of the Work pane. The header is "Roles" · what
 * differs ("2 changed · 2 added") · ⓘ (the scope) · "+"; its rows are only this session's
 * differences from Settings, one line each (name · "changed" or "this session" · engine · runs-as),
 * then "All roles ›", which opens the session's Role popover (with Hands-off at its foot). "+" adds a
 * role or changes one for this session; "Use defaults" and "Apply to sessions under it" are in the
 * Work pane's ⋯ (`SessionWorkMoreMenu`). Mounted by the Work pane's roles slot, below Triggers.
 */
export const SessionRolesSection = React.memo(function SessionRolesSection(props: SessionRolesSectionProps) {
    return <SessionRolesContent key={sessionAddressKey({ sessionId: props.sessionId, serverId: props.serverId ?? '' })} {...props} />;
});

function SessionRolesContent(props: SessionRolesSectionProps) {
    const { sessionId, serverId } = props;
    const sessionRoles = useSessionRolesConfiguration(sessionId, serverId);
    const catalog = useRoleCatalog(serverId);
    const allRolesRef = React.useRef<View>(null);
    const [rolePopoverOpen, setRolePopoverOpen] = React.useState(false);
    const overrides = Object.values(sessionRoles.overrides);
    const sessionOnly = Object.values(sessionRoles.sessionRoles);
    const enabledCount = catalog.entries.filter((entry) => entry.role.enabled).length + sessionOnly.length;
    const summary = [
        ...(overrides.length > 0 ? [t('roles.session.countChanged', { count: overrides.length })] : []),
        ...(sessionOnly.length > 0 ? [t('roles.session.countAdded', { count: sessionOnly.length })] : []),
    ].join(' · ');

    return (
        <WorkSection
            testID="session-work-roles"
            anatomy="page"
            title={t('roles.session.sectionTitle')}
            count={summary}
            info={props.copiedAtSpawn ? t('roles.session.crossOwnerNote') : t('roles.session.info')}
            action={<AddSessionRoleButton sessionId={sessionId} serverId={serverId} sessionRoles={sessionRoles} entries={catalog.entries} />}
        >
            {overrides.map((override) => (
                <SessionRoleDifferenceRow
                    key={`override:${override.roleId}`}
                    sessionId={sessionId}
                    serverId={serverId}
                    kind="changed"
                    roleId={override.roleId}
                    onEngineChange={(engine) => { void setSessionOverride(sessionId, { ...override, engine }, serverId); }}
                />
            ))}
            {sessionOnly.map((role) => (
                <SessionRoleDifferenceRow
                    key={`session:${role.roleId}`}
                    sessionId={sessionId}
                    serverId={serverId}
                    kind="session"
                    roleId={role.roleId}
                    onEngineChange={(engine) => {
                        void roleActions.addSessionRole(sessionId, role.roleId, { ...toArtifact(role), engine }, { serverId }).then(settleSessionRoleWrite);
                    }}
                />
            ))}
            <View ref={allRolesRef} collapsable={false}>
                <Item
                    testID="session-work-roles.all"
                    title={t('roles.session.allRoles')}
                    detail={t('roles.session.inUse', { count: enabledCount })}
                    onPress={() => setRolePopoverOpen(true)}
                />
            </View>
            {rolePopoverOpen ? (
                <SessionRolePopover
                    sessionId={sessionId}
                    serverId={serverId}
                    anchorRef={allRolesRef}
                    onRequestClose={() => setRolePopoverOpen(false)}
                />
            ) : null}
        </WorkSection>
    );
}

/** "Use defaults" and "Apply to sessions under it", for the Work pane's ⋯ menu. */
export function useSessionRolesMenuActions(input: Readonly<{ sessionId: string; serverId?: string | null; hasReports: boolean }>) {
    const sessionRoles = useSessionRolesConfiguration(input.sessionId, input.serverId);
    const hasChanges = Object.keys(sessionRoles.overrides).length > 0 || Object.keys(sessionRoles.sessionRoles).length > 0;
    return React.useMemo(() => {
        return [
            ...(hasChanges ? [{
                id: 'roles.useDefaults',
                title: t('roles.session.useDefaults'),
                onSelect: async () => {
                    // Stop at the first refusal: it is reported once, and what is left stays as it was.
                    for (const roleId of Object.keys(sessionRoles.overrides)) {
                        if (!await settleSessionRoleWrite(await roleActions.clearSessionOverride(input.sessionId, roleId, { serverId: input.serverId }))) return;
                    }
                    for (const roleId of Object.keys(sessionRoles.sessionRoles)) {
                        if (!await settleSessionRoleWrite(await roleActions.removeSessionRole(input.sessionId, roleId, { serverId: input.serverId }))) return;
                    }
                },
            }] : []),
            ...(input.hasReports ? [{
                id: 'roles.applyToReports',
                title: t('roles.session.applyToReports'),
                onSelect: async () => { await settleSessionRoleWrite(await roleActions.applyToReports(input.sessionId, { serverId: input.serverId })); },
            }] : []),
        ];
    }, [hasChanges, input.serverId, input.hasReports, input.sessionId, sessionRoles.overrides, sessionRoles.sessionRoles]);
}

function toArtifact(role: ResolvedRoleV1): RoleArtifactV1 {
    const { roleId: _roleId, changedAt: _changedAt, profileUnavailable: _profileUnavailable, ...artifact } = role;
    return artifact;
}

async function setSessionOverride(sessionId: string, override: RoleInstructionsOverrideV1, serverId?: string | null): Promise<void> {
    const { instructionsOverride: _instructions, ...fields } = override;
    await settleSessionRoleWrite(await roleActions.setSessionOverride(sessionId, fields, { serverId }));
}

/**
 * One difference: name · "changed" (turns into Reset on hover or keyboard focus) or "this session" ·
 * the engine · the runs-as glyph. Name, engine and runs-as are the one resolver's answer for this
 * session (Settings → session), not a local merge.
 */
function SessionRoleDifferenceRow(props: Readonly<{
    sessionId: string;
    serverId?: string | null;
    kind: 'changed' | 'session';
    roleId: string;
    onEngineChange: (engine: RoleEngineV1) => void;
}>) {
    const { theme } = useUnistyles();
    const { selection } = useSessionRoleSelection(props.sessionId, props.roleId, props.serverId);
    const engine = selection?.engine;
    const runsAs = selection?.runsAs.kind ?? 'session';
    const presentEngine = useRoleEnginePresentation(props.serverId);
    const presentation = presentEngine(engine);
    const [hovered, setHovered] = React.useState(false);
    const [focused, setFocused] = React.useState(false);
    // Touch has no hover: Reset stays visible there.
    const revealed = Platform.OS !== 'web' || hovered || focused;
    const reset = () => {
        const write = props.kind === 'changed'
            ? roleActions.clearSessionOverride(props.sessionId, props.roleId, { serverId: props.serverId })
            : roleActions.removeSessionRole(props.sessionId, props.roleId, { serverId: props.serverId });
        void write.then(settleSessionRoleWrite);
    };
    const marker = props.kind === 'changed' ? (
        // Reset stays in the tree and the tab order; its slot reveals it on keyboard focus as well as
        // hover, and reserves its width so "changed" turning into Reset moves nothing.
        <View style={styles.markerSlot}>
            <RowActionRevealSlot
                testID={`session-work-roles.row.${props.roleId}.resetSlot`}
                revealed={revealed}
                onFocus={() => setFocused(true)}
                onBlur={() => setFocused(false)}
            >
                <RoundButton
                    testID={`session-work-roles.row.${props.roleId}.reset`}
                    size="small"
                    display="secondary"
                    title={t('roles.session.reset')}
                    onPress={reset}
                />
            </RowActionRevealSlot>
            {revealed ? null : (
                <View style={styles.markerOverlay}>
                    <Text testID={`session-work-roles.row.${props.roleId}.marker`} style={styles.marker}>{t('roles.session.changed')}</Text>
                </View>
            )}
        </View>
    ) : (
        <Text style={styles.marker}>{t('roles.session.thisSession')}</Text>
    );
    return (
        <Item
            testID={`session-work-roles.row.${props.roleId}`}
            title={selection?.name ?? props.roleId}
            titleAccessory={marker}
            showChevron={false}
            // The engine field is its own control: one activation owner per control.
            rightElementOutsidePressable
            onHoverIn={Platform.OS === 'web' ? () => setHovered(true) : undefined}
            onHoverOut={Platform.OS === 'web' ? () => setHovered(false) : undefined}
            rightElement={(
                <View style={styles.rowControls}>
                    <RoleEngineField
                        serverId={props.serverId}
                        engine={engine}
                        label={presentation.label}
                        leading={presentation.icon}
                        onChange={props.onEngineChange}
                    />
                    <View
                        accessible
                        accessibilityLabel={runsAs === 'session' ? t('roles.settings.runsAsSession') : t('roles.settings.runsAsBackgroundRun')}
                    >
                        <Icon
                            name={runsAs === 'session' ? 'chat' : 'lightning'}
                            size={14}
                            color={theme.colors.text.tertiary}
                        />
                    </View>
                </View>
            )}
        />
    );
}

/** "+": a new role for this session, or change a Settings role for this session only. */
function AddSessionRoleButton(props: Readonly<{
    sessionId: string;
    serverId?: string | null;
    sessionRoles: SessionRolesV1;
    entries: ReadonlyArray<RoleCatalogEntry>;
}>) {
    const anchorRef = React.useRef<View>(null);
    const [mode, setMode] = React.useState<'closed' | 'menu' | 'new'>('closed');
    const close = () => setMode('closed');
    const changeable = props.entries.filter((entry) => !props.sessionRoles.overrides[entry.roleId]);
    return (
        <View ref={anchorRef} collapsable={false}>
            <IconButton
                testID="session-work-roles.add"
                iconName="plus"
                variant="plain"
                accessibilityLabel={t('roles.session.addRole')}
                tooltip={t('roles.session.addRole')}
                onPress={() => setMode('menu')}
            />
            {mode !== 'closed' ? (
                <Popover
                    open
                    anchorRef={anchorRef}
                    placement="bottom"
                    maxWidthCap={420}
                    maxHeightCap={520}
                    autoFocusOnOpen
                    onRequestClose={close}
                    portal={{ web: true, native: true, matchAnchorWidth: false }}
                >
                    {({ maxHeight }) => (
                        <FloatingOverlay maxHeight={maxHeight} scrollEnabled>
                            {mode === 'new' ? (
                                <AddSessionRoleForm sessionId={props.sessionId} serverId={props.serverId} onDone={close} />
                            ) : (
                                <>
                                    <ActionListSection
                                        actions={[{
                                            id: 'new',
                                            testID: 'session-work-roles.add.new',
                                            label: t('roles.session.newRoleForSession'),
                                            onPress: () => setMode('new'),
                                        }]}
                                    />
                                    {changeable.length > 0 ? (
                                        <ActionListSection
                                            title={t('roles.session.changeForSession')}
                                            separatorAbove
                                            actions={changeable.map((entry) => ({
                                                id: entry.roleId,
                                                testID: `session-work-roles.add.change.${entry.roleId}`,
                                                label: entry.role.name,
                                                onPress: () => {
                                                    close();
                                                    void setSessionOverride(props.sessionId, {
                                                        roleId: entry.roleId,
                                                        ...(entry.role.engine ? { engine: entry.role.engine } : {}),
                                                    }, props.serverId);
                                                },
                                            }))}
                                        />
                                    ) : null}
                                </>
                            )}
                        </FloatingOverlay>
                    )}
                </Popover>
            ) : null}
        </View>
    );
}

/** A role that exists only in this session (and the sessions under it). */
function AddSessionRoleForm(props: Readonly<{ sessionId: string; serverId?: string | null; onDone: () => void }>) {
    const presentEngine = useRoleEnginePresentation(props.serverId);
    const [name, setName] = React.useState('');
    const [instructions, setInstructions] = React.useState('');
    const [engine, setEngine] = React.useState<RoleEngineV1 | undefined>(undefined);
    const [runsAs, setRunsAs] = React.useState<'session' | 'background_run'>('session');
    const presentation = presentEngine(engine);
    const add = async () => {
        const roleName = name.trim();
        if (!roleName) return;
        // The form closes only once the role is added; a refusal keeps what was typed for retry.
        const added = await settleSessionRoleWrite(await roleActions.addSessionRole(
            props.sessionId,
            `session:${roleName.toLowerCase().replace(/[^a-z0-9]+/gu, '-')}`,
            {
                name: roleName,
                instructions,
                ...(engine ? { engine } : {}),
                runsAs: runsAs === 'session' ? { kind: 'session' } : { kind: 'background_run', intent: 'task' },
                workspaceWrites: 'allow',
                secondOpinion: 'off',
                enabled: true,
            },
            { serverId: props.serverId },
        ));
        if (added) props.onDone();
    };
    return (
        <View testID="session-work-roles.addForm" style={styles.form}>
            <FieldTextInput
                testID="session-work-roles.addForm.name"
                value={name}
                onChangeText={setName}
                accessibilityLabel={t('roles.settings.nameTitle')}
                placeholder={t('roles.session.namePlaceholder')}
                autoFocus
            />
            <FieldTextInput
                testID="session-work-roles.addForm.instructions"
                value={instructions}
                onChangeText={setInstructions}
                accessibilityLabel={t('roles.settings.instructionsTitle')}
                placeholder={t('roles.session.instructionsPlaceholder')}
                multiline
                minLines={2}
            />
            <View style={styles.formRow}>
                <Text style={styles.formLabel}>{t('roles.settings.engineTitle')}</Text>
                <RoleEngineField serverId={props.serverId} engine={engine} label={presentation.label} leading={presentation.icon} onChange={setEngine} />
            </View>
            <View style={styles.formRow}>
                <Text style={styles.formLabel}>{t('roles.settings.runsAsTitle')}</Text>
                <SegmentedTabBar
                    testIDPrefix="session-work-roles.addForm.runsAs"
                    compact
                    tabs={[
                        { id: 'session', label: t('roles.settings.runsAsSession') },
                        { id: 'background_run', label: t('roles.settings.runsAsBackgroundRun') },
                    ]}
                    activeTabId={runsAs}
                    onSelectTab={(id) => setRunsAs(id === 'background_run' ? 'background_run' : 'session')}
                />
            </View>
            <View style={styles.formActions}>
                <RoundButton size="small" display="secondary" title={t('common.cancel')} onPress={props.onDone} />
                <RoundButton
                    testID="session-work-roles.addForm.submit"
                    size="small"
                    title={t('roles.session.addRoleConfirm')}
                    disabled={!name.trim()}
                    onPress={() => { void add(); }}
                />
            </View>
        </View>
    );
}

const styles = StyleSheet.create((theme) => ({
    // The quiet marker after a role's name ("changed", "this session").
    marker: {
        ...Typography.default(),
        ...happierPageTextMetrics('rowDescription'),
        color: theme.colors.text.tertiary,
    },
    // "changed" sits over Reset's reserved slot until the row is hovered or focused.
    markerSlot: {
        justifyContent: 'center',
    },
    markerOverlay: {
        position: 'absolute',
        top: 0,
        bottom: 0,
        left: 0,
        justifyContent: 'center',
        pointerEvents: 'none',
    },
    rowControls: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 8,
    },
    form: {
        gap: 8,
        padding: 12,
        minWidth: 320,
    },
    formRow: {
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'space-between',
        gap: 8,
    },
    formLabel: {
        fontSize: 13,
        color: theme.colors.text.secondary,
    },
    formActions: {
        flexDirection: 'row',
        justifyContent: 'flex-end',
        gap: 8,
    },
}));
