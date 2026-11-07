import { createStoredReadSchema } from '@happier-dev/protocol/json/storedReadSchema';
import { ManagedMachineV1Schema, type ManagedMachineV1, type ManagedControllerV1 } from '@happier-dev/protocol/machines/managed/managedMachineV1';
import { deriveManagedDevcontainerChildProjectionV1 } from '@happier-dev/protocol/machines/managed/devcontainerV1';
import type { StoredManagedAdmission, StoredManagedMachine } from './managedRows';

/** The persisted pair is absent for Account-controlled cloud resources. */
export function readManagedController(row: Readonly<{ controllerMachineId: string | null; controllerInstallationId: string | null }>): ManagedControllerV1 | undefined {
    return row.controllerMachineId && row.controllerInstallationId
        ? { machineId: row.controllerMachineId, installationId: row.controllerInstallationId } : undefined;
}

/** Server-owned JSON written only after acquire/control/policy or native-result admission.
 * Carry those admitted types rather than re-admitting every retained request on reads.
 * Historical acquisitions preserve the absence of enrollment identity.
 */
export function readManagedAdmissionState(value: unknown): StoredManagedAdmission {
    return value as StoredManagedAdmission;
}

/** Project admitted storage through the generic stored reader, never today's provider declaration. */
export function projectManagedMachine(row: StoredManagedMachine): ManagedMachineV1 {
    const admission = readManagedAdmissionState(row.admittedInput);
    const submitted = admission.submittedEffect;
    const enrollmentIdentity = admission.computeInput?.enrollmentIdentity;
    const resource = row.resource === null ? undefined : row.resource as ManagedMachineV1['resource'];
    const controller = readManagedController(row);
    const devcontainerChild = controller ? deriveManagedDevcontainerChildProjectionV1({ managedMachineId: row.id,
        controllerMachineId: controller.machineId, enrolledMachineId: row.enrolledMachineId ?? undefined, resource }) : undefined;
    const value = {
        id: row.id, homeId: row.homeId, custodianAccountId: row.custodianAccountId,
        ...(admission.enrollmentAccountId ? { enrollmentAccountId: admission.enrollmentAccountId } : {}),
        ...(row.presetId && row.presetRevision !== null ? { preset: { id: row.presetId, revision: row.presetRevision } } : {}),
        launch: row.launch, ...(controller ? { controller } : {}),
        ...(enrollmentIdentity ? { enrollmentIdentity } : {}),
        ...(row.reviewedFacts !== null ? { reviewedFacts: row.reviewedFacts } : {}),
        ...(row.machineSetup !== null ? { machineSetup: row.machineSetup } : {}),
        allocation: row.allocation, creationState: row.creationState,
        ...(resource ? { resource } : {}),
        ...(devcontainerChild ? { devcontainerChild } : {}),
        ...(row.nativeOperationRef !== null ? { nativeOperationRef: row.nativeOperationRef } : {}),
        ...(row.recovery !== null ? { recovery: row.recovery } : {}),
        ...(row.bootstrapCredentialRef !== null ? { bootstrapCredentialRef: row.bootstrapCredentialRef } : {}),
        ...(admission.bootstrapInstalled ? { bootstrapInstalled: admission.bootstrapInstalled } : {}),
        ...(row.enrolledMachineId !== null ? { enrolledMachineId: row.enrolledMachineId } : {}),
        desired: row.desired, desiredWhen: row.desiredWhen,
        ...(row.desiredAfterMs !== null ? { desiredAfterMs: Number(row.desiredAfterMs) } : {}),
        intentRevision: row.intentRevision,
        ...(submitted ? { submittedNativeEffect: { intentRevision: submitted.expectedIntentRevision, requestId: submitted.requestId,
            intent: submitted.intent, controller: submitted.controller,
            ...(submitted.reviewedEffectDigest ? { reviewedEffectDigest: submitted.reviewedEffectDigest } : {}) } } : {}),
        ...(row.archivedAt !== null ? { archivedAt: row.archivedAt.getTime() } : {}),
        // The source lifecycle selects the existing unused/drain effect. The
        // person's ordinary retention selection remains intact when they choose Keep.
        retention: admission.creationScopeRetention?.endedAt !== undefined
            ? { kind: 'unused', afterMs: admission.creationScopeRetention.afterMs ?? 0, effect: admission.creationScopeRetention.effect }
            : row.retention,
        wakeOnAcceptedMessage: admission.creationScopeRetention?.endedAt !== undefined && admission.creationScopeRetention.effect === 'delete'
            ? false : row.wakeOnAcceptedMessage,
        ...(admission.creationScopeRetention ? { creationScopeRetention: admission.creationScopeRetention } : {}),
        ...(row.observation !== null ? { observation: row.observation } : {}),
        ...(row.cleanup !== null ? { cleanup: row.cleanup } : {}),
    };
    return createStoredReadSchema(ManagedMachineV1Schema).parse(value);
}
