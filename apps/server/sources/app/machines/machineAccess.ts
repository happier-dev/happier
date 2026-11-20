import { decodeMachineStoredContent, withMachineContentSelect } from '@/storage/sessionMachineStoredContent';
import type { ApiTokenSessionSpawnAdmissionV1 } from '@happier-dev/protocol/auth/apiTokenGrant';
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
import { resourceTeamShareScopeV1, type ResourceTeamShareScopeV1 } from '@happier-dev/protocol/teams/resourceGrantAccessV1';
import { resolveMachineRpcRoutePolicy } from '@happier-dev/protocol/machines/peer/mediation/rpc/routePolicyV1';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';
import { isRequesterProjectExecutionActionV1 } from '@happier-dev/protocol/actions/projectActionFamily';
import { isProjectWorkerCopyInspectActionIdV1 } from '@happier-dev/protocol/actions/specs/projectWorkersActionIdsV1';
import { isStoredDeploymentExecutionActionIdV1 } from '@happier-dev/protocol/deployments/deploymentActionIdsV1';
import { deploymentPreparationOperationForActionV1 } from '@happier-dev/protocol/deployments/deploymentPreparationAdmissionV1';
import { getActionSpec, SignedRootActionIdSchema, PluginPublicationActionOutputSchemas } from '@happier-dev/protocol/actions/actionSpecs';
import { isMachineAgentInventoryReadActionIdV1, RuntimeActionIdV1Schema, SESSION_MESSAGE_SEND_ACTION_ID_V1, SESSION_SPAWN_NEW_ACTION_ID_V1 } from '@happier-dev/protocol/actions/actionIds';
import { isBrowserRuntimeActionId } from '@happier-dev/protocol/actions/executor/browser';
import { isComputerRuntimeActionId } from '@happier-dev/protocol/actions/executor/computer';
import { requiredMachineRoleForBrowserAction } from '@happier-dev/protocol/actions';
import { NpmRegistryProfileActionOutputSchemasV1 } from '@happier-dev/protocol/actions/npmRegistryProfileActionFamily';
import { isProviderActionIdV1 } from '@happier-dev/protocol/providers/providerActionsV1';
import { resolveProviderActionRpcRouteV1 } from '@happier-dev/protocol/providers/executeProviderActionV1';
import { inTx, type Tx } from '@/storage/inTx';
import { withManagedWakeAvailabilityInTx } from './managed/managedWakeAvailability';
import type { MachineSerializationRow } from './machineSerialization';
import { getDbProviderFromEnv } from '@/storage/db';
import { resolveDbSqlDialect } from '@/config/databaseProvider';
import { portableQueryChunks } from '@/storage/portableQueryChunks';
import { projectResourceGrantRows, resourceGrantArmWheres, validateResourceGrantPrincipalInTx } from '@/app/teams/resourceGrantAccess';
import { deriveAccountRecipientEnvelopeReadinessFromRow } from '@/app/encryption/accountRecipientEnvelopeReadiness';
import { RECIPIENT_READINESS_SELECT } from '@/app/session/encryption/sessionDataKeyRecipientProjection';
import { resolveAccountDisplayLabelV1, ACCOUNT_DISPLAY_PROFILE_SELECT } from '@/app/account/profile/accountDisplayProfile';
import { acquireAccountChangePublicationLocksInTx, markAccountsChanged } from '@/app/changes/markAccountChanged';
import { resolveEffectiveAccountEncryptionModeFromAccountRow } from '@/app/encryption/accountEncryptionMode';
import { captureMachineAccessImpactsInTx, applyMachineAccessImpactsInTx } from './machineAccessEffects';
import { isMachineOperationSupportedForRequester, type MachineOperationRequesterContext } from './machineOperationSupport';
import { isMachineRecipientWorkPending, projectMachineRecipientWork, readMachineAudienceAccountIdsInTx, readMachineAudienceAccountIdsForMachinesInTx, readMachineRecipientWorkInTx } from './machineRecipientWork';
import { classifyMachineAvailabilityState, readMachineOnlineAvailabilityDiagnostic } from './machineStateGuards';
import { MACHINE_PERMISSION_FACTS_SELECT, machineGrantRelationsSelect, contributions, readMachineRoleGraphInTx, projectMachineRoles, readMachineRoleGraphForMachinesInTx, projectMachineTeamRoles, expandMachineIdsWithManagedGuestsInTx } from './machineRole';
import { projectTeamGroupNameForRecipient } from '@/app/teams/groups/privateLabels';
import type { SocketRpcMachineAdmissionContextV1 } from '@happier-dev/protocol/machines/machineAccessV1';

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
        managedResource: { select: { custodianAccountId: true, controllerMachineId: true } },
        daemonState: true, daemonStateVersion: true, dataEncryptionKey: true,
        installationId: true, active: true, revokedAt: true, replacedByMachineId: true,
        operationProtocolCapabilities: true, operationProtocolCapabilitiesRevision: true,
        account: { select: { ...ACCOUNT_DISPLAY_PROFILE_SELECT, encryptionMode: true, status: true } },
    } as const;

function machineAccessGrantRelationsSelect(actorAccountId?: string) {
    const { grants } = machineGrantRelationsSelect(actorAccountId);
    return { grants: { ...grants,
        ...(actorAccountId === undefined ? {} : { where: { ...grants.where,
            machine: { accountId: { not: actorAccountId } },
        } }),
        select: { ...grants.select,
            account: { select: { status: true, ...ACCOUNT_DISPLAY_PROFILE_SELECT } },
            team: { select: { ...grants.select.team.select, name: true } },
            teamGroup: { select: { ...grants.select.teamGroup.select, name: true } },
        },
    } } as const;
}

const MACHINE_ACCESS_FACTS_SELECT = { ...MACHINE_RESOURCE_FACTS_SELECT, ...machineAccessGrantRelationsSelect() } as const;

/** Same current Machine graph for exact Session binding and Machine admission. */
export function buildMachineAdmissionFactsSelect(actorAccountId: string) {
    return { ...MACHINE_RESOURCE_FACTS_SELECT, ...machineAccessGrantRelationsSelect(actorAccountId) } as const;
}

const MACHINE_OPENING_INCLUDE = {
    managedResource: true,
    account: MACHINE_RESOURCE_FACTS_SELECT.account,
    grants: MACHINE_ACCESS_FACTS_SELECT.grants,
} as const;
type MachineOpeningStorageRow = Prisma.MachineGetPayload<{ include: typeof MACHINE_OPENING_INCLUDE }>;
type MachineOpeningRow = MachineOpeningStorageRow & ReturnType<typeof projectResourceGrantRows<MachineOpeningStorageRow['grants'][number]>>;

async function readFactsInTx(tx: Tx, machineId: string, actorAccountId?: string) {
    const row = await tx.machine.findUnique({ where: { id: machineId },
        select: withMachineContentSelect(actorAccountId === undefined ? MACHINE_ACCESS_FACTS_SELECT : buildMachineAdmissionFactsSelect(actorAccountId)) }).then(decodeMachineStoredContent);
    return row ? { ...row, ...projectResourceGrantRows(row.grants) } : null;
}
type MachineFacts = NonNullable<Awaited<ReturnType<typeof readFactsInTx>>>;
type MachineResourceFacts = Prisma.MachineGetPayload<{ select: typeof MACHINE_RESOURCE_FACTS_SELECT }>;
export type MachineAdmissionFacts = Prisma.MachineGetPayload<{ select: ReturnType<typeof buildMachineAdmissionFactsSelect> }>;
/** Permission only: current grants/current membership, never key presence or Session history. */
export async function resolveEffectiveMachineRoleInTx(tx: Tx, input: MachineActor): Promise<MachineAccessRoleV1 | null> {
    const roles = await resolveEffectiveMachineAccessForMachinesInTx(tx, { machineIds: [input.machineId], accountIds: [input.actorAccountId] });
    return roles.get(input.machineId)?.get(input.actorAccountId) ?? null;
}

async function machineRolesInTx(tx: Tx, rows: readonly Parameters<typeof readMachineRoleGraphInTx>[1][number][], accountIds: readonly string[]) {
    return projectMachineRoles(await readMachineRoleGraphInTx(tx, rows, accountIds), accountIds);
}

/** Current grant lookup for work whose Session binding was already admitted.
 * This does not admit a new Machine operation or reopen recipient key material.
 */
export async function projectActiveMachineAdmissionFromFacts(
    tx: Tx, row: MachineAdmissionFacts, actorAccountId: string,
): Promise<SocketRpcMachineAdmissionContextV1 | null> {
    const facts = { ...row, ...projectResourceGrantRows(row.grants) };
    const role = (await machineRolesInTx(tx, [facts], [actorAccountId])).get(facts.id)?.get(actorAccountId) ?? null;
    const encryptionMode = resourceMode(facts);
    if (!role || !encryptionMode || !facts.installationId
        || classifyMachineAvailabilityState(facts) !== 'available') return null;
    return { actorAccountId, custodianAccountId: facts.accountId, machineId: facts.id,
        installationId: facts.installationId, role, encryptionMode };
}
function resolveMachineRpcRequiredRole(input: Readonly<{
    method: string; owned: boolean; requiredRole: MachineAccessRoleV1; actionId?: string;
}>): MachineAccessRoleV1 | null {
    const policy = resolveMachineRpcRoutePolicy(input.method).sharedMachineAccess;
    if (policy === 'custodian_only' && !input.owned) return null;
    // Discovery/acquisition and Machine administration can share a transport.
    return policy === 'manage' || input.actionId === 'machines.capabilities.install'
        || input.actionId === 'machines.agents.uninstall' ? 'manage' : input.requiredRole;
}

export async function resolveEffectiveMachineAccessForMachinesInTx(tx: Tx, input: Readonly<{
    machineIds: readonly string[]; accountIds: readonly string[]; rpcMethod?: string;
}>): Promise<Map<string, Map<string, MachineAccessRoleV1 | null>>> {
    const result = new Map<string, Map<string, MachineAccessRoleV1 | null>>();
    const machineIds = [...new Set(input.machineIds)];
    if (machineIds.length === 0) return result;
    const graph = await readMachineRoleGraphForMachinesInTx(tx, machineIds, input.accountIds);
    const roles = projectMachineRoles(graph, input.accountIds);
    for (const machineId of machineIds) {
        const row = graph.get(machineId);
        result.set(machineId, new Map(input.accountIds.map(accountId => {
            const role = roles.get(machineId)?.get(accountId) ?? null;
            const required = input.rpcMethod && row ? resolveMachineRpcRequiredRole({ method: input.rpcMethod,
                owned: row.accountId === accountId, requiredRole: 'use' }) : 'use';
            return [accountId, required !== null && (required !== 'manage' || role === 'manage') ? role : null] as const;
        })));
    }
    return result;
}

/** Workload authority is the explicit Source principal, never a member's personal share. */
export async function resolveMachinePrincipalAccessForMachinesInTx(tx: Tx, input: Readonly<{
    machineIds: readonly string[]; principal: Extract<PrincipalRefV1, { kind: 'account' | 'team' }>;
}>): Promise<Map<string, MachineAccessRoleV1 | null>> {
    const principal = input.principal;
    if (principal.kind === 'account') {
        const access = await resolveEffectiveMachineAccessForMachinesInTx(tx, { machineIds: input.machineIds, accountIds: [principal.accountId] });
        return new Map([...access].map(([id, roles]) => [id, roles.get(principal.accountId) ?? null]));
    }
    const rows: Parameters<typeof readMachineRoleGraphInTx>[1][number][] = [];
    for (const ids of portableQueryChunks({ values: [...new Set(input.machineIds)], bindingsPerValue: 1, fixedBindings: 9 })) {
        const loaded = await tx.machine.findMany({ where: { id: { in: [...ids] } }, select: withMachineContentSelect(MACHINE_PERMISSION_FACTS_SELECT) }).then(decodeMachineStoredContent);
        rows.push(...loaded.map(row => ({ ...row, ...projectResourceGrantRows(row.grants) })));
    }
    const roles = projectMachineTeamRoles(await readMachineRoleGraphInTx(tx, rows, []), principal.teamId);
    return new Map(input.machineIds.map(id => [id, roles.get(id) ?? null]));
}
/** The current structural audience includes the original custodian, irrespective of key delivery. */
export async function resolveCurrentMachineRecipientAccountIdsInTx(tx: Tx, machineId: string, custodianAccountId?: string): Promise<string[]> {
    return readMachineAudienceAccountIdsInTx(tx, machineId, custodianAccountId);
}
export async function listMachineCandidatesInTx(
    tx: Tx,
    actorAccountId: string,
    options: Readonly<{ includeRevokedOwned?: boolean; sharedWithTeamId?: string }> = {},
): Promise<string[]> {
    if (options.sharedWithTeamId) {
        return [...(await listScopedTeamMachineCandidatesInTx(tx, actorAccountId, options.sharedWithTeamId)).keys()];
    }
    const [owned, direct, memberships, groupMemberships] = await Promise.all([
        tx.machine.findMany({ where: { accountId: actorAccountId, ...(options.includeRevokedOwned ? {} : { revokedAt: null }) }, select: { id: true } }),
        tx.machineGrant.findMany({ where: { principalKind: 'account', accountId: actorAccountId }, select: { machineId: true } }),
        tx.teamMembership.findMany({ where: { accountId: actorAccountId }, select: { teamId: true } }),
        tx.teamGroupMembership.findMany({ where: { teamMembership: { accountId: actorAccountId } }, select: { teamGroupId: true } }),
    ]);
    const teams: { machineId: string }[] = [];
    const groups: { machineId: string }[] = [];
    for (const ids of portableQueryChunks({ values: memberships.map(member => member.teamId), bindingsPerValue: 1, fixedBindings: 1 })) {
        teams.push(...await tx.machineGrant.findMany({ where: { principalKind: 'team', teamId: { in: [...ids] } }, select: { machineId: true } }));
    }
    for (const ids of portableQueryChunks({ values: groupMemberships.map(member => member.teamGroupId), bindingsPerValue: 1, fixedBindings: 1 })) {
        groups.push(...await tx.machineGrant.findMany({ where: { principalKind: 'group', teamGroupId: { in: [...ids] } }, select: { machineId: true } }));
    }
    return expandMachineIdsWithManagedGuestsInTx(tx,
        [...owned.map(row => row.id), ...direct.map(row => row.machineId), ...teams.map(row => row.machineId), ...groups.map(row => row.machineId)]);
}

/** Preserve the qualifying grant arms, including inherited controller access, for scoped rows. */
export async function listScopedTeamMachineCandidatesInTx(tx: Tx, actorAccountId: string, teamId: string): Promise<Map<string, ResourceTeamShareScopeV1>> {
    const grants = resourceGrantArmWheres(actorAccountId, teamId);
    const [teams, groups] = await Promise.all([
        tx.machineGrant.findMany({ where: { principalKind: 'team', ...grants.team }, select: { machineId: true } }),
        tx.machineGrant.findMany({ where: { principalKind: 'group', ...grants.group }, select: { machineId: true } }),
    ]);
    const [teamIds, groupIds] = await Promise.all([
        expandMachineIdsWithManagedGuestsInTx(tx, teams.map(row => row.machineId)),
        expandMachineIdsWithManagedGuestsInTx(tx, groups.map(row => row.machineId)),
    ]);
    const team = new Set(teamIds);
    const group = new Set(groupIds);
    return new Map([...new Set([...teamIds, ...groupIds])].sort().map(id => [id,
        resourceTeamShareScopeV1({ team: team.has(id), group: group.has(id) })!]));
}

/** The Machine list's candidate/role owners, with no content, keys or native probes. */
export async function countScopedTeamMachinesInTx(tx: Tx, params: Readonly<{
    actorAccountId: string; sharedWithTeamId: string;
}>): Promise<Readonly<{ ok: true; count: number }>> {
    const candidates = await listMachineCandidatesInTx(tx, params.actorAccountId, params);
    const roles = await resolveEffectiveMachineAccessForMachinesInTx(tx, {
        machineIds: candidates, accountIds: [params.actorAccountId],
    });
    const machineIds = candidates.filter(id => roles.get(id)?.get(params.actorAccountId));
    let count = 0;
    for (const ids of portableQueryChunks({ values: machineIds, bindingsPerValue: 1, fixedBindings: 2 })) {
        count += await tx.machine.count({ where: { id: { in: [...ids] }, kind: 'persistent', revokedAt: null } });
    }
    return { ok: true, count };
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
    return { recipient, readiness, envelopes };
}

/** Read the existing key tuples for exact admitted Machine/recipient pairs in sets. */
async function readRecipientAccessMaterialsInTx(tx: Tx, targets: readonly MachineActor[]) {
    const dialect = resolveDbSqlDialect(getDbProviderFromEnv(process.env, 'postgres'));
    const materials = new Map<string, Awaited<ReturnType<typeof readRecipientAccessMaterialInTx>>>();
    const recipientIds = [...new Set(targets.map(target => target.actorAccountId))];
    const recipients: NonNullable<Awaited<ReturnType<typeof readRecipientAccessMaterialInTx>>['recipient']>[] = [];
    if (recipientIds.length > 0 && dialect === 'postgres') {
        const fields = Object.keys(RECIPIENT_READINESS_SELECT).map(field => `"${field}"`).join(', ');
        recipients.push(...await tx.$queryRawUnsafe<typeof recipients>(`SELECT ${fields} FROM "Account" WHERE "id" = ANY($1::text[])`, recipientIds));
    } else for (const ids of portableQueryChunks({ values: recipientIds, bindingsPerValue: 1, fixedBindings: 1 })) {
        recipients.push(...await tx.account.findMany({ where: { id: { in: [...ids] } }, select: RECIPIENT_READINESS_SELECT }));
    }
    for (const recipient of recipients) materials.set(recipient.id, { recipient,
        readiness: deriveAccountRecipientEnvelopeReadinessFromRow(recipient), envelopes: new Map() });
    for (const accountId of recipientIds) if (!materials.has(accountId)) materials.set(accountId, { recipient: null, readiness: null, envelopes: new Map() });
    const envelopeIds = [...new Map(targets
        .filter(target => materials.get(target.actorAccountId)?.readiness?.status === 'available')
        .map(target => {
            const id = { machineId: target.machineId, recipientAccountId: target.actorAccountId };
            return [JSON.stringify(id), id];
        })).values()];
    const envelopes: MachineKeyEnvelope[] = [];
    if (envelopeIds.length > 0 && dialect === 'postgres') {
        envelopes.push(...await tx.$queryRawUnsafe<MachineKeyEnvelope[]>(
            `SELECT e.* FROM "MachineKeyEnvelope" e
             JOIN jsonb_to_recordset($1::jsonb) AS requested("machineId" text, "recipientAccountId" text)
             ON e."machineId" = requested."machineId" AND e."recipientAccountId" = requested."recipientAccountId"`, JSON.stringify(envelopeIds)));
    } else for (const ids of portableQueryChunks({ values: envelopeIds, bindingsPerValue: 2, fixedBindings: 1 })) {
        envelopes.push(...await tx.machineKeyEnvelope.findMany({ where: { OR: [...ids] } }));
    }
    for (const envelope of envelopes) {
        materials.get(envelope.recipientAccountId)?.envelopes.set(envelope.machineId, envelope);
    }
    return materials;
}

async function accessFromFactsInTx(tx: Tx, row: MachineFacts, actorAccountId: string,
    material?: Awaited<ReturnType<typeof readRecipientAccessMaterialInTx>>,
    resolvedRole?: MachineAccessRoleV1 | null,
    storedContentMatchesByMachine?: Map<MachineFacts, boolean>): Promise<MachineAccessFacts | null> {
    const role = resolvedRole === undefined ? (await machineRolesInTx(tx, [row], [actorAccountId])).get(row.id)?.get(actorAccountId) ?? null : resolvedRole;
    if (!role) return null;
    const owned = row.accountId === actorAccountId;
    if (!owned && classifyMachineAvailabilityState(row) !== 'available') return null;
    const encryptionMode = resourceMode(row);
    if (encryptionMode === null) return null;
    const storedContentMatchesMode = storedContentMatchesByMachine?.get(row) ?? resourceContentMatchesMode(row, encryptionMode);
    storedContentMatchesByMachine?.set(row, storedContentMatchesMode);
    let accessState: MachineAccessFacts['accessState'] = storedContentMatchesMode ? 'ready' : 'refused';
    let reason: MachineAccessRefusalCode | null = accessState === 'refused' ? 'encryption_material_unavailable' : null;
    let canPrepareKeys = false;
    if (accessState === 'ready' && !owned && encryptionMode === 'plain' && !safePlainContent(row)) {
        accessState = 'refused'; reason = 'content_unpublished';
    }
    if (accessState === 'ready' && !owned && encryptionMode === 'e2ee') {
        const { recipient, readiness, envelopes } = material ?? await readRecipientAccessMaterialInTx(tx, actorAccountId, [row.id]);
        if (readiness?.status === 'unavailable' && readiness.reason === 'plain_account') {
            accessState = 'refused'; reason = 'recipient_encryption_incompatible';
        } else if (readiness?.status !== 'available') {
            accessState = 'key_pending'; reason = 'encryption_material_unavailable';
        }
        else {
            const envelope = envelopes.get(row.id);
            accessState = row.dataEncryptionKey !== null && recipient
                && projectMachineRecipientWork(recipient, envelope ?? null,
                    computeMachineOwnerEnvelopeFingerprintV1(row.dataEncryptionKey), readiness).current ? 'ready' : 'key_pending';
            if (accessState === 'key_pending') { reason = 'recipient_key_pending'; canPrepareKeys = true; }
        }
    }
    return { custodianAccountId: row.accountId, role, encryptionMode, accessState, reason, canPrepareKeys,
        installationId: row.installationId, owned };
}

async function accessFromFactsForActorsInTx(tx: Tx, row: MachineFacts, accountIds: readonly string[],
    roles: ReadonlyMap<string, MachineAccessRoleV1 | null> | undefined): Promise<Map<string, MachineAccessFacts | null>> {
    const recipients = accountIds.filter(accountId => accountId !== row.accountId && roles?.get(accountId));
    const contentMatches = new Map<MachineFacts, boolean>();
    if (recipients.length > 0 && classifyMachineAvailabilityState(row) === 'available' && resourceMode(row) === 'e2ee') {
        contentMatches.set(row, resourceContentMatchesMode(row, 'e2ee'));
    }
    const materials = contentMatches.get(row) === true
        ? await readRecipientAccessMaterialsInTx(tx, recipients.map(actorAccountId => ({ actorAccountId, machineId: row.id })))
        : undefined;
    const states = new Map<string, MachineAccessFacts | null>();
    for (const accountId of accountIds) {
        states.set(accountId, await accessFromFactsInTx(tx, row, accountId, materials?.get(accountId),
            roles?.get(accountId) ?? null, contentMatches));
    }
    return states;
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
    const actorAccountIds = [...new Set(input.actorAccountIds)];
    if (actorAccountIds.length === 0) return new Map();
    const row = await readFactsInTx(tx, input.machineId, actorAccountIds.length === 1 ? actorAccountIds[0] : undefined);
    if (!row) return new Map(actorAccountIds.map(accountId => [accountId, null]));
    const roles = (await machineRolesInTx(tx, [row], actorAccountIds)).get(row.id);
    if (actorAccountIds.length === 1) {
        const [accountId] = actorAccountIds;
        const access = await accessFromFactsInTx(tx, row, accountId, undefined, roles?.get(accountId) ?? null);
        return new Map([[accountId, access]]);
    }
    return accessFromFactsForActorsInTx(tx, row, actorAccountIds, roles);
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
    sessionSpawnAdmission?: ApiTokenSessionSpawnAdmissionV1;
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
    const admissions = await resolveMachineAdmissionsInTx(tx, { ...input, machineIds: [input.machineId] });
    return admissions.get(input.machineId)!;
}

/** Request-local facts serve namespace selection and the single admission decision. */
export async function readMachineAdmissionFactsInTx(tx: Tx, input: MachineActor): Promise<MachineAdmissionFacts | null> {
    const rows = await readMachineFactsInTx(tx, input.actorAccountId, [input.machineId]);
    return rows.get(input.machineId) ?? null;
}

/** Ownership decides the role without reading unrelated foreign grant graphs. */
async function readMachineFactsInTx(tx: Tx, actorAccountId: string, machineIds: readonly string[]): Promise<ReadonlyMap<string, MachineAdmissionFacts>> {
    const rows: MachineResourceFacts[] = [];
    for (const ids of portableQueryChunks({ values: [...new Set(machineIds)], bindingsPerValue: 1, fixedBindings: 3 })) {
        rows.push(...await tx.machine.findMany({ where: { id: { in: [...ids] } }, select: withMachineContentSelect(MACHINE_RESOURCE_FACTS_SELECT) }).then(decodeMachineStoredContent));
    }
    const result = new Map<string, MachineAdmissionFacts>();
    for (const row of rows) if (row.accountId === actorAccountId) {
        // Account status, mode, content, installation and lifecycle still reach
        // the same admission policy. Grants cannot change an owner's role.
        result.set(row.id, { ...row, grants: [] });
    }
    const foreignIds = rows.filter(row => row.accountId !== actorAccountId).map(row => row.id);
    if (foreignIds.length > 0) {
        for (const ids of portableQueryChunks({ values: foreignIds, bindingsPerValue: 1, fixedBindings: 15 })) {
            const foreignRows = await tx.machine.findMany({ where: { id: { in: [...ids] } }, select: withMachineContentSelect(buildMachineAdmissionFactsSelect(actorAccountId)) }).then(decodeMachineStoredContent);
            for (const row of foreignRows) result.set(row.id, row);
        }
    }
    return result;
}

interface AccessibleMachineOpening {
    machine: Machine & Pick<MachineOpeningRow, 'managedResource'> & Pick<MachineSerializationRow, 'managedWakeAvailability'>;
    access: AccessibleMachineAccessV1;
    owned: boolean;
    callerDataEncryptionKey: Uint8Array<ArrayBuffer> | null;
    recipientWorkPending?: boolean;
    recipientWorkCursor?: number;
}

/** Acquire row material and its opening together; callers never reacquire admitted content. */
/** Caller-openable key from one access derivation: the custodian's envelope or the caller's current recipient envelope. */
function callerDataEncryptionKeyFromFacts(row: Pick<MachineFacts, 'id' | 'dataEncryptionKey'>, facts: MachineAccessFacts,
    material: Awaited<ReturnType<typeof readRecipientAccessMaterialInTx>> | undefined): Uint8Array<ArrayBuffer> | null {
    const key = facts.owned ? row.dataEncryptionKey
        : facts.accessState === 'ready' && facts.encryptionMode === 'e2ee' ? material?.envelopes.get(row.id)?.encryptedDataKey : null;
    return key ? new Uint8Array(key) : null;
}
export async function readAccessibleMachineOpeningsInTx(tx: Tx, input: Readonly<{
    actorAccountId: string; machineIds: readonly string[];
    includeRecipientWork?: true;
    /** Host-verified finite admission; does not waive mode or recipient-envelope readiness. */
    admission?: SocketRpcMachineAdmissionContextV1;
}>): Promise<ReadonlyMap<string, AccessibleMachineOpening>> {
    const result = new Map<string, AccessibleMachineOpening>();
    if (input.machineIds.length === 0) return result;
    const rows: MachineOpeningRow[] = [];
    // An owner's grants cannot change their role. Do not load their foreign grant graph.
    const actorFacts = buildMachineAdmissionFactsSelect(input.actorAccountId);
    // Nine relation-projection bindings plus three custody and three actor predicates.
    for (const ids of portableQueryChunks({ values: [...new Set(input.machineIds)], bindingsPerValue: 1, fixedBindings: 15 })) {
        const loaded = await tx.machine.findMany({ where: { id: { in: [...ids] } }, include: {
            ...MACHINE_OPENING_INCLUDE,
            grants: actorFacts.grants,
        } }).then(decodeMachineStoredContent);
        rows.push(...loaded.map(row => ({ ...row, ...projectResourceGrantRows(row.grants) })));
    }
    const foreignEncryptedIds = rows.filter(row => row.accountId !== input.actorAccountId && resourceMode(row) === 'e2ee').map(row => row.id);
    const material = foreignEncryptedIds.length > 0
        ? await readRecipientAccessMaterialInTx(tx, input.actorAccountId, foreignEncryptedIds) : undefined;
    const roles = input.admission ? undefined : await machineRolesInTx(tx, rows, [input.actorAccountId]);
    for (const row of rows) {
        const admission = input.admission;
        if (admission && (admission.actorAccountId !== input.actorAccountId || admission.machineId !== row.id
            || admission.custodianAccountId !== row.accountId || admission.installationId !== row.installationId
            || admission.encryptionMode !== resourceMode(row))) continue;
        const facts = await accessFromFactsInTx(tx, row, input.actorAccountId, material,
            admission?.role ?? roles?.get(row.id)?.get(input.actorAccountId) ?? null);
        if (!facts) continue;
        const key = callerDataEncryptionKeyFromFacts(row, facts, material);
        result.set(row.id, {
            machine: row,
            access: { custodian: { accountId: row.accountId, displayName: resolveAccountDisplayLabelV1(row.account) ?? '' },
                role: facts.role, resourceMode: facts.encryptionMode, accessState: facts.accessState,
                ...(facts.accessState !== 'ready' && facts.reason ? { reason: facts.reason } : {}) },
            owned: facts.owned,
            callerDataEncryptionKey: key,
        });
    }
    for (const machine of await withManagedWakeAvailabilityInTx(tx, [...result.values()].map(opening => opening.machine))) {
        const opening = result.get(machine.id);
        if (opening) opening.machine = machine;
    }
    const managed = input.includeRecipientWork ? [...result.values()].filter(opening => opening.access.role === 'manage'
        && opening.access.resourceMode === 'e2ee' && opening.access.accessState === 'ready'
        && classifyMachineAvailabilityState(opening.machine) === 'available') : [];
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

type MachineAdmissionsInput = Omit<MachineAdmissionInput, 'machineId'> & Readonly<{ machineIds: readonly string[] }>;
/** Mixed-requester placement reads share one graph and recipient-material acquisition. */
export async function resolveMachineTargetAdmissionsInTx(tx: Tx, targets: readonly MachineActor[]): Promise<readonly MachineAdmission[]> {
    if (targets.length === 0) return [];
    const dialect = resolveDbSqlDialect(getDbProviderFromEnv(process.env, 'postgres'));
    const machineIds = [...new Set(targets.map(target => target.machineId))];
    const rows: MachineResourceFacts[] = [];
    if (dialect === 'postgres') {
        const accountFields = Object.keys(MACHINE_RESOURCE_FACTS_SELECT.account.select)
            .flatMap(field => [`'${field}'`, `a."${field}"`]).join(', ');
        const managedFields = Object.keys(MACHINE_RESOURCE_FACTS_SELECT.managedResource.select)
            .flatMap(field => [`'${field}'`, `managed."${field}"`]).join(', ');
        rows.push(...await tx.$queryRawUnsafe<MachineResourceFacts[]>(
            `SELECT m.*, jsonb_build_object(${accountFields}) AS "account",
             CASE WHEN managed."id" IS NULL THEN NULL ELSE jsonb_build_object(${managedFields}) END AS "managedResource"
             FROM "Machine" m JOIN "Account" a ON a."id" = m."accountId"
             LEFT JOIN "ManagedMachine" managed ON managed."enrolledMachineId" = m."id"
             WHERE m."id" = ANY($1::text[])`, machineIds).then(decodeMachineStoredContent));
    } else for (const ids of portableQueryChunks({ values: machineIds, bindingsPerValue: 1, fixedBindings: 3 })) {
        rows.push(...await tx.machine.findMany({ where: { id: { in: [...ids] } }, select: withMachineContentSelect(MACHINE_RESOURCE_FACTS_SELECT) }).then(decodeMachineStoredContent));
    }
    const facts = new Map(rows.map(row => [row.id, { ...row, grants: [], ...projectResourceGrantRows([]) }]));
    const accountIds = [...new Set(targets.map(target => target.actorAccountId))];
    const roles = await resolveEffectiveMachineAccessForMachinesInTx(tx, { machineIds, accountIds });
    const encrypted = targets.filter(target => {
        const row = facts.get(target.machineId);
        return row && row.accountId !== target.actorAccountId && resourceMode(row) === 'e2ee'
            && roles.get(row.id)?.get(target.actorAccountId);
    });
    const materials = await readRecipientAccessMaterialsInTx(tx, encrypted);
    // The captured Machine content is the same for every requester in this batch.
    const storedContentMatchesByMachine = new Map<MachineFacts, boolean>();
    const admissions: MachineAdmission[] = [];
    for (const target of targets) admissions.push(await machineAdmissionFromFactsWithRoleInTx(tx, facts.get(target.machineId) ?? null,
        target, roles.get(target.machineId)?.get(target.actorAccountId) ?? null, materials.get(target.actorAccountId), storedContentMatchesByMachine));
    return admissions;
}

/** Set-oriented default-use admission; point and batch readers share every policy decision. */
export function resolveMachineAdmissionsInTx(tx: Tx, input: MachineAdmissionsInput & Readonly<{ purpose: 'workflow' }>): Promise<ReadonlyMap<string, WorkflowMachineAdmission>>;
export function resolveMachineAdmissionsInTx(tx: Tx, input: MachineAdmissionsInput): Promise<ReadonlyMap<string, MachineAdmission>>;
export async function resolveMachineAdmissionsInTx(tx: Tx, input: MachineAdmissionsInput & Readonly<{ purpose?: 'workflow' }>): Promise<ReadonlyMap<string, MachineAdmission | WorkflowMachineAdmission>> {
    const machineIds = [...new Set(input.machineIds)];
    if (machineIds.length === 0) return new Map();
    const stored = await readMachineFactsInTx(tx, input.actorAccountId, machineIds);
    const byId = new Map([...stored].map(([id, row]) => [id, { ...row, ...projectResourceGrantRows(row.grants) }]));
    const roles = await machineRolesInTx(tx, [...byId.values()], [input.actorAccountId]);
    const foreignEncryptedIds = [...byId.values()].filter(row => row.accountId !== input.actorAccountId
        && roles.get(row.id)?.get(input.actorAccountId) && resourceMode(row) === 'e2ee').map(row => row.id);
    const material = foreignEncryptedIds.length > 0
        ? await readRecipientAccessMaterialInTx(tx, input.actorAccountId, foreignEncryptedIds) : undefined;
    const result = new Map<string, MachineAdmission | WorkflowMachineAdmission>();
    for (const machineId of machineIds) result.set(machineId, await machineAdmissionFromFactsWithRoleInTx(tx, byId.get(machineId) ?? null,
        { ...input, machineId }, roles.get(machineId)?.get(input.actorAccountId) ?? null, material));
    return result;
}

export function resolveMachineAdmissionFromFactsInTx(tx: Tx, row: MachineAdmissionFacts | null, input: WorkflowMachineAdmissionInput): Promise<WorkflowMachineAdmission>;
export function resolveMachineAdmissionFromFactsInTx(tx: Tx, row: MachineAdmissionFacts | null, input: MachineAdmissionInput): Promise<MachineAdmission>;
export async function resolveMachineAdmissionFromFactsInTx(tx: Tx, row: MachineAdmissionFacts | null, input: MachineAdmissionInput & Readonly<{ purpose?: 'workflow' }>): Promise<MachineAdmission | WorkflowMachineAdmission> {
    return machineAdmissionFromFactsWithRoleInTx(tx, row ? { ...row, ...projectResourceGrantRows(row.grants) } : null, input);
}
function machineAdmissionFromFactsWithRoleInTx(tx: Tx, row: MachineFacts | null,
    input: MachineAdmissionInput & Readonly<{ purpose?: never }>, role?: MachineAccessRoleV1 | null,
    material?: Awaited<ReturnType<typeof readRecipientAccessMaterialInTx>>,
    storedContentMatchesByMachine?: Map<MachineFacts, boolean>): Promise<MachineAdmission>;
function machineAdmissionFromFactsWithRoleInTx(tx: Tx, row: MachineFacts | null,
    input: MachineAdmissionInput & Readonly<{ purpose?: 'workflow' }>, role?: MachineAccessRoleV1 | null,
    material?: Awaited<ReturnType<typeof readRecipientAccessMaterialInTx>>,
    storedContentMatchesByMachine?: Map<MachineFacts, boolean>): Promise<MachineAdmission | WorkflowMachineAdmission>;
async function machineAdmissionFromFactsWithRoleInTx(tx: Tx, row: MachineFacts | null,
    input: MachineAdmissionInput & Readonly<{ purpose?: 'workflow' }>, role?: MachineAccessRoleV1 | null,
    material?: Awaited<ReturnType<typeof readRecipientAccessMaterialInTx>>,
    storedContentMatchesByMachine?: Map<MachineFacts, boolean>): Promise<MachineAdmission | WorkflowMachineAdmission> {
    const access = row && await accessFromFactsInTx(tx, row, input.actorAccountId, material, role, storedContentMatchesByMachine);
    if (!row || !access) return { kind: 'denied', code: 'access_denied' };
    if (input.purpose === 'workflow' && access.owned) {
        const availability = classifyMachineAvailabilityState(row);
        if (availability !== 'available' && availability !== 'replaced') return { kind: 'denied', code: 'machine_unavailable' };
        return { kind: 'admitted', actorAccountId: input.actorAccountId, custodianAccountId: row.accountId,
            machineId: row.id, installationId: row.installationId, role: access.role, encryptionMode: access.encryptionMode,
            availability };
    }
    if (access.accessState === 'refused' && access.reason === 'encryption_material_unavailable') {
        return { kind: 'denied', code: access.reason };
    }
    const availability = classifyMachineAvailabilityState(row);
    if (availability === 'revoked') return { kind: 'denied', code: 'machine_unavailable',
        diagnostic: { reason: 'machine_revoked', requiredFact: 'machine_registration', remedy: 'register_machine' } };
    if (availability === 'replaced') return { kind: 'denied', code: 'machine_unavailable',
        diagnostic: { reason: 'machine_replaced', requiredFact: 'current_machine', remedy: 'select_current_machine' } };
    if (!row.installationId) return { kind: 'denied', code: 'machine_unavailable',
        diagnostic: { reason: 'machine_installation_missing', requiredFact: 'machine_installation', remedy: 'register_machine' } };
    const onlineDiagnostic = readMachineOnlineAvailabilityDiagnostic(row, input.requireOnline);
    if (onlineDiagnostic) return { kind: 'denied', code: 'machine_unavailable', diagnostic: onlineDiagnostic };
    // A template creates the same requester-owned Session as ordinary New Session.
    // Keep its signed root while consuming the existing spawn role/isolation policy.
    const operationActionId = input.actionId === 'template.instantiate' ? 'session.spawn_new' : input.actionId;
    const spawnSetup = input.actionId === SESSION_SPAWN_NEW_ACTION_ID_V1 && input.sessionSpawnAdmission?.machineSetupRequested === true;
    const requesterCopyPreview = !input.rpcMethod && isProjectWorkerCopyInspectActionIdV1(input.actionId);
    let requiredRole = spawnSetup ? 'manage' : input.requiredRole ?? 'use';
    if (requesterCopyPreview) requiredRole = 'manage';
    const runtimeAction = RuntimeActionIdV1Schema.safeParse(input.actionId);
    const browserAction = runtimeAction.success && isBrowserRuntimeActionId(runtimeAction.data);
    if (input.actionId && requiredMachineRoleForBrowserAction(input.actionId) === 'manage') requiredRole = 'manage';
    let method = input.rpcMethod;
    const requesterSessionLifecycle = operationActionId === 'session.spawn_new' || operationActionId === 'session.open';
    // Exact copy review enters through signed Account admission. The daemon
    // binds it to retained relationship custody; its raw RPC stays private.
    // A signed message uses this Machine only as a carrier; the Session message
    // owner authorizes its effect without exposing a private custodian RPC.
    const requesterActionIngress = requesterSessionLifecycle || requesterCopyPreview
        || input.actionId === SESSION_MESSAGE_SEND_ACTION_ID_V1;
    if (input.actionId && !method) {
        const actionId = SignedRootActionIdSchema.safeParse(input.actionId);
        const spec = actionId.success ? getActionSpec(actionId.data) : null;
        // Session creation/resume uses admitted requester custody at the Action ingress.
        // Its private raw RPC binding remains custodian-only when requested directly.
        // Publication reads/prepare consume the same selected private profile as
        // upload. Reuse its Manage policy for admission, not an RPC binding.
        method = Object.hasOwn(PluginPublicationActionOutputSchemas, input.actionId) ? RPC_METHODS.DAEMON_NPM_REGISTRY_PROFILES_MUTATE
            : Object.hasOwn(NpmRegistryProfileActionOutputSchemasV1, input.actionId)
            ? spec?.sideEffectClass === 'read' ? RPC_METHODS.DAEMON_NPM_REGISTRY_PROFILES_GET
                : RPC_METHODS.DAEMON_NPM_REGISTRY_PROFILES_MUTATE
            : runtimeAction.success && isComputerRuntimeActionId(runtimeAction.data)
            ? RPC_METHODS.DAEMON_COMPUTER_PERSONAL_ACTION_EXECUTE
            : requesterActionIngress ? undefined : isProviderActionIdV1(input.actionId)
            ? resolveProviderActionRpcRouteV1(input.actionId)?.method : spec?.bindings?.rpcMethod;
        // Runtime Browser Actions use the signed Action executor rather than a
        // raw RPC binding. Its role owner above and the receiver's profile owner
        // govern guest access; absence of a raw binding is not a custody refusal.
        // Agent inventory roots also use signed Action ingress, with no private RPC binding.
        if (!method && !access.owned && !requesterActionIngress && !browserAction && !isRequesterProjectExecutionActionV1(input.actionId)
            && !isMachineAgentInventoryReadActionIdV1(input.actionId)
            && !isStoredDeploymentExecutionActionIdV1(input.actionId)
            // Template instantiation carries the effective grant role; the host's
            // definition admission consumes it once and requires Manage.
            && deploymentPreparationOperationForActionV1(input.actionId) !== 'template') {
            return { kind: 'denied', code: 'unsupported_operation' };
        }
    }
    if (method) {
        const rpcRole = resolveMachineRpcRequiredRole({ method, owned: access.owned, requiredRole, actionId: operationActionId });
        if (rpcRole === null) return { kind: 'denied', code: 'custodian_only' };
        requiredRole = rpcRole;
    }
    if (requiredRole === 'manage' && access.role !== 'manage') return { kind: 'denied', code: 'access_denied', requiredRole,
        ...(spawnSetup ? { diagnostic: { reason: 'machine_setup_requires_manage',
            requiredFact: 'machine_manage_role', remedy: 'request_machine_manage_access' } } : {}) };
    if (!isMachineOperationSupportedForRequester({ actorAccountId: input.actorAccountId, machine: row,
        rpcMethod: input.operationRpcMethod ?? method, actionId: operationActionId,
        callerAuthority: input.callerAuthority, sessionActionOrigin: input.sessionActionOrigin,
        executionBinding: input.executionBinding })) {
        return { kind: 'denied', code: 'daemon_upgrade_required' };
    }
    if (access.accessState === 'refused') return { kind: 'denied', code: access.reason ?? 'recipient_encryption_incompatible' };
    if (access.accessState !== 'ready') return { kind: 'denied', code: 'recipient_key_pending' };
    return { kind: 'admitted', actorAccountId: input.actorAccountId, custodianAccountId: row.accountId,
        machineId: row.id, installationId: row.installationId, role: access.role, encryptionMode: access.encryptionMode,
        ...(input.purpose === 'workflow' ? { availability: 'available' as const } : {}) };
}
export async function resolveMachineAdmission(input: MachineAdmissionInput): Promise<MachineAdmission> { return inTx(tx => resolveMachineAdmissionInTx(tx, input)); }

export async function listMachineAccessGrantsInTx(tx: Tx, input: MachineActor): Promise<MachineAccessGrantsListResultV1> {
    const row = await readFactsInTx(tx, input.machineId);
    if (!row) return refusal('access_denied');
    const graph = await readMachineRoleGraphInTx(tx, [row], []);
    const candidates = [...new Set([input.actorAccountId, ...[...graph.values()].flatMap(machine =>
        [machine.accountId, ...contributions(machine).flatMap(source => source.accountIds)])])];
    const roles = projectMachineRoles(graph, candidates);
    const access = await accessFromFactsInTx(tx, row, input.actorAccountId, undefined, roles.get(row.id)?.get(input.actorAccountId) ?? null);
    if (!row || !access) return refusal('access_denied');
    const sources = contributions(row);
    const canManage = access.role === 'manage';
    const custodian = { accountId: row.accountId, displayName: resolveAccountDisplayLabelV1(row.account) ?? '' };
    // The existing effective audience owns identity disclosure. This is only a
    // safe display projection for the custodian/Manage roster, never Session
    // content or another grant/summary audience decision.
    const currentRequesterAccountIds = canManage
        ? candidates.filter(accountId => roles.get(row.id)?.get(accountId) !== null)
        : [];
    const currentRequesterDisplayIdentities: Array<{ accountId: string; displayName: string }> | undefined = canManage ? [] : undefined;
    if (currentRequesterDisplayIdentities) for (const ids of portableQueryChunks({ values: currentRequesterAccountIds, bindingsPerValue: 1 })) {
        const accounts = await tx.account.findMany({ where: { id: { in: [...ids] } }, select: ACCOUNT_DISPLAY_PROFILE_SELECT });
        currentRequesterDisplayIdentities.push(...accounts.map(account => ({ accountId: account.id, displayName: resolveAccountDisplayLabelV1(account) ?? '' })));
    }
    const displayNames = new Map(currentRequesterDisplayIdentities?.map(account => [account.accountId, account.displayName]));
    const projectGroupName = (source: typeof sources[number]) => source.principal.kind === 'group' && source.groupNameSerialized !== undefined
        ? projectTeamGroupNameForRecipient({ serialized: source.groupNameSerialized, recipientAccountId: input.actorAccountId })
        : undefined;
    const grants: MachineAccessGrantRowV1[] = [];
    const rosterRecipients = canManage ? [...new Set(sources.flatMap(source => source.accountIds))].filter(accountId =>
        accountId !== row.accountId && accountId !== input.actorAccountId) : [];
    const rosterStates = await accessFromFactsForActorsInTx(tx, row, rosterRecipients, roles.get(row.id));
    rosterStates.set(input.actorAccountId, access);
    if (canManage) for (const source of sources) {
        const accountIds = source.accountIds.filter(accountId => accountId !== row.accountId);
        const states = accountIds.map(accountId => rosterStates.get(accountId) ?? null);
        const afterRemoval = projectMachineRoles(graph, source.accountIds, new Map([[row.id, sources.filter(candidate => candidate !== source)]]));
        const groupName = projectGroupName(source);
        grants.push({ machineId: row.id, principal: source.principal, level: source.level, display: {
            name: source.displayName, ...(groupName ? { groupName } : {}),
        },
            readiness: grantReadiness(states).readiness,
            audience: accountIds.map((accountId, index) => ({ accountId, displayName: displayNames.get(accountId) ?? '',
                readiness: states[index]?.accessState ?? 'refused', reason: states[index]?.reason ?? (states[index] ? null : 'machine_unavailable'),
                canPrepareKeys: states[index]?.canPrepareKeys === true })),
            removal: { losesAccessAccountIds: source.accountIds.filter(accountId => afterRemoval.get(row.id)?.get(accountId) === null) } });
    }
    return { machineId: row.id, custodian, access: { custodian, role: access.role, resourceMode: access.encryptionMode, accessState: access.accessState,
        ...(access.accessState !== 'ready' && access.reason ? { reason: access.reason } : {}) },
        canManage, grants, ownDirectGrant: row.accountGrants.some(grant => grant.accountId === input.actorAccountId),
        ...(currentRequesterDisplayIdentities ? { currentRequesterDisplayIdentities } : {}),
        ownAccessSources: sources.filter(source => source.accountIds.includes(input.actorAccountId)).map(source => {
            const groupName = projectGroupName(source);
            return { principal: source.principal, displayName: source.displayName, ...(groupName ? { groupName } : {}) };
        }) };
}

async function managerInTx(tx: Tx, input: MachineActor) {
    const row = await readFactsInTx(tx, input.machineId);
    const access = row && await accessFromFactsInTx(tx, row, input.actorAccountId);
    return row && access?.role === 'manage' && resourceContentMatchesMode(row, access.encryptionMode)
        && classifyMachineAvailabilityState(row) === 'available' ? row : null;
}
/** Key-holder Manage for the envelope census and commit: one access derivation, and the caller key comes from its recipient material. */
async function managerAccessInTx(tx: Tx, input: MachineActor, options: Readonly<{ requireCurrentKeyHolder?: boolean }> = {}) {
    const row = await readFactsInTx(tx, input.machineId);
    if (!row) return null;
    const material = row.accountId !== input.actorAccountId && resourceMode(row) === 'e2ee'
        ? await readRecipientAccessMaterialInTx(tx, input.actorAccountId, [row.id]) : undefined;
    const access = await accessFromFactsInTx(tx, row, input.actorAccountId, material);
    return access?.role === 'manage' && resourceContentMatchesMode(row, access.encryptionMode)
        && (!options.requireCurrentKeyHolder || access.accessState === 'ready')
        && classifyMachineAvailabilityState(row) === 'available'
        ? { row, callerDataEncryptionKey: callerDataEncryptionKeyFromFacts(row, access, material) } : null;
}
async function mutationImpactInTx(tx: Tx, machineId: string, accountIds: readonly string[]) {
    return captureMachineAccessImpactsInTx(tx, { machineIds: [machineId], accountIds });
}
async function publishMutationInTx(tx: Tx, impacts: Awaited<ReturnType<typeof mutationImpactInTx>>) {
    await applyMachineAccessImpactsInTx(tx, { impacts: impacts.values(), grantRosterChanged: true });
}
/** Stabilize Machine content after Account admission and before reading its CAS basis. */
export async function lockMachinePublicationInTx(tx: Tx, machineId: string): Promise<void> {
    // Content Account admission permits peer PostgreSQL Machine writes. MySQL's
    // exclusive Account admission and SQLite's single writer already exclude peers.
    if (resolveDbSqlDialect(getDbProviderFromEnv(process.env, 'postgres')) === 'postgres') {
        await tx.$queryRawUnsafe('SELECT "id" FROM "Machine" WHERE "id" = $1 FOR NO KEY UPDATE', machineId);
    }
}

/** Fence existing and prospective recipients before authority, key or grant reads. */
export async function acquireMachineAccessPublicationLocksInTx(tx: Tx, machineId: string, principal?: PrincipalRefV1): Promise<void> {
    const provider = getDbProviderFromEnv(process.env, 'postgres');
    if (provider === 'sqlite') return;
    const readAudience = async () => {
        const machineIds = await expandMachineIdsWithManagedGuestsInTx(tx, [machineId]);
        const accountIds = [...new Set([...(await readMachineAudienceAccountIdsForMachinesInTx(tx, machineIds)).values()].flat())];
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
    // Materialization consumes the admitted audience; terminal publication
    // retains its locked CAS checks without repeating recipient discovery.
}
/** Idempotent per-principal grants; Manage can delegate Manage without replacing custody. */
export async function setMachineAccessGrantInTx(tx: Tx, input: MachineActor & Readonly<{ principal: PrincipalRefV1; level: 'view' | 'admin' }>): Promise<MachineAccessMutationResultV1> {
    await acquireMachineAccessPublicationLocksInTx(tx, input.machineId, input.principal);
    const row = await managerInTx(tx, input);
    if (!row) return refusal('access_denied');
    if (row.kind !== 'persistent') return refusal('unsupported_operation');
    const principal = input.principal;
    if (principal.kind === 'account' && principal.accountId === row.accountId) return refusal('custodian_protected');
    const data = { accessLevel: input.level, createdByAccountId: input.actorAccountId };
    let previous: Readonly<{ accessLevel: string }> | null;
    let upsert: () => Promise<unknown>;
    if (principal.kind === 'account') {
        const where = { machineId_accountId: { machineId: row.id, accountId: principal.accountId } };
        previous = await tx.machineGrant.findUnique({ where: { ...where, principalKind: 'account' } });
        upsert = () => tx.machineGrant.upsert({ where: { ...where, principalKind: 'account' }, create: { principalKind: 'account', machineId: row.id, accountId: principal.accountId, ...data }, update: data });
    } else if (principal.kind === 'team') {
        const where = { machineId_teamId: { machineId: row.id, teamId: principal.teamId } };
        previous = await tx.machineGrant.findUnique({ where: { ...where, principalKind: 'team' } });
        upsert = () => tx.machineGrant.upsert({ where: { ...where, principalKind: 'team' }, create: { principalKind: 'team', machineId: row.id, teamId: principal.teamId, ...data }, update: data });
    } else {
        const where = { machineId_teamGroupId: { machineId: row.id, teamGroupId: principal.groupId } };
        previous = await tx.machineGrant.findUnique({ where: { ...where, principalKind: 'group' } });
        upsert = () => tx.machineGrant.upsert({ where: { ...where, principalKind: 'group' }, create: { principalKind: 'group', machineId: row.id, teamGroupId: principal.groupId, ...data }, update: data });
    }
    const principalError = await validateResourceGrantPrincipalInTx(tx, { actorAccountId: input.actorAccountId,
        ownerAccountId: row.accountId, principal, hasExistingGrant: previous !== null });
    if (principalError) return refusal(principalError === 'subject_not_found' ? 'principal_not_found' : 'principal_ineligible');
    let targetAccountIds: string[] = [];
    if (principal.kind === 'account') {
        if (resourceMode(row) === 'e2ee') {
            const account = await tx.account.findUniqueOrThrow({ where: { id: principal.accountId }, select: RECIPIENT_READINESS_SELECT });
            const readiness = deriveAccountRecipientEnvelopeReadinessFromRow(account);
            if (readiness.status === 'unavailable' && readiness.reason === 'plain_account') return refusal('recipient_encryption_incompatible');
        }
        targetAccountIds = [principal.accountId];
    } else if (principal.kind === 'team') {
        const team = await tx.team.findUniqueOrThrow({ where: { id: principal.teamId }, select: { memberships: { select: { accountId: true } } } });
        targetAccountIds = team.memberships.map(member => member.accountId);
    } else {
        const group = await tx.teamGroup.findUniqueOrThrow({ where: { id: principal.groupId }, select: { memberships: { select: { teamMembership: { select: { accountId: true } } } } } });
        targetAccountIds = group.memberships.map(member => member.teamMembership.accountId);
    }
    const impacts = await mutationImpactInTx(tx, row.id, [...new Set([row.accountId, ...targetAccountIds])]);
    const changed = previous?.accessLevel !== input.level;
    if (changed) await upsert();
    if (changed) await publishMutationInTx(tx, impacts);
    const current = await readFactsInTx(tx, row.id);
    const source = current && contributions(current).find(candidate => isDeepStrictEqual(candidate.principal, principal));
    const recipients = source?.accountIds.filter(id => id !== row.accountId) ?? [];
    const roles = current ? (await machineRolesInTx(tx, [current], recipients)).get(current.id) : undefined;
    const states = current ? [...(await accessFromFactsForActorsInTx(tx, current, recipients, roles)).values()] : [];
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
    const deleted = principal.kind === 'account' ? await tx.machineGrant.deleteMany({ where: { principalKind: 'account', machineId: row.id, accountId: principal.accountId } })
        : principal.kind === 'team' ? await tx.machineGrant.deleteMany({ where: { principalKind: 'team', machineId: row.id, teamId: principal.teamId } })
            : await tx.machineGrant.deleteMany({ where: { principalKind: 'group', machineId: row.id, teamGroupId: principal.groupId } });
    if (deleted.count) await publishMutationInTx(tx, impacts);
    const role = await resolveEffectiveMachineRoleInTx(tx, { machineId: row.id, actorAccountId: principal.kind === 'account' ? principal.accountId : input.actorAccountId });
    if (self && role) return { kind: 'inherited_access_remains', role };
    return { kind: self ? 'left' : 'removed', effectiveAccess: role ?? 'none' };
}

/** Current holder worklist; returns caller-openable bytes but never the custodian's private envelope. */
export async function readMachineRecipientCensusInTx(tx: Tx, input: MachineActor & Readonly<{ query?: MachineRecipientKeyEnvelopePageQueryV1 }>): Promise<MachineAccessRecipientCensusResponseV1 | MachineAccessRefusalV1> {
    const admitted = await managerAccessInTx(tx, input, { requireCurrentKeyHolder: true });
    if (!admitted) return refusal('access_denied');
    const { row } = admitted;
    const encryptionMode = resourceMode(row);
    if (encryptionMode === null || !resourceContentMatchesMode(row, encryptionMode)) return refusal('encryption_material_unavailable');
    if (encryptionMode === 'plain' && !safePlainContent(row)) return refusal('content_unpublished');
    const callerKey = encryptionMode === 'plain' ? null : admitted.callerDataEncryptionKey;
    if (encryptionMode === 'e2ee' && (!callerKey || !row.dataEncryptionKey || !parseEncryptedDataKeyEnvelopeV1(row.dataEncryptionKey))) return refusal('encryption_material_unavailable');
    const query = input.query ?? MachineRecipientKeyEnvelopePageQueryV1Schema.parse({});
    const after = query.cursor ? decodeSessionDataKeyEnvelopeCursorV1(query.cursor) : null;
    if (query.cursor && !after) return refusal('unsupported_operation');
    const fingerprint = encryptionMode === 'e2ee' && row.dataEncryptionKey ? computeMachineOwnerEnvelopeFingerprintV1(row.dataEncryptionKey) : null;
    const recipients: MachineAccessRecipientCensusResponseV1['recipients'] = [];
    let nextCursor: string | null = null;
    if (encryptionMode === 'e2ee') {
        const work = await readMachineRecipientWorkInTx(tx, { actorAccountId: input.actorAccountId,
            ownerFingerprints: new Map([[row.id, fingerprint]]) });
        const page = (work.get(row.id)?.recipients ?? []).filter(recipient =>
            (after === null || recipient.recipientAccountId > after)
            && (query.state !== 'action_required' || isMachineRecipientWorkPending(recipient)));
        for (const { current: _current, ...recipient } of page.slice(0, query.limit)) recipients.push(recipient);
        if (page.length > query.limit) {
            nextCursor = encodeSessionDataKeyEnvelopeCursorV1(recipients[recipients.length - 1]!.recipientAccountId);
        }
    }
    return { machineId: row.id, custodianAccountId: row.accountId, encryptionMode, machineOwnerEnvelopeFingerprint: fingerprint,
        callerDataEncryptionKey: callerKey ? encodeBase64(callerKey) : null, nextCursor, recipients,
        content: { metadata: row.metadata, metadataVersion: row.metadataVersion, daemonState: row.daemonState, daemonStateVersion: row.daemonStateVersion } };
}
/** Atomic opaque tuple commit after current Manage, holder, whole-blob versions and recipient binding recheck. */
export async function commitMachineRecipientKeyEnvelopesInTx(tx: Tx, input: MachineRecipientKeyEnvelopeCommitInputV1 & Readonly<{ actorAccountId: string }>): Promise<MachineRecipientKeyEnvelopeCommitResponseV1 | MachineAccessRefusalV1> {
    await acquireMachineAccessPublicationLocksInTx(tx, input.machineId);
    const admitted = await managerAccessInTx(tx, input, { requireCurrentKeyHolder: true });
    if (!admitted) return refusal('access_denied');
    const { row } = admitted;
    const encryptionMode = resourceMode(row);
    if (encryptionMode === null || !resourceContentMatchesMode(row, encryptionMode)) return refusal('encryption_material_unavailable');
    if (encryptionMode === 'plain') return refusal('data_key_not_required');
    if (!row.dataEncryptionKey || !parseEncryptedDataKeyEnvelopeV1(row.dataEncryptionKey)) return refusal('encryption_material_unavailable');
    const fingerprint = computeMachineOwnerEnvelopeFingerprintV1(row.dataEncryptionKey);
    const currentBasis = { machineOwnerEnvelopeFingerprint: fingerprint, metadataVersion: row.metadataVersion,
        daemonStateVersion: row.daemonStateVersion };
    const expectedBasis = { machineOwnerEnvelopeFingerprint: input.expectedMachineOwnerEnvelopeFingerprint,
        metadataVersion: input.expectedMetadataVersion, daemonStateVersion: input.expectedDaemonStateVersion };
    if (!isDeepStrictEqual(currentBasis, expectedBasis)) return refusal('machine_key_changed');
    const callerKey = admitted.callerDataEncryptionKey;
    if (!callerKey || !isDeepStrictEqual(callerKey, decodeBase64(input.expectedCallerDataEncryptionKey))) return refusal('recipient_binding_changed');
    const recipientIds = [...new Set(input.recipientKeyEnvelopes.map(envelope => envelope.recipientAccountId))];
    const accounts = recipientIds.length === 0 ? [] : await tx.account.findMany({
        where: { id: { in: recipientIds } }, select: RECIPIENT_READINESS_SELECT,
    });
    const accountsById = new Map(accounts.map(account => [account.id, account]));
    const roles = await machineRolesInTx(tx, [row], recipientIds);
    const prepared: Array<{ recipientAccountId: string; encryptedDataKey: Uint8Array<ArrayBuffer>; recipientContentPublicKeyFingerprint: string }> = [];
    for (const envelope of input.recipientKeyEnvelopes) {
        const encryptedDataKey = new Uint8Array(decodeBase64(envelope.encryptedDataKey));
        if (!parseEncryptedDataKeyEnvelopeV1(encryptedDataKey)) return refusal('invalid_recipient_envelope');
        if (envelope.recipientAccountId === row.accountId || !roles.get(row.id)?.get(envelope.recipientAccountId)) return refusal('access_denied');
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
