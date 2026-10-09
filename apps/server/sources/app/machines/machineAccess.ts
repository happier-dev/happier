import { isDeepStrictEqual } from 'node:util';
import { decodeBase64, encodeBase64 } from 'privacy-kit';
import {
    computeMachineOwnerEnvelopeFingerprintV1, decodePlainMachineStoredContent,
    decodeSessionDataKeyEnvelopeCursorV1, encodeSessionDataKeyEnvelopeCursorV1,
    isMachinePublishedContentSafeV1, parseEncryptedDataKeyEnvelopeV1,
    machineStoredContentMatchesAccountMode,
    MachineRecipientKeyEnvelopePageQueryV1Schema,
    type AccessibleMachineAccessV1, type MachineAdmission, type MachineAccessRoleV1,
    type MachineAccessRefusalV1, type MachineAccessRefusalCode, type MachineAccessGrantRowV1,
    type MachineAccessGrantsListResultV1, type MachineAccessMutationResultV1, type PrincipalRefV1,
    type MachineAccessRecipientCensusResponseV1, type MachineRecipientKeyEnvelopeCommitInputV1,
    type MachineRecipientKeyEnvelopeCommitResponseV1, type MachineRecipientKeyEnvelopePageQueryV1,
} from '@happier-dev/protocol';
import { resolveMachineRpcRoutePolicy } from '@happier-dev/protocol/machines/peer/mediation/rpc/routePolicyV1';
import { isRequesterProjectExecutionActionV1 } from '@happier-dev/protocol/actions/projectActionFamily';
import { inTx, type Tx } from '@/storage/inTx';
import { isEffectiveTeamMembership } from '@/app/teams/memberships/effectiveMembership';
import { isEffectiveTeamGroupMembership } from '@/app/teams/groups/effectiveGroupMembership';
import { deriveAccountRecipientEnvelopeReadinessFromRow } from '@/app/encryption/accountRecipientEnvelopeReadiness';
import { projectRecipientContentKey, RECIPIENT_READINESS_SELECT } from '@/app/session/encryption/sessionDataKeyRecipientProjection';
import { resolveAccountDisplayLabelV1, ACCOUNT_DISPLAY_PROFILE_SELECT } from '@/app/account/profile/accountDisplayProfile';
import { markAccountChanged } from '@/app/changes/markAccountChanged';
import { resolveEffectiveAccountEncryptionModeFromAccountRow } from '@/app/encryption/accountEncryptionMode';

type MachineActor = Readonly<{ actorAccountId: string; machineId: string }>;
export interface MachineAccessFacts {
    custodianAccountId: string;
    role: MachineAccessRoleV1;
    encryptionMode: 'plain' | 'e2ee';
    accessState: 'ready' | 'key_pending' | 'refused';
    reason: MachineAccessRefusalCode | null;
    canPrepareKeys: boolean;
    installationId: string | null;
    owned: boolean;
}
const refusal = (code: MachineAccessRefusalCode): MachineAccessRefusalV1 => ({ kind: 'refused', code });

async function readFactsInTx(tx: Tx, machineId: string) {
    return tx.machine.findUnique({ where: { id: machineId }, select: {
        id: true, kind: true, accountId: true, metadata: true, metadataVersion: true,
        daemonState: true, daemonStateVersion: true, dataEncryptionKey: true,
        installationId: true, active: true, revokedAt: true, replacedByMachineId: true,
        account: { select: { ...ACCOUNT_DISPLAY_PROFILE_SELECT, encryptionMode: true, status: true } },
        accountGrants: { select: { accountId: true, accessLevel: true, account: { select: { status: true, ...ACCOUNT_DISPLAY_PROFILE_SELECT } } } },
        teamGrants: { select: { teamId: true, accessLevel: true, team: { select: { name: true, archivedAt: true,
            memberships: { select: { accountId: true, status: true, account: { select: { status: true } } } },
        } } } },
        groupGrants: { select: { teamGroupId: true, accessLevel: true, teamGroup: { select: {
            name: true, teamId: true, archivedAt: true, team: { select: { archivedAt: true } },
            memberships: { select: { teamMembership: { select: { accountId: true, status: true, account: { select: { status: true } } } } } },
        } } } },
    } });
}
type MachineFacts = NonNullable<Awaited<ReturnType<typeof readFactsInTx>>>;
type Contribution = Readonly<{ principal: PrincipalRefV1; level: 'view' | 'admin'; displayName: string | null; accountIds: readonly string[] }>;

function contributions(row: MachineFacts): Contribution[] {
    return [
        ...row.accountGrants.map(grant => ({ principal: { kind: 'account' as const, accountId: grant.accountId }, level: grant.accessLevel,
            displayName: resolveAccountDisplayLabelV1(grant.account), accountIds: grant.account.status === 'active' ? [grant.accountId] : [] })),
        ...row.teamGrants.map(grant => ({ principal: { kind: 'team' as const, teamId: grant.teamId }, level: grant.accessLevel,
            displayName: grant.team.name, accountIds: grant.team.memberships.filter(member => isEffectiveTeamMembership({
                accountStatus: member.account.status, membershipStatus: member.status, teamArchivedAt: grant.team.archivedAt,
            })).map(member => member.accountId) })),
        ...row.groupGrants.map(grant => ({ principal: { kind: 'group' as const, teamId: grant.teamGroup.teamId, groupId: grant.teamGroupId }, level: grant.accessLevel,
            displayName: grant.teamGroup.name, accountIds: grant.teamGroup.memberships.filter(({ teamMembership: member }) => isEffectiveTeamGroupMembership({
                accountStatus: member.account.status, membershipStatus: member.status,
                teamArchivedAt: grant.teamGroup.team.archivedAt, groupArchivedAt: grant.teamGroup.archivedAt,
            })).map(({ teamMembership: member }) => member.accountId) })),
    ];
}
function effectiveRole(row: MachineFacts, actorAccountId: string, sources = contributions(row)): MachineAccessRoleV1 | null {
    if (row.accountId === actorAccountId) return row.account.status === 'active' ? 'manage' : null;
    if (row.kind !== 'persistent') return null;
    let role: MachineAccessRoleV1 | null = null;
    for (const source of sources) if (source.accountIds.includes(actorAccountId)) {
        if (source.level === 'admin') return 'manage';
        role = 'use';
    }
    return role;
}

/** Permission only: current grants/current membership, never key presence or Session history. */
export async function resolveEffectiveMachineRoleInTx(tx: Tx, input: MachineActor): Promise<MachineAccessRoleV1 | null> {
    const row = await readFactsInTx(tx, input.machineId);
    return row ? effectiveRole(row, input.actorAccountId) : null;
}
export async function resolveEffectiveMachineAccessForMachinesInTx(tx: Tx, input: Readonly<{ machineIds: readonly string[]; accountIds: readonly string[] }>): Promise<Map<string, Map<string, MachineAccessRoleV1 | null>>> {
    const result = new Map<string, Map<string, MachineAccessRoleV1 | null>>();
    for (const machineId of new Set(input.machineIds)) {
        const row = await readFactsInTx(tx, machineId);
        const sources = row ? contributions(row) : [];
        result.set(machineId, new Map(input.accountIds.map(accountId => [accountId, row ? effectiveRole(row, accountId, sources) : null])));
    }
    return result;
}
/** The current structural audience includes the original custodian, irrespective of key delivery. */
export async function resolveCurrentMachineRecipientAccountIdsInTx(tx: Tx, machineId: string): Promise<string[]> {
    const row = await readFactsInTx(tx, machineId);
    if (!row) return [];
    return [...new Set([row.accountId, ...contributions(row).flatMap(source => source.accountIds)])].sort();
}
export async function listMachineCandidatesInTx(tx: Tx, actorAccountId: string): Promise<string[]> {
    const [owned, direct, memberships, groupMemberships] = await Promise.all([
        tx.machine.findMany({ where: { accountId: actorAccountId }, select: { id: true } }),
        tx.machineAccountGrant.findMany({ where: { accountId: actorAccountId }, select: { machineId: true } }),
        tx.teamMembership.findMany({ where: { accountId: actorAccountId }, select: { teamId: true } }),
        tx.teamGroupMembership.findMany({ where: { teamMembership: { accountId: actorAccountId } }, select: { teamGroupId: true } }),
    ]);
    const [teams, groups] = await Promise.all([
        tx.machineTeamGrant.findMany({ where: { teamId: { in: memberships.map(member => member.teamId) } }, select: { machineId: true } }),
        tx.machineGroupGrant.findMany({ where: { teamGroupId: { in: groupMemberships.map(member => member.teamGroupId) } }, select: { machineId: true } }),
    ]);
    return [...new Set([...owned.map(row => row.id), ...direct.map(row => row.machineId), ...teams.map(row => row.machineId), ...groups.map(row => row.machineId)])].sort();
}

function resourceMode(row: MachineFacts): 'plain' | 'e2ee' | null {
    const mode = resolveEffectiveAccountEncryptionModeFromAccountRow(row.account);
    return mode.status === 'ready' ? mode.mode : null;
}
function resourceContentMatchesMode(row: MachineFacts, mode: 'plain' | 'e2ee'): boolean {
    return machineStoredContentMatchesAccountMode({
        mode, metadata: row.metadata, storedRead: true,
        ...(row.daemonState === null ? {} : { daemonState: row.daemonState }),
        dataEncryptionKey: row.dataEncryptionKey,
    }) && (mode === 'plain' || row.dataEncryptionKey === null || parseEncryptedDataKeyEnvelopeV1(row.dataEncryptionKey) !== null);
}
function safePlainContent(row: MachineFacts): boolean {
    try {
        return isMachinePublishedContentSafeV1({ metadata: decodePlainMachineStoredContent(row.metadata),
            daemonState: row.daemonState === null ? null : decodePlainMachineStoredContent(row.daemonState) });
    } catch { return false; }
}
async function accessFromFactsInTx(tx: Tx, row: MachineFacts, actorAccountId: string): Promise<MachineAccessFacts | null> {
    const role = effectiveRole(row, actorAccountId);
    if (!role) return null;
    const owned = row.accountId === actorAccountId;
    if (!owned && (row.revokedAt || row.replacedByMachineId)) return null;
    const encryptionMode = resourceMode(row);
    if (encryptionMode === null) return null;
    let accessState: MachineAccessFacts['accessState'] = resourceContentMatchesMode(row, encryptionMode) ? 'ready' : 'refused';
    let reason: MachineAccessRefusalCode | null = accessState === 'refused' ? 'encryption_material_unavailable' : null;
    let canPrepareKeys = false;
    if (accessState === 'ready' && !owned && encryptionMode === 'plain' && !safePlainContent(row)) {
        accessState = 'key_pending'; reason = 'encryption_material_unavailable';
    }
    if (accessState === 'ready' && !owned && encryptionMode === 'e2ee') {
        const recipient = await tx.account.findUnique({ where: { id: actorAccountId }, select: RECIPIENT_READINESS_SELECT });
        const readiness = recipient ? deriveAccountRecipientEnvelopeReadinessFromRow(recipient) : null;
        if (readiness?.status === 'unavailable' && readiness.reason === 'plain_account') {
            accessState = 'refused'; reason = 'recipient_encryption_incompatible';
        } else if (readiness?.status !== 'available') {
            accessState = 'key_pending'; reason = 'encryption_material_unavailable';
        }
        else {
            const envelope = await tx.machineKeyEnvelope.findUnique({ where: { machineId_recipientAccountId: { machineId: row.id, recipientAccountId: actorAccountId } } });
            accessState = row.dataEncryptionKey !== null && parseEncryptedDataKeyEnvelopeV1(row.dataEncryptionKey) !== null && envelope
                && envelope.machineOwnerEnvelopeFingerprint === computeMachineOwnerEnvelopeFingerprintV1(row.dataEncryptionKey)
                && envelope.recipientContentPublicKeyFingerprint === readiness.binding.contentPublicKeyFingerprint
                && parseEncryptedDataKeyEnvelopeV1(envelope.encryptedDataKey) !== null ? 'ready' : 'key_pending';
            if (accessState === 'key_pending') { reason = 'recipient_key_pending'; canPrepareKeys = true; }
        }
    }
    return { custodianAccountId: row.accountId, role, encryptionMode, accessState, reason, canPrepareKeys,
        installationId: row.installationId, owned };
}

function grantReadiness(states: readonly (MachineAccessFacts | null)[]) {
    return { readiness: states.some(state => state?.accessState === 'refused') ? 'refused' as const
        : states.some(state => state?.accessState === 'key_pending') ? 'key_pending' as const : 'ready' as const,
        canPrepareKeys: states.some(state => state?.canPrepareKeys === true) };
}
export async function resolveMachineAccessInTx(tx: Tx, input: MachineActor): Promise<MachineAccessFacts | null> {
    const row = await readFactsInTx(tx, input.machineId);
    return row ? accessFromFactsInTx(tx, row, input.actorAccountId) : null;
}
export async function resolveMachineAccess(input: MachineActor) { return inTx(tx => resolveMachineAccessInTx(tx, input)); }
export async function readAccessibleMachineAccessInTx(tx: Tx, input: MachineActor): Promise<AccessibleMachineAccessV1 | null> {
    const row = await readFactsInTx(tx, input.machineId);
    const access = row && await accessFromFactsInTx(tx, row, input.actorAccountId);
    return row && access ? { custodian: { accountId: row.accountId, displayName: resolveAccountDisplayLabelV1(row.account) ?? '' },
        role: access.role, resourceMode: access.encryptionMode, accessState: access.accessState } : null;
}
/** Opening material is caller-specific; the separate C40 Machine write basis owns CAS identity. */
export async function readMachineDataKeyForCallerInTx(tx: Tx, input: MachineActor): Promise<Uint8Array<ArrayBuffer> | null> {
    const row = await readFactsInTx(tx, input.machineId);
    const access = row && await accessFromFactsInTx(tx, row, input.actorAccountId);
    if (!row || !access || access.accessState !== 'ready') return null;
    if (access.owned) return row.dataEncryptionKey ? new Uint8Array(row.dataEncryptionKey) : null;
    if (access.encryptionMode === 'plain' || access.accessState !== 'ready') return null;
    const envelope = await tx.machineKeyEnvelope.findUnique({ where: { machineId_recipientAccountId: { machineId: row.id, recipientAccountId: input.actorAccountId } }, select: { encryptedDataKey: true } });
    return envelope ? new Uint8Array(envelope.encryptedDataKey) : null;
}
export interface MachineAdmissionInput extends MachineActor {
    requiredRole?: MachineAccessRoleV1;
    requireOnline?: boolean;
    rpcMethod?: string;
    actionId?: string;
}
export async function resolveMachineAdmissionInTx(tx: Tx, input: MachineAdmissionInput): Promise<MachineAdmission> {
    const row = await readFactsInTx(tx, input.machineId);
    const access = row && await accessFromFactsInTx(tx, row, input.actorAccountId);
    if (!row || !access) return { kind: 'denied', code: 'access_denied' };
    if (!resourceContentMatchesMode(row, access.encryptionMode)) return { kind: 'denied', code: 'encryption_material_unavailable' };
    if (row.revokedAt || row.replacedByMachineId || !row.installationId || (input.requireOnline === true && !row.active)) return { kind: 'denied', code: 'machine_unavailable' };
    let requiredRole = input.requiredRole ?? 'use';
    let method = input.rpcMethod;
    if (input.actionId && !method) {
        const { getActionSpec, PublicActionIdSchema } = await import('@happier-dev/protocol/actions');
        const actionId = PublicActionIdSchema.safeParse(input.actionId);
        const spec = actionId.success ? getActionSpec(actionId.data) : null;
        method = spec?.bindings?.rpcMethod;
        if (!method && !access.owned && !isRequesterProjectExecutionActionV1(input.actionId)) {
            return { kind: 'denied', code: 'unsupported_operation' };
        }
    }
    if (method) {
        const policy = resolveMachineRpcRoutePolicy(method).sharedMachineAccess;
        if (policy === 'custodian_only' && !access.owned) return { kind: 'denied', code: 'unsupported_operation' };
        if (policy === 'manage') requiredRole = 'manage';
    }
    if (requiredRole === 'manage' && access.role !== 'manage') return { kind: 'denied', code: 'access_denied' };
    if (access.accessState === 'refused') return { kind: 'denied', code: 'recipient_encryption_incompatible' };
    if (access.accessState !== 'ready') return { kind: 'denied', code: 'recipient_key_pending' };
    return { kind: 'admitted', actorAccountId: input.actorAccountId, custodianAccountId: row.accountId,
        machineId: row.id, installationId: row.installationId, role: access.role, encryptionMode: access.encryptionMode };
}
export async function resolveMachineAdmission(input: MachineAdmissionInput): Promise<MachineAdmission> { return inTx(tx => resolveMachineAdmissionInTx(tx, input)); }

export async function listMachineAccessGrantsInTx(tx: Tx, input: MachineActor): Promise<MachineAccessGrantsListResultV1> {
    const row = await readFactsInTx(tx, input.machineId);
    const access = row && await accessFromFactsInTx(tx, row, input.actorAccountId);
    if (!row || !access) return refusal('access_denied');
    const sources = contributions(row);
    const canManage = access.role === 'manage';
    const custodian = { accountId: row.accountId, displayName: resolveAccountDisplayLabelV1(row.account) ?? '' };
    // The existing effective audience owns identity disclosure. This is only a
    // safe display projection for the custodian/Manage roster, never Session
    // content or another grant/summary audience decision.
    const currentRequesterAccountIds = canManage
        ? [...new Set([row.accountId, ...sources.flatMap(source => source.accountIds)])]
            .filter(accountId => effectiveRole(row, accountId, sources) !== null)
        : [];
    const currentRequesterDisplayIdentities = canManage
        ? (await tx.account.findMany({ where: { id: { in: currentRequesterAccountIds } }, select: ACCOUNT_DISPLAY_PROFILE_SELECT }))
            .map(account => ({ accountId: account.id, displayName: resolveAccountDisplayLabelV1(account) ?? '' }))
        : undefined;
    const displayNames = new Map(currentRequesterDisplayIdentities?.map(account => [account.accountId, account.displayName]));
    const grants: MachineAccessGrantRowV1[] = [];
    if (canManage) for (const source of sources) {
        const accountIds = source.accountIds.filter(accountId => accountId !== row.accountId);
        const states = await Promise.all(accountIds.map(accountId => accessFromFactsInTx(tx, row, accountId)));
        grants.push({ machineId: row.id, principal: source.principal, level: source.level, display: { name: source.displayName },
            readiness: grantReadiness(states).readiness,
            audience: accountIds.map((accountId, index) => ({ accountId, displayName: displayNames.get(accountId) ?? '',
                readiness: states[index]?.accessState ?? 'refused', reason: states[index]?.reason ?? (states[index] ? null : 'machine_unavailable'),
                canPrepareKeys: states[index]?.canPrepareKeys === true })),
            removal: { losesAccessAccountIds: source.accountIds.filter(accountId => effectiveRole(row, accountId, sources.filter(candidate => candidate !== source)) === null) } });
    }
    return { machineId: row.id, custodian, access: { custodian, role: access.role, resourceMode: access.encryptionMode, accessState: access.accessState },
        canManage, grants, ownDirectGrant: row.accountGrants.some(grant => grant.accountId === input.actorAccountId),
        ...(currentRequesterDisplayIdentities ? { currentRequesterDisplayIdentities } : {}),
        ownAccessSources: sources.filter(source => source.accountIds.includes(input.actorAccountId)).map(source => ({ principal: source.principal, displayName: source.displayName })) };
}

async function managerInTx(tx: Tx, input: MachineActor, options: Readonly<{ requireCurrentKeyHolder?: boolean }> = {}) {
    const row = await readFactsInTx(tx, input.machineId);
    const access = row && await accessFromFactsInTx(tx, row, input.actorAccountId);
    return row && access?.role === 'manage' && resourceContentMatchesMode(row, access.encryptionMode)
        && (!options.requireCurrentKeyHolder || access.accessState === 'ready')
        && !row.revokedAt && !row.replacedByMachineId ? row : null;
}
async function mutationImpactInTx(tx: Tx, machineId: string, accountIds: readonly string[]) {
    const { captureMachineAccessImpactsInTx } = await import('./machineAccessEffects');
    return captureMachineAccessImpactsInTx(tx, { machineIds: [machineId], accountIds });
}
async function publishMutationInTx(tx: Tx, impacts: Awaited<ReturnType<typeof mutationImpactInTx>>, changedAccountId?: string) {
    const { applyMachineAccessImpactsInTx } = await import('./machineAccessEffects');
    await applyMachineAccessImpactsInTx(tx, { impacts: impacts.values(), grantRosterChanged: true, ...(changedAccountId ? { directGrantChangedAccountId: changedAccountId } : {}) });
}
/** Idempotent per-principal grants; Manage can delegate Manage without replacing custody. */
export async function setMachineAccessGrantInTx(tx: Tx, input: MachineActor & Readonly<{ principal: PrincipalRefV1; level: 'view' | 'admin' }>): Promise<MachineAccessMutationResultV1> {
    const row = await managerInTx(tx, input);
    if (!row) return refusal('access_denied');
    if (row.kind !== 'persistent') return refusal('unsupported_operation');
    const principal = input.principal;
    if (principal.kind === 'account' && principal.accountId === row.accountId) return refusal('custodian_protected');
    let targetAccountIds: string[] = [];
    if (principal.kind === 'account') {
        const account = await tx.account.findUnique({ where: { id: principal.accountId }, select: { status: true, ...RECIPIENT_READINESS_SELECT } });
        if (!account) return refusal('principal_not_found');
        if (account.status !== 'active') return refusal('principal_ineligible');
        if (resourceMode(row) === 'e2ee') {
            const readiness = deriveAccountRecipientEnvelopeReadinessFromRow(account);
            if (readiness.status === 'unavailable' && readiness.reason === 'plain_account') return refusal('recipient_encryption_incompatible');
        }
        targetAccountIds = [principal.accountId];
    } else if (principal.kind === 'team') {
        const team = await tx.team.findUnique({ where: { id: principal.teamId }, select: { archivedAt: true, memberships: { select: { accountId: true } } } });
        if (!team) return refusal('principal_not_found');
        if (team.archivedAt) return refusal('principal_ineligible');
        targetAccountIds = team.memberships.map(member => member.accountId);
    } else {
        const group = await tx.teamGroup.findUnique({ where: { id: principal.groupId }, select: { teamId: true, archivedAt: true, team: { select: { archivedAt: true } }, memberships: { select: { teamMembership: { select: { accountId: true } } } } } });
        if (!group || group.teamId !== principal.teamId) return refusal('principal_not_found');
        if (group.archivedAt || group.team.archivedAt) return refusal('principal_ineligible');
        targetAccountIds = group.memberships.map(member => member.teamMembership.accountId);
    }
    const impacts = await mutationImpactInTx(tx, row.id, [...new Set([row.accountId, ...targetAccountIds])]);
    const data = { accessLevel: input.level, createdByAccountId: input.actorAccountId };
    let changed = false;
    if (principal.kind === 'account') {
        const where = { machineId_accountId: { machineId: row.id, accountId: principal.accountId } };
        changed = (await tx.machineAccountGrant.findUnique({ where }))?.accessLevel !== input.level;
        if (changed) await tx.machineAccountGrant.upsert({ where, create: { machineId: row.id, accountId: principal.accountId, ...data }, update: data });
    } else if (principal.kind === 'team') {
        const where = { machineId_teamId: { machineId: row.id, teamId: principal.teamId } };
        changed = (await tx.machineTeamGrant.findUnique({ where }))?.accessLevel !== input.level;
        if (changed) await tx.machineTeamGrant.upsert({ where, create: { machineId: row.id, teamId: principal.teamId, ...data }, update: data });
    } else {
        const where = { machineId_teamGroupId: { machineId: row.id, teamGroupId: principal.groupId } };
        changed = (await tx.machineGroupGrant.findUnique({ where }))?.accessLevel !== input.level;
        if (changed) await tx.machineGroupGrant.upsert({ where, create: { machineId: row.id, teamGroupId: principal.groupId, ...data }, update: data });
    }
    if (changed) await publishMutationInTx(tx, impacts, principal.kind === 'account' ? principal.accountId : undefined);
    const current = await readFactsInTx(tx, row.id);
    const source = current && contributions(current).find(candidate => isDeepStrictEqual(candidate.principal, principal));
    const states = current && source ? await Promise.all(source.accountIds.filter(id => id !== row.accountId).map(id => accessFromFactsInTx(tx, current, id))) : [];
    return { kind: 'saved', grant: { machineId: row.id, principal, level: input.level }, ...grantReadiness(states) };
}

/** Direct Leave removes only self's direct tuple; surviving inherited contributions remain. */
export async function removeMachineAccessGrantInTx(tx: Tx, input: MachineActor & Readonly<{ principal: PrincipalRefV1; leave?: boolean }>): Promise<MachineAccessMutationResultV1> {
    const row = await readFactsInTx(tx, input.machineId);
    if (!row) return refusal('access_denied');
    const principal = input.principal;
    const self = principal.kind === 'account' && principal.accountId === input.actorAccountId;
    if (input.leave && !self) return refusal('access_denied');
    if (principal.kind === 'account' && principal.accountId === row.accountId) return refusal('custodian_protected');
    if (!self && !await managerInTx(tx, input)) return refusal('access_denied');
    if (principal.kind === 'group') {
        const group = await tx.teamGroup.findUnique({ where: { id: principal.groupId }, select: { teamId: true } });
        if (!group || group.teamId !== principal.teamId) return refusal('principal_not_found');
    }
    const before = await resolveCurrentMachineRecipientAccountIdsInTx(tx, row.id);
    const impacts = await mutationImpactInTx(tx, row.id, [...new Set([...before, ...(principal.kind === 'account' ? [principal.accountId] : [])])]);
    const deleted = principal.kind === 'account' ? await tx.machineAccountGrant.deleteMany({ where: { machineId: row.id, accountId: principal.accountId } })
        : principal.kind === 'team' ? await tx.machineTeamGrant.deleteMany({ where: { machineId: row.id, teamId: principal.teamId } })
            : await tx.machineGroupGrant.deleteMany({ where: { machineId: row.id, teamGroupId: principal.groupId } });
    if (deleted.count) await publishMutationInTx(tx, impacts, principal.kind === 'account' ? principal.accountId : undefined);
    const role = await resolveEffectiveMachineRoleInTx(tx, { machineId: row.id, actorAccountId: principal.kind === 'account' ? principal.accountId : input.actorAccountId });
    if (self && role) return { kind: 'inherited_access_remains', role };
    return { kind: self ? 'left' : 'removed', effectiveAccess: role ?? 'none' };
}

/** Current holder worklist; returns caller-openable bytes but never the custodian's private envelope. */
export async function readMachineRecipientCensusInTx(tx: Tx, input: MachineActor & Readonly<{ query?: MachineRecipientKeyEnvelopePageQueryV1 }>): Promise<MachineAccessRecipientCensusResponseV1 | MachineAccessRefusalV1> {
    const row = await managerInTx(tx, input, { requireCurrentKeyHolder: true });
    if (!row) return refusal('access_denied');
    const encryptionMode = resourceMode(row);
    if (encryptionMode === null || !resourceContentMatchesMode(row, encryptionMode)) return refusal('encryption_material_unavailable');
    if (encryptionMode === 'plain' && !safePlainContent(row)) return refusal('encryption_material_unavailable');
    const callerKey = encryptionMode === 'plain' ? null : await readMachineDataKeyForCallerInTx(tx, input);
    if (encryptionMode === 'e2ee' && (!callerKey || !row.dataEncryptionKey || !parseEncryptedDataKeyEnvelopeV1(row.dataEncryptionKey))) return refusal('encryption_material_unavailable');
    const query = input.query ?? MachineRecipientKeyEnvelopePageQueryV1Schema.parse({});
    const after = query.cursor ? decodeSessionDataKeyEnvelopeCursorV1(query.cursor) : null;
    if (query.cursor && !after) return refusal('unsupported_operation');
    const fingerprint = encryptionMode === 'e2ee' && row.dataEncryptionKey ? computeMachineOwnerEnvelopeFingerprintV1(row.dataEncryptionKey) : null;
    const recipients: MachineAccessRecipientCensusResponseV1['recipients'] = [];
    let nextCursor: string | null = null;
    if (encryptionMode === 'e2ee') {
        const ids = await resolveCurrentMachineRecipientAccountIdsInTx(tx, row.id);
        for (const accountId of ids) {
            if (accountId === row.accountId || (after !== null && accountId <= after)) continue;
            const account = await tx.account.findUnique({ where: { id: accountId }, select: RECIPIENT_READINESS_SELECT });
            if (!account) continue;
            const readiness = deriveAccountRecipientEnvelopeReadinessFromRow(account);
            const envelope = await tx.machineKeyEnvelope.findUnique({ where: { machineId_recipientAccountId: { machineId: row.id, recipientAccountId: accountId } } });
            const publicFingerprint = readiness.status === 'available' ? readiness.binding.contentPublicKeyFingerprint : null;
            const current = readiness.status === 'available' && envelope?.machineOwnerEnvelopeFingerprint === fingerprint
                && envelope.recipientContentPublicKeyFingerprint === publicFingerprint && parseEncryptedDataKeyEnvelopeV1(envelope.encryptedDataKey) !== null;
            if (query.state === 'action_required' && current) continue;
            if (recipients.length === query.limit) { nextCursor = encodeSessionDataKeyEnvelopeCursorV1(recipients[recipients.length - 1].recipientAccountId); break; }
            recipients.push({ recipientAccountId: accountId, contentKey: projectRecipientContentKey(account, readiness),
                contentPublicKeyFingerprint: publicFingerprint, encryptedDataKey: current ? encodeBase64(new Uint8Array(envelope.encryptedDataKey)) : null,
                recipientContentPublicKeyFingerprint: current ? envelope.recipientContentPublicKeyFingerprint : null });
        }
    }
    return { machineId: row.id, custodianAccountId: row.accountId, encryptionMode, machineOwnerEnvelopeFingerprint: fingerprint,
        callerDataEncryptionKey: callerKey ? encodeBase64(callerKey) : null, nextCursor, recipients,
        content: { metadata: row.metadata, metadataVersion: row.metadataVersion, daemonState: row.daemonState, daemonStateVersion: row.daemonStateVersion } };
}
/** Atomic opaque tuple commit after current Manage, holder, whole-blob versions and recipient binding recheck. */
export async function commitMachineRecipientKeyEnvelopesInTx(tx: Tx, input: MachineRecipientKeyEnvelopeCommitInputV1 & Readonly<{ actorAccountId: string }>): Promise<MachineRecipientKeyEnvelopeCommitResponseV1 | MachineAccessRefusalV1> {
    const row = await managerInTx(tx, input, { requireCurrentKeyHolder: true });
    if (!row) return refusal('access_denied');
    const encryptionMode = resourceMode(row);
    if (encryptionMode === null || !resourceContentMatchesMode(row, encryptionMode)) return refusal('encryption_material_unavailable');
    if (encryptionMode === 'plain') return refusal('data_key_not_required');
    if (!row.dataEncryptionKey || !parseEncryptedDataKeyEnvelopeV1(row.dataEncryptionKey)) return refusal('encryption_material_unavailable');
    const fingerprint = computeMachineOwnerEnvelopeFingerprintV1(row.dataEncryptionKey);
    if (fingerprint !== input.expectedMachineOwnerEnvelopeFingerprint || row.metadataVersion !== input.expectedMetadataVersion || row.daemonStateVersion !== input.expectedDaemonStateVersion) return refusal('machine_key_changed');
    const callerKey = await readMachineDataKeyForCallerInTx(tx, input);
    if (!callerKey || !isDeepStrictEqual(callerKey, decodeBase64(input.expectedCallerDataEncryptionKey))) return refusal('recipient_binding_changed');
    const prepared: Array<{ recipientAccountId: string; encryptedDataKey: Uint8Array<ArrayBuffer>; recipientContentPublicKeyFingerprint: string }> = [];
    for (const envelope of input.recipientKeyEnvelopes) {
        const encryptedDataKey = new Uint8Array(decodeBase64(envelope.encryptedDataKey));
        if (!parseEncryptedDataKeyEnvelopeV1(encryptedDataKey)) return refusal('invalid_recipient_envelope');
        if (envelope.recipientAccountId === row.accountId || !effectiveRole(row, envelope.recipientAccountId)) return refusal('access_denied');
        const account = await tx.account.findUnique({ where: { id: envelope.recipientAccountId }, select: RECIPIENT_READINESS_SELECT });
        const readiness = account ? deriveAccountRecipientEnvelopeReadinessFromRow(account) : null;
        if (readiness?.status !== 'available' || readiness.binding.contentPublicKeyFingerprint !== envelope.recipientContentPublicKeyFingerprint) return refusal('recipient_binding_changed');
        prepared.push({ recipientAccountId: envelope.recipientAccountId, encryptedDataKey, recipientContentPublicKeyFingerprint: envelope.recipientContentPublicKeyFingerprint });
    }
    for (const envelope of prepared) {
        const data = { encryptedDataKey: envelope.encryptedDataKey, machineOwnerEnvelopeFingerprint: fingerprint, recipientContentPublicKeyFingerprint: envelope.recipientContentPublicKeyFingerprint };
        await tx.machineKeyEnvelope.upsert({ where: { machineId_recipientAccountId: { machineId: row.id, recipientAccountId: envelope.recipientAccountId } },
            create: { machineId: row.id, recipientAccountId: envelope.recipientAccountId, ...data }, update: data });
        await markAccountChanged(tx, { accountId: envelope.recipientAccountId, kind: 'machine', entityId: row.id });
    }
    return { appliedRecipientAccountIds: prepared.map(envelope => envelope.recipientAccountId), skippedRecipientAccountIds: [] };
}
