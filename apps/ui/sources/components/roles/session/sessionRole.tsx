import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';
import { useRouter } from 'expo-router';
import { readSessionRoleIdV1, readSessionRolesV1 } from '@happier-dev/protocol/prompts/roles/sessionRolesSnapshot';
import { resolveRoleSelectionV1 } from '@happier-dev/protocol/prompts/roles/resolveRoleSelectionV1';
import type { ResolvedRoleV1 } from '@happier-dev/protocol/prompts/roles/rolesV1';
import { resolvedRoleToArtifact } from '@/sync/domains/roles/roleCatalog';
import { joinHappierFacts } from '@happier-dev/plugin-ui/presentation';

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

type SessionRoleWriteResult = Readonly<{ ok: boolean; errorCode?: string; error?: string }>;

/**
 * What a refused session-role write tells the person: the typed refusals the role Action host returns
 * (`apps/cli/src/session/actions/roleActions.ts`) in words, each with its next step. A hands-off role
 * on an agent that cannot hold back its own edits is `role_policy_unenforceable` (ORC §3.3); a
 * refusal with no words here keeps the host's own detail under the generic failure.
 */
export function describeSessionRoleRefusal(result: SessionRoleWriteResult): Readonly<{ title: string; message: string }> {
    switch (result.errorCode) {
        case 'role_policy_unenforceable':
            return { title: t('roles.session.refusal.unenforceableTitle'), message: t('roles.session.refusal.unenforceableBody') };
        case 'role_policy_restart_required':
            return { title: t('roles.session.refusal.restartRequiredTitle'), message: t('roles.session.refusal.restartRequiredBody') };
        case 'role_target_unavailable':
            return { title: t('roles.session.refusal.roleUnavailableTitle'), message: t('roles.session.refusal.roleUnavailableBody') };
        default:
            return { title: t('roles.session.saveFailed'), message: result.error ?? '' };
    }
}

/**
 * Settles one session-role write: a refusal is reported, and the answer says whether the write landed.
 * An editor closes (and drops what was typed) only on `true`; on `false` it keeps the draft for retry.
 */
export async function settleSessionRoleWrite(result: SessionRoleWriteResult): Promise<boolean> {
    if (result.ok) return true;
    const refusal = describeSessionRoleRefusal(result);
    await Modal.alertAsync(refusal.title, refusal.message);
    return false;
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
            settingsRoles: entry ? { [roleId]: resolvedRoleToArtifact(entry.role) } : {},
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
        sessionId,
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
            edgePadding={ROLE_POPOVER_EDGE_PADDING}
            autoFocusOnOpen
            onRequestClose={props.onRequestClose}
            // The row sits in a right-hand pane: the popover keeps its right edge on the row's and
            // grows toward the transcript, never past the window edge.
            portal={{ web: true, native: true, matchAnchorWidth: false, anchorAlign: 'end' }}
        >
            {({ maxHeight, maxWidth }) => (
                <FloatingOverlay maxHeight={maxHeight} scrollEnabled={false} surfaceChrome="theme">
                    {/* A fixed frame, so the rail's grid scrolls inside it and its footer stays at the foot. */}
                    <View testID="session-role-popover" style={[styles.rolePopover, { height: maxHeight, width: maxWidth }]}>
                    <RolesRailDetail
                        serverId={props.serverId}
                        value={params.value}
                        sessionId={props.sessionId}
                        onChange={(roleId) => { params.onChange(roleId); props.onRequestClose(); }}
                        describeConsequence={params.describeConsequence}
                        onManageRoles={params.onManageRoles ? () => { params.onManageRoles?.(); props.onRequestClose(); } : undefined}
                        footer={params.footer}
                    />
                    </View>
                </FloatingOverlay>
            )}
        </Popover>
    );
}

const ROLE_POPOVER_EDGE_PADDING = { vertical: 8, horizontal: 8 } as const;

const styles = StyleSheet.create({
    // The composer picker's detail inset (`AgentInputChipPickerPanel` detail content), so the Roles
    // rail reads the same wherever it opens.
    rolePopover: { paddingHorizontal: 12, paddingVertical: 15 },
});

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
            ? joinHappierFacts(roleName, t('sessionWork.role.handsOff'))
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
