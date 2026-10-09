import {
    ManagedListInputV1Schema, ManagedGetInputV1Schema, ManagedCancelInputV1Schema,
    type ManagedMachineActionInputV1,
    ManagedResourceDependencyV1Schema,
    SharedSavedSecretRefV1Schema,
    SHARED_SAVED_SECRET_REF_V1_PREFIX,
    sameQualifiedConnectedAccountRef,
    type ManagedResourceDependencyV1, type ManagedResourceDispositionV1, type QualifiedConnectedAccountRef,
} from "@happier-dev/protocol";
import { inTx, type Tx } from "@/storage/inTx";
import { listSavedSecretReferenceCarrierPathsV1 } from '@happier-dev/protocol/account/settings/savedSecretReferenceV1';
import { readCurrentServerIdentityId } from "@/app/serverIdentity/serverIdentity";
import { listMachineCandidatesInTx, resolveEffectiveMachineRoleInTx } from "@/app/machines/machineAccess";
import {
    ManagedMachineError, readManagedMachineInTx, projectManagedMachineInTx,
    invalidateManagedMachineInTx, projectManagedMachine, readManagedLaunchSnapshot, sameManagedInput, type StoredManagedMachine,
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
    const role = await resolveEffectiveMachineRoleInTx(tx, { actorAccountId, machineId: row.controllerMachineId });
    if (!role || (manage && role !== "manage")) throw new ManagedMachineError("permission_denied");
}
export async function getManagedMachine(params: Readonly<{ actorAccountId: string; input: ManagedMachineActionInputV1<"machines.managed.get"> }>) {
    const input = ManagedGetInputV1Schema.parse(params.input);
    return await inTx(async tx => {
        await requireHome(tx, input.homeId);
        const row = await readManagedMachineInTx(tx, input);
        await requireManagedMachineAccessInTx(tx, row, params.actorAccountId, false);
        return await projectManagedMachineInTx(tx, row);
    });
}
export async function listManagedMachines(params: Readonly<{ actorAccountId: string; input: ManagedMachineActionInputV1<"machines.managed.list"> }>) {
    const input = ManagedListInputV1Schema.parse(params.input);
    return await inTx(async tx => {
        await requireHome(tx, input.homeId);
        const candidates = await listMachineCandidatesInTx(tx, params.actorAccountId);
        const rows = await tx.managedMachine.findMany({ where: { homeId: input.homeId, controllerMachineId: { in: candidates }, archivedAt: input.archived ? { not: null } : null }, orderBy: [{ createdAt: "asc" }, { id: "asc" }] });
        const machines = [];
        for (const row of rows) {
            if (await resolveEffectiveMachineRoleInTx(tx, { actorAccountId: params.actorAccountId, machineId: row.controllerMachineId })) machines.push(await projectManagedMachineInTx(tx, row));
        }
        return { machines };
    });
}
/** Cancellation retires creation; only the existing intent owner can perform native cleanup. */
export async function cancelManagedCreation(params: Readonly<{ actorAccountId: string; input: ManagedMachineActionInputV1<"machines.managed.cancel"> }>) {
    const input = ManagedCancelInputV1Schema.parse(params.input);
    return await inTx(async tx => {
        await requireHome(tx, input.homeId);
        const row = await readManagedMachineInTx(tx, input);
        await requireManagedMachineAccessInTx(tx, row, params.actorAccountId, true);
        if (row.intentRevision !== input.expectedIntentRevision) throw new ManagedMachineError("intent_changed");
        if (row.creationState !== "active") return { machine: await projectManagedMachineInTx(tx, row) };
        if (row.enrolledMachineId) throw new ManagedMachineError("intent_changed");
        const possibleResource = row.allocation !== "unsubmitted" && row.allocation !== "confirmed-absent";
        const changed = await tx.managedMachine.updateMany({ where: { id: row.id, intentRevision: input.expectedIntentRevision, creationState: "active", enrolledMachineId: null }, data: {
            creationState: "canceled", intentRevision: { increment: 1 }, desired: "delete", desiredWhen: "now", desiredAfterMs: null,
            ...(!possibleResource ? { allocation: "confirmed-absent" } : { cleanup: { disposition: "pending", reason: "creation_canceled" } }),
        } });
        if (changed.count !== 1) throw new ManagedMachineError("intent_changed");
        const current = await tx.managedMachine.findUniqueOrThrow({ where: { id: row.id } });
        await invalidateManagedMachineInTx(tx, current);
        return { machine: await projectManagedMachineInTx(tx, current) };
    });
}
