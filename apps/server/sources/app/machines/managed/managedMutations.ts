import {
    ManagedControllerCurrentnessV1Schema, ManagedControllerReportV1Schema,
    ManagedControllerSubmitInputV1Schema, type ManagedControllerSubmitInputV1,
    ManagedEnrollmentCorrelationV1Schema, ManagedBootstrapCredentialCreateV1Schema,
    ManagedMachineV1Schema,
    type ManagedControllerCurrentnessV1, type ManagedControllerReportV1,
    type ManagedEnrollmentCorrelationV1, type ManagedBootstrapCredentialCreateV1,
    ManagedControlAdmissionInputV1Schema, ManagedControllerIntentReportV1Schema,
    type ManagedControlAdmissionInputV1, type ManagedControllerIntentReportV1,
    ProviderObservationV1Schema, createStoredReadSchema,
    ManagedPolicyAdmissionInputV1Schema,
    type ManagedPolicyAdmissionInputV1, type ManagedPolicyPurposeV1,
    type ExternalActionExecutionAuthorizationV1,
    MANAGED_ADMISSION_DRAIN_CONFIRM_RPC_METHOD, verifyMachineInstallationProof,
    isMachineRetentionPolicySupportedV1,
} from "@happier-dev/protocol";
import { resolveEffectiveMachineRoleInTx } from "@/app/machines/machineAccess";
import { validateManagedRecipeInTx } from "./machinePresetService";
import type { TeamOperationAuthenticationContext } from "@/app/teams/actorContext";
import { createSavedSecretResourceInTx } from "@/app/account/savedSecrets/savedSecretResourceService";
import type { Prisma } from "@prisma/client";
import * as privacyKit from "privacy-kit";
import { inTx, type Tx } from "@/storage/inTx";
import { getActivePrismaRuntime } from "@/storage/db";
import { jsonPathEquals } from "@/storage/jsonPathFilter";
import { readCurrentServerIdentityId } from "@/app/serverIdentity/serverIdentity";
import { classifyMachineAvailabilityState } from "@/app/machines/machineStateGuards";
import { applyMachineReplacement } from "@/app/machines/applyMachineReplacement";
import { assertManagedWakeOriginCurrentInTx } from './managedWake';
import {
    ManagedMachineError, requireCurrentManagedMachineInTx, resolveManagedDeclarationInTx,
    projectManagedMachine, invalidateManagedMachineInTx, sameManagedInput,
    createManagedMachineDeclaredSchema,
    readManagedLaunchSnapshot,
    projectManagedMachineInTx,
    requireManagedControllerInTx,
    readManagedMachineInTx,
    type StoredManagedMachine,
    readManagedAdmissionState, readManagedCurrentRequestId,
} from "./managedRows";

/** A declared, retained native handle can identify partial cleanup before resource binding. */
async function hasPendingManagedCleanupTargetInTx(tx: Tx, row: StoredManagedMachine): Promise<boolean> {
    if (row.allocation !== 'may-exist' || row.resource !== null || row.nativeOperationRef === null) return false;
    const launch = readManagedLaunchSnapshot(row.launch);
    const declaration = await resolveManagedDeclarationInTx(tx, { homeId: row.homeId, custodianAccountId: row.custodianAccountId,
        controller: { machineId: row.controllerMachineId, installationId: row.controllerInstallationId }, provider: launch.provider });
    if (!declaration?.reconciliation || declaration.schemaVersion !== launch.schemaVersion) return false;
    return projectManagedMachine(row, declaration).nativeOperationRef !== undefined;
}

/** Policy execution consumes committed row intent, guest drain or an accepted origin, never caller ids alone. */
export async function requireManagedPolicyPurposeInTx(tx: Tx, row: StoredManagedMachine, purpose: ManagedPolicyPurposeV1, options: Readonly<{ admission?: boolean; actionOrigin?: ExternalActionExecutionAuthorizationV1 }> = {}): Promise<'start' | 'resume' | 'stop' | 'delete'> {
    const machine = await projectManagedMachineInTx(tx, row);
    const pendingCleanup = purpose.kind === 'creation-cleanup' && await hasPendingManagedCleanupTargetInTx(tx, row);
    if (machine.archivedAt !== undefined || (!(machine.allocation === 'bound' && machine.resource) && !pendingCleanup)
        || (purpose.kind === 'creation-cleanup'
            ? machine.creationState !== 'canceled' || machine.desired !== 'delete' || machine.desiredWhen !== 'now'
            : machine.creationState !== 'active')) throw new ManagedMachineError('resource_mismatch');
    const admission = readManagedAdmissionState(row.admittedInput).currentAdmission;
    const admittedPurpose = admission?.kind === 'policy' ? admission.request.purpose : undefined;
    if (!options.admission && !sameManagedInput(admittedPurpose, purpose)) {
        if (purpose.kind !== 'accepted-input-start' || admittedPurpose?.kind !== 'accepted-input-start'
            || !sameManagedInput({ ...admittedPurpose.target, expectedIntentRevision: purpose.target.expectedIntentRevision }, purpose.target)) throw new ManagedMachineError('request_conflict');
        purpose = admittedPurpose;
    }
    // Cancel already committed this Delete intent through its ordinary Action
    // owner. The installation proof binds its execution, not a new approval.
    if (purpose.kind === 'creation-cleanup') return 'delete';
    if (purpose.kind === 'accepted-input-start') {
        if (!machine.wakeOnAcceptedMessage || machine.desired === 'delete') throw new ManagedMachineError('intent_changed');
        await assertManagedWakeOriginCurrentInTx(tx, { row, target: purpose.target, actionOrigin: options.actionOrigin });
        if (options.admission && purpose.target.expectedIntentRevision !== row.intentRevision) throw new ManagedMachineError('intent_changed');
        const declaration = await resolveManagedDeclarationInTx(tx, { homeId: row.homeId, custodianAccountId: row.custodianAccountId,
            controller: machine.controller, provider: machine.launch.provider });
        if (!options.admission && machine.desired === 'resume' && declaration?.retention.supportedIntents.includes('resume')) return 'resume';
        if (machine.observation?.power === 'suspended' && declaration?.retention.supportedIntents.includes('resume')) return 'resume';
        if (!declaration?.retention.supportedIntents.includes('start')) throw new ManagedMachineError('provider_unavailable');
        return 'start';
    }
    if (machine.retention.kind === 'until-delete') throw new ManagedMachineError('permission_denied');
    if (machine.retention.kind === 'deadline') {
        if (!machine.retention.interrupts || Date.now() < machine.retention.at) throw new ManagedMachineError('intent_changed');
        return machine.retention.effect;
    }
    const evidence = purpose.evidence;
    if (!evidence) throw new ManagedMachineError('permission_denied');
    const { context, method, managedTarget, decision, proof } = evidence;
    const guest = await tx.machine.findUnique({ where: { id: context.machineId } });
    if (context.custodianAccountId !== row.custodianAccountId || context.actorAccountId !== row.custodianAccountId
        || row.enrolledMachineId !== context.machineId || context.role !== 'manage'
        || !guest || guest.accountId !== row.custodianAccountId || guest.installationId !== context.installationId
        || classifyMachineAvailabilityState(guest) !== 'available' || !guest.installationPublicKey
        || method !== `${context.machineId}:${MANAGED_ADMISSION_DRAIN_CONFIRM_RPC_METHOD}`
        || managedTarget.homeId !== row.homeId || managedTarget.managedId !== row.id
        || !sameManagedInput(managedTarget.controller, machine.controller)
        || (options.admission && managedTarget.expectedRevision !== row.intentRevision)
        || !verifyMachineInstallationProof({ payload: { version: 1, machineId: context.machineId, installationId: context.installationId,
            accountId: context.custodianAccountId, rpcAdmission: { context, method, managedTarget, managedIdleDecision: decision } }, proof,
            publicKey: guest.installationPublicKey })) throw new ManagedMachineError('permission_denied');
    const account = await tx.account.findUnique({ where: { id: row.custodianAccountId }, select: { encryptionMode: true } });
    if (account?.encryptionMode !== context.encryptionMode || decision.confirmedAt - decision.since < machine.retention.afterMs) throw new ManagedMachineError('intent_changed');
    return machine.retention.effect;
}

/** The existing row is the one policy/current-request authority; no extra wake queue or effect journal. */
export async function admitManagedPolicy(params: Readonly<{ custodianAccountId: string; input: ManagedPolicyAdmissionInputV1; actionOrigin?: ExternalActionExecutionAuthorizationV1 }>) {
    return readOrAdmitManagedPolicy(params, true);
}

/** Approval reviews the same qualified policy without committing a desired intent. */
export async function prepareManagedPolicy(params: Readonly<{ custodianAccountId: string; input: ManagedPolicyAdmissionInputV1; actionOrigin?: ExternalActionExecutionAuthorizationV1 }>) {
    const prepared = await readOrAdmitManagedPolicy(params, false);
    return { machine: prepared.machine };
}

async function readOrAdmitManagedPolicy(params: Readonly<{ custodianAccountId: string; input: ManagedPolicyAdmissionInputV1; actionOrigin?: ExternalActionExecutionAuthorizationV1 }>, admit: boolean) {
    const input = ManagedPolicyAdmissionInputV1Schema.parse(params.input);
    return inTx(async tx => {
        const row = await readManagedMachineInTx(tx, input);
        if (row.custodianAccountId !== params.custodianAccountId || row.controllerMachineId !== input.controller.machineId
            || row.controllerInstallationId !== input.controller.installationId) throw new ManagedMachineError('permission_denied');
        await requireManagedControllerInTx(tx, { ...input, custodianAccountId: params.custodianAccountId });
        const admitted = readManagedAdmissionState(row.admittedInput);
        const pending = admitted.submittedEffect;
        const currentAdmission = { kind: 'policy' as const, request: input };
        if (readManagedCurrentRequestId(row) === input.requestId) {
            if (!sameManagedInput(admitted.currentAdmission, currentAdmission)) throw new ManagedMachineError('request_conflict');
            return { machine: await projectManagedMachineInTx(tx, row), requestId: input.requestId, replayed: true };
        }
        const previousPurpose = admitted.currentAdmission?.kind === 'policy' ? admitted.currentAdmission.request.purpose : undefined;
        if (pending && previousPurpose?.kind === 'retention'
            && input.purpose.kind === 'retention') {
            return { machine: await projectManagedMachineInTx(tx, row), requestId: readManagedCurrentRequestId(row), replayed: true };
        }
        if (input.purpose.kind === 'accepted-input-start'
            && previousPurpose?.kind === 'accepted-input-start' && (row.desired === 'start' || row.desired === 'resume')
            && sameManagedInput(previousPurpose.target.origin, input.purpose.target.origin)) {
            await requireManagedPolicyPurposeInTx(tx, row, previousPurpose, { actionOrigin: params.actionOrigin });
            return { machine: await projectManagedMachineInTx(tx, row), requestId: readManagedCurrentRequestId(row), replayed: true };
        }
        if (row.intentRevision !== input.expectedIntentRevision) throw new ManagedMachineError('intent_changed');
        const intent = await requireManagedPolicyPurposeInTx(tx, row, input.purpose, { admission: true, actionOrigin: params.actionOrigin });
        const machine = await projectManagedMachineInTx(tx, row);
        const declaration = await resolveManagedDeclarationInTx(tx, { homeId: row.homeId, custodianAccountId: row.custodianAccountId,
            controller: input.controller, provider: machine.launch.provider });
        if (!declaration?.retention.supportedIntents.includes(intent)) throw new ManagedMachineError('provider_unavailable');
        if (!admit) return { machine: { ...machine, desired: intent, desiredWhen: 'now' as const, desiredAfterMs: undefined },
            requestId: input.requestId, replayed: false };
        const changed = await tx.managedMachine.updateMany({ where: { id: row.id, intentRevision: input.expectedIntentRevision,
            controllerMachineId: input.controller.machineId, controllerInstallationId: input.controller.installationId, admittedInput: { equals: row.admittedInput } },
            data: { desired: intent, desiredWhen: 'now', desiredAfterMs: null, intentRevision: { increment: 1 },
                admittedInput: { ...admitted, currentAdmission },
                ...(intent === 'delete' ? { cleanup: { disposition: 'pending', reason: 'delete_requested' } } : {}) } });
        if (changed.count !== 1) throw new ManagedMachineError('intent_changed');
        const current = await tx.managedMachine.findUniqueOrThrow({ where: { id: row.id } });
        await invalidateManagedMachineInTx(tx, current);
        return { machine: await projectManagedMachineInTx(tx, current), requestId: readManagedCurrentRequestId(current), replayed: false };
    });
}

/** Same-row admission owns immediate CAS, fire-time idle intent, policy and future controller custody. */
export async function admitManagedControl(params: Readonly<{
    actorAccountId: string; custodianAccountId: string; authentication?: TeamOperationAuthenticationContext;
    input: ManagedControlAdmissionInputV1;
}>) {
    const request = ManagedControlAdmissionInputV1Schema.parse(params.input);
    return await inTx(async tx => {
        const input = request.input;
        const row = await readManagedMachineInTx(tx, { homeId: input.homeId,
            managedId: 'managedMachineId' in input ? input.managedMachineId : input.managedId });
        if (row.custodianAccountId !== params.custodianAccountId
            || await resolveEffectiveMachineRoleInTx(tx, { actorAccountId: params.actorAccountId, machineId: row.controllerMachineId }) !== "manage") throw new ManagedMachineError("permission_denied");
        const controller = { machineId: row.controllerMachineId, installationId: row.controllerInstallationId };
        await requireManagedControllerInTx(tx, { homeId: row.homeId, custodianAccountId: row.custodianAccountId, controller });
        const admitted = readManagedAdmissionState(row.admittedInput);
        const currentAdmission = { kind: 'control' as const, request };
        if (readManagedCurrentRequestId(row) === request.requestId) {
            if (admitted.currentAdmission?.kind !== 'control'
                || !sameManagedInput(admitted.currentAdmission.request, request)) throw new ManagedMachineError("request_conflict");
            return { machine: await projectManagedMachineInTx(tx, row), replayed: true };
        }
        const expected = 'when' in input ? input.when === 'now' ? input.expectedRevision : row.intentRevision
            : 'expectedRevision' in input ? input.expectedRevision : input.expectedIntentRevision;
        if (row.intentRevision !== expected) throw new ManagedMachineError("intent_changed");
        const data: Prisma.ManagedMachineUpdateManyMutationInput = {
            intentRevision: { increment: 1 }, admittedInput: { ...admitted, currentAdmission },
        };
        if (request.action === "machines.managed.retire") {
            data.archivedAt = new Date();
            data.cleanup = { disposition: "unavailable", reason: "manual_responsibility" };
        } else {
            const pendingCleanup = request.action === 'machines.managed.delete' && request.input.when === 'now'
                && await hasPendingManagedCleanupTargetInTx(tx, row);
            if (row.creationState !== "active" || (!(row.allocation === "bound" && row.resource) && !pendingCleanup)) throw new ManagedMachineError("resource_mismatch");
            const launch = readManagedLaunchSnapshot(row.launch);
            const declaration = await resolveManagedDeclarationInTx(tx, { homeId: row.homeId, custodianAccountId: row.custodianAccountId, controller, provider: launch.provider });
            if (!declaration || declaration.schemaVersion !== launch.schemaVersion) throw new ManagedMachineError("provider_unavailable");
            if (request.action === "machines.managed.controller.update") {
                if (declaration.billing.location !== "cloud") throw new ManagedMachineError("controller_unavailable");
                await requireManagedControllerInTx(tx, { homeId: row.homeId, custodianAccountId: row.custodianAccountId, controller: request.input.controller });
                await validateManagedRecipeInTx(tx, { accountId: params.actorAccountId, authentication: params.authentication }, {
                    homeId: row.homeId, controller: request.input.controller, recipe: projectManagedMachine(row, declaration).launch,
                });
                data.controllerMachineId = request.input.controller.machineId;
                data.controllerInstallationId = request.input.controller.installationId;
            } else if (request.action === "machines.managed.retention.update") {
                const policy = request.input;
                if (!isMachineRetentionPolicySupportedV1(policy, declaration.retention)) throw new ManagedMachineError("provider_unavailable");
                data.retention = policy.retention;
                data.wakeOnAcceptedMessage = policy.wakeOnAcceptedMessage;
            } else if (request.action === "machines.managed.rebuild") {
                if (declaration.resourceKind !== 'devcontainer' || !declaration.retention.supportedIntents.includes('rebuild')
                    || !declaration.actions.rebuild) throw new ManagedMachineError("provider_unavailable");
                data.desired = 'rebuild';
                data.desiredWhen = 'now';
                data.desiredAfterMs = null;
            } else {
                if (!declaration.retention.supportedIntents.includes(request.input.intent)) throw new ManagedMachineError("provider_unavailable");
                data.desired = request.input.intent;
                data.desiredWhen = request.input.when;
                data.desiredAfterMs = request.input.when === "after-idle" && request.input.afterMs !== undefined ? request.input.afterMs : null;
                if (request.input.intent === "delete") data.cleanup = { disposition: "pending", reason: "delete_requested" };
            }
        }
        const changed = await tx.managedMachine.updateMany({ where: { id: row.id, intentRevision: expected,
            controllerMachineId: controller.machineId, controllerInstallationId: controller.installationId, admittedInput: { equals: row.admittedInput } }, data });
        if (changed.count !== 1) throw new ManagedMachineError("intent_changed");
        const current = await tx.managedMachine.findUniqueOrThrow({ where: { id: row.id } });
        await invalidateManagedMachineInTx(tx, row);
        if (row.controllerMachineId !== current.controllerMachineId) await invalidateManagedMachineInTx(tx, current);
        return { machine: await projectManagedMachineInTx(tx, current), replayed: false };
    });
}

/** Claim only the current single native effect before IO; submitted ambiguity survives policy/Move edits. */
export async function submitManagedIntent(input: ManagedControllerCurrentnessV1) {
    const canonical = ManagedControllerCurrentnessV1Schema.parse(input);
    return await inTx(async tx => {
        const row = await requireCurrentManagedMachineInTx(tx, canonical, { allowInactiveCurrentIntent: true });
        const pendingCleanup = row.archivedAt === null && row.desired === 'delete' && row.desiredWhen === 'now'
            && await hasPendingManagedCleanupTargetInTx(tx, row);
        if (!(row.allocation === "bound" && row.resource) && !pendingCleanup) throw new ManagedMachineError("resource_mismatch");
        const admitted = readManagedAdmissionState(row.admittedInput);
        if (admitted.submittedEffect) return { machine: await projectManagedMachineInTx(tx, row), submitted: false };
        const rebuild = admitted.currentAdmission?.kind === 'control' && admitted.currentAdmission.request.action === 'machines.managed.rebuild'
            ? admitted.currentAdmission.request.input : undefined;
        if (row.desired === 'rebuild' && !rebuild) throw new ManagedMachineError('request_conflict');
        if (row.desired === 'rebuild' && admitted.currentAdmission?.kind === 'control' && admitted.currentAdmission.rebuildSettled) {
            return { machine: await projectManagedMachineInTx(tx, row), submitted: false };
        }
        const changed = await tx.managedMachine.updateMany({ where: { id: row.id, intentRevision: canonical.expectedIntentRevision, admittedInput: { equals: row.admittedInput } },
            data: { admittedInput: { ...admitted, submittedEffect: { ...canonical, intent: row.desired,
                ...(rebuild ? { reviewedEffectDigest: rebuild.reviewedEffectDigest } : {}) } } } });
        const current = await tx.managedMachine.findUniqueOrThrow({ where: { id: row.id } });
        if (changed.count) await invalidateManagedMachineInTx(tx, current);
        return { machine: await projectManagedMachineInTx(tx, current), submitted: changed.count === 1 };
    });
}

/** Native command settlement is not an observation. Late exact submitted reports cannot replace current intent. */
export async function reportManagedIntent(input: ManagedControllerIntentReportV1) {
    const canonical = ManagedControllerIntentReportV1Schema.parse(input);
    return await inTx(async tx => {
        const row = await readManagedMachineInTx(tx, canonical);
        const admitted = readManagedAdmissionState(row.admittedInput);
        const pending = admitted.submittedEffect;
        if (!pending || pending.homeId !== canonical.homeId || pending.managedId !== canonical.managedId
                || pending.expectedIntentRevision !== canonical.expectedIntentRevision || pending.requestId !== canonical.requestId
                || !sameManagedInput(pending.controller, canonical.controller)) throw new ManagedMachineError("request_conflict");
        const data: Prisma.ManagedMachineUpdateManyMutationInput = {};
        if (canonical.result.kind === 'bound') {
            if (pending.intent !== 'rebuild') throw new ManagedMachineError('resource_mismatch');
            const launch = readManagedLaunchSnapshot(row.launch);
            const declaration = await resolveManagedDeclarationInTx(tx, { homeId: row.homeId, custodianAccountId: row.custodianAccountId,
                controller: canonical.controller, provider: launch.provider });
            if (!declaration || declaration.schemaVersion !== launch.schemaVersion || !declaration.actions.rebuild) throw new ManagedMachineError('provider_unavailable');
            const previous = projectManagedMachine(row, declaration);
            const previousNativeId = previous.resource?.devcontainerObservation?.nativeResourceId;
            // Devcontainer rebuild removes the retained native child before
            // realizing its replacement. Namespace changes on that old child
            // do not prove a new installation; opaque identities of other
            // provisioner kinds are not subject to this native contract.
            if (declaration.resourceKind === 'devcontainer' && (previousNativeId === undefined
                || canonical.result.resource.devcontainerObservation === undefined
                || previousNativeId === canonical.result.resource.devcontainerObservation.nativeResourceId)) {
                throw new ManagedMachineError('resource_mismatch');
            }
            const parsed = createManagedMachineDeclaredSchema(declaration.launchSchema, declaration.resourceSchema, declaration.reconciliation?.nativeOperationSchema)
                .safeParse({ ...previous, enrolledMachineId: undefined, devcontainerChild: undefined, resource: canonical.result.resource });
            if (!parsed.success) throw new ManagedMachineError('resource_mismatch');
            const { submittedEffect: _settled, ...retained } = admitted;
            const currentAdmission = admitted.currentAdmission;
            const settlesCurrentRebuild = currentAdmission?.kind === 'control'
                && currentAdmission.request.action === 'machines.managed.rebuild'
                && currentAdmission.request.requestId === pending.requestId
                && row.intentRevision === pending.expectedIntentRevision
                && row.controllerMachineId === pending.controller.machineId
                && row.controllerInstallationId === pending.controller.installationId;
            data.resource = ManagedMachineV1Schema.parse(parsed.data).resource;
            data.allocation = 'bound';
            data.enrolledMachineId = null;
            data.observation = getActivePrismaRuntime().DbNull;
            data.recovery = getActivePrismaRuntime().DbNull;
            data.cleanup = getActivePrismaRuntime().DbNull;
            data.admittedInput = { ...retained,
                ...(settlesCurrentRebuild ? { currentAdmission: { ...currentAdmission, rebuildSettled: true } } : {}),
                ...(row.enrolledMachineId ? { replacementEnrollment: { machineId: row.enrolledMachineId } } : {}) };
            const changed = await tx.managedMachine.updateMany({ where: { id: row.id, intentRevision: row.intentRevision,
                admittedInput: { equals: row.admittedInput } }, data });
            if (changed.count !== 1) throw new ManagedMachineError('intent_changed');
            const current = await tx.managedMachine.findUniqueOrThrow({ where: { id: row.id } });
            await invalidateManagedMachineInTx(tx, row);
            return { machine: await projectManagedMachineInTx(tx, current) };
        }
        if (pending.intent === 'rebuild' && canonical.result.kind === 'unknown' && 'recovery' in canonical.result) {
            data.recovery = canonical.result.recovery;
        }
        const previousObservation = createStoredReadSchema(ProviderObservationV1Schema).safeParse(row.observation);
        const currentObservation = canonical.observation && (!previousObservation.success || canonical.observation.observedAt >= previousObservation.data.observedAt)
            ? canonical.observation : undefined;
        if (currentObservation) {
            data.observation = currentObservation;
            if (currentObservation.availability === "absent" && pending.intent !== 'rebuild') data.allocation = "confirmed-absent";
        }
        const observedSettlement = pending.intent !== 'rebuild' && currentObservation && (pending.intent === 'delete'
            ? currentObservation.availability === 'absent'
            : currentObservation.availability === 'present' && currentObservation.power === (
                pending.intent === 'stop' ? 'stopped' : pending.intent === 'suspend' ? 'suspended'
                    : pending.intent === 'start' || pending.intent === 'resume' ? 'running' : undefined));
        if (canonical.result.kind !== "refused" && !observedSettlement) {
            // Retire transfers cleanup to the user; an unresolved native
            // effect retains its fact without reclaiming that responsibility.
            if (row.archivedAt === null) data.cleanup = { disposition: "pending", reason: ('code' in canonical.result ? canonical.result.code : undefined) ?? "native_effect_unknown" };
        } else {
            const { submittedEffect: _settled, ...currentAdmission } = admitted;
            data.admittedInput = currentAdmission;
            if (currentObservation?.availability === "absent") data.cleanup = getActivePrismaRuntime().DbNull;
            else if (row.archivedAt === null) data.cleanup = canonical.result.kind === "refused"
                ? { disposition: "unavailable", reason: canonical.result.code } : getActivePrismaRuntime().DbNull;
        }
        const changed = await tx.managedMachine.updateMany({ where: { id: row.id, intentRevision: row.intentRevision, admittedInput: { equals: row.admittedInput } }, data });
        if (changed.count !== 1) throw new ManagedMachineError("intent_changed");
        const current = await tx.managedMachine.findUniqueOrThrow({ where: { id: row.id } });
        await invalidateManagedMachineInTx(tx, row);
        return { machine: await projectManagedMachineInTx(tx, current) };
    });
}

/** Only the successful unsubmitted -> may-exist transition permits native acquisition. */
export async function submitManagedAcquire(input: ManagedControllerSubmitInputV1) {
    const canonical = ManagedControllerSubmitInputV1Schema.parse(input);
    return await inTx(async (tx) => {
        const row = await requireCurrentManagedMachineInTx(tx, canonical, { requestAuthority: 'creation' });
        const launch = readManagedLaunchSnapshot(row.launch);
        const credentials = launch.credentials ?? [];
        const captured = canonical.credentials ?? [];
        if (row.allocation === 'unsubmitted' && (captured.length !== credentials.length
            || captured.some(credential => credential.configurationRevision === undefined
                || !credentials.some(selected => sameManagedInput(selected.purpose, credential.purpose)
                    && sameManagedInput(selected.account, credential.account))))) throw new ManagedMachineError('credential_unavailable');
        const changed = await tx.managedMachine.updateMany({ where: { id: row.id, intentRevision: canonical.expectedIntentRevision, creationState: "active", allocation: "unsubmitted" }, data: {
            allocation: "may-exist",
            ...(credentials.length ? { launch: { ...launch, credentials: captured } } : {}),
        } });
        const current = changed.count ? await tx.managedMachine.findUniqueOrThrow({ where: { id: row.id } }) : row;
        if (changed.count) await invalidateManagedMachineInTx(tx, current);
        return { machine: await projectManagedMachineInTx(tx, current), submitted: changed.count === 1 };
    });
}

/** Bound identity is saved before bootstrap, including an exact late cleanup identity. */
export async function reportManagedAcquire(input: ManagedControllerReportV1, options: Readonly<{ requestAuthority?: 'creation' | 'intent' }> = {}) {
    const canonical = ManagedControllerReportV1Schema.parse(input);
    return await inTx(async (tx) => {
        const row = await requireCurrentManagedMachineInTx(tx, canonical, { requestAuthority: options.requestAuthority ?? 'creation',
            allowCanceledResourceReport: (canonical.result.kind === "bound" || canonical.result.kind === "pending") && options.requestAuthority !== 'intent',
            allowInactiveCurrentIntent: options.requestAuthority === 'intent' });
        const launch = readManagedLaunchSnapshot(row.launch);
        const declaration = await resolveManagedDeclarationInTx(tx, { homeId: row.homeId, custodianAccountId: row.custodianAccountId, controller: canonical.controller, provider: launch.provider });
        if (!declaration || declaration.schemaVersion !== launch.schemaVersion) throw new ManagedMachineError("provider_unavailable");
        if (canonical.result.kind === "bound") {
            if (row.allocation !== "may-exist" && row.allocation !== "bound") throw new ManagedMachineError("intent_changed");
            const current = projectManagedMachine(row, declaration);
            const parsed = createManagedMachineDeclaredSchema(declaration.launchSchema, declaration.resourceSchema, declaration.reconciliation?.nativeOperationSchema).safeParse({ ...current, allocation: "bound", resource: canonical.result.resource });
            if (!parsed.success) throw new ManagedMachineError("resource_mismatch");
            const projected = ManagedMachineV1Schema.parse(parsed.data);
            if (row.resource !== null && !sameManagedInput(current.resource, projected.resource)) throw new ManagedMachineError("resource_mismatch");
            const changed = await tx.managedMachine.updateMany({ where: { id: row.id, intentRevision: row.intentRevision, creationState: row.creationState }, data: {
                allocation: "bound", resource: projected.resource,
                ...(row.creationState !== "active" && row.archivedAt === null ? { cleanup: { disposition: "pending", reason: "late_allocation" } } : {}),
                ...(canonical.observation ? { observation: canonical.observation } : {}),
            } });
            if (changed.count !== 1) throw new ManagedMachineError("intent_changed");
            const updated = await tx.managedMachine.findUniqueOrThrow({ where: { id: row.id } });
            await invalidateManagedMachineInTx(tx, updated);
            return { machine: projectManagedMachine(updated, declaration) };
        }
        if (row.allocation !== "may-exist") throw new ManagedMachineError("intent_changed");
        const result = canonical.result;
        if (result.kind === "pending") {
            if (!declaration.reconciliation) throw new ManagedMachineError("provider_unavailable");
            const parsed = createManagedMachineDeclaredSchema(declaration.launchSchema, declaration.resourceSchema, declaration.reconciliation.nativeOperationSchema)
                .safeParse({ ...projectManagedMachine(row, declaration), nativeOperationRef: result.nativeOperationRef });
            if (!parsed.success) throw new ManagedMachineError("resource_mismatch");
        }
        const changed = await tx.managedMachine.updateMany({ where: { id: row.id, intentRevision: row.intentRevision, creationState: row.creationState, allocation: "may-exist" }, data: {
            ...(result.kind === "pending" ? { nativeOperationRef: result.nativeOperationRef } : {}),
            ...(result.kind === "unknown" ? { recovery: result.recovery } : {}),
            ...(result.kind === "rejected" ? { allocation: "confirmed-absent" } : {}),
            ...(canonical.observation ? { observation: canonical.observation } : {}),
        } });
        if (changed.count !== 1) throw new ManagedMachineError("intent_changed");
        const updated = await tx.managedMachine.findUniqueOrThrow({ where: { id: row.id } });
        await invalidateManagedMachineInTx(tx, updated);
        return { machine: projectManagedMachine(updated, declaration) };
    });
}

/** Creates the private key at SavedSecret's owner and retains only its reference atomically. */
export async function createManagedBootstrapCredential(input: ManagedBootstrapCredentialCreateV1) {
    const canonical = ManagedBootstrapCredentialCreateV1Schema.parse(input);
    return await inTx(async (tx) => {
        const row = await requireCurrentManagedMachineInTx(tx, canonical, { requestAuthority: 'creation' });
        if (row.bootstrapCredentialRef !== null) return { machine: await projectManagedMachineInTx(tx, row) };
        // Acquire the owning row's database write lock before creating a secret.
        // Concurrent callers then reuse the winning reference, never orphan a key.
        const claimed = await tx.managedMachine.updateMany({ where: { id: row.id, intentRevision: row.intentRevision, creationState: "active", bootstrapCredentialRef: { equals: getActivePrismaRuntime().DbNull } }, data: { intentRevision: row.intentRevision } });
        if (claimed.count !== 1) {
            const current = await requireCurrentManagedMachineInTx(tx, canonical, { requestAuthority: 'creation' });
            if (current.bootstrapCredentialRef !== null) return { machine: await projectManagedMachineInTx(tx, current) };
            throw new ManagedMachineError("intent_changed");
        }
        const account = await tx.account.findUniqueOrThrow({ where: { id: row.custodianAccountId }, select: { encryptionMode: true } });
        if (canonical.credential.encryptionMode !== account.encryptionMode
            || (canonical.credential.accountGrants?.length ?? 0) > 0
            || (canonical.credential.teamGrants?.length ?? 0) > 0
            || (canonical.credential.groupGrants?.length ?? 0) > 0) throw new ManagedMachineError("credential_unavailable");
        const created = await createSavedSecretResourceInTx(tx, { ...canonical.credential, accountId: row.custodianAccountId,
            keyEnvelopes: canonical.credential.keyEnvelopes?.map((envelope) => ({ ...envelope, encryptedDataKey: privacyKit.decodeBase64(envelope.encryptedDataKey) })),
        });
        if (!created.ok) throw new ManagedMachineError("credential_unavailable");
        const updated = await tx.managedMachine.update({ where: { id: row.id }, data: { bootstrapCredentialRef: { kind: "shared_resource", resourceId: created.value.resourceId } } });
        await invalidateManagedMachineInTx(tx, updated);
        return { machine: await projectManagedMachineInTx(tx, updated) };
    });
}

/** Ordinary rejoin cannot bypass the proof retained for a rebuilt installation. */
type ManagedMachineRegistrationInput = Readonly<{
    custodianAccountId: string; machineId: string; enrollment?: ManagedEnrollmentCorrelationV1;
}>;
export function requireManagedMachineRegistrationInTx(tx: Tx, input: ManagedMachineRegistrationInput & { enrollment: ManagedEnrollmentCorrelationV1 }): Promise<StoredManagedMachine>;
export function requireManagedMachineRegistrationInTx(tx: Tx, input: ManagedMachineRegistrationInput): Promise<StoredManagedMachine | undefined>;
export async function requireManagedMachineRegistrationInTx(tx: Tx, input: ManagedMachineRegistrationInput): Promise<StoredManagedMachine | undefined> {
    const homeId = await readCurrentServerIdentityId(process.env, tx);
    // An unavailable Home must not erase an existing pending proof requirement;
    // the exact Account/Machine predicate still recognizes it and refuses proof.
    const pending = await tx.managedMachine.findMany({ where: {
        ...(homeId === null ? {} : { homeId }), custodianAccountId: input.custodianAccountId,
        // Match requireCurrentManagedMachineInTx's enrollment lifecycle. Retire
        // keeps recovery history but hands ordinary custody back to its owner.
        creationState: 'active', archivedAt: null,
        admittedInput: jsonPathEquals(['replacementEnrollment', 'machineId'], input.machineId),
    }, select: { id: true, admittedInput: true } });
    for (const row of pending) {
        if (readManagedAdmissionState(row.admittedInput).replacementEnrollment?.machineId !== input.machineId
            || !input.enrollment || input.enrollment.homeId !== homeId || input.enrollment.managedId !== row.id) {
            throw new ManagedMachineError('enrollment_retired');
        }
    }
    if (input.enrollment) return await requireManagedEnrollmentInTx(tx, input.enrollment, input.custodianAccountId);
}

/** Enrollment remains inside ordinary registration's transaction, before any Machine write. */
export async function requireManagedEnrollmentInTx(tx: Tx, input: ManagedEnrollmentCorrelationV1, custodianAccountId: string) {
    const canonical = ManagedEnrollmentCorrelationV1Schema.parse(input);
    const retained = await readManagedMachineInTx(tx, canonical);
    const row = await requireCurrentManagedMachineInTx(tx, canonical, { requestAuthority:
        canonical.requestId === retained.admittedActionRequestId ? 'creation' : 'intent' });
    if (readManagedAdmissionState(row.admittedInput).submittedEffect?.intent === 'rebuild') throw new ManagedMachineError('enrollment_retired');
    if (row.custodianAccountId !== custodianAccountId || row.allocation !== "bound") throw new ManagedMachineError("resource_mismatch");
    const declaration = await resolveManagedDeclarationInTx(tx, { homeId: row.homeId, custodianAccountId: row.custodianAccountId, controller: canonical.controller, provider: readManagedLaunchSnapshot(row.launch).provider });
    if (!declaration || declaration.schemaVersion !== readManagedLaunchSnapshot(row.launch).schemaVersion) throw new ManagedMachineError("provider_unavailable");
    const stored = projectManagedMachine(row, declaration);
    const incoming = createManagedMachineDeclaredSchema(declaration.launchSchema, declaration.resourceSchema, declaration.reconciliation?.nativeOperationSchema).safeParse({ ...stored, resource: canonical.resource });
    if (!incoming.success || !sameManagedInput(stored.resource, incoming.data.resource)) throw new ManagedMachineError("resource_mismatch");
    return row;
}

export async function linkManagedEnrollmentInTx(tx: Tx, input: ManagedEnrollmentCorrelationV1, custodianAccountId: string, machineId: string): Promise<void> {
    const row = await requireManagedMachineRegistrationInTx(tx, { custodianAccountId, machineId, enrollment: input });
    const machine = await tx.machine.findUnique({ where: { id: machineId } });
    if (!machine || machine.accountId !== custodianAccountId || classifyMachineAvailabilityState(machine) !== "available") throw new ManagedMachineError("enrollment_retired");
    if (machine.id === row.controllerMachineId || machine.installationId === row.controllerInstallationId) throw new ManagedMachineError("resource_mismatch");
    if (row.enrolledMachineId && row.enrolledMachineId !== machineId) throw new ManagedMachineError("resource_mismatch");
    const admitted = readManagedAdmissionState(row.admittedInput);
    const { replacementEnrollment, ...retainedAdmission } = admitted;
    if (replacementEnrollment && replacementEnrollment.machineId !== machineId) {
        const previous = await tx.machine.findUnique({ where: { id: replacementEnrollment.machineId } });
        if (!previous || previous.accountId !== custodianAccountId) throw new ManagedMachineError('resource_mismatch');
        await applyMachineReplacement({ tx, accountId: custodianAccountId, oldMachineId: previous.id,
            replacementMachineId: machineId, reason: 'managed_native_rebuild', source: 'automatic', actorUserId: null });
    }
    const updated = await tx.managedMachine.updateMany({ where: { id: row.id, intentRevision: input.expectedIntentRevision, creationState: "active", enrolledMachineId: row.enrolledMachineId,
        admittedInput: { equals: row.admittedInput } }, data: { enrolledMachineId: machineId, ...(replacementEnrollment ? { admittedInput: retainedAdmission } : {}) } });
    if (updated.count !== 1) throw new ManagedMachineError("enrollment_retired");
    await invalidateManagedMachineInTx(tx, row);
}
