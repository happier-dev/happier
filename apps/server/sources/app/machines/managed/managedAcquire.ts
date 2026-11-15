import { isStoredOpaquePresetMachine, projectManagedMachineFull, projectManagedMachineOpaque } from './managedMachineProjection';
import { ManagedAdmissionInputV1Schema, ManagedAdmissionPresetContentV1Schema, resolveManagedAcquireReviewV1, isManagedPresetAcquireInputV1, type ManagedAdmissionInputV1, type ManagedAdmissionOutputV1, type ManagedAdmissionPresetContentV1 } from '@happier-dev/protocol/machines/managed/actionsV1';
import { ManagedMachineFullV1Schema, type ManagedMachineV1, type ValidatedLaunchSnapshotV1 } from '@happier-dev/protocol/machines/managed/managedMachineV1';
import { createManagedConfigurationFactsV1Schema } from '@happier-dev/protocol/machines/managed/managedConfigurationV1';
import { createPluginJsonSchemaZodValueAdapter } from "@happier-dev/protocol/plugins/actions/json-schema-validation";
import { db, isPrismaUniqueConstraintError } from "@/storage/db";
import { resolveMachineRetentionNativeIntentV1, resolveMachineRetentionPolicyV1 } from "@happier-dev/protocol/machines/managed/resolveMachineRetentionPolicyV1";
import type { RetentionCapabilitiesV1 } from "@happier-dev/protocol/machines/managed/providerFactsV1";
import {
    ManagedMachineError, invalidateManagedMachineInTx,
    requireManagedControllerInTx, requireManagedHomeInTx, sameManagedInput,
    type ManagedDeclaration,
    createManagedMachineDeclaredSchema,
    readManagedAcquisitionIdentity,
    projectManagedAcquisitionComputeInput,
    readManagedEnrollmentAccountId,
    readManagedAdmissionState,
    readManagedAcquisitionDigest,
    readManagedOpaquePresetContent,
    storeOpaquePresetLaunch,
    inManagedMachinePublicationTx,
} from "./managedRows";
import { resolveMachinePresetForAcquireInTx, validateManagedLaunchInTx } from "./machinePresetService";
import type { TeamOperationAuthenticationContext } from "@/app/teams/actorContext";
import { inReadSnapshot, type Tx } from "@/storage/inTx";

/** Admission evidence comes from the write owner, never an absent-row read. */
export class ExternalActionAdmissionUnexpectedError extends Error {
    constructor(readonly cause: unknown, readonly admissionCommitted: boolean | null) {
        super('Unexpected Action admission failure');
    }
}

type OpaquePresetContent = ManagedAdmissionPresetContentV1;

/** Keep acquire aligned with the opaque admission carrier and its retained sealed name override. */
type ManagedAcquireAdmissionResult = ManagedAdmissionOutputV1;

/** Explicit reviewed policy still receives the sole resolver's native qualification. */
export function qualifyManagedAcquisitionPolicy(input: Pick<ReturnType<typeof resolveManagedAcquireReviewV1>, "retention" | "wakeOnAcceptedMessage">, declaration: Pick<ManagedDeclaration, "billing" | "retention">, selectedCapabilities?: RetentionCapabilitiesV1) {
    return resolveMachineRetentionPolicyV1({ billing: declaration.billing, nativeCapabilities: selectedCapabilities ?? declaration.retention, machineOverride: input });
}

/**
 * Retains the admitted compute request before the controller can submit native IO.
 * The route's existing signed Action authority derives custody; caller input
 * never selects an Account. Replays are pure reads of the existing allocation.
 */
export async function admitManagedAcquire(params: Readonly<{
    custodianAccountId: string;
    requesterAccountId: string;
    /** Verified Home binding; fresh delegated admission cannot inherit Session-source authority. */
    managedAcquireDelegation?: true;
    authentication?: TeamOperationAuthenticationContext;
    requestEnvelopeDigest: string;
    input: ManagedAdmissionInputV1;
}>): Promise<ManagedAcquireAdmissionResult> {
    let transactionStarted = false;
    try {
        const request = ManagedAdmissionInputV1Schema.parse(params.input);
        const review = resolveManagedAcquireReviewV1(request.input);
        if (!review.controller && params.custodianAccountId !== params.requesterAccountId) throw new ManagedMachineError('permission_denied');
        // Dedupe includes the private continuation without retaining its prompt,
        // attachments, or startup instructions in a Home-visible resource row.
        const admittedInputIdentity = { computeInput: projectManagedAcquisitionComputeInput(request.input),
            continuation: request.continuationPresent ? { requestEnvelopeDigest: params.requestEnvelopeDigest } : null };
        const existingAdmission = async (tx: Tx) => {
            const existing = await tx.managedMachine.findUnique({ where: { homeId_admittedActionRequestId: { homeId: review.homeId, admittedActionRequestId: request.requestId } } });
            if (!existing) return null;
            if (existing.custodianAccountId !== params.custodianAccountId
                || readManagedEnrollmentAccountId(existing) !== params.requesterAccountId) throw new ManagedMachineError("request_conflict");
            const acquisition = readManagedAcquisitionIdentity(existing.admittedInput);
            if (!sameManagedInput(acquisition, admittedInputIdentity)) throw new ManagedMachineError("request_conflict");
            const retainedAdmission = readManagedAdmissionState(existing.admittedInput);
            const retainedDigest = readManagedAcquisitionDigest(retainedAdmission);
            if (retainedDigest && retainedDigest !== params.requestEnvelopeDigest) throw new ManagedMachineError("request_conflict");
            if (isStoredOpaquePresetMachine(existing)) {
                const presetContent = readManagedOpaquePresetContent(existing);
                const machine = projectManagedMachineOpaque(existing);
                return { machine, presetContent,
                    ...(retainedAdmission.presetContentOverride ? { presetContentOverride: retainedAdmission.presetContentOverride } : {}),
                    replayed: true };
            }
            const machine = projectManagedMachineFull(existing);
            return { machine, replayed: true };
        };
        // Home may already have retained custody before dispatching to the controller.
        // Re-admission is a read, so unrelated publication must not prevent the
        // controller from accepting an operation for that durable allocation.
        const retained = await db.managedMachine.findUnique({ where: { homeId_admittedActionRequestId: { homeId: review.homeId, admittedActionRequestId: request.requestId } }, select: { id: true } });
        const replay = () => inReadSnapshot(async tx => {
            await requireManagedHomeInTx(tx, review.homeId);
            const existing = await existingAdmission(tx);
            if (!existing) throw new ManagedMachineError("managed_not_found");
            return existing;
        }, { transactionClass: 'managed-machine-acquire-replay' });
        if (retained) return replay();
        // Serialize capacity and cursor publication without excluding ordinary
        // KEY SHARE content admission (including provider-usage record work).
        // Account authority changes still take the conflicting exclusive intent.
        const execute = () => inManagedMachinePublicationTx({ controllerMachineId: review.controller?.machineId }, async (tx) => {
            await requireManagedControllerInTx(tx, { homeId: review.homeId, custodianAccountId: params.custodianAccountId, controller: review.controller });
            const existing = await existingAdmission(tx);
            if (existing) return existing;
            if (isManagedPresetAcquireInputV1(request.input)) {
                const selected = await resolveMachinePresetForAcquireInTx(tx, { accountId: params.requesterAccountId, authentication: params.authentication,
                    ...request.input.selection, boundController: review.controller });
                if (selected.kind === "conflict") throw new ManagedMachineError("request_conflict");
                if (selected.kind === "refused") throw new ManagedMachineError(selected.code);
                if (selected.delegated && params.managedAcquireDelegation !== true) throw new ManagedMachineError('permission_denied');
                if (!sameManagedInput(selected.preset.controller, review.controller)) throw new ManagedMachineError("controller_retired");
                const preset = { id: selected.preset.id, revision: selected.preset.revision } as const;
                const presetContent = ManagedAdmissionPresetContentV1Schema.parse(selected.presetContent);
                const presetContentOverride = request.input.presetContentOverride;
                if (presetContentOverride && presetContentOverride.content.t !== presetContent.content.t) {
                    throw new ManagedMachineError('account_mode_mismatch');
                }
                const controller = selected.preset.controller;
                const retention = selected.preset.retention
                    ?? (selected.delegated ? request.presetPolicy?.retention : review.retention ?? request.presetPolicy?.retention);
                const wakeOnAcceptedMessage = selected.preset.wakeOnAcceptedMessage
                    ?? (selected.delegated ? request.presetPolicy?.wakeOnAcceptedMessage : review.wakeOnAcceptedMessage ?? request.presetPolicy?.wakeOnAcceptedMessage);
                if (retention === undefined || wakeOnAcceptedMessage === undefined) {
                    throw new ManagedMachineError(selected.delegated ? 'permission_denied' : 'invalid_request');
                }
                if (selected.delegated && ((review.retention !== undefined && !sameManagedInput(review.retention, retention))
                    || (review.wakeOnAcceptedMessage !== undefined && review.wakeOnAcceptedMessage !== wakeOnAcceptedMessage))) {
                    throw new ManagedMachineError('permission_denied');
                }
                if (request.presetPolicy && (!sameManagedInput(request.presetPolicy.retention, retention)
                    || request.presetPolicy.wakeOnAcceptedMessage !== wakeOnAcceptedMessage)) throw new ManagedMachineError('permission_denied');
                const scopeChoice = request.input.creationScopeRetention;
                const creationScopeRetention = scopeChoice ? { ...scopeChoice } : undefined;
                const admittedInput = { ...admittedInputIdentity,
                    enrollmentAccountId: params.requesterAccountId,
                    ...(creationScopeRetention ? { creationScopeRetention } : {}),
                    requestEnvelopeDigest: params.requestEnvelopeDigest,
                    ...(presetContentOverride ? { presetContentOverride } : {}),
                };
                const row = await tx.managedMachine.create({ data: {
                    homeId: review.homeId, custodianAccountId: selected.custodianAccountId,
                    controllerMachineId: controller?.machineId ?? null, controllerInstallationId: controller?.installationId ?? null,
                    admittedActionRequestId: request.requestId, admittedInput,
                    presetId: preset.id, presetRevision: preset.revision,
                    // The historical column is non-null; its value is an
                    // opaque envelope, never a launch snapshot.
                    launch: storeOpaquePresetLaunch({
                        contentEncryptionMode: selected.preset.contentEncryptionMode,
                        ...presetContent,
                        ...(selected.preset.controllerPoolId ? { controllerPoolId: selected.preset.controllerPoolId } : {}),
                    }),
                    retention, wakeOnAcceptedMessage,
                } });
                await invalidateManagedMachineInTx(tx, row);
                const machine = projectManagedMachineOpaque(row);
                return { machine, presetContent,
                    ...(presetContentOverride ? { presetContentOverride } : {}),
                    replayed: false };
            }
            let launch: ValidatedLaunchSnapshotV1;
            let declaration: ManagedDeclaration;
            launch = request.input.selection.launch;
            const validated = await validateManagedLaunchInTx(tx, { accountId: params.requesterAccountId, authentication: params.authentication },
                { homeId: review.homeId, controller: review.controller, launch }, request.input.reviewedFacts);
            if (!validated.declaration) throw new ManagedMachineError('invalid_request');
            declaration = validated.declaration;
            if (!review.controller && request.input.reviewedFacts?.provisioner?.id !== launch.provider.localId) throw new ManagedMachineError('invalid_request');
            const parsedFacts = request.input.reviewedFacts === undefined ? undefined
                : createManagedConfigurationFactsV1Schema(createPluginJsonSchemaZodValueAdapter(declaration.launchSchema)).safeParse(request.input.reviewedFacts);
            if (parsedFacts && !parsedFacts.success) throw new ManagedMachineError("invalid_request");
            // Retained native authority comes from admission's declaration, not requester presentation facts.
            const reviewedFacts = parsedFacts?.success ? { ...parsedFacts.data, provisioner: declaration.provisioner,
                ...(review.controller ? { retentionCapabilities: declaration.retention, billing: declaration.billing } : {}) } : undefined;
            const policy = qualifyManagedAcquisitionPolicy(review, declaration, reviewedFacts?.retentionCapabilities);
            const scopeChoice = request.input.creationScopeRetention;
            if (scopeChoice && !resolveMachineRetentionNativeIntentV1(scopeChoice.effect, declaration.retention.supportedIntents)) {
                throw new ManagedMachineError('invalid_request');
            }
            const creationScopeRetention = scopeChoice ? { ...scopeChoice,
                ...(policy.retention.kind === 'unused' && policy.retention.afterMs > 0 ? { afterMs: policy.retention.afterMs } : {}) } : undefined;
            if (reviewedFacts && (!sameManagedInput(reviewedFacts.launch, launch)
                || !sameManagedInput(reviewedFacts.controller, review.controller)
                || !sameManagedInput(reviewedFacts.retention, policy.retention)
                || reviewedFacts.wakeOnAcceptedMessage !== policy.wakeOnAcceptedMessage
                || reviewedFacts.preset !== undefined)) {
                throw new ManagedMachineError("invalid_request");
            }
            const candidate = {
                id: "admission", homeId: review.homeId, custodianAccountId: params.custodianAccountId,
                enrollmentAccountId: params.requesterAccountId,
                launch, controller: review.controller,
                enrollmentIdentity: request.input.enrollmentIdentity,
                allocation: "unsubmitted", creationState: "active", desired: "start", desiredWhen: "now", intentRevision: 0,
                retention: policy.retention, wakeOnAcceptedMessage: policy.wakeOnAcceptedMessage,
                ...(reviewedFacts ? { reviewedFacts } : {}),
            };
            const canonical = ManagedMachineFullV1Schema.parse(createManagedMachineDeclaredSchema(declaration.launchSchema, declaration.resourceSchema).parse(candidate));
            const row = await tx.managedMachine.create({ data: {
                homeId: canonical.homeId, custodianAccountId: canonical.custodianAccountId,
                controllerMachineId: canonical.controller?.machineId ?? null, controllerInstallationId: canonical.controller?.installationId ?? null,
                admittedActionRequestId: request.requestId, admittedInput: { ...admittedInputIdentity,
                    enrollmentAccountId: params.requesterAccountId,
                    ...(creationScopeRetention ? { creationScopeRetention } : {}),
                    requestEnvelopeDigest: params.requestEnvelopeDigest,
                    },
                launch: canonical.launch, retention: canonical.retention, wakeOnAcceptedMessage: canonical.wakeOnAcceptedMessage,
                ...(canonical.reviewedFacts ? { reviewedFacts: canonical.reviewedFacts } : {}),
                ...(canonical.machineSetup ? { machineSetup: canonical.machineSetup } : {}),
            } });
            await invalidateManagedMachineInTx(tx, row);
            const machine = projectManagedMachineFull(row);
            return { machine, replayed: false };
        }, { intent: 'serializing', additionalAccountIds: [params.requesterAccountId, params.custodianAccountId],
            transactionClass: 'managed-machine-acquire' });
        // Entering this owner can submit a write even if Prisma later rejects its
        // COMMIT acknowledgement. Its rollback attempt may also fail silently.
        transactionStarted = true;
        try { return await execute(); }
        catch (error) {
            // A concurrent retry may win the database correlation. Readmit the
            // retained canonical input through the same read-only replay owner.
            if (!isPrismaUniqueConstraintError(error)) throw error;
            const existing = await db.managedMachine.findUnique({ where: { homeId_admittedActionRequestId: { homeId: review.homeId, admittedActionRequestId: request.requestId } } });
            if (!existing) throw error;
            return await replay();
        }
    } catch (error) {
        // Preserve the transaction/domain error owners and their proven rollback
        // classifications. Only this pre-write path adds admission evidence.
        if (transactionStarted || error instanceof ManagedMachineError) throw error;
        throw new ExternalActionAdmissionUnexpectedError(error, false);
    }
}
