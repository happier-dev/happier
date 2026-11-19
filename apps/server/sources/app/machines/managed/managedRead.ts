import { isStoredOpaquePresetMachine, projectManagedMachineFull, projectManagedMachineOpaque } from './managedMachineProjection';
import { ManagedListInputV1Schema, ManagedGetInputV1Schema, ManagedCancelInputV1Schema, type ManagedMachineActionInputV1, type ManagedMachineReadV1 } from '@happier-dev/protocol/machines/managed/actionsV1';
import { isManagedOpaquePresetResourceDependencyV1, isManagedOpaquePresetResourceDispositionV1, ManagedResourceDependencyV1Schema, type ManagedResourceDependencyV1, type ManagedResourceDispositionV1 } from '@happier-dev/protocol/machines/managed/managedDependencyV1';
import { SharedSavedSecretRefV1Schema } from '@happier-dev/protocol/machines/managed/providerFactsV1';
import { isManagedOpaquePresetMachineV1, redactManagedMachineCredentialReferences, type ManagedMachineV1 } from '@happier-dev/protocol/machines/managed/managedMachineV1';
import { projectManagedMachinePresetForRecipientV1 } from '@happier-dev/protocol/machines/managed/managedMachinePresetContentV1';
import { SHARED_SAVED_SECRET_REF_V1_PREFIX } from '@happier-dev/protocol/account/settings/savedSecretReferenceV1';
import { sameQualifiedConnectedAccountRef, type QualifiedConnectedAccountRef } from '@happier-dev/protocol/connect/qualified-connected-account-persistence';
import type { Prisma } from '@prisma/client';
import { inReadSnapshot, inTx, type Tx } from "@/storage/inTx";
import { jsonPathEquals } from '@/storage/jsonPathFilter';
import { getActivePrismaRuntime } from '@/storage/prisma';
import { portableQueryChunks } from '@/storage/portableQueryChunks';
import { listSavedSecretReferenceCarrierPathsV1 } from '@happier-dev/protocol/account/settings/savedSecretReferenceV1';
import { readCurrentServerIdentityId } from "@/app/serverIdentity/serverIdentity";
import { resolveEffectiveAccountEncryptionModeFromAccountRow } from '@/app/encryption/accountEncryptionMode';
import { isExternalActionRequestVersionAllowedForAccountModeV1 } from '@happier-dev/protocol/actions/externalActionApi';
import { listMachineCandidatesInTx, resolveEffectiveMachineAccessForMachinesInTx } from "@/app/machines/machineAccess";
import {
    ManagedMachineError, readManagedMachineInTx, projectManagedMachineInTx,
    invalidateManagedMachineInTx, readManagedLaunchSnapshot, sameManagedInput, type StoredManagedMachine,
    inManagedMachinePublicationTx,
    projectManagedMachinesInTx, projectManagedControllerAccess,
    readManagedAdmissionState,
    hasPossibleManagedNativeResource, readStoredOpaquePresetLaunch,
    resolveManagedMachineRoleInTx, resolveManagedMachineRole,
} from "./managedRows";

type ManagedResourceDependencyTarget =
    | Readonly<{ kind: "account"; accountId: string }>
    | Readonly<{ kind: "plugin"; accountId: string; pluginId: string;
        controller?: Readonly<{ machineId: string; installationId: string }> }>
    | Readonly<{ kind: "connected-account"; accountId: string; ref: QualifiedConnectedAccountRef }>
    | Readonly<{ kind: "saved-secret"; resourceId: string }>;

/** Reads real retained custody, including archived and unavailable resources, without requiring a serving plugin. */
export async function readManagedResourceDependenciesInTx(tx: Tx, target: ManagedResourceDependencyTarget): Promise<ManagedResourceDependencyV1[]> {
    const machines = target.kind === "account"
        ? await tx.machine.findMany({ where: { accountId: target.accountId }, select: { id: true } }) : [];
    const secrets = target.kind === "account"
        ? await tx.savedSecretResource.findMany({ where: { ownerAccountId: target.accountId }, select: { id: true } }) : [];
    const machineIds = new Set(machines.map(machine => machine.id));
    const secretIds = new Set(secrets.map(secret => secret.id));
    const ownedOrReferenced = target.kind === 'account' ? [
        { custodianAccountId: target.accountId },
        // Immutable setup may carry additive reference fields; the matcher
        // below remains authoritative for those candidate rows.
        ...(secretIds.size > 0 ? [
            { machineSetup: { not: getActivePrismaRuntime().DbNull } },
        ] : []),
    ] : [];
    const read = (where: Prisma.ManagedMachineWhereInput) => tx.managedMachine.findMany({
        where: { allocation: { in: ["may-exist", "bound"] }, ...where,
            ...(target.kind === "plugin" || target.kind === "connected-account" ? { custodianAccountId: target.accountId } : {}),
            ...(target.kind === "plugin" && target.controller ? {
                controllerMachineId: target.controller.machineId, controllerInstallationId: target.controller.installationId,
            } : {}),
        },
        orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    });
    const rows = await read(target.kind === 'account' ? { OR: ownedOrReferenced }
        : target.kind === 'saved-secret' ? { OR: [
            { bootstrapCredentialRef: jsonPathEquals(['resourceId'], target.resourceId) },
            { machineSetup: { not: getActivePrismaRuntime().DbNull } },
        ] } : {});
    if (target.kind === 'account') {
        // Custodian/setup and controller selections are disjoint.
        for (const ids of portableQueryChunks({ values: [...machineIds], bindingsPerValue: 1,
            fixedBindings: 4 + (secretIds.size > 0 ? 2 : 0) })) {
            rows.push(...await read({ controllerMachineId: { in: [...ids] }, NOT: { OR: ownedOrReferenced } }));
        }
        // Bootstrap references are selected by the owned secrets, never by
        // secret-owner Account on the retained allocation (shared references cross Accounts).
        // Each JSON equality binds path/value for comparison and type qualification;
        // allocation binds two values and the custodian exclusion binds one.
        for (const ids of portableQueryChunks({ values: [...secretIds], bindingsPerValue: 4,
            fixedBindings: 3 })) {
            rows.push(...await read({ OR: ids.map(id => ({ bootstrapCredentialRef: jsonPathEquals(['resourceId'], id) })),
                NOT: { OR: ownedOrReferenced } }));
        }
        rows.sort((left, right) => left.createdAt.getTime() - right.createdAt.getTime() || left.id.localeCompare(right.id));
    }
    const dependencies: ManagedResourceDependencyV1[] = [];
    // A controller-owned allocation can also carry a matching bootstrap
    // reference; project it once after the bounded independent selections.
    const selectedRows = target.kind === 'account' ? new Map(rows.map(row => [row.id, row])).values() : rows;
    for (const row of selectedRows) {
        // Preset declaration and setup content is opaque. In particular, resource
        // dependency review must not turn a retained ciphertext row into a server
        // plaintext parser. Account retirement still needs structural custody for
        // its own retained allocations and controller-owned allocations.
        if (isStoredOpaquePresetMachine(row)) {
            const matchesAccountCustody = target.kind === 'account'
                && (row.custodianAccountId === target.accountId
                    || row.controllerMachineId !== null && machineIds.has(row.controllerMachineId));
            if (matchesAccountCustody) {
                const machine = projectManagedMachineOpaque(row);
                dependencies.push(ManagedResourceDependencyV1Schema.parse({
                    managedId: machine.id, homeId: machine.homeId, custodianAccountId: machine.custodianAccountId,
                    intentRevision: machine.intentRevision, controller: machine.controller,
                    allocation: machine.allocation, observation: machine.observation, cleanup: machine.cleanup,
                    opaquePreset: true,
                }));
            }
            continue;
        }
        const bootstrap = SharedSavedSecretRefV1Schema.safeParse(row.bootstrapCredentialRef);
        const launch = target.kind === "plugin" || target.kind === "connected-account" ? readManagedLaunchSnapshot(row.launch) : undefined;
        const credentials = launch?.credentials?.flatMap(credential => 'account' in credential ? [credential.account] : []) ?? [];
        const setupReferencesSecret = (resourceId: string) => listSavedSecretReferenceCarrierPathsV1(row.machineSetup,
            { secretId: `${SHARED_SAVED_SECRET_REF_V1_PREFIX}${resourceId}` }).length > 0;
        const matches = target.kind === "account"
                ? row.custodianAccountId === target.accountId || (row.controllerMachineId !== null && machineIds.has(row.controllerMachineId))
                || (bootstrap.success && secretIds.has(bootstrap.data.resourceId))
                || [...secretIds].some(setupReferencesSecret)
            : target.kind === "saved-secret"
                ? (bootstrap.success && bootstrap.data.resourceId === target.resourceId) || setupReferencesSecret(target.resourceId)
                : target.kind === "plugin"
                    ? launch?.provider.pluginId === target.pluginId || credentials.some(credential => credential.service.pluginId === target.pluginId)
                    : credentials.some(credential => sameQualifiedConnectedAccountRef(credential, target.ref));
        if (!matches) continue;
        const machine = projectManagedMachineFull(row);
        dependencies.push(ManagedResourceDependencyV1Schema.parse({
            managedId: machine.id, homeId: machine.homeId, custodianAccountId: machine.custodianAccountId,
            intentRevision: machine.intentRevision, controller: machine.controller, provider: machine.launch.provider,
            allocation: machine.allocation, resource: machine.resource, nativeOperationRef: machine.nativeOperationRef,
            recovery: machine.recovery, observation: machine.observation, cleanup: machine.cleanup,
        }));
    }
    return dependencies;
}

export function acceptsManagedResourceDispositions(resources: readonly ManagedResourceDependencyV1[], dispositions: readonly ManagedResourceDispositionV1[] = []): boolean {
    if (resources.length !== dispositions.length) return false;
    const reviewed = new Map(dispositions.map(disposition => [disposition.managedId, disposition]));
    return reviewed.size === resources.length && resources.every(resource => {
        const disposition = reviewed.get(resource.managedId);
        if (isManagedOpaquePresetResourceDependencyV1(resource)) {
            return disposition !== undefined && isManagedOpaquePresetResourceDispositionV1(disposition)
                && disposition.responsibility === 'manual'
                && disposition.expectedIntentRevision === resource.intentRevision
                && disposition.expectedAllocation === resource.allocation;
        }
        return disposition !== undefined && !isManagedOpaquePresetResourceDispositionV1(disposition)
            && disposition.responsibility === "manual" && disposition.expectedIntentRevision === resource.intentRevision
            && disposition.expectedAllocation === resource.allocation
            && sameManagedInput(disposition.expectedResource, resource.resource)
            && sameManagedInput(disposition.expectedNativeOperationRef, resource.nativeOperationRef)
            && sameManagedInput(disposition.expectedRecovery, resource.recovery);
    });
}

async function requireHome(tx: Tx, homeId: string) {
    if (await readCurrentServerIdentityId(process.env, tx) !== homeId) throw new ManagedMachineError("permission_denied");
}
export async function requireManagedMachineAccessInTx(tx: Tx,
    row: Pick<StoredManagedMachine, 'admittedInput' | 'custodianAccountId' | 'controllerMachineId' | 'enrolledMachineId'>,
    actorAccountId: string, manage: boolean) {
    if (!manage && isManagedMachineCreator(row, actorAccountId)) return;
    const role = await resolveManagedMachineRoleInTx(tx, row, actorAccountId);
    if (!role || (manage && role !== "manage")) throw new ManagedMachineError("permission_denied");
}
/** Only explicit admitted requester identity grants creation-scoped access. */
export function isManagedMachineCreator(row: Pick<StoredManagedMachine, 'admittedInput'>, actorAccountId: string): boolean {
    const admission = readManagedAdmissionState(row.admittedInput);
    return admission.enrollmentAccountId === actorAccountId && !admission.resourceBoundSessionEnded;
}
/** Creation recovery/cancellation does not grant native power or controller management. */
export async function requireManagedCreationAccessInTx(tx: Tx,
    row: Parameters<typeof requireManagedMachineAccessInTx>[1], actorAccountId: string): Promise<'creator' | 'manage'> {
    if (isManagedMachineCreator(row, actorAccountId)) return 'creator';
    await requireManagedMachineAccessInTx(tx, row, actorAccountId, true);
    return 'manage';
}
export async function getManagedMachine(params: Readonly<{ actorAccountId: string; input: ManagedMachineActionInputV1<"machines.managed.get">;
    enrolledMachineId?: string }>) {
    const input = ManagedGetInputV1Schema.parse(params.input);
    return await inTx(async tx => {
        await requireHome(tx, input.homeId);
        if ('creationRequestId' in input) {
            if (params.enrolledMachineId !== undefined) throw new ManagedMachineError('managed_not_found');
            const row = await tx.managedMachine.findUnique({ where: { homeId_admittedActionRequestId: {
                homeId: input.homeId, admittedActionRequestId: input.creationRequestId,
            } } });
            const root = row && readManagedAdmissionState(row.admittedInput).continuation?.workflowRoot;
            if (!row || !root || root.binding.accountId !== params.actorAccountId
                || root.binding.serverIdentityId !== input.homeId) throw new ManagedMachineError('managed_not_found');
            const account = await tx.account.findUnique({ where: { id: params.actorAccountId }, select: { encryptionMode: true } });
            const mode = account && resolveEffectiveAccountEncryptionModeFromAccountRow(account);
            if (mode?.status !== 'ready' || !isExternalActionRequestVersionAllowedForAccountModeV1({
                accountEncryptionMode: mode.mode, envelopeVersion: root.envelope.v,
            })) throw new ManagedMachineError('managed_not_found');
            try { await requireManagedMachineAccessInTx(tx, row, params.actorAccountId, false); }
            catch (error) {
                if (error instanceof ManagedMachineError && error.code === 'permission_denied') throw new ManagedMachineError('managed_not_found');
                throw error;
            }
            return { ...await projectManagedMachineReadForActorInTx(tx, row, params.actorAccountId), retainedWorkflowRoot: root };
        }
        const row = await readManagedMachineInTx(tx, input);
        if (params.enrolledMachineId !== undefined && row.enrolledMachineId !== params.enrolledMachineId) {
            throw new ManagedMachineError('managed_not_found');
        }
        await requireManagedMachineAccessInTx(tx, row, params.actorAccountId, false);
        return projectManagedMachineReadForActorInTx(tx, row, params.actorAccountId);
    });
}
/** Private native custody and public creator results share one actor-aware projection. */
export async function projectManagedMachineForActorInTx(tx: Tx, row: StoredManagedMachine, actorAccountId: string): Promise<ManagedMachineV1> {
    const machine = await projectManagedMachineInTx(tx, row);
    if (row.custodianAccountId === actorAccountId
        || !isManagedMachineCreator(row, actorAccountId)
            && await resolveManagedMachineRoleInTx(tx, row, actorAccountId) === 'manage') return machine;
    if (!row.controllerMachineId || !row.controllerInstallationId) return redactManagedMachineCredentialReferences(machine);
    const controller = await tx.machine.findUnique({ where: { id: row.controllerMachineId }, select: {
        kind: true, accountId: true, installationId: true, installationPublicKey: true, revokedAt: true, replacedByMachineId: true,
    } });
    const controllerAccess = projectManagedControllerAccess(controller, { installationId: row.controllerInstallationId });
    return { ...redactManagedMachineCredentialReferences(machine), ...(controllerAccess ? { controllerAccess } : {}) };
}
/**
 * Account reads of an opaque preset never disclose the audience.  The stored
 * carrier is exact for this allocation revision, while the recipient envelope
 * is projected by the protocol owner for just the authenticated reader.
 */
export function projectManagedMachineReadForActor(
    row: Pick<StoredManagedMachine, 'presetId' | 'launch'>,
    machine: ManagedMachineV1,
    actorAccountId: string,
): ManagedMachineReadV1 {
    if (!isManagedOpaquePresetMachineV1(machine)) return machine;
    const { content, recipients } = readStoredOpaquePresetLaunch(row.launch);
    return {
        machine,
        presetContent: projectManagedMachinePresetForRecipientV1({ content, recipients, recipientAccountId: actorAccountId }),
    };
}
export async function projectManagedMachineReadForActorInTx(tx: Tx, row: StoredManagedMachine, actorAccountId: string): Promise<ManagedMachineReadV1> {
    return projectManagedMachineReadForActor(row, await projectManagedMachineForActorInTx(tx, row, actorAccountId), actorAccountId);
}
export async function listManagedMachines(params: Readonly<{ actorAccountId: string; input: ManagedMachineActionInputV1<"machines.managed.list"> }>) {
    const input = ManagedListInputV1Schema.parse(params.input);
    return await inReadSnapshot(async tx => {
        await requireHome(tx, input.homeId);
        // Retiring a controller must not conceal the custodian's retained managed
        // resources, including archived history and outstanding native cleanup.
        const candidates = input.enrolledMachineId ? undefined
            : await listMachineCandidatesInTx(tx, params.actorAccountId, { includeRevokedOwned: true });
        // Home, creator JSON path/value and Prisma pagination accompany each ID set.
        const selections = candidates ? portableQueryChunks({ values: candidates, bindingsPerValue: 2,
            fixedBindings: 6 + (input.presetId ? 1 : 0) }) : [];
        const rowsById = new Map<string, StoredManagedMachine>();
        for (const [index, ids] of (selections.length ? selections : [undefined]).entries()) {
            const selected = await tx.managedMachine.findMany({ where: { homeId: input.homeId,
            ...(input.presetId ? { presetId: input.presetId } : {}),
            ...(input.enrolledMachineId ? { enrolledMachineId: input.enrolledMachineId } : {}),
            ...(candidates ? { OR: [
                ...(ids ? [{ controllerMachineId: { in: [...ids] } }, { enrolledMachineId: { in: [...ids] } }] : []),
                ...(index === 0 ? [{ admittedInput: jsonPathEquals(['enrollmentAccountId'], params.actorAccountId) },
                    { custodianAccountId: params.actorAccountId, controllerMachineId: null }] : []),
            ] } : {}),
            archivedAt: input.archived ? { not: null } : null }, orderBy: [{ createdAt: "asc" }, { id: "asc" }] });
            for (const row of selected) rowsById.set(row.id, row);
        }
        const rows = [...rowsById.values()].sort((left, right) => left.createdAt.getTime() - right.createdAt.getTime()
            || left.id.localeCompare(right.id));
        const access = await resolveEffectiveMachineAccessForMachinesInTx(tx, {
            machineIds: rows.flatMap(row => [row.controllerMachineId, row.enrolledMachineId].filter((id): id is string => id !== null)),
            accountIds: [params.actorAccountId],
        });
        const role = (row: StoredManagedMachine) => resolveManagedMachineRole(row, params.actorAccountId,
            row.controllerMachineId ? access.get(row.controllerMachineId)?.get(params.actorAccountId) ?? null : null,
            row.enrolledMachineId ? access.get(row.enrolledMachineId)?.get(params.actorAccountId) ?? null : null);
        const accessible = rows.filter(row => isManagedMachineCreator(row, params.actorAccountId)
            || role(row));
        const machines = await projectManagedMachinesInTx(tx, accessible);
        return { machines: machines.map((machine, index) => {
            const row = accessible[index];
            const projected = row.custodianAccountId !== params.actorAccountId
                && (isManagedMachineCreator(row, params.actorAccountId) || role(row) !== 'manage')
                ? redactManagedMachineCredentialReferences(machine) : machine;
            return projectManagedMachineReadForActor(row, projected, params.actorAccountId);
        }) };
    });
}
/** Cancellation retires creation; only the existing intent owner can perform native cleanup. */
export async function cancelManagedCreation(params: Readonly<{ actorAccountId: string; input: ManagedMachineActionInputV1<"machines.managed.cancel"> }>,
    options: Readonly<{ onlyIfUnsubmitted?: boolean; admittedCreationRecovery?: true }> = {}) {
    const input = ManagedCancelInputV1Schema.parse(params.input);
    return await inManagedMachinePublicationTx(input, async tx => {
        const row = await readManagedMachineInTx(tx, input);
        await requireHome(tx, input.homeId);
        if (!options.admittedCreationRecovery) await requireManagedCreationAccessInTx(tx, row, params.actorAccountId);
        // A refused dispatch can retire only work which never crossed submit.
        // The allocation predicate below shares that boundary with native admission.
        if (options.onlyIfUnsubmitted && (row.allocation !== 'unsubmitted'
            || row.creationState !== 'active' || row.intentRevision !== input.expectedIntentRevision)) {
            return { machine: await projectManagedMachineForActorInTx(tx, row, params.actorAccountId) };
        }
        if (readManagedAdmissionState(row.admittedInput).workspaceAttachment) throw new ManagedMachineError('native_intent_unsupported');
        if (row.intentRevision !== input.expectedIntentRevision) throw new ManagedMachineError("intent_changed");
        if (row.creationState !== "active") return { machine: await projectManagedMachineForActorInTx(tx, row, params.actorAccountId) };
        if (row.enrolledMachineId) throw new ManagedMachineError("intent_changed");
        const possibleResource = hasPossibleManagedNativeResource(row);
        const changed = await tx.managedMachine.updateMany({ where: { id: row.id, intentRevision: input.expectedIntentRevision, creationState: "active", enrolledMachineId: null,
            ...(options.onlyIfUnsubmitted ? { allocation: 'unsubmitted' } : {}),
        }, data: {
            creationState: "canceled", intentRevision: { increment: 1 }, desired: "delete", desiredWhen: "now", desiredAfterMs: null,
            ...(!possibleResource ? { allocation: "confirmed-absent" } : { cleanup: { disposition: "pending", reason: "creation_canceled" } }),
        } });
        if (changed.count !== 1 && !options.onlyIfUnsubmitted) throw new ManagedMachineError("intent_changed");
        const current = await tx.managedMachine.findUniqueOrThrow({ where: { id: row.id } });
        await invalidateManagedMachineInTx(tx, current);
        return { machine: await projectManagedMachineForActorInTx(tx, current, params.actorAccountId) };
    });
}
