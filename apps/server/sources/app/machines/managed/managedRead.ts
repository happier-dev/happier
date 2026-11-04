import { portableQueryChunks } from '@/storage/portableQueryChunks';
import { jsonPathEquals } from '@/storage/jsonPathFilter';
import { redactManagedMachineCredentialReferences, type ManagedMachineV1 } from '@happier-dev/protocol/machines/managed/managedMachineV1';
import { ManagedListInputV1Schema, ManagedGetInputV1Schema, ManagedCancelInputV1Schema, type ManagedMachineActionInputV1 } from '@happier-dev/protocol/machines/managed/actionsV1';
import { ManagedResourceDependencyV1Schema, type ManagedResourceDependencyV1, type ManagedResourceDispositionV1 } from '@happier-dev/protocol/machines/managed/managedDependencyV1';
import { SharedSavedSecretRefV1Schema } from '@happier-dev/protocol/machines/managed/providerFactsV1';
import { SHARED_SAVED_SECRET_REF_V1_PREFIX } from '@happier-dev/protocol/account/settings/savedSecretReferenceV1';
import { sameQualifiedConnectedAccountRef, type QualifiedConnectedAccountRef } from '@happier-dev/protocol/connect/qualified-connected-account-persistence';
import { inReadSnapshot, inTx, type Tx } from "@/storage/inTx";
import { listSavedSecretReferenceCarrierPathsV1 } from '@happier-dev/protocol/account/settings/savedSecretReferenceV1';
import { readCurrentServerIdentityId } from "@/app/serverIdentity/serverIdentity";
import { listMachineCandidatesInTx, resolveEffectiveMachineAccessForMachinesInTx, resolveEffectiveMachineRoleInTx } from "@/app/machines/machineAccess";
import {
    ManagedMachineError, readManagedMachineInTx, projectManagedMachineInTx,
    invalidateManagedMachineInTx, projectManagedMachine, readManagedLaunchSnapshot, sameManagedInput, type StoredManagedMachine,
    inManagedMachinePublicationTx,
    projectManagedMachinesInTx, projectManagedControllerAccess,
    readManagedAdmissionState,
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
    const rows = await tx.managedMachine.findMany({
        where: {
            allocation: { in: ["may-exist", "bound"] },
            ...(target.kind === "plugin" || target.kind === "connected-account" ? { custodianAccountId: target.accountId } : {}),
            ...(target.kind === "plugin" && target.controller ? {
                controllerMachineId: target.controller.machineId, controllerInstallationId: target.controller.installationId,
            } : {}),
        },
        orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    });
    const dependencies: ManagedResourceDependencyV1[] = [];
    for (const row of rows) {
        const bootstrap = SharedSavedSecretRefV1Schema.safeParse(row.bootstrapCredentialRef);
        const launch = target.kind === "plugin" || target.kind === "connected-account" ? readManagedLaunchSnapshot(row.launch) : undefined;
        const credentials = launch?.credentials?.map(credential => credential.account) ?? [];
        const setupReferencesSecret = (resourceId: string) => listSavedSecretReferenceCarrierPathsV1(row.environmentSetup,
            { secretId: `${SHARED_SAVED_SECRET_REF_V1_PREFIX}${resourceId}` }).length > 0;
        const matches = target.kind === "account"
            ? row.custodianAccountId === target.accountId || machineIds.has(row.controllerMachineId)
                || (bootstrap.success && secretIds.has(bootstrap.data.resourceId))
                || [...secretIds].some(setupReferencesSecret)
            : target.kind === "saved-secret"
                ? (bootstrap.success && bootstrap.data.resourceId === target.resourceId) || setupReferencesSecret(target.resourceId)
                : target.kind === "plugin"
                    ? launch?.provider.pluginId === target.pluginId || credentials.some(credential => credential.service.pluginId === target.pluginId)
                    : credentials.some(credential => sameQualifiedConnectedAccountRef(credential, target.ref));
        if (!matches) continue;
        const machine = projectManagedMachine(row);
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
        return disposition?.responsibility === "manual" && disposition.expectedIntentRevision === resource.intentRevision
            && disposition.expectedAllocation === resource.allocation
            && sameManagedInput(disposition.expectedResource, resource.resource)
            && sameManagedInput(disposition.expectedNativeOperationRef, resource.nativeOperationRef)
            && sameManagedInput(disposition.expectedRecovery, resource.recovery);
    });
}

async function requireHome(tx: Tx, homeId: string) {
    if (await readCurrentServerIdentityId(process.env, tx) !== homeId) throw new ManagedMachineError("permission_denied");
}
export async function requireManagedMachineAccessInTx(tx: Tx, row: StoredManagedMachine, actorAccountId: string, manage: boolean) {
    if (!manage && isManagedMachineCreator(row, actorAccountId)) return;
    const role = await resolveManagedMachineRoleInTx(tx, row, actorAccountId);
    if (!role || (manage && role !== "manage")) throw new ManagedMachineError("permission_denied");
}
/** Only explicit admitted requester identity grants creation-scoped access. */
export function isManagedMachineCreator(row: Pick<StoredManagedMachine, 'admittedInput'>, actorAccountId: string): boolean {
    return readManagedAdmissionState(row.admittedInput).enrollmentAccountId === actorAccountId;
}
/** Creation recovery/cancellation does not grant native power or controller management. */
export async function requireManagedCreationAccessInTx(tx: Tx, row: StoredManagedMachine, actorAccountId: string): Promise<void> {
    if (isManagedMachineCreator(row, actorAccountId)) return;
    await requireManagedMachineAccessInTx(tx, row, actorAccountId, true);
}
export async function getManagedMachine(params: Readonly<{ actorAccountId: string; input: ManagedMachineActionInputV1<"machines.managed.get"> }>) {
    const input = ManagedGetInputV1Schema.parse(params.input);
    return await inTx(async tx => {
        await requireHome(tx, input.homeId);
        const row = await readManagedMachineInTx(tx, input);
        await requireManagedMachineAccessInTx(tx, row, params.actorAccountId, false);
        return projectManagedMachineForActorInTx(tx, row, params.actorAccountId);
    });
}
/** Private native custody and public creator results share one actor-aware projection. */
export async function projectManagedMachineForActorInTx(tx: Tx, row: StoredManagedMachine, actorAccountId: string): Promise<ManagedMachineV1> {
    const machine = await projectManagedMachineInTx(tx, row);
    if (!isManagedMachineCreator(row, actorAccountId) || row.custodianAccountId === actorAccountId
        || await resolveManagedMachineRoleInTx(tx, row, actorAccountId) === 'manage') return machine;
    if (!row.controllerMachineId || !row.controllerInstallationId) return redactManagedMachineCredentialReferences(machine);
    const controller = await tx.machine.findUnique({ where: { id: row.controllerMachineId }, select: {
        kind: true, accountId: true, installationId: true, installationPublicKey: true, revokedAt: true, replacedByMachineId: true,
    } });
    const controllerAccess = projectManagedControllerAccess(controller, { installationId: row.controllerInstallationId });
    return { ...redactManagedMachineCredentialReferences(machine), ...(controllerAccess ? { controllerAccess } : {}) };
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
        const selections = candidates ? portableQueryChunks({ values: candidates, bindingsPerValue: 1,
            fixedBindings: 6 + (input.presetId ? 1 : 0) }) : [];
        const rowsById = new Map<string, StoredManagedMachine>();
        for (const [index, ids] of (selections.length ? selections : [undefined]).entries()) {
            const selected = await tx.managedMachine.findMany({ where: { homeId: input.homeId,
            ...(input.presetId ? { presetId: input.presetId } : {}),
            ...(input.enrolledMachineId ? { enrolledMachineId: input.enrolledMachineId } : {}),
            ...(candidates ? { OR: [
                ...(ids ? [{ controllerMachineId: { in: [...ids] } }] : []),
                ...(index === 0 ? [{ admittedInput: jsonPathEquals(['enrollmentAccountId'], params.actorAccountId) },
                    { custodianAccountId: params.actorAccountId, controllerMachineId: null }] : []),
            ] } : {}),
            archivedAt: input.archived ? { not: null } : null }, orderBy: [{ createdAt: "asc" }, { id: "asc" }] });
            for (const row of selected) rowsById.set(row.id, row);
        }
        const rows = [...rowsById.values()].sort((left, right) => left.createdAt.getTime() - right.createdAt.getTime()
            || left.id.localeCompare(right.id));
        const access = await resolveEffectiveMachineAccessForMachinesInTx(tx, {
            machineIds: rows.flatMap(row => row.controllerMachineId ? [row.controllerMachineId] : []), accountIds: [params.actorAccountId],
        });
        const accessible = rows.filter(row => isManagedMachineCreator(row, params.actorAccountId)
            || resolveManagedMachineRole(row, params.actorAccountId, row.controllerMachineId ? access.get(row.controllerMachineId)?.get(params.actorAccountId) ?? null : null));
        const machines = await projectManagedMachinesInTx(tx, accessible);
        return { machines: machines.map((machine, index) => {
            const row = accessible[index];
            return row.custodianAccountId !== params.actorAccountId && isManagedMachineCreator(row, params.actorAccountId)
                && resolveManagedMachineRole(row, params.actorAccountId, row.controllerMachineId ? access.get(row.controllerMachineId)?.get(params.actorAccountId) ?? null : null) !== 'manage'
                ? redactManagedMachineCredentialReferences(machine) : machine;
        }) };
    });
}
/** Cancellation retires creation; only the existing intent owner can perform native cleanup. */
export async function cancelManagedCreation(params: Readonly<{ actorAccountId: string; input: ManagedMachineActionInputV1<"machines.managed.cancel"> }>) {
    const input = ManagedCancelInputV1Schema.parse(params.input);
    return await inManagedMachinePublicationTx(input, async tx => {
        const row = await readManagedMachineInTx(tx, input);
        await requireHome(tx, input.homeId);
        await requireManagedCreationAccessInTx(tx, row, params.actorAccountId);
        if (row.intentRevision !== input.expectedIntentRevision) throw new ManagedMachineError("intent_changed");
        if (row.creationState !== "active") return { machine: await projectManagedMachineForActorInTx(tx, row, params.actorAccountId) };
        if (row.enrolledMachineId) throw new ManagedMachineError("intent_changed");
        const possibleResource = row.allocation !== "unsubmitted" && row.allocation !== "confirmed-absent";
        const changed = await tx.managedMachine.updateMany({ where: { id: row.id, intentRevision: input.expectedIntentRevision, creationState: "active", enrolledMachineId: null }, data: {
            creationState: "canceled", intentRevision: { increment: 1 }, desired: "delete", desiredWhen: "now", desiredAfterMs: null,
            ...(!possibleResource ? { allocation: "confirmed-absent" } : { cleanup: { disposition: "pending", reason: "creation_canceled" } }),
        } });
        if (changed.count !== 1) throw new ManagedMachineError("intent_changed");
        const current = await tx.managedMachine.findUniqueOrThrow({ where: { id: row.id } });
        await invalidateManagedMachineInTx(tx, current);
        return { machine: await projectManagedMachineForActorInTx(tx, current, params.actorAccountId) };
    });
}
