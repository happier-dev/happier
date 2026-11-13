import { isStoredOpaquePresetMachine } from './managedMachineProjection';
import { readManagedCreationBirthInTx } from './managedCreationBirth';
import { requireManagedCreationAccessInTx } from './managedRead';
import { isManagedResizeActionIdV1, MANAGED_RESIZE_ACTION_ID_V1 } from '@happier-dev/protocol/machines/managed/actionIdsV1';
import { ManagedControllerResizeReportV1Schema, type ManagedControllerResizeReportV1 } from '@happier-dev/protocol/machines/managed/actionsV1';
import { ManagedControllerCurrentnessV1Schema, ManagedControllerReportV1Schema, ManagedControllerSubmitInputV1Schema, type ManagedControllerSubmitInputV1, ManagedEnrollmentCorrelationV1Schema, ManagedBootstrapCredentialCreateV1Schema, type ManagedControllerCurrentnessV1, type ManagedControllerReportV1, type ManagedEnrollmentCorrelationV1, type ManagedBootstrapCredentialCreateV1, ManagedControlAdmissionInputV1Schema, ManagedControllerIntentReportV1Schema, type ManagedControlAdmissionInputV1, type ManagedControllerIntentReportV1 } from '@happier-dev/protocol/machines/managed/actionsV1';
import { ManagedMachineV1Schema } from '@happier-dev/protocol/machines/managed/managedMachineV1';
import { buildManagedConfigurationFactsV1 } from '@happier-dev/protocol/machines/managed/managedConfigurationV1';
import { createPluginJsonSchemaZodValueAdapter } from '@happier-dev/protocol/plugins/actions/json-schema-validation';
import { ManagedOpaquePresetObservationV1Schema, ProviderObservationV1Schema } from '@happier-dev/protocol/machines/managed/providerFactsV1';
import { createStoredReadSchema } from '@happier-dev/protocol/json/storedReadSchema';
import { ManagedPolicyAdmissionInputV1Schema, type ManagedPolicyAdmissionInputV1, type ManagedPolicyPurposeV1 } from '@happier-dev/protocol/machines/managed/managedPolicyV1';
import { type ExternalActionExecutionAuthorizationV1 } from '@happier-dev/protocol/actions/externalActionApi';
import { MANAGED_ADMISSION_DRAIN_CONFIRM_RPC_METHOD } from '@happier-dev/protocol/machines/managed/managedIntentV1';
import { verifyMachineInstallationProof } from '@happier-dev/protocol/machines/identity/installationIdentity';
import { isMachineRetentionPolicySupportedV1, resolveMachineRetentionNativeIntentV1, resolveMachineWakeNativeIntentV1 } from '@happier-dev/protocol/machines/managed/resolveMachineRetentionPolicyV1';
import { validateManagedLaunchInTx } from "./machinePresetService";
import type { TeamOperationAuthenticationContext } from "@/app/teams/actorContext";
import { createSavedSecretResourceInTx } from "@/app/account/savedSecrets/savedSecretResourceService";
import type { Prisma } from "@prisma/client";
import * as privacyKit from "privacy-kit";
import { inReadSnapshot, type Tx } from "@/storage/inTx";
import { getActivePrismaRuntime } from "@/storage/db";
import { jsonPathEquals } from "@/storage/jsonPathFilter";
import { readCurrentServerIdentityId } from "@/app/serverIdentity/serverIdentity";
import { classifyMachineAvailabilityState } from "@/app/machines/machineStateGuards";
import { applyMachineReplacement } from "@/app/machines/applyMachineReplacement";
import { assertManagedWakeOriginCurrentInTx } from './managedWake';
import { doesManagedNativeObservationSettleIntent } from './managedNativeObservation';
import {
    ManagedMachineError, requireCurrentManagedMachineInTx, resolveManagedRowDeclarationInTx, resolveManagedDeclarationInTx,
    requireActiveManagedResizeInTx, readManagedIntentReportAuthority,
    projectManagedMachine, invalidateManagedMachineInTx, sameManagedInput,
    createManagedMachineRetainedSchema,
    readManagedLaunchSnapshot,
    projectManagedMachineInTx,
    requireManagedControllerInTx,
    readManagedMachineInTx,
    type StoredManagedMachine,
    readManagedAdmissionState, readManagedCurrentRequestId, readManagedEnrollmentAccountId,
    readManagedJsonEqualityOperand,
    inManagedMachinePublicationTx,
    readManagedController, readManagedOpaquePresetContent, readManagedOpaquePresetContentOverride, requireManagedHomeInTx, resolveManagedMachineRoleInTx,
    hasPossibleManagedNativeResource,
} from "./managedRows";
import { readStoredOpaquePresetLaunch } from './managedMachineProjection';

/** Admission/control returns the exact retained opaque envelope, never a latest Preset read. */
function projectManagedAdmissionCarrier(row: StoredManagedMachine, machine = projectManagedMachine(row)) {
    if (!isStoredOpaquePresetMachine(row)) return { machine };
    const presetContentOverride = readManagedOpaquePresetContentOverride(row);
    return { machine, presetContent: readManagedOpaquePresetContent(row),
        ...(presetContentOverride ? { presetContentOverride } : {}) };
}

/** Declared reconciliation can recover partial cleanup; native submission still requires its concrete target. */
async function hasPendingManagedCleanupTargetInTx(tx: Tx, row: StoredManagedMachine, allowCorrelation = false): Promise<boolean> {
    if (row.allocation !== 'may-exist' || row.resource !== null) return false;
    if (isStoredOpaquePresetMachine(row)) return false;
    const launch = readManagedLaunchSnapshot(row.launch);
    const declaration = await resolveManagedRowDeclarationInTx(tx, row);
    if (!declaration?.reconciliation || declaration.schemaVersion !== launch.schemaVersion) return false;
    return row.nativeOperationRef === null ? allowCorrelation : projectManagedMachine(row).nativeOperationRef !== undefined;
}

/** Opaque rows retain bound lifecycle authority without retaining a provider-native identity at Home. */
function hasBoundManagedLifecycle(row: Pick<StoredManagedMachine, 'presetId' | 'launch' | 'allocation' | 'resource'>): boolean {
    return row.allocation === 'bound' && (isStoredOpaquePresetMachine(row) || row.resource !== null);
}

/** Policy execution consumes committed row intent, guest drain or an accepted origin, never caller ids alone. */
export async function requireManagedPolicyPurposeInTx(tx: Tx, row: StoredManagedMachine, purpose: ManagedPolicyPurposeV1, options: Readonly<{ admission?: boolean; actionOrigin?: ExternalActionExecutionAuthorizationV1 }> = {}): Promise<'start' | 'resume' | 'stop' | 'suspend' | 'delete'> {
    const machine = await projectManagedMachineInTx(tx, row);
    const pendingCleanup = purpose.kind === 'creation-cleanup' && await hasPendingManagedCleanupTargetInTx(tx, row);
    if (machine.archivedAt !== undefined || (!hasBoundManagedLifecycle(row) && !pendingCleanup)
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
        if ((!machine.wakeOnAcceptedMessage && purpose.target.origin.kind !== 'finite-command')
            || machine.desired === 'delete') throw new ManagedMachineError('intent_changed');
        await assertManagedWakeOriginCurrentInTx(tx, { row, target: purpose.target, actionOrigin: options.actionOrigin });
        if (options.admission && purpose.target.expectedIntentRevision !== row.intentRevision) throw new ManagedMachineError('intent_changed');
        if (isStoredOpaquePresetMachine(row)) return machine.desired === 'resume' ? 'resume' : 'start';
        const declaration = await resolveManagedRowDeclarationInTx(tx, row);
        if (!options.admission && machine.desired === 'resume' && declaration?.retention.supportedIntents.includes('resume')) return 'resume';
        const intent = resolveMachineWakeNativeIntentV1(machine.observation?.power, declaration?.retention.supportedIntents ?? []);
        if (!intent) throw new ManagedMachineError('provider_unavailable');
        return intent;
    }
    if (machine.retention.kind === 'until-delete') throw new ManagedMachineError('permission_denied');
    /** A retention Stop is carried out by the provider's native Stop, or its Suspend when that is how it parks. */
    const retentionIntent = async (effect: 'stop' | 'delete') => {
        if (isStoredOpaquePresetMachine(row)) return effect;
        const declaration = await resolveManagedRowDeclarationInTx(tx, row);
        const intent = declaration && resolveMachineRetentionNativeIntentV1(effect, declaration.retention.supportedIntents);
        if (!intent) throw new ManagedMachineError('provider_unavailable');
        return intent;
    };
    if (machine.retention.kind === 'deadline') {
        if (Date.now() < machine.retention.at) throw new ManagedMachineError('intent_changed');
        return await retentionIntent(machine.retention.effect);
    }
    const evidence = purpose.evidence;
    if (!evidence) throw new ManagedMachineError('permission_denied');
    const { context, method, managedTarget, decision, proof } = evidence;
    const guest = await tx.machine.findUnique({ where: { id: context.machineId } });
    const enrollmentAccountId = readManagedEnrollmentAccountId(row);
    if (context.custodianAccountId !== enrollmentAccountId || context.actorAccountId !== row.custodianAccountId
        || row.enrolledMachineId !== context.machineId || context.role !== 'manage'
        || !guest || guest.accountId !== enrollmentAccountId || guest.installationId !== context.installationId
        || classifyMachineAvailabilityState(guest) !== 'available' || !guest.installationPublicKey
        || method !== `${context.machineId}:${MANAGED_ADMISSION_DRAIN_CONFIRM_RPC_METHOD}`
        || managedTarget.homeId !== row.homeId || managedTarget.managedId !== row.id
        || !sameManagedInput(managedTarget.controller, machine.controller)
        || (options.admission && managedTarget.expectedRevision !== row.intentRevision)
        || !verifyMachineInstallationProof({ payload: { version: 1, machineId: context.machineId, installationId: context.installationId,
            accountId: context.custodianAccountId, rpcAdmission: { context, method, managedTarget, managedIdleDecision: decision } }, proof,
            publicKey: guest.installationPublicKey })) throw new ManagedMachineError('permission_denied');
    const account = await tx.account.findUnique({ where: { id: enrollmentAccountId }, select: { encryptionMode: true } });
    if (account?.encryptionMode !== context.encryptionMode || decision.confirmedAt - decision.since < machine.retention.afterMs) throw new ManagedMachineError('intent_changed');
    return await retentionIntent(machine.retention.effect);
}

/** The existing row is the one policy/current-request authority; no extra wake queue or effect journal. */
export async function admitManagedPolicy(params: Readonly<{ custodianAccountId: string; input: ManagedPolicyAdmissionInputV1; actionOrigin?: ExternalActionExecutionAuthorizationV1 }>) {
    return readOrAdmitManagedPolicy(params, true);
}

/** Approval reviews the same qualified policy without committing a desired intent. */
export async function prepareManagedPolicy(params: Readonly<{ custodianAccountId: string; input: ManagedPolicyAdmissionInputV1; actionOrigin?: ExternalActionExecutionAuthorizationV1 }>) {
    // Preserve the exact opaque admission carrier for a preset row.  A
    // preparatory policy read is also a restart-safe content delivery edge.
    return await readOrAdmitManagedPolicy(params, false);
}

async function readOrAdmitManagedPolicy(params: Readonly<{ custodianAccountId: string; input: ManagedPolicyAdmissionInputV1; actionOrigin?: ExternalActionExecutionAuthorizationV1 }>, admit: boolean) {
    const input = ManagedPolicyAdmissionInputV1Schema.parse(params.input);
    const execute = async (tx: Tx) => {
        const row = await readManagedMachineInTx(tx, input);
        if (row.custodianAccountId !== params.custodianAccountId || (row.controllerMachineId !== null
            && (row.controllerMachineId !== input.controller.machineId || row.controllerInstallationId !== input.controller.installationId))) throw new ManagedMachineError('permission_denied');
        await requireManagedHomeInTx(tx, input.homeId);
        const admitted = readManagedAdmissionState(row.admittedInput);
        const pending = admitted.submittedEffect;
        const currentAdmission = { kind: 'policy' as const, request: input };
        if (readManagedCurrentRequestId(row) === input.requestId) {
            if (!sameManagedInput(admitted.currentAdmission, currentAdmission)) throw new ManagedMachineError('request_conflict');
            return { ...projectManagedAdmissionCarrier(row, await projectManagedMachineInTx(tx, row)), requestId: input.requestId, replayed: true };
        }
        const previousPurpose = admitted.currentAdmission?.kind === 'policy' ? admitted.currentAdmission.request.purpose : undefined;
        if (pending && previousPurpose?.kind === 'retention'
            && input.purpose.kind === 'retention') {
            return { ...projectManagedAdmissionCarrier(row, await projectManagedMachineInTx(tx, row)), requestId: readManagedCurrentRequestId(row), replayed: true };
        }
        if (input.purpose.kind === 'accepted-input-start'
            && previousPurpose?.kind === 'accepted-input-start' && (row.desired === 'start' || row.desired === 'resume')
            && sameManagedInput(previousPurpose.target.origin, input.purpose.target.origin)) {
            await requireManagedPolicyPurposeInTx(tx, row, previousPurpose, { actionOrigin: params.actionOrigin });
            return { ...projectManagedAdmissionCarrier(row, await projectManagedMachineInTx(tx, row)), requestId: readManagedCurrentRequestId(row), replayed: true };
        }
        await requireManagedControllerInTx(tx, { ...input, custodianAccountId: params.custodianAccountId });
        if (row.intentRevision !== input.expectedIntentRevision) throw new ManagedMachineError('intent_changed');
        const intent = await requireManagedPolicyPurposeInTx(tx, row, input.purpose, { admission: true, actionOrigin: params.actionOrigin });
        const machine = await projectManagedMachineInTx(tx, row);
        const declaration = await resolveManagedRowDeclarationInTx(tx, row);
        if (!isStoredOpaquePresetMachine(row) && !declaration?.retention.supportedIntents.includes(intent)) throw new ManagedMachineError('provider_unavailable');
        if (!admit) return { ...projectManagedAdmissionCarrier(row, { ...machine, desired: intent, desiredWhen: 'now' as const, desiredAfterMs: undefined }),
            requestId: input.requestId, replayed: false };
        const changed = await tx.managedMachine.updateMany({ where: { id: row.id, intentRevision: input.expectedIntentRevision,
            controllerMachineId: row.controllerMachineId, controllerInstallationId: row.controllerInstallationId, admittedInput: { equals: readManagedJsonEqualityOperand(row.admittedInput) } },
            data: { desired: intent, desiredWhen: 'now', desiredAfterMs: null, intentRevision: { increment: 1 },
                admittedInput: { ...admitted, currentAdmission },
                ...(intent === 'delete' ? { cleanup: { disposition: 'pending', reason: 'delete_requested' } } : {}) } });
        if (changed.count !== 1) throw new ManagedMachineError('intent_changed');
        const current = await tx.managedMachine.findUniqueOrThrow({ where: { id: row.id } });
        await invalidateManagedMachineInTx(tx, current);
        return { ...projectManagedAdmissionCarrier(current, await projectManagedMachineInTx(tx, current)), requestId: readManagedCurrentRequestId(current), replayed: false };
    };
    return admit ? inManagedMachinePublicationTx(input, execute) : inReadSnapshot(execute);
}

/** Same-row admission owns immediate CAS, fire-time idle intent, policy and future controller custody. */
export async function admitManagedControl(params: Readonly<{
    actorAccountId: string; custodianAccountId: string; authentication?: TeamOperationAuthenticationContext;
    /** Internal verified Home admission, never a controller request body field. */
    admittedCreationRecovery?: true;
    input: ManagedControlAdmissionInputV1;
}>) {
    const request = ManagedControlAdmissionInputV1Schema.parse(params.input);
    return await inManagedMachinePublicationTx({ homeId: request.input.homeId,
        managedId: 'managedMachineId' in request.input ? request.input.managedMachineId : request.input.managedId,
        ...(request.action === 'machines.managed.controller.update' && request.input.controller ? { nextControllerMachineId: request.input.controller.machineId } : {}) }, async tx => {
        const input = request.input;
        const row = await readManagedMachineInTx(tx, { homeId: input.homeId,
            managedId: 'managedMachineId' in input ? input.managedMachineId : input.managedId });
        const controller = readManagedController(row);
        if (row.custodianAccountId !== params.custodianAccountId) throw new ManagedMachineError('permission_denied');
        if (request.action === 'machines.managed.delete') {
            if (!params.admittedCreationRecovery) await requireManagedCreationAccessInTx(tx, row, params.actorAccountId);
        } else {
            const role = await resolveManagedMachineRoleInTx(tx, row, params.actorAccountId);
            if (role === null) throw new ManagedMachineError('permission_denied');
            if (role !== 'manage') throw new ManagedMachineError(request.action === 'machines.managed.power.set' && !controller
                ? 'managed_power_required' : 'permission_denied');
        }
        // A retained request remains routed to its admitted Home.  Replays do
        // not re-admit the controller's current availability; fresh control
        // admission below still does.
        await requireManagedHomeInTx(tx, row.homeId);
        // U1 has no saved-policy power/Move/retirement reconciliation. Retain
        // the sole installed/uncertain binding proof until exact release.
        if (request.action !== MANAGED_RESIZE_ACTION_ID_V1
            && await tx.sessionTeamCredentialBinding.findFirst({ where: { nativeManagedId: row.id }, select: { sessionId: true } })) {
            throw new ManagedMachineError('credential_unavailable');
        }
        const admitted = readManagedAdmissionState(row.admittedInput);
        const currentAdmission = { kind: 'control' as const, request };
        const opaqueResize = request.action === MANAGED_RESIZE_ACTION_ID_V1
            && 'presetContentOverride' in request.input;
        if (request.action === MANAGED_RESIZE_ACTION_ID_V1) {
            if (!isStoredOpaquePresetMachine(row) && opaqueResize) throw new ManagedMachineError('invalid_request');
            if (isStoredOpaquePresetMachine(row)) {
                if (!('presetContentOverride' in request.input)) throw new ManagedMachineError('invalid_request');
                const storedPreset = readStoredOpaquePresetLaunch(row.launch);
                if ((storedPreset.contentEncryptionMode === 'plain') !== (request.input.presetContentOverride.content.t === 'plain')) {
                    throw new ManagedMachineError('account_mode_mismatch');
                }
            }
        }
        if (readManagedCurrentRequestId(row) === request.requestId) {
            if (admitted.currentAdmission?.kind !== 'control'
                || !sameManagedInput(admitted.currentAdmission.request, request)) throw new ManagedMachineError("request_conflict");
            return { ...projectManagedAdmissionCarrier(row, await projectManagedMachineInTx(tx, row)), replayed: true,
                ...(!isStoredOpaquePresetMachine(row) && admitted.currentAdmission.resizeProvisioner
                    ? { resizeProvisioner: admitted.currentAdmission.resizeProvisioner } : {}) };
        }
        await requireManagedControllerInTx(tx, { homeId: row.homeId, custodianAccountId: row.custodianAccountId, controller });
        // Resize executes the approved size even when another intent advanced
        // during review. This revision is only the atomic row-write operand.
        const expected = request.action === MANAGED_RESIZE_ACTION_ID_V1 ? row.intentRevision
            : 'when' in input ? input.when === 'now' ? input.expectedRevision : row.intentRevision
            : 'expectedRevision' in input ? input.expectedRevision
            : 'expectedIntentRevision' in input ? input.expectedIntentRevision : row.intentRevision;
        if (row.intentRevision !== expected) throw new ManagedMachineError("intent_changed");
        const data: Prisma.ManagedMachineUpdateManyMutationInput = {
            intentRevision: { increment: 1 }, admittedInput: { ...admitted, currentAdmission },
        };
        if (request.action === "machines.managed.retire") {
            data.archivedAt = new Date();
            data.cleanup = { disposition: "unavailable", reason: "manual_responsibility" };
        } else if (request.action === 'machines.managed.delete'
            && !hasPossibleManagedNativeResource(row)) {
            // Admission owns allocation: unsubmitted and confirmed-absent
            // allocations need neither a provisioner nor a cleanup operation.
            data.allocation = 'confirmed-absent';
            if (!row.enrolledMachineId) data.creationState = 'canceled';
            data.desired = 'delete';
            data.desiredWhen = 'now';
            data.desiredAfterMs = null;
            data.cleanup = getActivePrismaRuntime().DbNull;
        } else {
            const pendingCleanup = request.action === 'machines.managed.delete' && request.input.when === 'now'
                && await hasPendingManagedCleanupTargetInTx(tx, row, true);
            const canceledCleanup = request.action === 'machines.managed.delete' && request.input.when === 'now'
                && row.creationState === 'canceled' && row.archivedAt === null
                && row.desired === 'delete' && row.desiredWhen === 'now';
            if ((row.creationState !== "active" && !canceledCleanup)
                || (!hasBoundManagedLifecycle(row) && !pendingCleanup)) throw new ManagedMachineError("resource_mismatch");
            if (isStoredOpaquePresetMachine(row)) {
                // Private provisioner capabilities live in the opened preset on
                // the controller.  This owner retains only the structural
                // intent/custody transition and never reads the envelope.
                if (request.action === "machines.managed.controller.update") {
                    if (request.input.controller) {
                        await requireManagedControllerInTx(tx, { homeId: row.homeId, custodianAccountId: row.custodianAccountId,
                            controller: request.input.controller });
                    } else if (params.actorAccountId !== row.custodianAccountId) {
                        throw new ManagedMachineError('permission_denied');
                    }
                    data.controllerMachineId = request.input.controller?.machineId ?? null;
                    data.controllerInstallationId = request.input.controller?.installationId ?? null;
                } else if (request.action === "machines.managed.retention.update") {
                    const policy = request.input;
                    if ('creationScopeRetention' in policy) {
                        const { creationScopeRetention: _previousScope, ...admission } = admitted;
                        const choice = policy.creationScopeRetention;
                        const birth = choice ? await readManagedCreationBirthInTx(tx, {
                            accountId: readManagedEnrollmentAccountId(row), managedId: row.id,
                        }) : null;
                        if (choice && !birth) throw new ManagedMachineError('resource_mismatch');
                        const retention = projectManagedMachine({ ...row, admittedInput: admission }).retention;
                        data.admittedInput = { ...admission, currentAdmission,
                            ...(choice && birth ? { creationScopeRetention: { ...choice, ...birth,
                                ...(retention.kind === 'unused' && retention.afterMs > 0 ? { afterMs: retention.afterMs } : {}) } } : {}),
                        };
                    } else {
                        data.retention = policy.retention;
                        data.wakeOnAcceptedMessage = policy.wakeOnAcceptedMessage;
                    }
                } else if (request.action === "machines.managed.rebuild") {
                    data.desired = 'rebuild';
                    data.desiredWhen = 'now';
                    data.desiredAfterMs = null;
                } else if ('intent' in request.input) {
                    data.desired = request.input.intent;
                    data.desiredWhen = request.input.when;
                    data.desiredAfterMs = request.input.when === "after-idle" && request.input.afterMs !== undefined
                        ? request.input.afterMs : null;
                    if (request.input.intent === "delete") data.cleanup = { disposition: "pending", reason: "delete_requested" };
                }
            } else {
                const launch = readManagedLaunchSnapshot(row.launch);
                const declaration = request.action === MANAGED_RESIZE_ACTION_ID_V1
                    ? await resolveManagedDeclarationInTx(tx, { homeId: row.homeId, custodianAccountId: row.custodianAccountId,
                        controller, provider: launch.provider, reviewedFacts: row.reviewedFacts })
                    : await resolveManagedRowDeclarationInTx(tx, row);
                if (!declaration || (request.action !== MANAGED_RESIZE_ACTION_ID_V1 && declaration.schemaVersion !== launch.schemaVersion)) {
                    throw new ManagedMachineError("provider_unavailable");
                }
                if (request.action === "machines.managed.controller.update") {
                if (declaration.billing.location !== "cloud") throw new ManagedMachineError("controller_unavailable");
                if (request.input.controller) {
                    await requireManagedControllerInTx(tx, { homeId: row.homeId, custodianAccountId: row.custodianAccountId, controller: request.input.controller });
                    await validateManagedLaunchInTx(tx, { accountId: params.actorAccountId, authentication: params.authentication }, {
                        homeId: row.homeId, controller: request.input.controller, launch: projectManagedMachine(row).launch,
                    });
                } else {
                    if (params.actorAccountId !== row.custodianAccountId) throw new ManagedMachineError('permission_denied');
                    if (!declaration.accountAcquire) throw new ManagedMachineError('provider_unavailable');
                    const current = projectManagedMachine(row);
                    const reviewedPrerequisites = current.reviewedFacts?.prerequisites;
                    if (reviewedPrerequisites === undefined && declaration.provisioner.prerequisites.length > 0) {
                        throw new ManagedMachineError('provider_unavailable');
                    }
                    data.reviewedFacts = buildManagedConfigurationFactsV1({ choicesSchema: createPluginJsonSchemaZodValueAdapter(declaration.launchSchema),
                        launch: current.launch, provisioner: declaration.provisioner, optionStatus: 'current',
                        prerequisites: reviewedPrerequisites ?? [], billing: declaration.billing, retentionCapabilities: declaration.retention,
                        machineOverride: { retention: current.retention, wakeOnAcceptedMessage: current.wakeOnAcceptedMessage },
                        ...(current.preset ? { preset: current.preset } : {}), ...(current.machineSetup ? { setup: current.machineSetup.setup } : {}) });
                }
                data.controllerMachineId = request.input.controller?.machineId ?? null;
                data.controllerInstallationId = request.input.controller?.installationId ?? null;
                } else if (request.action === "machines.managed.retention.update") {
                const policy = request.input;
                if ('creationScopeRetention' in policy) {
                    const { creationScopeRetention: _previousScope, ...admission } = admitted;
                    const choice = policy.creationScopeRetention;
                    if (choice && !resolveMachineRetentionNativeIntentV1(choice.effect, declaration.retention.supportedIntents)) {
                        throw new ManagedMachineError('provider_unavailable');
                    }
                    const birth = choice ? await readManagedCreationBirthInTx(tx, {
                        accountId: readManagedEnrollmentAccountId(row), managedId: row.id,
                    }) : null;
                    if (choice && !birth) throw new ManagedMachineError('resource_mismatch');
                    const retention = projectManagedMachine({ ...row, admittedInput: admission }).retention;
                    data.admittedInput = { ...admission, currentAdmission,
                        ...(choice && birth ? { creationScopeRetention: { ...choice, ...birth,
                            ...(retention.kind === 'unused' && retention.afterMs > 0 ? { afterMs: retention.afterMs } : {}) } } : {}),
                    };
                } else {
                    if (!isMachineRetentionPolicySupportedV1(policy, declaration.retention)) throw new ManagedMachineError("provider_unavailable");
                    data.retention = policy.retention;
                    data.wakeOnAcceptedMessage = policy.wakeOnAcceptedMessage;
                }
                } else if (request.action === MANAGED_RESIZE_ACTION_ID_V1) {
                data.admittedInput = { ...admitted, currentAdmission: { ...currentAdmission, resizeProvisioner: declaration.provisioner } };
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
        }
        const changed = await tx.managedMachine.updateMany({ where: { id: row.id, intentRevision: expected,
            controllerMachineId: row.controllerMachineId, controllerInstallationId: row.controllerInstallationId, admittedInput: { equals: readManagedJsonEqualityOperand(row.admittedInput) } }, data });
        if (changed.count !== 1) throw new ManagedMachineError("intent_changed");
        const current = await tx.managedMachine.findUniqueOrThrow({ where: { id: row.id } });
        await invalidateManagedMachineInTx(tx, row);
        if (row.controllerMachineId !== current.controllerMachineId) await invalidateManagedMachineInTx(tx, current);
        const retainedControl = readManagedAdmissionState(current.admittedInput).currentAdmission;
        return { ...projectManagedAdmissionCarrier(current, await projectManagedMachineInTx(tx, current)), replayed: false,
            ...(!isStoredOpaquePresetMachine(current) && retainedControl?.kind === 'control' && retainedControl.resizeProvisioner
                ? { resizeProvisioner: retainedControl.resizeProvisioner } : {}) };
    });
}

/** Store native resize observation under the active admitted job, without re-admitting approved work. */
export async function reportManagedResize(input: ManagedControllerResizeReportV1) {
    const canonical = ManagedControllerResizeReportV1Schema.parse(input);
    return inManagedMachinePublicationTx(canonical, async tx => {
        const row = await requireActiveManagedResizeInTx(tx, canonical);
        if (isStoredOpaquePresetMachine(row)) {
            if (!('presetContent' in canonical)) throw new ManagedMachineError('invalid_request');
            const storedPreset = readStoredOpaquePresetLaunch(row.launch);
            if ((storedPreset.contentEncryptionMode === 'plain') !== (canonical.presetContent.t === 'plain')) {
                throw new ManagedMachineError('account_mode_mismatch');
            }
            const admitted = readManagedAdmissionState(row.admittedInput);
            const currentAdmission = admitted.currentAdmission;
            if (currentAdmission?.kind !== 'control' || !isManagedResizeActionIdV1(currentAdmission.request.action)) {
                throw new ManagedMachineError('request_conflict');
            }
            const updated = await tx.managedMachine.updateMany({ where: { id: row.id,
                launch: { equals: readManagedJsonEqualityOperand(row.launch) },
                admittedInput: { equals: readManagedJsonEqualityOperand(row.admittedInput) } }, data: {
                launch: { ...storedPreset, content: canonical.presetContent },
                resource: getActivePrismaRuntime().DbNull,
                nativeOperationRef: getActivePrismaRuntime().DbNull,
                recovery: getActivePrismaRuntime().DbNull,
                admittedInput: { ...admitted, currentAdmission: { ...currentAdmission, resizeSettled: true } },
                ...(canonical.observation ? { observation: canonical.observation } : {}),
            } });
            if (updated.count !== 1) throw new ManagedMachineError('intent_changed');
            const current = await tx.managedMachine.findUniqueOrThrow({ where: { id: row.id } });
            await invalidateManagedMachineInTx(tx, current);
            return { machine: await projectManagedMachineInTx(tx, current) };
        }
        if ('presetContent' in canonical) throw new ManagedMachineError('invalid_request');
        if (!canonical.observation) return { machine: await projectManagedMachineInTx(tx, row) };
        const current = await tx.managedMachine.update({ where: { id: row.id }, data: { observation: canonical.observation } });
        await invalidateManagedMachineInTx(tx, current);
        return { machine: await projectManagedMachineInTx(tx, current) };
    });
}

/** Claim only the current single native effect before IO; submitted ambiguity survives policy/Move edits. */
export async function submitManagedIntent(input: ManagedControllerCurrentnessV1) {
    const canonical = ManagedControllerCurrentnessV1Schema.parse(input);
    return await inManagedMachinePublicationTx(canonical, async tx => {
        const row = await requireCurrentManagedMachineInTx(tx, canonical, { allowInactiveCurrentIntent: true });
        // Covers automatic policy and already-admitted operations too: none
        // may resume or replace a resource with unprepared retained rules.
        if (await tx.sessionTeamCredentialBinding.findFirst({ where: { nativeManagedId: row.id }, select: { sessionId: true } })) {
            throw new ManagedMachineError('credential_unavailable');
        }
        const pendingCleanup = row.archivedAt === null && row.desired === 'delete' && row.desiredWhen === 'now'
            && await hasPendingManagedCleanupTargetInTx(tx, row);
        if (!hasBoundManagedLifecycle(row) && !pendingCleanup) throw new ManagedMachineError("resource_mismatch");
        const admitted = readManagedAdmissionState(row.admittedInput);
        if (admitted.submittedEffect) return { machine: await projectManagedMachineInTx(tx, row), submitted: false };
        const rebuild = admitted.currentAdmission?.kind === 'control' && admitted.currentAdmission.request.action === 'machines.managed.rebuild'
            ? admitted.currentAdmission.request.input : undefined;
        if (row.desired === 'rebuild' && !rebuild) throw new ManagedMachineError('request_conflict');
        if (row.desired === 'rebuild' && admitted.currentAdmission?.kind === 'control' && admitted.currentAdmission.rebuildSettled) {
            return { machine: await projectManagedMachineInTx(tx, row), submitted: false };
        }
        const changed = await tx.managedMachine.updateMany({ where: { id: row.id, intentRevision: canonical.expectedIntentRevision, admittedInput: { equals: readManagedJsonEqualityOperand(row.admittedInput) } },
            data: { admittedInput: { ...admitted, submittedEffect: { ...canonical, intent: row.desired,
                ...(rebuild ? { reviewedEffectDigest: rebuild.reviewedEffectDigest } : {}) } } } });
        const current = await tx.managedMachine.findUniqueOrThrow({ where: { id: row.id } });
        if (changed.count) await invalidateManagedMachineInTx(tx, current);
        return { machine: await projectManagedMachineInTx(tx, current), submitted: changed.count === 1 };
    });
}

/** Native facts reconcile the exact submitted or still-current admitted command, never a newer intent. */
export async function reportManagedIntent(input: ManagedControllerIntentReportV1) {
    const canonical = ManagedControllerIntentReportV1Schema.parse(input);
    return await inManagedMachinePublicationTx(canonical, async tx => {
        const row = await readManagedMachineInTx(tx, canonical);
        const admitted = readManagedAdmissionState(row.admittedInput);
        const pending = readManagedIntentReportAuthority(row, canonical);
        if (!pending) throw new ManagedMachineError("request_conflict");
        if (isStoredOpaquePresetMachine(row)) {
            if (!('presetContent' in canonical)) throw new ManagedMachineError('invalid_request');
            if (canonical.result.kind === 'pending' && pending.intent !== 'delete') throw new ManagedMachineError('resource_mismatch');
            if (canonical.result.kind === 'accepted' && pending.intent !== 'delete') throw new ManagedMachineError('resource_mismatch');
            const storedPreset = readStoredOpaquePresetLaunch(row.launch);
            if ((storedPreset.contentEncryptionMode === 'plain') !== (canonical.presetContent.t === 'plain')) {
                throw new ManagedMachineError('account_mode_mismatch');
            }
            const replacementLaunch = { ...storedPreset, content: canonical.presetContent };
            const data: Prisma.ManagedMachineUncheckedUpdateManyInput = {
                launch: replacementLaunch,
                resource: getActivePrismaRuntime().DbNull,
                nativeOperationRef: getActivePrismaRuntime().DbNull,
                recovery: getActivePrismaRuntime().DbNull,
            };
            if (canonical.result.kind === 'bound') {
                if (pending.intent !== 'rebuild') throw new ManagedMachineError('resource_mismatch');
                const { submittedEffect: _settled, bootstrapInstalled: _installed, ...retained } = admitted;
                const currentAdmission = admitted.currentAdmission;
                const settlesCurrentRebuild = currentAdmission?.kind === 'control'
                    && currentAdmission.request.action === 'machines.managed.rebuild'
                    && currentAdmission.request.requestId === pending.requestId
                    && row.intentRevision === pending.expectedIntentRevision
                    && (row.controllerMachineId === null || sameManagedInput(readManagedController(row), pending.controller));
                data.allocation = 'bound';
                data.enrolledMachineId = null;
                data.observation = getActivePrismaRuntime().DbNull;
                data.cleanup = getActivePrismaRuntime().DbNull;
                data.admittedInput = { ...retained,
                    ...(settlesCurrentRebuild ? { currentAdmission: { ...currentAdmission, rebuildSettled: true } } : {}),
                    ...(row.enrolledMachineId ? { replacementEnrollment: { machineId: row.enrolledMachineId } } : {}) };
                const changed = await tx.managedMachine.updateMany({ where: { id: row.id, intentRevision: row.intentRevision,
                    launch: { equals: readManagedJsonEqualityOperand(row.launch) },
                    admittedInput: { equals: readManagedJsonEqualityOperand(row.admittedInput) } }, data });
                if (changed.count !== 1) throw new ManagedMachineError('intent_changed');
                const current = await tx.managedMachine.findUniqueOrThrow({ where: { id: row.id } });
                await invalidateManagedMachineInTx(tx, row);
                return { machine: await projectManagedMachineInTx(tx, current) };
            }
            const previousObservation = createStoredReadSchema(ManagedOpaquePresetObservationV1Schema).safeParse(row.observation);
            const currentObservation = canonical.observation && (!previousObservation.success || canonical.observation.observedAt >= previousObservation.data.observedAt)
                ? canonical.observation : undefined;
            if (currentObservation) {
                data.observation = currentObservation;
                if (currentObservation.availability === 'absent' && pending.intent !== 'rebuild') {
                    data.allocation = 'confirmed-absent';
                }
            }
            if (!admitted.submittedEffect) {
                // Settled custody admits newer observations, never its old private snapshot.
                if (!currentObservation || previousObservation.success && sameManagedInput(previousObservation.data, currentObservation)) {
                    return { machine: await projectManagedMachineInTx(tx, row) };
                }
                const observationUpdate: Prisma.ManagedMachineUncheckedUpdateManyInput = {
                    observation: currentObservation,
                    ...(currentObservation.availability === 'absent' ? {
                        allocation: 'confirmed-absent', nativeOperationRef: getActivePrismaRuntime().DbNull,
                        cleanup: getActivePrismaRuntime().DbNull,
                    } : {}),
                };
                const changed = await tx.managedMachine.updateMany({ where: { id: row.id, intentRevision: row.intentRevision,
                    admittedInput: { equals: readManagedJsonEqualityOperand(row.admittedInput) } }, data: observationUpdate });
                if (changed.count !== 1) throw new ManagedMachineError('intent_changed');
                const current = await tx.managedMachine.findUniqueOrThrow({ where: { id: row.id } });
                await invalidateManagedMachineInTx(tx, row);
                return { machine: await projectManagedMachineInTx(tx, current) };
            }
            const currentControl = admitted.currentAdmission?.kind === 'control' ? admitted.currentAdmission.request : undefined;
            const retryDelete = pending.intent === 'delete' && row.intentRevision > pending.expectedIntentRevision
                && row.archivedAt === null && (row.creationState === 'active' || row.creationState === 'canceled')
                && hasBoundManagedLifecycle(row)
                && row.desired === 'delete' && row.desiredWhen === 'now'
                && currentControl?.action === 'machines.managed.delete' && currentControl.input.when === 'now'
                && currentControl.requestId !== pending.requestId
                && (row.controllerMachineId === null || sameManagedInput(readManagedController(row), pending.controller));
            const observedSettlement = doesManagedNativeObservationSettleIntent(pending.intent, currentObservation,
                previousObservation.success ? previousObservation.data : undefined, retryDelete);
            const ownsCleanup = pending.intent === 'delete' || pending.intent === 'rebuild';
            const preservesNewerCleanup = !ownsCleanup && (row.desired === 'delete' || row.desired === 'rebuild');
            if (canonical.result.kind !== 'refused' && !observedSettlement) {
                if (row.archivedAt === null && !preservesNewerCleanup) data.cleanup = ownsCleanup
                    ? { disposition: 'pending', reason: 'native_effect_unknown' }
                    : getActivePrismaRuntime().DbNull;
            } else {
                const { submittedEffect: _settled, ...currentAdmission } = admitted;
                data.admittedInput = currentAdmission;
                if (currentObservation?.availability === 'absent') data.cleanup = getActivePrismaRuntime().DbNull;
                else if (row.archivedAt === null && !preservesNewerCleanup) data.cleanup = canonical.result.kind === 'refused' && ownsCleanup
                    ? { disposition: 'unavailable', reason: 'native_effect_refused' }
                    : retryDelete ? { disposition: 'pending', reason: 'delete_requested' } : getActivePrismaRuntime().DbNull;
            }
            const changed = await tx.managedMachine.updateMany({ where: { id: row.id, intentRevision: row.intentRevision,
                launch: { equals: readManagedJsonEqualityOperand(row.launch) },
                admittedInput: { equals: readManagedJsonEqualityOperand(row.admittedInput) } }, data });
            if (changed.count !== 1) throw new ManagedMachineError('intent_changed');
            const current = await tx.managedMachine.findUniqueOrThrow({ where: { id: row.id } });
            await invalidateManagedMachineInTx(tx, row);
            return { machine: await projectManagedMachineInTx(tx, current) };
        }
        if ('presetContent' in canonical) throw new ManagedMachineError('invalid_request');
        const data: Prisma.ManagedMachineUncheckedUpdateManyInput = {};
        if ((canonical.result.kind === 'pending' || canonical.result.kind === 'accepted') && pending.intent !== 'delete') throw new ManagedMachineError('resource_mismatch');
        if (canonical.result.kind === 'bound' && pending.intent !== 'rebuild') throw new ManagedMachineError('resource_mismatch');
        const previousObservation = createStoredReadSchema(ProviderObservationV1Schema).safeParse(row.observation);
        const currentObservation = canonical.observation && (!previousObservation.success || canonical.observation.observedAt >= previousObservation.data.observedAt)
            ? canonical.observation : undefined;
        const recordObservation = () => {
            if (currentObservation) {
                data.observation = currentObservation;
                if (currentObservation.availability === "absent" && pending.intent !== 'rebuild') {
                    data.allocation = "confirmed-absent";
                    data.nativeOperationRef = getActivePrismaRuntime().DbNull;
                }
            }
        };
        const publish = async () => {
            const changed = await tx.managedMachine.updateMany({ where: { id: row.id, intentRevision: row.intentRevision,
                admittedInput: { equals: readManagedJsonEqualityOperand(row.admittedInput) } }, data });
            if (changed.count !== 1) throw new ManagedMachineError("intent_changed");
            const current = await tx.managedMachine.findUniqueOrThrow({ where: { id: row.id } });
            await invalidateManagedMachineInTx(tx, row);
            return { machine: await projectManagedMachineInTx(tx, current) };
        };
        if (!admitted.submittedEffect) {
            // Custody is already settled. Publish only a newer native fact;
            // replaying a Delete acknowledgement must not restore its handle.
            if (!currentObservation || previousObservation.success && sameManagedInput(previousObservation.data, currentObservation)) {
                return { machine: await projectManagedMachineInTx(tx, row) };
            }
            recordObservation();
            if (currentObservation.availability === 'absent') data.cleanup = getActivePrismaRuntime().DbNull;
            return await publish();
        }
        if (canonical.result.kind === 'accepted') {
            const launch = readManagedLaunchSnapshot(row.launch);
            const declaration = await resolveManagedRowDeclarationInTx(tx, row);
            if (!declaration?.reconciliation || declaration.schemaVersion !== launch.schemaVersion) {
                throw new ManagedMachineError('provider_unavailable');
            }
            const previous = projectManagedMachine(row);
            const parsed = createManagedMachineRetainedSchema(undefined,
                declaration.reconciliation.nativeOperationSchema).safeParse({ ...previous,
                nativeOperationRef: canonical.result.nativeOperationRef });
            if (!parsed.success) throw new ManagedMachineError('resource_mismatch');
            data.nativeOperationRef = ManagedMachineV1Schema.parse(parsed.data).nativeOperationRef;
            data.recovery = getActivePrismaRuntime().DbNull;
        }
        if (canonical.result.kind === 'bound') {
            const previous = projectManagedMachine(row);
            const launch = readManagedLaunchSnapshot(row.launch);
            const declaration = await resolveManagedRowDeclarationInTx(tx, row);
            if (!declaration || declaration.schemaVersion !== launch.schemaVersion || !declaration.actions.rebuild) throw new ManagedMachineError('provider_unavailable');
            const previousNativeId = previous.resource?.devcontainerObservation?.nativeResourceId;
            // Devcontainer rebuild removes the retained native child before
            // realizing its replacement. Namespace changes on that old child
            // do not prove a new installation.
            if (declaration.resourceKind === 'devcontainer' && (previousNativeId === undefined
                || canonical.result.resource.devcontainerObservation === undefined
                || previousNativeId === canonical.result.resource.devcontainerObservation.nativeResourceId)) {
                throw new ManagedMachineError('resource_mismatch');
            }
            const parsed = createManagedMachineRetainedSchema(declaration.resourceSchema)
                .safeParse({ ...previous, enrolledMachineId: undefined, devcontainerChild: undefined, resource: canonical.result.resource });
            if (!parsed.success) throw new ManagedMachineError('resource_mismatch');
            const replacementResource = ManagedMachineV1Schema.parse(parsed.data).resource;
            const { submittedEffect: _settled, bootstrapInstalled: _installed, ...retained } = admitted;
            const currentAdmission = admitted.currentAdmission;
            const settlesCurrentRebuild = currentAdmission?.kind === 'control'
                && currentAdmission.request.action === 'machines.managed.rebuild'
                && currentAdmission.request.requestId === pending.requestId
                && row.intentRevision === pending.expectedIntentRevision
                && (row.controllerMachineId === null || sameManagedInput(readManagedController(row), pending.controller));
            data.resource = replacementResource;
            data.allocation = 'bound';
            data.enrolledMachineId = null;
            data.observation = getActivePrismaRuntime().DbNull;
            data.recovery = getActivePrismaRuntime().DbNull;
            data.cleanup = getActivePrismaRuntime().DbNull;
            data.admittedInput = { ...retained,
                ...(settlesCurrentRebuild ? { currentAdmission: { ...currentAdmission, rebuildSettled: true } } : {}),
                ...(row.enrolledMachineId ? { replacementEnrollment: { machineId: row.enrolledMachineId } } : {}) };
            const changed = await tx.managedMachine.updateMany({ where: { id: row.id, intentRevision: row.intentRevision,
                admittedInput: { equals: readManagedJsonEqualityOperand(row.admittedInput) } }, data });
            if (changed.count !== 1) throw new ManagedMachineError('intent_changed');
            const current = await tx.managedMachine.findUniqueOrThrow({ where: { id: row.id } });
            await invalidateManagedMachineInTx(tx, row);
            return { machine: await projectManagedMachineInTx(tx, current) };
        }
        if (pending.intent === 'rebuild' && canonical.result.kind === 'unknown' && 'recovery' in canonical.result) {
            data.recovery = canonical.result.recovery;
        }
        recordObservation();
        const currentControl = admitted.currentAdmission?.kind === 'control' ? admitted.currentAdmission.request : undefined;
        const retryDelete = pending.intent === 'delete' && row.intentRevision > pending.expectedIntentRevision
            && row.archivedAt === null && (row.creationState === 'active' || row.creationState === 'canceled')
            && hasBoundManagedLifecycle(row)
            && row.nativeOperationRef === null && row.desired === 'delete' && row.desiredWhen === 'now'
            && currentControl?.action === 'machines.managed.delete' && currentControl.input.when === 'now'
            && currentControl.requestId !== pending.requestId
            && (row.controllerMachineId === null || sameManagedInput(readManagedController(row), pending.controller));
        const observedSettlement = doesManagedNativeObservationSettleIntent(pending.intent, currentObservation,
            previousObservation.success ? previousObservation.data : undefined, retryDelete);
        // Only destruction or replacement owns cleanup. Power uncertainty
        // remains in submittedEffect and its independent native observation.
        const ownsCleanup = pending.intent === 'delete' || pending.intent === 'rebuild';
        const preservesNewerCleanup = !ownsCleanup && (row.desired === 'delete' || row.desired === 'rebuild');
        if (canonical.result.kind !== "refused" && !observedSettlement) {
            // Retire transfers cleanup to the user; an unresolved native
            // effect retains its fact without reclaiming that responsibility.
            if (row.archivedAt === null && !preservesNewerCleanup) data.cleanup = ownsCleanup
                ? { disposition: "pending", reason: ('code' in canonical.result ? canonical.result.code : undefined) ?? "native_effect_unknown" }
                : getActivePrismaRuntime().DbNull;
        } else {
            const { submittedEffect: _settled, ...currentAdmission } = admitted;
            data.admittedInput = currentAdmission;
            if (currentObservation?.availability === "absent") data.cleanup = getActivePrismaRuntime().DbNull;
            else if (row.archivedAt === null && !preservesNewerCleanup) data.cleanup = canonical.result.kind === "refused" && ownsCleanup
                ? { disposition: "unavailable", reason: canonical.result.code }
                : retryDelete ? { disposition: 'pending', reason: 'delete_requested' } : getActivePrismaRuntime().DbNull;
        }
        return await publish();
    });
}

/** Only the successful unsubmitted -> may-exist transition permits native acquisition. */
export async function submitManagedAcquire(input: ManagedControllerSubmitInputV1) {
    const canonical = ManagedControllerSubmitInputV1Schema.parse(input);
    return await inManagedMachinePublicationTx(canonical, async (tx) => {
        const row = await requireCurrentManagedMachineInTx(tx, canonical, { requestAuthority: 'creation' });
        // Admission already owns the exact account selections in row.launch.
        // Credential rotation is handled by the next secret acquisition, not
        // by capturing a second configuration authority before native spend.
        const changed = await tx.managedMachine.updateMany({ where: { id: row.id, intentRevision: canonical.expectedIntentRevision, creationState: "active", allocation: "unsubmitted" }, data: {
            allocation: "may-exist",
        } });
        const current = changed.count ? await tx.managedMachine.findUniqueOrThrow({ where: { id: row.id } }) : row;
        if (changed.count) await invalidateManagedMachineInTx(tx, current);
        return { machine: await projectManagedMachineInTx(tx, current), submitted: changed.count === 1 };
    });
}

/** Bound identity is saved before bootstrap, including an exact late cleanup identity. */
export async function reportManagedAcquire(input: ManagedControllerReportV1, options: Readonly<{ requestAuthority?: 'creation' | 'intent' }> = {}) {
    const canonical = ManagedControllerReportV1Schema.parse(input);
    return await inManagedMachinePublicationTx(canonical, async (tx) => {
        const row = await requireCurrentManagedMachineInTx(tx, canonical, { requestAuthority: options.requestAuthority ?? 'creation',
            allowCanceledResourceReport: (canonical.result.kind === "bound" || canonical.result.kind === "pending") && options.requestAuthority !== 'intent',
            allowInactiveCurrentIntent: options.requestAuthority === 'intent' });
        if (isStoredOpaquePresetMachine(row)) {
            if (!('presetContent' in canonical)) throw new ManagedMachineError('invalid_request');
            // A controller snapshots its locally validated opaque content.
            // Native provider identity, recovery and diagnostics stay in that
            // sealed snapshot; Home retains only lifecycle state.
            const storedPreset = readStoredOpaquePresetLaunch(row.launch);
            if ((storedPreset.contentEncryptionMode === 'plain') !== (canonical.presetContent.t === 'plain')) {
                throw new ManagedMachineError('account_mode_mismatch');
            }
            const admitted = readManagedAdmissionState(row.admittedInput);
            const { presetContentOverride: _override, ...nextAdmission } = admitted;
            const replacementLaunch = { ...storedPreset, content: canonical.presetContent };
            if (canonical.result.kind === "bound") {
                if (row.allocation !== "may-exist" && row.allocation !== "bound") throw new ManagedMachineError("intent_changed");
                const changed = await tx.managedMachine.updateMany({ where: { id: row.id, intentRevision: row.intentRevision,
                    creationState: row.creationState,
                    launch: { equals: readManagedJsonEqualityOperand(row.launch) },
                }, data: {
                    allocation: "bound",
                    resource: getActivePrismaRuntime().DbNull,
                    nativeOperationRef: getActivePrismaRuntime().DbNull,
                    recovery: getActivePrismaRuntime().DbNull,
                    launch: replacementLaunch,
                    admittedInput: {
                        ...nextAdmission,
                        ...(canonical.bootstrapInstalled ? { bootstrapInstalled: true } : {}),
                    },
                    ...(row.creationState !== "active" && row.archivedAt === null ? { cleanup: { disposition: "pending", reason: "late_allocation" } } : {}),
                    ...(canonical.observation ? { observation: canonical.observation } : {}),
                } });
                if (changed.count !== 1) throw new ManagedMachineError("intent_changed");
                const updated = await tx.managedMachine.findUniqueOrThrow({ where: { id: row.id } });
                await invalidateManagedMachineInTx(tx, updated);
                return { machine: projectManagedMachine(updated) };
            }
            if (row.allocation !== "may-exist") throw new ManagedMachineError("intent_changed");
            const result = canonical.result;
            const changed = await tx.managedMachine.updateMany({ where: { id: row.id, intentRevision: row.intentRevision,
                creationState: row.creationState, allocation: "may-exist", launch: { equals: readManagedJsonEqualityOperand(row.launch) } }, data: {
                launch: replacementLaunch,
                admittedInput: nextAdmission,
                resource: getActivePrismaRuntime().DbNull,
                nativeOperationRef: getActivePrismaRuntime().DbNull,
                recovery: getActivePrismaRuntime().DbNull,
                ...(result.kind === "rejected" ? { allocation: "confirmed-absent", cleanup: getActivePrismaRuntime().DbNull } : {}),
                ...(canonical.observation ? { observation: canonical.observation } : {}),
            } });
            if (changed.count !== 1) throw new ManagedMachineError("intent_changed");
            const updated = await tx.managedMachine.findUniqueOrThrow({ where: { id: row.id } });
            await invalidateManagedMachineInTx(tx, updated);
            return { machine: projectManagedMachine(updated) };
        }
        if ('presetContent' in canonical) throw new ManagedMachineError('invalid_request');
        const launch = readManagedLaunchSnapshot(row.launch);
        const declaration = await resolveManagedRowDeclarationInTx(tx, row);
        if (!declaration || declaration.schemaVersion !== launch.schemaVersion) throw new ManagedMachineError("provider_unavailable");
        const current = projectManagedMachine(row);
        const configurationFacts = !current.reviewedFacts ? canonical.configurationFacts : undefined;
        if (configurationFacts && (!sameManagedInput(configurationFacts.launch, current.launch)
            || !sameManagedInput(configurationFacts.controller, current.controller)
            || !sameManagedInput(configurationFacts.retention, current.retention)
            || configurationFacts.wakeOnAcceptedMessage !== current.wakeOnAcceptedMessage
            || !sameManagedInput(configurationFacts.preset ? { id: configurationFacts.preset.id, revision: configurationFacts.preset.revision } : undefined, current.preset)
            || configurationFacts.setup !== undefined)) throw new ManagedMachineError('invalid_request');
        // Reporting adds presentation facts only. Home's existing declaration and
        // signed admission remain the authority for roles, setup and native effects.
        const factsUpdate = configurationFacts ? { reviewedFacts: { ...configurationFacts, provisioner: declaration } } : {};
        if (canonical.result.kind === "bound") {
            if (row.allocation !== "may-exist" && row.allocation !== "bound") throw new ManagedMachineError("intent_changed");
            const parsed = createManagedMachineRetainedSchema(declaration.resourceSchema).safeParse({ ...current, allocation: "bound", resource: canonical.result.resource });
            if (!parsed.success) throw new ManagedMachineError("resource_mismatch");
            const projected = ManagedMachineV1Schema.parse(parsed.data);
            if (row.resource !== null && !sameManagedInput(current.resource, projected.resource)) throw new ManagedMachineError("resource_mismatch");
            if (canonical.bootstrapInstalled && current.bootstrapInstalled && !canonical.observation) return { machine: current };
            const changed = await tx.managedMachine.updateMany({ where: { id: row.id, intentRevision: row.intentRevision, creationState: row.creationState }, data: {
                allocation: "bound", resource: projected.resource,
                ...factsUpdate,
                ...(canonical.bootstrapInstalled ? { admittedInput: { ...readManagedAdmissionState(row.admittedInput), bootstrapInstalled: true } } : {}),
                // Binding settles acquisition custody; a late report must retain an outstanding Delete's handle.
                ...(row.allocation === 'may-exist' && current.submittedNativeEffect?.intent !== 'delete'
                    ? { nativeOperationRef: getActivePrismaRuntime().DbNull } : {}),
                ...(row.creationState !== "active" && row.archivedAt === null ? { cleanup: { disposition: "pending", reason: "late_allocation" } } : {}),
                ...(canonical.observation ? { observation: canonical.observation } : {}),
            } });
            if (changed.count !== 1) throw new ManagedMachineError("intent_changed");
            const updated = await tx.managedMachine.findUniqueOrThrow({ where: { id: row.id } });
            await invalidateManagedMachineInTx(tx, updated);
            return { machine: projectManagedMachine(updated) };
        }
        if (row.allocation !== "may-exist") throw new ManagedMachineError("intent_changed");
        const result = canonical.result;
        if (result.kind === "pending") {
            if (!declaration.reconciliation) throw new ManagedMachineError("provider_unavailable");
            const parsed = createManagedMachineRetainedSchema(undefined, declaration.reconciliation.nativeOperationSchema)
                .safeParse({ ...projectManagedMachine(row), nativeOperationRef: result.nativeOperationRef });
            if (!parsed.success) throw new ManagedMachineError("resource_mismatch");
        }
        const changed = await tx.managedMachine.updateMany({ where: { id: row.id, intentRevision: row.intentRevision, creationState: row.creationState, allocation: "may-exist" }, data: {
            ...factsUpdate,
            ...(result.kind === "pending" ? { nativeOperationRef: result.nativeOperationRef } : {}),
            ...(result.kind === "unknown" ? { recovery: result.recovery } : {}),
            ...(result.kind === "rejected" ? { allocation: "confirmed-absent", cleanup: getActivePrismaRuntime().DbNull } : {}),
            ...(canonical.observation ? { observation: canonical.observation } : {}),
        } });
        if (changed.count !== 1) throw new ManagedMachineError("intent_changed");
        const updated = await tx.managedMachine.findUniqueOrThrow({ where: { id: row.id } });
        await invalidateManagedMachineInTx(tx, updated);
        return { machine: projectManagedMachine(updated) };
    });
}

/** Creates the private key at SavedSecret's owner and retains only its reference atomically. */
export async function createManagedBootstrapCredential(input: ManagedBootstrapCredentialCreateV1) {
    const canonical = ManagedBootstrapCredentialCreateV1Schema.parse(input);
    return await inManagedMachinePublicationTx(canonical, async (tx) => {
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
        // The resource owner refuses a credential whose mode differs from the
        // custodian's Account mode; this caller only keeps the bootstrap key unshared.
        if ((canonical.credential.accountGrants?.length ?? 0) > 0
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
    accountId: string; machineId: string; enrollment?: ManagedEnrollmentCorrelationV1;
}>;
export function requireManagedMachineRegistrationInTx(tx: Tx, input: ManagedMachineRegistrationInput & { enrollment: ManagedEnrollmentCorrelationV1 }): Promise<StoredManagedMachine>;
export function requireManagedMachineRegistrationInTx(tx: Tx, input: ManagedMachineRegistrationInput): Promise<StoredManagedMachine | undefined>;
export async function requireManagedMachineRegistrationInTx(tx: Tx, input: ManagedMachineRegistrationInput): Promise<StoredManagedMachine | undefined> {
    const homeId = await readCurrentServerIdentityId(process.env, tx);
    // An unavailable Home must not erase an existing pending proof requirement;
    // the exact Account/Machine predicate still recognizes it and refuses proof.
    const pending = await tx.managedMachine.findMany({ where: {
        ...(homeId === null ? {} : { homeId }),
        // Match requireCurrentManagedMachineInTx's enrollment lifecycle. Retire
        // keeps recovery history but hands ordinary custody back to its owner.
        creationState: 'active', archivedAt: null,
        admittedInput: jsonPathEquals(['replacementEnrollment', 'machineId'], input.machineId),
    }, select: { id: true, admittedInput: true, custodianAccountId: true } });
    for (const row of pending) {
        if (readManagedEnrollmentAccountId(row) !== input.accountId
            || readManagedAdmissionState(row.admittedInput).replacementEnrollment?.machineId !== input.machineId
            || !input.enrollment || input.enrollment.homeId !== homeId || input.enrollment.managedId !== row.id) {
            throw new ManagedMachineError('enrollment_retired');
        }
    }
    if (input.enrollment) return await requireManagedEnrollmentInTx(tx, input.enrollment, input.accountId);
}

/** Enrollment remains inside ordinary registration's transaction, before any Machine write. */
export async function requireManagedEnrollmentInTx(tx: Tx, input: ManagedEnrollmentCorrelationV1,
    authority: string | Readonly<{ controllerCustodianAccountId: string }>) {
    const canonical = ManagedEnrollmentCorrelationV1Schema.parse(input);
    const retained = await readManagedMachineInTx(tx, canonical);
    const row = await requireCurrentManagedMachineInTx(tx, canonical, { requestAuthority:
        canonical.requestId === retained.admittedActionRequestId ? 'creation' : 'intent' });
    const admission = readManagedAdmissionState(row.admittedInput);
    if (admission.submittedEffect?.intent === 'rebuild') throw new ManagedMachineError('enrollment_retired');
    const accountMatches = typeof authority === 'string'
        ? readManagedEnrollmentAccountId(row) === authority
        : row.custodianAccountId === authority.controllerCustodianAccountId;
    if (!accountMatches || row.allocation !== "bound") throw new ManagedMachineError("resource_mismatch");
    const stored = projectManagedMachine(row);
    if (isStoredOpaquePresetMachine(row)) {
        // The enrolled native identity is sealed in the admitted preset
        // snapshot; bound lifecycle/custody is the server-owned enrollment fact.
        if ('resource' in canonical) throw new ManagedMachineError('invalid_request');
        return row;
    }
    if (!('resource' in canonical)) throw new ManagedMachineError('invalid_request');
    const declaration = await resolveManagedRowDeclarationInTx(tx, row);
    if (!declaration || declaration.schemaVersion !== readManagedLaunchSnapshot(row.launch).schemaVersion) throw new ManagedMachineError("provider_unavailable");
    const incoming = createManagedMachineRetainedSchema(declaration.resourceSchema, declaration.reconciliation?.nativeOperationSchema).safeParse({ ...stored, resource: canonical.resource });
    if (!incoming.success || !sameManagedInput(stored.resource, incoming.data.resource)) throw new ManagedMachineError("resource_mismatch");
    return row;
}

export async function linkManagedEnrollmentInTx(tx: Tx, input: ManagedEnrollmentCorrelationV1, accountId: string, machineId: string): Promise<void> {
    const row = await requireManagedMachineRegistrationInTx(tx, { accountId, machineId, enrollment: input });
    const machine = await tx.machine.findUnique({ where: { id: machineId } });
    if (!machine || machine.accountId !== readManagedEnrollmentAccountId(row) || classifyMachineAvailabilityState(machine) !== "available") throw new ManagedMachineError("enrollment_retired");
    if (machine.id === row.controllerMachineId || machine.installationId === row.controllerInstallationId) throw new ManagedMachineError("resource_mismatch");
    if (row.enrolledMachineId && row.enrolledMachineId !== machineId) throw new ManagedMachineError("resource_mismatch");
    const admitted = readManagedAdmissionState(row.admittedInput);
    const { replacementEnrollment, ...retainedAdmission } = admitted;
    if (replacementEnrollment && replacementEnrollment.machineId !== machineId) {
        const previous = await tx.machine.findUnique({ where: { id: replacementEnrollment.machineId } });
        if (!previous || previous.accountId !== readManagedEnrollmentAccountId(row)) throw new ManagedMachineError('resource_mismatch');
        await applyMachineReplacement({ tx, accountId, oldMachineId: previous.id,
            replacementMachineId: machineId, reason: 'managed_native_rebuild', source: 'automatic',
            actorUserId: null });
    }
    const updated = await tx.managedMachine.updateMany({ where: { id: row.id, intentRevision: input.expectedIntentRevision, creationState: "active", enrolledMachineId: row.enrolledMachineId,
        admittedInput: { equals: readManagedJsonEqualityOperand(row.admittedInput) } }, data: { enrolledMachineId: machineId, ...(replacementEnrollment ? { admittedInput: retainedAdmission } : {}) } });
    if (updated.count !== 1) throw new ManagedMachineError("enrollment_retired");
    await invalidateManagedMachineInTx(tx, row);
}
