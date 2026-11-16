import { createStoredReadSchema } from '@happier-dev/protocol/json/storedReadSchema';
import { ManagedMachineFullV1Schema, ManagedOpaqueMachineSetupStateV1Schema, ManagedOpaquePresetMachineV1Schema,
    type ManagedMachineV1, type ManagedMachineFullV1, type ManagedOpaquePresetMachineV1, type ManagedControllerV1 } from '@happier-dev/protocol/machines/managed/managedMachineV1';
import { ManagedOpaquePresetObservationV1Schema } from '@happier-dev/protocol/machines/managed/providerFactsV1';
import { deriveManagedDevcontainerChildProjectionV1 } from '@happier-dev/protocol/machines/managed/devcontainerV1';
import { ManagedMachinePresetEnvelopeV1Schema, type ManagedMachinePresetEnvelopeV1 } from '@happier-dev/protocol/machines/managed/managedMachinePresetContentV1';
import type { StoredManagedAdmission, StoredManagedMachine } from './managedRows';

/**
 * The outer mode is the author-admitted persistence binding.  The inner tag is
 * transport shape only: accepting it as the mode would let a reader infer a
 * different authority after an Account-mode change.
 */
export type StoredOpaquePresetLaunch = ManagedMachinePresetEnvelopeV1 & Readonly<{
    contentEncryptionMode: 'plain' | 'e2ee';
}>;

function requireStoredPresetMode(contentEncryptionMode: 'plain' | 'e2ee', content: ManagedMachinePresetEnvelopeV1['content']): void {
    if ((contentEncryptionMode === 'plain') !== (content.t === 'plain')) {
        throw new Error('Stored opaque preset content mode does not match its persisted binding');
    }
}

/** Presence selects the current carrier even when malformed; never downgrade it to legacy raw. */
export function hasStoredOpaquePresetEnvelope(value: unknown): boolean {
    return value !== null && typeof value === 'object'
        && ('contentEncryptionMode' in value || 'content' in value || 'recipients' in value);
}

export function isStoredOpaquePresetMachine<Row extends Pick<StoredManagedMachine, 'presetId' | 'launch'>>(row: Row): row is Row & { presetId: string } {
    return row.presetId !== null && hasStoredOpaquePresetEnvelope(row.launch);
}

export function readStoredOpaquePresetLaunch(value: unknown): StoredOpaquePresetLaunch {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
        throw new Error('Expected stored opaque preset launch');
    }
    const { contentEncryptionMode, ...envelope } = value as Readonly<Record<string, unknown>>;
    if (contentEncryptionMode !== 'plain' && contentEncryptionMode !== 'e2ee') {
        throw new Error('Expected persisted opaque preset content mode');
    }
    const parsed = ManagedMachinePresetEnvelopeV1Schema.parse(envelope);
    requireStoredPresetMode(contentEncryptionMode, parsed.content);
    return { contentEncryptionMode, ...parsed };
}

export function storeOpaquePresetLaunch(input: Readonly<{
    contentEncryptionMode: 'plain' | 'e2ee';
    content: ManagedMachinePresetEnvelopeV1['content'];
    recipients: ManagedMachinePresetEnvelopeV1['recipients'];
    controllerPoolId?: ManagedMachinePresetEnvelopeV1['controllerPoolId'];
}>): StoredOpaquePresetLaunch {
    const envelope = ManagedMachinePresetEnvelopeV1Schema.parse({
        content: input.content,
        recipients: input.recipients,
        ...(input.controllerPoolId === undefined ? {} : { controllerPoolId: input.controllerPoolId }),
    });
    requireStoredPresetMode(input.contentEncryptionMode, envelope.content);
    return { contentEncryptionMode: input.contentEncryptionMode, ...envelope };
}

/** Retained raw snapshots stay intact on reads; migration exposes their existing private fields. */
export function readStoredPresetSnapshotContent(row: StoredManagedMachine): StoredOpaquePresetLaunch {
    if (hasStoredOpaquePresetEnvelope(row.launch)) return readStoredOpaquePresetLaunch(row.launch);
    const machine = projectManagedMachineFull(row);
    const admission = readManagedAdmissionState(row.admittedInput);
    const controlIntent = admission.submittedEffect?.intent;
    const nativeControlResult = row.resource !== null && row.nativeOperationRef !== null && controlIntent === 'delete'
        ? { kind: 'delete', result: { kind: 'accepted', nativeOperationRef: row.nativeOperationRef } } : undefined;
    if (row.recovery !== null && (row.resource !== null || row.nativeOperationRef !== null)
        || row.resource !== null && row.nativeOperationRef !== null && nativeControlResult === undefined) {
        // A normal controller report must first settle/reseal this historical
        // combination. Refuse migration rather than omit private custody data.
        throw new Error('Retained native state cannot be represented by the preset content carrier');
    }
    const nativeResult = row.resource !== null ? { kind: 'bound', resource: row.resource }
        : row.nativeOperationRef !== null ? { kind: 'pending', nativeOperationRef: row.nativeOperationRef }
            : row.recovery !== null ? { kind: 'unknown', recovery: row.recovery } : undefined;
    return storeOpaquePresetLaunch({ contentEncryptionMode: 'plain', recipients: [], content: { t: 'plain', v: {
        v: 1, name: machine.launch.name, launch: row.launch,
        ...(machine.machineSetup ? { setup: machine.machineSetup.setup } : {}),
        ...(admission.computeInput?.enrollmentIdentity ? { enrollmentIdentity: admission.computeInput.enrollmentIdentity } : {}),
        ...(row.reviewedFacts === null && !admission.computeInput?.reviewedFacts ? {}
            : { reviewedFacts: row.reviewedFacts ?? admission.computeInput?.reviewedFacts }),
        ...(nativeResult === undefined ? {} : { nativeResult }),
        ...(nativeControlResult === undefined ? {} : { nativeControlResult }),
        ...(row.observation === null ? {} : { observation: row.observation }),
    } } });
}

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

function projectManagedMachineStructural(row: StoredManagedMachine) {
    const admission = readManagedAdmissionState(row.admittedInput);
    const submitted = admission.submittedEffect;
    const enrollmentIdentity = admission.computeInput?.enrollmentIdentity;
    const controller = readManagedController(row);
    const structural = {
        id: row.id, homeId: row.homeId, custodianAccountId: row.custodianAccountId,
        ...(admission.enrollmentAccountId ? { enrollmentAccountId: admission.enrollmentAccountId } : {}),
        ...(admission.acquisitionMode ? { acquisitionMode: admission.acquisitionMode } : {}),
        ...(row.presetId && row.presetRevision !== null ? { preset: {
            id: row.presetId,
            revision: row.presetRevision,
            ...(row.presetConfigurationRevision === null ? {} : { configurationRevision: row.presetConfigurationRevision }),
        } } : {}),
        ...(controller ? { controller } : {}),
        allocation: row.allocation, creationState: row.creationState,
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
        ...(row.cleanup !== null ? { cleanup: row.cleanup } : {}),
    };
    return { structural, enrollmentIdentity };
}

/** Project an already selected raw row through the established full stored reader. */
export function projectManagedMachineFull(row: StoredManagedMachine): ManagedMachineFullV1 {
    const { structural, enrollmentIdentity } = projectManagedMachineStructural(row);
    const resource = row.resource === null ? undefined : row.resource as ManagedMachineFullV1['resource'];
    const controller = structural.controller;
    const devcontainerChild = controller ? deriveManagedDevcontainerChildProjectionV1({ managedMachineId: row.id,
        controllerMachineId: controller.machineId, enrolledMachineId: row.enrolledMachineId ?? undefined, resource }) : undefined;
    return createStoredReadSchema(ManagedMachineFullV1Schema).parse({
        ...structural,
        ...(structural.preset ? { preset: { ...structural.preset, contentEncryptionMode: 'plain' } } : {}),
        ...(enrollmentIdentity ? { enrollmentIdentity } : {}),
        ...(resource ? { resource } : {}),
        ...(devcontainerChild ? { devcontainerChild } : {}),
        ...(row.nativeOperationRef !== null ? { nativeOperationRef: row.nativeOperationRef } : {}),
        ...(row.recovery !== null ? { recovery: row.recovery } : {}),
        ...(row.observation !== null ? { observation: row.observation } : {}),
        launch: row.launch,
        ...(row.reviewedFacts !== null ? { reviewedFacts: row.reviewedFacts } : {}),
        ...(row.machineSetup !== null ? { machineSetup: row.machineSetup } : {}),
    });
}

/** Project an already selected opaque row without opening its private content. */
export function projectManagedMachineOpaque(row: StoredManagedMachine): ManagedOpaquePresetMachineV1 {
    const storedOpaquePreset = readStoredOpaquePresetLaunch(row.launch);
    const { structural } = projectManagedMachineStructural(row);
    return createStoredReadSchema(ManagedOpaquePresetMachineV1Schema).parse({
        ...structural,
        ...(structural.preset ? { preset: { ...structural.preset, contentEncryptionMode: storedOpaquePreset.contentEncryptionMode } } : {}),
        ...(row.observation !== null ? { observation: ManagedOpaquePresetObservationV1Schema.parse(row.observation) } : {}),
        ...(row.machineSetup === null ? {} : { machineSetup: ManagedOpaqueMachineSetupStateV1Schema.parse(row.machineSetup) }),
    });
}

/** Project admitted storage through the generic stored reader, never today's provider declaration. */
export function projectManagedMachine(row: StoredManagedMachine): ManagedMachineV1 {
    return isStoredOpaquePresetMachine(row) ? projectManagedMachineOpaque(row) : projectManagedMachineFull(row);
}
