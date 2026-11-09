import * as React from 'react';
import { joinHappierFacts } from '@happier-dev/plugin-ui/presentation';
import { View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';
import { readSessionRolesV1, type SessionRolesV1 } from '@happier-dev/protocol/prompts/roles/sessionRolesSnapshot';
import type { RoleInstructionsOverrideV1 } from '@happier-dev/protocol/prompts/roles/rolesV1';
import type { RoleEngineV1 } from '@happier-dev/protocol/prompts/roles/roleArtifactV1';
import { resolveRoleRunsAsKindV1 } from '@happier-dev/protocol/prompts/roles/roleArtifactV1';
import { resolvedRoleToArtifact, roleDisplayName } from '@/sync/domains/roles/roleCatalog';
import { describeRoleRunsAs } from '@/components/roles/catalog/rolePresentation';

import { useRoleCatalog } from '@/components/roles/catalog/useRoleCatalog';
import { useRoleEnginePresentation } from '@/components/roles/catalog/useRoleEnginePresentation';
import { RoleEngineField, RoleEnginePicker } from '@/components/roles/engine/RoleEngineField';
import { buildSessionRoleInventory } from './sessionRoleInventory';
import { SessionRolePopover, settleSessionRoleWrite, useSessionRoleDefaultEngine, useSessionRoleSelection } from '@/components/roles/session/sessionRole';
import { WorkSection, WorkSectionDescription } from '@/components/sessions/work/WorkSection';
import { IconButton } from '@/components/ui/buttons/IconButton';
import { RoundButton } from '@/components/ui/buttons/RoundButton';
import { TextLinkButton } from '@/components/ui/buttons/TextLinkButton';
import { FieldTextInput } from '@/components/ui/forms/FieldTextInput';
import { ActionListSection } from '@/components/ui/lists/ActionListSection';
import { Item } from '@/components/ui/lists/Item';
import { SegmentedChoiceItem } from '@/components/ui/lists/SegmentedChoiceItem';
import { SegmentedTabBar } from '@/components/ui/navigation/SegmentedTabBar';
import { FloatingOverlay } from '@/components/ui/overlays/FloatingOverlay';
import { Popover } from '@/components/ui/popover';
import { Text } from '@/components/ui/text/Text';
import type { RoleCatalogEntry } from '@/sync/domains/roles/roleCatalog';
import { useSessionSelector, useSetting } from '@/sync/domains/state/storage';
import { readSessionOwnerMetadataView } from '@/sync/domains/session/readSessionOwnerMetadataView';
import { sessionAddressKey } from '@/sync/domains/session/sessionAddress';
import { roleActions } from '@/sync/ops/roles/roleActions';
import { randomUUID } from '@/platform/randomUUID';
import { t } from '@/text';

const EMPTY_SESSION_ROLES: SessionRolesV1 = { overrides: {}, sessionRoles: {}, notes: '' };

export type SessionRolesSectionProps = Readonly<{
    sessionId: string;
    serverId?: string | null;
    /** Explains where the worker's initial configuration came from, not a write restriction. */
    copiedAtSpawn?: boolean;
}>;

function useSessionRolesConfiguration(sessionId: string, serverId?: string | null): SessionRolesV1 {
    const metadata = useSessionSelector(sessionId, serverId, session => session ? readSessionOwnerMetadataView(session) : null);
    return React.useMemo(() => readSessionRolesV1(metadata) ?? EMPTY_SESSION_ROLES, [metadata]);
}

/**
 * Session Info › Setup › Roles (calm-shell lab csinfo I2). Closed, the row says what differs ("1 changed
 * · 1 added"); open, it reads: the scope ("Roles apply to this session and the sessions under it."),
 * only this session's differences from Settings (name, then a quiet line "Changed here · Codex · …"
 * with Reset trailing; the row opens the role's engine), the session's Approval reviewer (Default · On ·
 * Off; Default follows the Account setting), then
 * "All roles ›", which opens the session's Role popover (with Hands-off at its foot). "+" adds a role
 * or changes one for this session; "Use defaults" and "Apply to sessions under it" are in the Work
 * pane header's ⋯ (`useSessionWorkMenuActions`).
 */
export const SessionRolesSection = React.memo(function SessionRolesSection(props: SessionRolesSectionProps) {
    return <SessionRolesContent key={sessionAddressKey({ sessionId: props.sessionId, serverId: props.serverId ?? '' })} {...props} />;
});

function SessionRolesContent(props: SessionRolesSectionProps) {
    const { sessionId, serverId } = props;
    const sessionRoles = useSessionRolesConfiguration(sessionId, serverId);
    const defaultEngine = useSessionRoleDefaultEngine(sessionId, serverId);
    const catalog = useRoleCatalog(serverId);
    const allRolesRef = React.useRef<View>(null);
    const [rolePopoverOpen, setRolePopoverOpen] = React.useState(false);
    const catalogKnown = catalog.status === 'ready' || catalog.entries.length > 0;
    const inventory = React.useMemo(
        () => buildSessionRoleInventory({ entries: catalog.entries, catalogKnown, sessionRoles, defaultEngine }),
        [catalog.entries, catalogKnown, sessionRoles, defaultEngine],
    );
    const differences = inventory.filter(role => role.kind !== null);
    const differenceIds = new Set(differences.map(role => role.roleId));
    const changedCount = differences.filter(role => role.kind === 'changed').length;
    const addedCount = differences.filter(role => role.kind === 'session').length;
    const enabledCount = inventory.filter(role => role.enabled).length;
    const summary = joinHappierFacts(...[
        ...(changedCount > 0 ? [t('roles.session.countChanged', { count: changedCount })] : []),
        ...(addedCount > 0 ? [t('roles.session.countAdded', { count: addedCount })] : []),
    ]);

    return (
        <WorkSection
            testID="session-work-roles"
            icon="users"
            anatomy="page"
            title={t('roles.session.sectionTitle')}
            count={summary}
            action={<AddSessionRoleButton sessionId={sessionId} serverId={serverId}
                entries={catalog.entries.filter(entry => !differenceIds.has(entry.roleId))} />}
        >
            <WorkSectionDescription testID="session-work-roles.description">
                {props.copiedAtSpawn ? `${t('roles.session.info')} ${t('roles.session.crossOwnerNote')}` : t('roles.session.info')}
            </WorkSectionDescription>
            {differences.map((role) => (
                <SessionRoleDifferenceRow
                    key={role.roleId}
                    sessionId={sessionId}
                    serverId={serverId}
                    kind={role.kind!}
                    reset={role.reset}
                    roleId={role.roleId}
                    onEngineChange={(engine) => {
                        if (role.override || role.kind === 'changed') {
                            void setSessionOverride(sessionId, { ...role.override, roleId: role.roleId, engine }, serverId);
                        } else if (role.snapshot) {
                            void roleActions.addSessionRole(sessionId, role.roleId, { ...resolvedRoleToArtifact(role.snapshot), engine }, { serverId }).then(settleSessionRoleWrite);
                        }
                    }}
                />
            ))}
            <SessionApprovalReviewerRow sessionId={sessionId} serverId={serverId} />
            <View ref={allRolesRef} collapsable={false}>
                <Item
                    testID="session-work-roles.all"
                    title={t('roles.session.allRoles')}
                    detail={catalog.status === 'loading' ? t('common.loading') : catalog.status === 'failed' ? t('roles.settings.loadFailed')
                        : t('roles.session.inUse', { count: enabledCount })}
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

async function setSessionOverride(sessionId: string, override: RoleInstructionsOverrideV1, serverId?: string | null): Promise<void> {
    const { instructionsOverride: _instructions, ...fields } = override;
    await settleSessionRoleWrite(await roleActions.setSessionOverride(sessionId, fields, { serverId }));
}

/**
 * One difference (lab csinfo I2): the role's name, then one quiet line — where it differs ("Changed
 * here" / "Added here"), its engine, and "runs in the background" when it does — with Reset trailing
 * a changed role. The row opens the role's engine picker. Name, engine and runs-as are the one
 * resolver's answer for this session (Settings → session), not a local merge.
 */
function SessionRoleDifferenceRow(props: Readonly<{
    sessionId: string;
    serverId?: string | null;
    kind: 'changed' | 'session';
    reset: 'override' | 'snapshot';
    roleId: string;
    onEngineChange: (engine: RoleEngineV1) => void;
}>) {
    const { selection } = useSessionRoleSelection(props.sessionId, props.roleId, props.serverId);
    const engine = selection?.engine;
    const presentEngine = useRoleEnginePresentation(props.serverId);
    const presentation = presentEngine(engine);
    const anchorRef = React.useRef<View>(null);
    const [engineOpen, setEngineOpen] = React.useState(false);
    const reset = () => {
        const write = props.reset === 'override'
            ? roleActions.clearSessionOverride(props.sessionId, props.roleId, { serverId: props.serverId })
            : roleActions.removeSessionRole(props.sessionId, props.roleId, { serverId: props.serverId });
        void write.then(settleSessionRoleWrite);
    };
    const facts = joinHappierFacts(...[
        t(props.kind === 'changed' ? 'roles.session.changedHere' : 'roles.session.addedHere'),
        ...(presentation.label ? [presentation.label] : []),
        ...(selection?.runsAs.kind === 'background_run' ? [t('roles.session.runsInBackground')] : []),
    ]);
    return (
        <View ref={anchorRef} collapsable={false}>
            <Item
                testID={`session-work-roles.row.${props.roleId}`}
                title={selection?.name ?? props.roleId}
                subtitle={facts}
                subtitleTestID={`session-work-roles.row.${props.roleId}.facts`}
                showChevron={false}
                accessibilityHint={t('roles.rail.chooseEngine')}
                onPress={() => setEngineOpen(true)}
                // Reset is its own control beside the row's press target: one activation owner per control.
                rightElementOutsidePressable
                rightElement={props.kind === 'changed' ? (
                    <TextLinkButton
                        testID={`session-work-roles.row.${props.roleId}.reset`}
                        label={t('roles.session.reset')}
                        accessibilityLabel={`${t('roles.session.reset')}: ${selection?.name ?? props.roleId}`}
                        onPress={reset}
                    />
                ) : undefined}
            />
            {engineOpen ? (
                <RoleEnginePicker
                    serverId={props.serverId}
                    anchorRef={anchorRef}
                    engine={engine}
                    onChange={props.onEngineChange}
                    onRequestClose={() => setEngineOpen(false)}
                />
            ) : null}
        </View>
    );
}

/**
 * The session's Approval reviewer (ORC R-14): Default · On · Off over `session.approval_reviewer.set`.
 * Default clears the session's own choice (`enabled: null`), so the session follows the Account
 * default (Settings › Delegation) again, including later changes to it — the same fallback the CLI
 * permission handler reads. The line under the name says which one applies and what it resolves to.
 */
type ApprovalReviewerChoice = 'default' | 'on' | 'off';

function SessionApprovalReviewerRow(props: Readonly<{ sessionId: string; serverId?: string | null }>) {
    const sessionValue = useSessionSelector(props.sessionId, props.serverId, (session) => {
        const value = session ? readSessionOwnerMetadataView(session)?.approvalReviewerEnabled : undefined;
        return typeof value === 'boolean' ? value : null;
    });
    const accountDefault = t(useSetting('approvalReviewerEnabled') === true ? 'common.on' : 'common.off');
    const value: ApprovalReviewerChoice = sessionValue === null ? 'default' : sessionValue ? 'on' : 'off';
    const [pending, setPending] = React.useState(false);
    const choose = async (next: ApprovalReviewerChoice) => {
        if (next === value || pending) return;
        setPending(true);
        try {
            const enabled = next === 'default' ? null : next === 'on';
            await settleSessionRoleWrite(await roleActions.setApprovalReviewer(props.sessionId, enabled, { serverId: props.serverId }));
        } finally {
            setPending(false);
        }
    };
    return (
        <SegmentedChoiceItem<ApprovalReviewerChoice>
            testID="session-work-roles.approvalReviewer"
            testIDPrefix="session-work-roles.approvalReviewer"
            title={t('roles.delegation.approvalReviewer')}
            subtitle={sessionValue === null
                ? t('roles.session.approvalReviewerFollowsDefault', { value: accountDefault })
                : t('roles.session.approvalReviewerOverride', { value: accountDefault })}
            subtitleTestID="session-work-roles.approvalReviewer.state"
            accessibilityHint={t('roles.delegation.approvalReviewerDescription')}
            options={[
                { id: 'default', label: t('common.default') },
                { id: 'on', label: t('common.on') },
                { id: 'off', label: t('common.off') },
            ]}
            value={value}
            disabled={pending}
            onChange={(next) => { void choose(next); }}
        />
    );
}

/** "+": a new role for this session, or change a Settings role for this session only. */
function AddSessionRoleButton(props: Readonly<{
    sessionId: string;
    serverId?: string | null;
    entries: ReadonlyArray<RoleCatalogEntry>;
}>) {
    const anchorRef = React.useRef<View>(null);
    const [mode, setMode] = React.useState<'closed' | 'menu' | 'new'>('closed');
    const [changingRoleId, setChangingRoleId] = React.useState<string | null>(null);
    const close = () => setMode('closed');
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
                                    {props.entries.length > 0 ? (
                                        <ActionListSection
                                            title={t('roles.session.changeForSession')}
                                            separatorAbove
                                            actions={props.entries.map((entry) => ({
                                                id: entry.roleId,
                                                testID: `session-work-roles.add.change.${entry.roleId}`,
                                                label: roleDisplayName(entry.role),
                                                onPress: () => {
                                                    close();
                                                    setChangingRoleId(entry.roleId);
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
            {changingRoleId ? <SessionRoleChangePicker sessionId={props.sessionId} serverId={props.serverId}
                roleId={changingRoleId} anchorRef={anchorRef} onRequestClose={() => setChangingRoleId(null)} /> : null}
        </View>
    );
}

/** Resolve the selected Role only while its existing engine picker is open. */
function SessionRoleChangePicker(props: Readonly<{
    sessionId: string;
    serverId?: string | null;
    roleId: string;
    anchorRef: React.RefObject<View | null>;
    onRequestClose: () => void;
}>) {
    const { selection, sessionRoles } = useSessionRoleSelection(props.sessionId, props.roleId, props.serverId);
    return <RoleEnginePicker serverId={props.serverId} anchorRef={props.anchorRef} engine={selection?.engine}
        onRequestClose={props.onRequestClose}
        onChange={engine => { void setSessionOverride(props.sessionId, {
            ...sessionRoles?.overrides[props.roleId], roleId: props.roleId, engine,
        }, props.serverId); }} />;
}

/** A role that exists only in this session (and the sessions under it). */
function AddSessionRoleForm(props: Readonly<{ sessionId: string; serverId?: string | null; onDone: () => void }>) {
    const presentEngine = useRoleEnginePresentation(props.serverId);
    const [roleId] = React.useState(() => `session:${randomUUID()}`);
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
            roleId,
            {
                name: roleName,
                instructions,
                ...(engine ? { engine } : {}),
                runsAs: resolveRoleRunsAsKindV1(runsAs),
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
                <Text variant="meta" style={styles.formLabel}>{t('roles.settings.engineTitle')}</Text>
                <RoleEngineField serverId={props.serverId} engine={engine} label={presentation.label} leading={presentation.icon} onChange={setEngine} />
            </View>
            <View style={styles.formRow}>
                <Text variant="meta" style={styles.formLabel}>{t('roles.settings.runsAsTitle')}</Text>
                <SegmentedTabBar
                    testIDPrefix="session-work-roles.addForm.runsAs"
                    compact
                    tabs={[
                        { id: 'session', label: describeRoleRunsAs('session') },
                        { id: 'background_run', label: describeRoleRunsAs('background_run') },
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
    form: {
        gap: theme.space.s8,
        padding: theme.space.s12,
        minWidth: 320,
    },
    formRow: {
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'space-between',
        gap: theme.space.s8,
    },
    formLabel: {
        color: theme.colors.text.secondary,
    },
    formActions: {
        flexDirection: 'row',
        justifyContent: 'flex-end',
        gap: theme.space.s8,
    },
}));
