import { isDeepStrictEqual } from 'node:util';
import type { Machine, MachineKeyEnvelope, Prisma } from '@prisma/client';
import { decodeBase64, encodeBase64 } from 'privacy-kit';
import { computeMachineOwnerEnvelopeFingerprintV1 } from '@happier-dev/protocol/machines/machineOwnerEnvelopeFingerprintV1';
import { decodePlainMachineStoredContent, machineStoredContentMatchesAccountMode } from '@happier-dev/protocol/machines/machineStoredContent';
import { decodeSessionDataKeyEnvelopeCursorV1, encodeSessionDataKeyEnvelopeCursorV1 } from '@happier-dev/protocol/sessions/encryption/sessionDataKeyEnvelopes';
import { isMachinePublishedContentSafeV1 } from '@happier-dev/protocol/machines/machinePublishedContentV1';
import { parseEncryptedDataKeyEnvelopeV1 } from '@happier-dev/protocol/crypto/encryptedDataKeyEnvelopeV1';
import { MachineRecipientKeyEnvelopePageQueryV1Schema, type AccessibleMachineAccessV1, type MachineAdmission, type MachineAccessRoleV1, type MachineAccessRefusalV1, type MachineAccessRefusalCode, type MachineAccessGrantRowV1, type MachineAccessGrantsListResultV1, type MachineAccessMutationResultV1, type MachineAccessRecipientCensusResponseV1, type MachineRecipientKeyEnvelopeCommitInputV1, type MachineRecipientKeyEnvelopeCommitResponseV1, type MachineRecipientKeyEnvelopePageQueryV1 } from '@happier-dev/protocol/machines/machineAccessV1';
import { type PrincipalRefV1 } from '@happier-dev/protocol/teams/principal';
import { resolveMachineRpcRoutePolicy } from '@happier-dev/protocol/machines/peer/mediation/rpc/routePolicyV1';
import { isRequesterProjectExecutionActionV1 } from '@happier-dev/protocol/actions/projectActionFamily';
import { isBrowserExtensionActionIdV1 } from '@happier-dev/protocol/actions/actionIds';
import { requiredMachineRoleForBrowserAction } from '@happier-dev/protocol/actions';
import { getActionSpec, SignedRootActionIdSchema } from '@happier-dev/protocol/actions/actionSpecs';
import { isProviderActionIdV1 } from '@happier-dev/protocol/providers/providerActionsV1';
import { resolveProviderActionRpcRouteV1 } from '@happier-dev/protocol/providers/executeProviderActionV1';
import { inTx, TransactionReplayRequiredError, type Tx } from '@/storage/inTx';
import { getDbProviderFromEnv } from '@/storage/db';
import { portableQueryChunks } from '@/storage/portableQueryChunks';
import { isEffectiveTeamMembership } from '@/app/teams/memberships/effectiveMembership';
import { isEffectiveTeamGroupMembership } from '@/app/teams/groups/effectiveGroupMembership';
import { deriveAccountRecipientEnvelopeReadinessFromRow } from '@/app/encryption/accountRecipientEnvelopeReadiness';
import { RECIPIENT_READINESS_SELECT } from '@/app/session/encryption/sessionDataKeyRecipientProjection';
import { resolveAccountDisplayLabelV1, ACCOUNT_DISPLAY_PROFILE_SELECT } from '@/app/account/profile/accountDisplayProfile';
import { acquireAccountChangePublicationLocksInTx, assertAccountChangePublicationAudienceInTx, beforeAccountChangePublication, markAccountsChanged } from '@/app/changes/markAccountChanged';
import { resolveEffectiveAccountEncryptionModeFromAccountRow } from '@/app/encryption/accountEncryptionMode';
import { captureMachineAccessImpactsInTx, applyMachineAccessImpactsInTx } from './machineAccessEffects';
import { classifyMachineAvailabilityState } from './machineStateGuards';
import { isMachineOperationSupportedForRequester, type MachineOperationRequesterContext } from './machineOperationSupport';
import { isMachineRecipientWorkPending, projectMachineRecipientWork, readMachineRecipientWorkInTx, readMachineAudienceAccountIdsInTx } from './machineRecipientWork';

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

const MACHINE_RESOURCE_FACTS_SELECT = {
        id: true, kind: true, accountId: true, metadata: true, metadataVersion: true,
        daemonState: true, daemonStateVersion: true, dataEncryptionKey: true,
        installationId: true, active: true, revokedAt: true, replacedByMachineId: true,
        operationProtocolCapabilities: true, operationProtocolCapabilitiesRevision: true,
        account: { select: { ...ACCOUNT_DISPLAY_PROFILE_SELECT, encryptionMode: true, status: true } },
    } as const;

const MACHINE_ACCESS_FACTS_SELECT = {
        ...MACHINE_RESOURCE_FACTS_SELECT,
        accountGrants: { select: { accountId: true, accessLevel: true, account: { select: { status: true, ...ACCOUNT_DISPLAY_PROFILE_SELECT } } } },
        teamGrants: { select: { teamId: true, accessLevel: true, team: { select: { name: true, archivedAt: true,
            memberships: { select: { accountId: true, status: true, account: { select: { status: true } } } },
        } } } },
        groupGrants: { select: { teamGroupId: true, accessLevel: true, teamGroup: { select: {
            name: true, teamId: true, archivedAt: true, team: { select: { archivedAt: true } },
            memberships: { select: { teamMembership: { select: { accountId: true, status: true, account: { select: { status: true } } } } } },
        } } } },
    } as const;

/** Same current Machine graph for exact Session binding and Machine admission. */
export function buildMachineAdmissionFactsSelect(actorAccountId: string) {
    const foreignGrant = { machine: { accountId: { not: actorAccountId } } };
    const { accountGrants, teamGrants, groupGrants } = MACHINE_ACCESS_FACTS_SELECT;
    return {
        ...MACHINE_ACCESS_FACTS_SELECT,
        accountGrants: { ...accountGrants, where: { ...foreignGrant, accountId: actorAccountId } },
        teamGrants: { where: foreignGrant, select: { ...teamGrants.select, team: { select: {
            ...teamGrants.select.team.select,
            memberships: { ...teamGrants.select.team.select.memberships, where: { accountId: actorAccountId } },
        } } } },
        groupGrants: { where: foreignGrant, select: { ...groupGrants.select, teamGroup: { select: {
            ...groupGrants.select.teamGroup.select,
            memberships: { ...groupGrants.select.teamGroup.select.memberships, where: { teamMembership: { accountId: actorAccountId } } },
        } } } },
    } as const;
}

const MACHINE_OPENING_INCLUDE = {
    managedResource: { select: { id: true, homeId: true } },
    account: MACHINE_RESOURCE_FACTS_SELECT.account,
    accountGrants: MACHINE_ACCESS_FACTS_SELECT.accountGrants,
    teamGrants: MACHINE_ACCESS_FACTS_SELECT.teamGrants,
    groupGrants: MACHINE_ACCESS_FACTS_SELECT.groupGrants,
} as const;
type MachineOpeningRow = Prisma.MachineGetPayload<{ include: typeof MACHINE_OPENING_INCLUDE }>;

// Bulk role maps need current permission facts, not Machine content or key material.
const MACHINE_PERMISSION_FACTS_SELECT = {
    id: true, kind: true, accountId: true,
    account: { select: { status: true } },
    accountGrants: { select: { accountId: true, accessLevel: true, account: { select: { status: true } } } },
    teamGrants: { select: { teamId: true, accessLevel: true, team: { select: { archivedAt: true,
        memberships: { select: { accountId: true, status: true, account: { select: { status: true } } } },
    } } } },
    groupGrants: { select: { teamGroupId: true, accessLevel: true, teamGroup: { select: {
        teamId: true, archivedAt: true, team: { select: { archivedAt: true } },
        memberships: { select: { teamMembership: { select: { accountId: true, status: true, account: { select: { status: true } } } } } },
    } } } },
} as const;
type MachinePermissionFacts = Prisma.MachineGetPayload<{ select: typeof MACHINE_PERMISSION_FACTS_SELECT }>;

async function readFactsInTx(tx: Tx, machineId: string, actorAccountId?: string) {
    return tx.machine.findUnique({ where: { id: machineId },
        select: actorAccountId === undefined ? MACHINE_ACCESS_FACTS_SELECT : buildMachineAdmissionFactsSelect(actorAccountId) });
}
type MachineFacts = NonNullable<Awaited<ReturnType<typeof readFactsInTx>>>;
export type MachineAdmissionFacts = MachineFacts;
type Contribution = Readonly<{ principal: PrincipalRefV1; level: 'view' | 'admin'; displayName: string | null; accountIds: readonly string[] }>;

function contributions(row: MachineFacts | MachinePermissionFacts): Contribution[] {
    return [
        ...row.accountGrants.map(grant => ({ principal: { kind: 'account' as const, accountId: grant.accountId }, level: grant.accessLevel,
            displayName: resolveAccountDisplayLabelV1('name' in grant.account ? grant.account : {}), accountIds: grant.account.status === 'active' ? [grant.accountId] : [] })),
        ...row.teamGrants.map(grant => ({ principal: { kind: 'team' as const, teamId: grant.teamId }, level: grant.accessLevel,
            displayName: 'name' in grant.team ? grant.team.name : null, accountIds: grant.team.memberships.filter(member => isEffectiveTeamMembership({
                accountStatus: member.account.status, membershipStatus: member.status, teamArchivedAt: grant.team.archivedAt,
            })).map(member => member.accountId) })),
        ...row.groupGrants.map(grant => ({ principal: { kind: 'group' as const, teamId: grant.teamGroup.teamId, groupId: grant.teamGroupId }, level: grant.accessLevel,
            displayName: 'name' in grant.teamGroup ? grant.teamGroup.name : null, accountIds: grant.teamGroup.memberships.filter(({ teamMembership: member }) => isEffectiveTeamGroupMembership({
                accountStatus: member.account.status, membershipStatus: member.status,
                teamArchivedAt: grant.teamGroup.team.archivedAt, groupArchivedAt: grant.teamGroup.archivedAt,
            })).map(({ teamMembership: member }) => member.accountId) })),
    ];
}
function effectiveRole(row: MachineFacts | MachinePermissionFacts, actorAccountId: string, sources?: readonly Contribution[]): MachineAccessRoleV1 | null {
    if (row.accountId === actorAccountId) return row.account.status === 'active' ? 'manage' : null;
    if (row.kind !== 'persistent') return null;
    let role: MachineAccessRoleV1 | null = null;
    for (const source of sources ?? contributions(row)) if (source.accountIds.includes(actorAccountId)) {
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
function resolveMachineRpcRequiredRole(input: Readonly<{
    method: string; owned: boolean; requiredRole: MachineAccessRoleV1; actionId?: string;
}>): MachineAccessRoleV1 | null {
    const policy = resolveMachineRpcRoutePolicy(input.method).sharedMachineAccess;
    if (policy === 'custodian_only' && !input.owned) return null;
    // Capability discovery and installation share a transport, not a role.
    return policy === 'manage' || input.actionId === 'machines.capabilities.install' ? 'manage' : input.requiredRole;
}

export async function resolveEffectiveMachineAccessForMachinesInTx(tx: Tx, input: Readonly<{ machineIds: readonly string[]; accountIds: readonly string[]; rpcMethod?: string }>): Promise<Map<string, Map<string, MachineAccessRoleV1 | null>>> {
    const result = new Map<string, Map<string, MachineAccessRoleV1 | null>>();
    const machineIds = [...new Set(input.machineIds)];
    if (machineIds.length === 0) return result;
    const byId = new Map<string, MachinePermissionFacts>();
    // Prisma 6.19.2 emits eight fixed relation-projection bindings in addition to IDs.
    for (const ids of portableQueryChunks({ values: machineIds, bindingsPerValue: 1, fixedBindings: 8 })) {
        const rows = await tx.machine.findMany({ where: { id: { in: [...ids] } }, select: MACHINE_PERMISSION_FACTS_SELECT });
        for (const row of rows) byId.set(row.id, row);
    }
    for (const machineId of machineIds) {
        const row = byId.get(machineId);
        const sources = row ? contributions(row) : [];
        result.set(machineId, new Map(input.accountIds.map(accountId => {
            const role = row ? effectiveRole(row, accountId, sources) : null;
            const required = input.rpcMethod && row ? resolveMachineRpcRequiredRole({ method: input.rpcMethod,
                owned: row.accountId === accountId, requiredRole: 'use' }) : 'use';
            return [accountId, required !== null && (required !== 'manage' || role === 'manage') ? role : null] as const;
        })));
    }
    return result;
}
/** The current structural audience includes the original custodian, irrespective of key delivery. */
export async function resolveCurrentMachineRecipientAccountIdsInTx(tx: Tx, machineId: string, custodianAccountId?: string): Promise<string[]> {
    return readMachineAudienceAccountIdsInTx(tx, machineId, custodianAccountId);
}
export async function listMachineCandidatesInTx(
    tx: Tx,
    actorAccountId: string,
    options: Readonly<{ includeRevokedOwned?: boolean }> = {},
): Promise<string[]> {
    const [owned, direct, memberships, groupMemberships] = await Promise.all([
        tx.machine.findMany({ where: { accountId: actorAccountId, ...(options.includeRevokedOwned ? {} : { revokedAt: null }) }, select: { id: true } }),
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
export function resourceContentMatchesMode(row: Pick<MachineFacts, 'metadata' | 'daemonState' | 'dataEncryptionKey'>, mode: 'plain' | 'e2ee'): boolean {
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
async function readRecipientAccessMaterialInTx(tx: Tx, actorAccountId: string, machineIds: readonly string[]) {
    const recipient = await tx.account.findUnique({ where: { id: actorAccountId }, select: RECIPIENT_READINESS_SELECT });
    const readiness = recipient ? deriveAccountRecipientEnvelopeReadinessFromRow(recipient) : null;
    const envelopes = new Map<string, MachineKeyEnvelope>();
    if (readiness?.status === 'available') {
        // Recipient equality and the portable Prisma OFFSET accompany the ID set.
        for (const ids of portableQueryChunks({ values: machineIds, bindingsPerValue: 1, fixedBindings: 2 })) {
            const rows = await tx.machineKeyEnvelope.findMany({ where: { machineId: { in: [...ids] }, recipientAccountId: actorAccountId } });
            for (const row of rows) envelopes.set(row.machineId, row);
        }
    }
    return { readiness, envelopes };
}

async function accessFromFactsInTx(tx: Tx, row: MachineFacts, actorAccountId: string,
    material?: Awaited<ReturnType<typeof readRecipientAccessMaterialInTx>>,
    sources?: readonly Contribution[], admittedRole?: MachineAccessRoleV1): Promise<MachineAccessFacts | null> {
    const role = admittedRole ?? effectiveRole(row, actorAccountId, sources);
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
        const { readiness, envelopes } = material ?? await readRecipientAccessMaterialInTx(tx, actorAccountId, [row.id]);
        if (readiness?.status === 'unavailable' && readiness.reason === 'plain_account') {
            accessState = 'refused'; reason = 'recipient_encryption_incompatible';
        } else if (readiness?.status !== 'available') {
            accessState = 'key_pending'; reason = 'encryption_material_unavailable';
        }
        else {
            const envelope = envelopes.get(row.id);
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
/** Share one current Machine/grant graph while keeping recipient readiness actor-specific. */
export async function resolveMachineAccessForActorsInTx(tx: Tx, input: Readonly<{
    machineId: string; actorAccountIds: readonly string[];
}>): Promise<Map<string, MachineAccessFacts | null>> {
    const result = new Map<string, MachineAccessFacts | null>();
    const actorAccountIds = [...new Set(input.actorAccountIds)];
    if (actorAccountIds.length === 0) return result;
    const row = await readFactsInTx(tx, input.machineId, actorAccountIds.length === 1 ? actorAccountIds[0] : undefined);
    const sources = row ? contributions(row) : [];
    for (const actorAccountId of actorAccountIds) {
        result.set(actorAccountId, row ? await accessFromFactsInTx(tx, row, actorAccountId, undefined, sources) : null);
    }
    return result;
}
export async function resolveMachineAccessInTx(tx: Tx, input: MachineActor): Promise<MachineAccessFacts | null> {
    const access = await resolveMachineAccessForActorsInTx(tx, { machineId: input.machineId, actorAccountIds: [input.actorAccountId] });
    return access.get(input.actorAccountId) ?? null;
}
export async function resolveMachineAccess(input: MachineActor) { return inTx(tx => resolveMachineAccessInTx(tx, input)); }
export async function readAccessibleMachineAccessInTx(tx: Tx, input: MachineActor): Promise<AccessibleMachineAccessV1 | null> {
    const openings = await readAccessibleMachineOpeningsInTx(tx, { actorAccountId: input.actorAccountId, machineIds: [input.machineId] });
    return openings.get(input.machineId)?.access ?? null;
}
/** Opening material is caller-specific; the separate C40 Machine write basis owns CAS identity. */
export async function readMachineDataKeyForCallerInTx(tx: Tx, input: MachineActor): Promise<Uint8Array<ArrayBuffer> | null> {
    const openings = await readAccessibleMachineOpeningsInTx(tx, { actorAccountId: input.actorAccountId, machineIds: [input.machineId] });
    const opening = openings.get(input.machineId);
    return opening?.access.accessState === 'ready' ? opening.callerDataEncryptionKey : null;
}
export interface MachineAdmissionInput extends MachineActor, Partial<MachineOperationRequesterContext> {
    requiredRole?: MachineAccessRoleV1;
    requireOnline?: boolean;
    rpcMethod?: string;
    /** Reviewed composite effects retain role custody while checking their actual operation. */
    operationRpcMethod?: string;
    actionId?: string;
}
/** Workflow ownership predates installation identity and published Machine content.
 * Preserve those owned records; shared execution still consumes strict admission.
 * Occurrence preparation owns whether a reversibly replaced assignment is frozen.
 */
export type WorkflowMachineAdmission = Exclude<MachineAdmission, { kind: 'admitted' }>
    | (Omit<Extract<MachineAdmission, { kind: 'admitted' }>, 'installationId'> & {
        installationId: string | null;
        availability: 'available' | 'replaced';
    });
type WorkflowMachineAdmissionInput = MachineActor & Readonly<{ purpose: 'workflow' }>;
export async function resolveMachineAdmissionInTx(tx: Tx, input: MachineAdmissionInput): Promise<MachineAdmission> {
    const rows = await readMachineFactsInTx(tx, input.actorAccountId, [input.machineId]);
    return resolveMachineAdmissionFromFactsInTx(tx, rows.get(input.machineId) ?? null, input);
}

/** Ownership decides the role without reading unrelated foreign grant graphs. */
async function readMachineFactsInTx(tx: Tx, actorAccountId: string, machineIds: readonly string[]): Promise<ReadonlyMap<string, MachineFacts>> {
    const rows = await tx.machine.findMany({ where: { id: { in: [...machineIds] } }, select: MACHINE_RESOURCE_FACTS_SELECT });
    const result = new Map<string, MachineFacts>();
    for (const row of rows) if (row.accountId === actorAccountId) {
        // Account status, mode, content, installation and lifecycle still reach
        // the same admission policy. Grants cannot change an owner's role.
        result.set(row.id, { ...row, accountGrants: [], teamGrants: [], groupGrants: [] });
    }
    const foreignIds = rows.filter(row => row.accountId !== actorAccountId).map(row => row.id);
    if (foreignIds.length > 0) {
        const foreignRows = await tx.machine.findMany({ where: { id: { in: foreignIds } }, select: MACHINE_ACCESS_FACTS_SELECT });
        for (const row of foreignRows) result.set(row.id, row);
    }
    return result;
}

interface AccessibleMachineOpening {
    machine: Machine & Pick<MachineOpeningRow, 'managedResource'>;
    access: AccessibleMachineAccessV1;
    owned: boolean;
    callerDataEncryptionKey: Uint8Array<ArrayBuffer> | null;
    recipientWorkPending?: boolean;
    recipientWorkCursor?: number;
}

/** Acquire row material and its opening together; callers never reacquire admitted content. */
export async function readAccessibleMachineOpeningsInTx(tx: Tx, input: Readonly<{
    actorAccountId: string; machineIds: readonly string[];
    includeRecipientWork?: true;
}>): Promise<ReadonlyMap<string, AccessibleMachineOpening>> {
    const result = new Map<string, AccessibleMachineOpening>();
    if (input.machineIds.length === 0) return result;
    const rows: MachineOpeningRow[] = [];
    // An owner's grants cannot change their role. Do not load their foreign grant graph.
    const foreignGrant = { machine: { accountId: { not: input.actorAccountId } } };
    // Eight relation-projection bindings plus the three foreign-custody predicates.
    for (const ids of portableQueryChunks({ values: [...new Set(input.machineIds)], bindingsPerValue: 1, fixedBindings: 11 })) {
        rows.push(...await tx.machine.findMany({ where: { id: { in: [...ids] } }, include: {
            ...MACHINE_OPENING_INCLUDE,
            accountGrants: { ...MACHINE_OPENING_INCLUDE.accountGrants, where: foreignGrant },
            teamGrants: { ...MACHINE_OPENING_INCLUDE.teamGrants, where: foreignGrant },
            groupGrants: { ...MACHINE_OPENING_INCLUDE.groupGrants, where: foreignGrant },
        } }));
    }
    const foreignEncryptedIds = rows.filter(row => row.accountId !== input.actorAccountId && resourceMode(row) === 'e2ee').map(row => row.id);
    const material = foreignEncryptedIds.length > 0
        ? await readRecipientAccessMaterialInTx(tx, input.actorAccountId, foreignEncryptedIds) : undefined;
    for (const row of rows) {
        const facts = await accessFromFactsInTx(tx, row, input.actorAccountId, material);
        if (!facts) continue;
        const key = facts.owned ? row.dataEncryptionKey
            : facts.accessState === 'ready' && facts.encryptionMode === 'e2ee' ? material?.envelopes.get(row.id)?.encryptedDataKey : null;
        result.set(row.id, {
            machine: row,
            access: { custodian: { accountId: row.accountId, displayName: resolveAccountDisplayLabelV1(row.account) ?? '' },
                role: facts.role, resourceMode: facts.encryptionMode, accessState: facts.accessState },
            owned: facts.owned,
            callerDataEncryptionKey: key ? new Uint8Array(key) : null,
        });
    }
    const managed = input.includeRecipientWork ? [...result.values()].filter(opening => opening.access.role === 'manage'
        && opening.access.resourceMode === 'e2ee' && opening.access.accessState === 'ready'
        && opening.machine.revokedAt === null && opening.machine.replacedByMachineId === null) : [];
    const recipientWork = await readMachineRecipientWorkInTx(tx, { actorAccountId: input.actorAccountId,
        ownerFingerprints: new Map(managed.map(({ machine }) => [machine.id, machine.dataEncryptionKey
            ? computeMachineOwnerEnvelopeFingerprintV1(machine.dataEncryptionKey) : null])) });
    for (const opening of managed) {
        const work = recipientWork.get(opening.machine.id);
        opening.recipientWorkPending = work?.recipients.some(isMachineRecipientWorkPending) ?? false;
        opening.recipientWorkCursor = work?.cursor ?? 0;
    }
    return result;
}

type MachineAdmissionsInput = Readonly<{
    actorAccountId: string; machineIds: readonly string[];
}>;
/** Set-oriented default-use admission; point and batch readers share every policy decision. */
export function resolveMachineAdmissionsInTx(tx: Tx, input: MachineAdmissionsInput & Readonly<{ purpose: 'workflow' }>): Promise<ReadonlyMap<string, WorkflowMachineAdmission>>;
export function resolveMachineAdmissionsInTx(tx: Tx, input: MachineAdmissionsInput): Promise<ReadonlyMap<string, MachineAdmission>>;
export async function resolveMachineAdmissionsInTx(tx: Tx, input: MachineAdmissionsInput & Readonly<{ purpose?: 'workflow' }>): Promise<ReadonlyMap<string, MachineAdmission | WorkflowMachineAdmission>> {
    const machineIds = [...new Set(input.machineIds)];
    if (machineIds.length === 0) return new Map();
    const byId = await readMachineFactsInTx(tx, input.actorAccountId, machineIds);
    const result = new Map<string, MachineAdmission | WorkflowMachineAdmission>();
    for (const machineId of machineIds) result.set(machineId, await resolveMachineAdmissionFromFactsInTx(tx, byId.get(machineId) ?? null,
        { actorAccountId: input.actorAccountId, machineId, ...(input.purpose === 'workflow' ? { purpose: 'workflow' as const } : {}) }));
    return result;
}

export function resolveMachineAdmissionFromFactsInTx(tx: Tx, row: MachineFacts | null, input: WorkflowMachineAdmissionInput): Promise<WorkflowMachineAdmission>;
export function resolveMachineAdmissionFromFactsInTx(tx: Tx, row: MachineFacts | null, input: MachineAdmissionInput): Promise<MachineAdmission>;
export async function resolveMachineAdmissionFromFactsInTx(tx: Tx, row: MachineFacts | null, input: MachineAdmissionInput & Readonly<{ purpose?: 'workflow' }>): Promise<MachineAdmission | WorkflowMachineAdmission> {

    const access = row && await accessFromFactsInTx(tx, row, input.actorAccountId);
    if (!row || !access) return { kind: 'denied', code: 'access_denied' };
    if (input.purpose === 'workflow' && access.owned) {
        const availability = classifyMachineAvailabilityState(row);
        if (availability !== 'available' && availability !== 'replaced') return { kind: 'denied', code: 'machine_unavailable' };
        return { kind: 'admitted', actorAccountId: input.actorAccountId, custodianAccountId: row.accountId,
            machineId: row.id, installationId: row.installationId, role: access.role, encryptionMode: access.encryptionMode,
            availability };
    }
    if (!resourceContentMatchesMode(row, access.encryptionMode)) return { kind: 'denied', code: 'encryption_material_unavailable' };
    if (row.revokedAt || row.replacedByMachineId || !row.installationId || (input.requireOnline === true && !row.active)) return { kind: 'denied', code: 'machine_unavailable' };
    // A template creates the same requester-owned Session as ordinary New Session.
    // Keep its signed root while consuming the existing spawn role/isolation policy.
    const operationActionId = input.actionId === 'template.instantiate' ? 'session.spawn_new' : input.actionId;
    let requiredRole = input.requiredRole ?? 'use';
    const browserExtensionAction = input.actionId !== undefined && isBrowserExtensionActionIdV1(input.actionId);
    if (input.actionId && requiredMachineRoleForBrowserAction(input.actionId) === 'manage') requiredRole = 'manage';
    let method = input.rpcMethod;
    const requesterSessionLifecycle = operationActionId === 'session.spawn_new' || operationActionId === 'session.open';
    if (input.actionId && !method) {
        const actionId = SignedRootActionIdSchema.safeParse(input.actionId);
        const spec = actionId.success ? getActionSpec(actionId.data) : null;
        // Session creation/resume uses admitted requester custody at the Action ingress.
        // Its private raw RPC binding remains custodian-only when requested directly.
        method = requesterSessionLifecycle ? undefined : isProviderActionIdV1(input.actionId)
            ? resolveProviderActionRpcRouteV1(input.actionId)?.method : spec?.bindings?.rpcMethod;
        if (!method && !access.owned && !requesterSessionLifecycle && !browserExtensionAction && !isRequesterProjectExecutionActionV1(input.actionId)) {
            return { kind: 'denied', code: 'unsupported_operation' };
        }
    }
    if (method) {
        const rpcRole = resolveMachineRpcRequiredRole({ method, owned: access.owned, requiredRole, actionId: operationActionId });
        if (rpcRole === null) return { kind: 'denied', code: 'custodian_only' };
        requiredRole = rpcRole;
    }
    if (requiredRole === 'manage' && access.role !== 'manage') return { kind: 'denied', code: 'access_denied' };
    if (!isMachineOperationSupportedForRequester({ actorAccountId: input.actorAccountId, machine: row,
        rpcMethod: input.operationRpcMethod ?? method, actionId: operationActionId,
        callerAuthority: input.callerAuthority, sessionActionOrigin: input.sessionActionOrigin,
        executionBinding: input.executionBinding })) {
        return { kind: 'denied', code: 'daemon_upgrade_required' };
    }
    if (access.accessState === 'refused') return { kind: 'denied', code: 'recipient_encryption_incompatible' };
    if (access.accessState !== 'ready') return { kind: 'denied', code: 'recipient_key_pending' };
    return { kind: 'admitted', actorAccountId: input.actorAccountId, custodianAccountId: row.accountId,
        machineId: row.id, installationId: row.installationId, role: access.role, encryptionMode: access.encryptionMode,
        ...(input.purpose === 'workflow' ? { availability: 'available' as const } : {}) };
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
    return captureMachineAccessImpactsInTx(tx, { machineIds: [machineId], accountIds });
}
async function publishMutationInTx(tx: Tx, impacts: Awaited<ReturnType<typeof mutationImpactInTx>>, changedAccountId?: string) {
    await applyMachineAccessImpactsInTx(tx, { impacts: impacts.values(), grantRosterChanged: true, ...(changedAccountId ? { directGrantChangedAccountId: changedAccountId } : {}) });
}
/** Stabilize Machine content after Account admission and before reading its CAS basis. */
export async function lockMachinePublicationInTx(tx: Tx, machineId: string): Promise<void> {
    // Content Account admission permits peer PostgreSQL Machine writes. MySQL's
    // exclusive Account admission and SQLite's single writer already exclude peers.
    if (getDbProviderFromEnv(process.env, 'postgres') === 'postgres') {
        await tx.$queryRawUnsafe('SELECT "id" FROM "Machine" WHERE "id" = $1 FOR NO KEY UPDATE', machineId);
    }
}

/** Fence existing and prospective recipients before authority, key or grant reads. */
export async function acquireMachineAccessPublicationLocksInTx(tx: Tx, machineId: string, principal?: PrincipalRefV1): Promise<void> {
    const provider = getDbProviderFromEnv(process.env, 'postgres');
    if (provider === 'sqlite') return;
    const readAudience = async () => {
        const accountIds = await resolveCurrentMachineRecipientAccountIdsInTx(tx, machineId);
        if (principal?.kind === 'account') accountIds.push(principal.accountId);
        else if (principal?.kind === 'team') {
            const team = await tx.team.findUnique({ where: { id: principal.teamId },
                select: { memberships: { select: { accountId: true } } } });
            accountIds.push(...team?.memberships.map(member => member.accountId) ?? []);
        } else if (principal?.kind === 'group') {
            const group = await tx.teamGroup.findUnique({ where: { id: principal.groupId },
                select: { memberships: { select: { teamMembership: { select: { accountId: true } } } } } });
            accountIds.push(...group?.memberships.map(member => member.teamMembership.accountId) ?? []);
        }
        return accountIds;
    };
    const captured = new Set(await readAudience());
    await acquireAccountChangePublicationLocksInTx(tx, [...captured], { includeSingleAccount: true });
    await lockMachinePublicationInTx(tx, machineId);
    // ReadCommitted can observe audience growth during the wait. Replay through
    // inTx rather than extending a sorted lock set with a lower-id recipient.
    if ((await readAudience()).some(accountId => !captured.has(accountId))) {
        throw new TransactionReplayRequiredError('transaction-account-audience-changed');
    }
    beforeAccountChangePublication(tx, [...captured], async () => {
        assertAccountChangePublicationAudienceInTx(tx, await readAudience());
    });
}
/** Idempotent per-principal grants; Manage can delegate Manage without replacing custody. */
export async function setMachineAccessGrantInTx(tx: Tx, input: MachineActor & Readonly<{ principal: PrincipalRefV1; level: 'view' | 'admin' }>): Promise<MachineAccessMutationResultV1> {
    await acquireMachineAccessPublicationLocksInTx(tx, input.machineId, input.principal);
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
    await acquireMachineAccessPublicationLocksInTx(tx, input.machineId, input.principal);
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
        const ids = (await resolveCurrentMachineRecipientAccountIdsInTx(tx, row.id))
            .filter(accountId => accountId !== row.accountId && (after === null || accountId > after));
        for (let offset = 0; offset < ids.length && nextCursor === null;) {
            // The response page owns the scan batch; one further qualifying row proves continuation.
            const batchIds = ids.slice(offset, offset + query.limit + 1);
            offset += batchIds.length;
            const accounts = await tx.account.findMany({
                where: { id: { in: batchIds } }, select: RECIPIENT_READINESS_SELECT,
            });
            const envelopes = await tx.machineKeyEnvelope.findMany({
                where: { machineId: row.id, recipientAccountId: { in: batchIds } },
            });
            const accountsById = new Map(accounts.map(account => [account.id, account]));
            const envelopesByAccountId = new Map(envelopes.map(envelope => [envelope.recipientAccountId, envelope]));
            for (const accountId of batchIds) {
                const account = accountsById.get(accountId);
                if (!account) continue;
                const projected = projectMachineRecipientWork(account, envelopesByAccountId.get(accountId) ?? null, fingerprint);
                if (query.state === 'action_required' && !isMachineRecipientWorkPending(projected)) continue;
                if (recipients.length === query.limit) { nextCursor = encodeSessionDataKeyEnvelopeCursorV1(recipients[recipients.length - 1].recipientAccountId); break; }
                const { current: _current, ...recipient } = projected;
                recipients.push(recipient);
            }
        }
    }
    return { machineId: row.id, custodianAccountId: row.accountId, encryptionMode, machineOwnerEnvelopeFingerprint: fingerprint,
        callerDataEncryptionKey: callerKey ? encodeBase64(callerKey) : null, nextCursor, recipients,
        content: { metadata: row.metadata, metadataVersion: row.metadataVersion, daemonState: row.daemonState, daemonStateVersion: row.daemonStateVersion } };
}
/** Atomic opaque tuple commit after current Manage, holder, whole-blob versions and recipient binding recheck. */
export async function commitMachineRecipientKeyEnvelopesInTx(tx: Tx, input: MachineRecipientKeyEnvelopeCommitInputV1 & Readonly<{ actorAccountId: string }>): Promise<MachineRecipientKeyEnvelopeCommitResponseV1 | MachineAccessRefusalV1> {
    await acquireMachineAccessPublicationLocksInTx(tx, input.machineId);
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
    const recipientIds = [...new Set(input.recipientKeyEnvelopes.map(envelope => envelope.recipientAccountId))];
    const accounts = recipientIds.length === 0 ? [] : await tx.account.findMany({
        where: { id: { in: recipientIds } }, select: RECIPIENT_READINESS_SELECT,
    });
    const accountsById = new Map(accounts.map(account => [account.id, account]));
    const sources = contributions(row);
    const prepared: Array<{ recipientAccountId: string; encryptedDataKey: Uint8Array<ArrayBuffer>; recipientContentPublicKeyFingerprint: string }> = [];
    for (const envelope of input.recipientKeyEnvelopes) {
        const encryptedDataKey = new Uint8Array(decodeBase64(envelope.encryptedDataKey));
        if (!parseEncryptedDataKeyEnvelopeV1(encryptedDataKey)) return refusal('invalid_recipient_envelope');
        if (envelope.recipientAccountId === row.accountId || !effectiveRole(row, envelope.recipientAccountId, sources)) return refusal('access_denied');
        const account = accountsById.get(envelope.recipientAccountId);
        const readiness = account ? deriveAccountRecipientEnvelopeReadinessFromRow(account) : null;
        if (readiness?.status !== 'available' || readiness.binding.contentPublicKeyFingerprint !== envelope.recipientContentPublicKeyFingerprint) return refusal('recipient_binding_changed');
        prepared.push({ recipientAccountId: envelope.recipientAccountId, encryptedDataKey, recipientContentPublicKeyFingerprint: envelope.recipientContentPublicKeyFingerprint });
    }
    for (const envelope of prepared) {
        const data = { encryptedDataKey: envelope.encryptedDataKey, machineOwnerEnvelopeFingerprint: fingerprint, recipientContentPublicKeyFingerprint: envelope.recipientContentPublicKeyFingerprint };
        await tx.machineKeyEnvelope.upsert({ where: { machineId_recipientAccountId: { machineId: row.id, recipientAccountId: envelope.recipientAccountId } },
            create: { machineId: row.id, recipientAccountId: envelope.recipientAccountId, ...data }, update: data });
    }
    await markAccountsChanged(tx, { accountIds: prepared.map(envelope => envelope.recipientAccountId), kind: 'machine', entityId: row.id });
    return { appliedRecipientAccountIds: prepared.map(envelope => envelope.recipientAccountId), skippedRecipientAccountIds: [] };
}

export async function resolveMachinePrincipalAccessForMachinesInTx(tx: Tx, input: Readonly<{
    machineIds: readonly string[]; principal: Extract<PrincipalRefV1, { kind: 'account' | 'team' }>;
}>): Promise<Map<string, MachineAccessRoleV1 | null>> {
    const principal = input.principal;
    if (principal.kind === 'account') {
        const access = await resolveEffectiveMachineAccessForMachinesInTx(tx, { machineIds: input.machineIds, accountIds: [principal.accountId] });
        return new Map([...access].map(([id, roles]) => [id, roles.get(principal.accountId) ?? null]));
    }
    const result = new Map<string, MachineAccessRoleV1 | null>();
    for (const ids of portableQueryChunks({ values: [...new Set(input.machineIds)], bindingsPerValue: 1, fixedBindings: 2 })) {
        const rows = await tx.machine.findMany({ where: { id: { in: [...ids] } }, select: {
            id: true, kind: true, teamGrants: { where: { teamId: principal.teamId, team: { archivedAt: null } }, select: { accessLevel: true } },
        } });
        for (const row of rows) {
            const grant = row.kind === 'persistent' ? row.teamGrants[0] : undefined;
            result.set(row.id, grant ? grant.accessLevel === 'admin' ? 'manage' : 'use' : null);
        }
    }
    return result;
}
/** The current structural audience includes the original custodian, irrespective of key delivery. */
