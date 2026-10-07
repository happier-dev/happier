import * as React from 'react';
import { View } from 'react-native';
import { useRouter } from 'expo-router';
import { readSessionRoleIdV1, readSessionRolesV1 } from '@happier-dev/protocol/prompts/roles/sessionRolesSnapshot';
import { resolveRoleSelectionV1 } from '@happier-dev/protocol/prompts/roles/resolveRoleSelectionV1';
import type { ResolvedRoleV1 } from '@happier-dev/protocol/prompts/roles/rolesV1';
import type { RoleArtifactV1 } from '@happier-dev/protocol/prompts/roles/roleArtifactV1';

import { resolveBackendTargetKeyV2 } from '@/agents/backendCatalog/backendTargetKeyV2';
import { useRoleCatalog } from '@/components/roles/catalog/useRoleCatalog';
import { RolesRailDetail } from '@/components/roles/rail/RolesRailDetail';
import type { RolesRailPickerOptionParams } from '@/components/roles/rail/buildRolesRailPickerOption';
import type { RoleRailItem } from '@/components/roles/rail/rolesRailTypes';
import { Switch } from '@/components/ui/forms/Switch';
import { Item } from '@/components/ui/lists/Item';
import { Popover } from '@/components/ui/popover';
import { FloatingOverlay } from '@/components/ui/overlays/FloatingOverlay';
import { Modal } from '@/modal';
import {
    resolveSessionActionDefaultBackend,
    resolveSessionActionDefaultTarget,
} from '@/sync/domains/session/resolveSessionActionDefaultBackend';
import { useSessionSelector, useSessionMetadata } from '@/sync/domains/state/storage';
import { roleActions } from '@/sync/ops/roles/roleActions';
import { t } from '@/text';
import type { Session } from '@/sync/domains/state/storageTypes';
import { isSessionAccessOwner } from '@/sync/engine/sessions/normalizeSessionAccessProjection';
import { areServerProfileIdentifiersEquivalent } from '@/sync/domains/server/serverProfiles';

/** Inheritance alone does not make a same-owner worker's configuration read-only. */
export function isSessionRoleSnapshotCopiedAcrossOwners(session: Session | null, lead: Session | null, accountId: string | null): boolean {
    const inheritedFrom = readSessionRolesV1(session?.metadata)?.inheritedFrom;
    if (!session || !lead || inheritedFrom !== lead.id || !session.serverId || !lead.serverId
        || !areServerProfileIdentifiersEquivalent(session.serverId, lead.serverId)) return false;
    const owner = (row: Session) => row.owner ?? (isSessionAccessOwner(row.access, row.accessLevel) ? accountId : null);
    const workerOwner = owner(session);
    const leadOwner = owner(lead);
    return workerOwner !== null && leadOwner !== null && workerOwner !== leadOwner;
}

/** The session's own role id, as a primitive: closed chrome re-renders only when the role changes. */
export function useSessionRoleId(sessionId: string, serverId?: string | null): string | null {
    return useSessionSelector(sessionId, serverId, (session) => readSessionRoleIdV1(session?.metadata ?? null));
}

/**
 * The Agent target this session runs on, as a primitive, through the session-action default owner
 * (the same resolvers the composer uses). Read only by an open Role popover: a role on another Agent
 * explains that its engine applies when starting the role. The session already runs on its Agent,
 * so no enabled-Agents filter.
 */
function useSessionAgentTargetKey(sessionId: string, serverId?: string | null): string | null {
    return useSessionSelector(sessionId, serverId, (session) => {
        const target = resolveSessionActionDefaultTarget(resolveSessionActionDefaultBackend({
            session,
        }));
        return target ? resolveBackendTargetKeyV2(target) : null;
    });
}

/**
 * Settles one session-role write: a refusal is reported, and the answer says whether the write landed.
 * An editor closes (and drops what was typed) only on `true`; on `false` it keeps the draft for retry.
 */
export async function settleSessionRoleWrite(result: Readonly<{ ok: boolean; error?: string }>): Promise<boolean> {
    if (result.ok) return true;
    await Modal.alertAsync(t('roles.session.saveFailed'), result.error ?? '');
    return false;
}

function toArtifact(role: ResolvedRoleV1): RoleArtifactV1 {
    const { roleId: _roleId, changedAt: _changedAt, profileUnavailable: _profileUnavailable, ...artifact } = role;
    return artifact;
}

/**
 * One role of this session as the one resolver answers it (Settings → session): its name, engine and
 * hands-off. Null while the role is unknown or unresolvable here. The Work tab's Role row and the
 * popover's Hands-off switch read the same answer.
 */
export function useSessionRoleSelection(sessionId: string, roleId: string | null, serverId?: string | null): Readonly<{
    sessionRoles: ReturnType<typeof readSessionRolesV1>;
    selection: ResolvedRoleV1 | null;
}> {
    const metadata = useSessionMetadata(sessionId, serverId);
    const sessionRoles = React.useMemo(() => readSessionRolesV1(metadata), [metadata]);
    const catalog = useRoleCatalog(serverId);
    const entry = roleId ? catalog.entries.find((candidate) => candidate.roleId === roleId) : undefined;
    const selection = React.useMemo(() => {
        if (!roleId) return null;
        const resolved = resolveRoleSelectionV1({
            roleId,
            settingsRoles: entry ? { [roleId]: toArtifact(entry.role) } : {},
            settingsOverrides: entry?.override ? { [roleId]: entry.override } : {},
            ...(sessionRoles ? { sessionRoles } : {}),
        });
        return resolved.ok ? resolved.selection : null;
    }, [entry, roleId, sessionRoles]);
    return { sessionRoles, selection };
}

/**
 * Hands-off for the session's own role, in the Role popover. The value is the one resolver's answer
 * (Settings → session); switching writes the session override. A user may relax an agent-set deny;
 * an agent that tries is refused by the Action host (`workspace_write_escalation_denied`).
 */
export function SessionHandsOffRow(props: Readonly<{ sessionId: string; serverId?: string | null; roleId: string }>) {
    const { sessionRoles, selection } = useSessionRoleSelection(props.sessionId, props.roleId, props.serverId);
    if (!selection) return null;
    const handsOff = selection.workspaceWrites === 'deny';
    return (
        <Item
            testID="session-role.handsOff"
            title={t('roles.session.handsOffTitle')}
            subtitle={t('roles.session.handsOffDescription')}
            density="compact"
            showChevron={false}
            rightElement={(
                <Switch
                    value={handsOff}
                    onValueChange={(on) => {
                        const existing = sessionRoles?.overrides[props.roleId];
                        const { instructionsOverride: _instructions, ...fields } = existing ?? { roleId: props.roleId };
                        void roleActions.setSessionOverride(props.sessionId, {
                            ...fields,
                            roleId: props.roleId,
                            workspaceWrites: on ? 'deny' : 'allow',
                        }, { serverId: props.serverId }).then(settleSessionRoleWrite);
                    }}
                />
            )}
        />
    );
}

/**
 * The Roles rail for one live session — the same controlled rail the composer and the Work tab's
 * Role popover show. Choosing writes `session.role.set`; a role on another Agent explains that its
 * engine applies when starting the role; Hands-off for the current role sits at the foot.
 */
export function useSessionRolesRailParams(input: Readonly<{
    sessionId: string;
    serverId?: string | null;
    currentAgentTargetKey: string | null;
}>): RolesRailPickerOptionParams {
    const { sessionId, serverId, currentAgentTargetKey } = input;
    const router = useRouter();
    const value = useSessionRoleId(sessionId, serverId);
    const onChange = React.useCallback((roleId: string) => {
        void roleActions.setSessionRole(sessionId, roleId, { serverId }).then(settleSessionRoleWrite);
    }, [sessionId, serverId]);
    const describeConsequence = React.useCallback((item: RoleRailItem) => (
        item.agentTargetKey && currentAgentTargetKey && item.agentTargetKey !== currentAgentTargetKey
            ? t('roles.rail.engineAppliesOnStart')
            : null
    ), [currentAgentTargetKey]);
    const onManageRoles = React.useCallback(() => { router.push('/settings/roles' as never); }, [router]);
    return React.useMemo(() => ({
        serverId,
        value,
        onChange,
        describeConsequence,
        onManageRoles,
        footer: value ? <SessionHandsOffRow sessionId={sessionId} serverId={serverId} roleId={value} /> : undefined,
    }), [describeConsequence, onChange, onManageRoles, sessionId, serverId, value]);
}

/**
 * The Role popover: the session's Roles rail anchored to a row (the Work tab's "All roles ›"), with
 * Hands-off for the session's role at its foot.
 */
export function SessionRolePopover(props: Readonly<{
    sessionId: string;
    serverId?: string | null;
    anchorRef: React.RefObject<View | null>;
    onRequestClose: () => void;
}>) {
    const currentAgentTargetKey = useSessionAgentTargetKey(props.sessionId, props.serverId);
    const params = useSessionRolesRailParams({ sessionId: props.sessionId, serverId: props.serverId, currentAgentTargetKey });
    return (
        <Popover
            open
            anchorRef={props.anchorRef}
            placement="bottom"
            maxWidthCap={560}
            maxHeightCap={560}
            autoFocusOnOpen
            onRequestClose={props.onRequestClose}
            portal={{ web: true, native: true, matchAnchorWidth: false }}
        >
            {({ maxHeight }) => (
                <FloatingOverlay maxHeight={maxHeight} scrollEnabled>
                    <RolesRailDetail
                        serverId={props.serverId}
                        value={params.value}
                        onChange={(roleId) => { params.onChange(roleId); props.onRequestClose(); }}
                        describeConsequence={params.describeConsequence}
                        onManageRoles={params.onManageRoles ? () => { params.onManageRoles?.(); props.onRequestClose(); } : undefined}
                        footer={params.footer}
                    />
                </FloatingOverlay>
            )}
        </Popover>
    );
}

/**
 * The session's Role as a value row ("Role · Orchestrator · hands-off ›"; lab `convo-W8full`), which
 * opens the Role popover. The role is `readSessionRoleIdV1`, named through the one resolver; hands-off
 * is the role's attribute (its switch lives in the popover). No role says None; a role this device
 * cannot resolve still says which one it is, by its id.
 */
export const SessionRoleValueRow = React.memo(function SessionRoleValueRow(props: Readonly<{
    sessionId: string;
    serverId?: string | null;
    testID?: string;
}>) {
    const { sessionId } = props;
    const roleId = useSessionRoleId(sessionId, props.serverId);
    const { selection } = useSessionRoleSelection(sessionId, roleId, props.serverId);
    const anchorRef = React.useRef<View>(null);
    const [popoverOpen, setPopoverOpen] = React.useState(false);
    const openPopover = React.useCallback(() => setPopoverOpen(true), []);
    const closePopover = React.useCallback(() => setPopoverOpen(false), []);
    const testID = props.testID ?? 'session-role.value';

    const roleName = selection?.name ?? roleId;
    const value = roleName === null
        ? t('sessionWork.role.none')
        : selection?.workspaceWrites === 'deny'
            ? `${roleName} · ${t('sessionWork.role.handsOff')}`
            : roleName;

    return (
        <>
            <View ref={anchorRef} collapsable={false}>
                <Item
                    testID={testID}
                    title={t('roles.rail.title')}
                    detail={value}
                    density="compact"
                    accessibilityLabel={t('sessionWork.role.a11y', { role: value })}
                    onPress={openPopover}
                />
            </View>
            {popoverOpen ? (
                <SessionRolePopover sessionId={sessionId} serverId={props.serverId} anchorRef={anchorRef} onRequestClose={closePopover} />
            ) : null}
        </>
    );
});
