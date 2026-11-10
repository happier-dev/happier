import { ManagedAdmissionInputV1Schema, resolveManagedAcquireReviewV1, type ManagedAdmissionInputV1 } from '@happier-dev/protocol/machines/managed/actionsV1';
import { ManagedMachineV1Schema, type ManagedMachineV1, type ValidatedLaunchSnapshotV1 } from '@happier-dev/protocol/machines/managed/managedMachineV1';
import { createManagedConfigurationFactsV1Schema } from '@happier-dev/protocol/machines/managed/managedConfigurationV1';
import { type MachineSetupV1 } from '@happier-dev/protocol/machines/managed/machineSetupV1';
import { createPluginJsonSchemaZodValueAdapter } from "@happier-dev/protocol/plugins/actions/json-schema-validation";
import { db, isPrismaUniqueConstraintError } from "@/storage/db";
import { resolveMachineRetentionNativeIntentV1, resolveMachineRetentionPolicyV1 } from "@happier-dev/protocol/machines/managed/resolveMachineRetentionPolicyV1";
import type { RetentionCapabilitiesV1 } from "@happier-dev/protocol/machines/managed/providerFactsV1";
import {
    ManagedMachineError, invalidateManagedMachineInTx, managedPresetMachineName, projectManagedMachine,
    requireManagedControllerInTx, resolveManagedDeclarationInTx, sameManagedInput,
    type ManagedDeclaration,
    createManagedMachineDeclaredSchema,
    readManagedLaunchSnapshot,
    readManagedAcquisitionIdentity,
    readManagedEnrollmentAccountId,
    readManagedAdmissionState,
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
    authentication?: TeamOperationAuthenticationContext;
    requestEnvelopeDigest: string;
    input: ManagedAdmissionInputV1;
}>): Promise<{ machine: ManagedMachineV1; replayed: boolean }> {
    let transactionStarted = false;
    try {
        const request = ManagedAdmissionInputV1Schema.parse(params.input);
        const review = resolveManagedAcquireReviewV1(request.input);
        if (!review.controller && params.custodianAccountId !== params.requesterAccountId) throw new ManagedMachineError('permission_denied');
        // Dedupe includes the private continuation without retaining its prompt,
        // attachments, or startup instructions in a Home-visible resource row.
        const admittedInputIdentity = { computeInput: request.input, continuation: request.continuationPresent ? { requestEnvelopeDigest: params.requestEnvelopeDigest } : null };
        const existingAdmission = async (tx: Tx) => {
            const existing = await tx.managedMachine.findUnique({ where: { homeId_admittedActionRequestId: { homeId: review.homeId, admittedActionRequestId: request.requestId } } });
            if (!existing) return null;
            if (existing.custodianAccountId !== params.custodianAccountId
                || readManagedEnrollmentAccountId(existing) !== params.requesterAccountId) throw new ManagedMachineError("request_conflict");
            const acquisition = readManagedAcquisitionIdentity(existing.admittedInput);
            if (!sameManagedInput(acquisition, admittedInputIdentity)) throw new ManagedMachineError("request_conflict");
            const retainedAdmission = readManagedAdmissionState(existing.admittedInput);
            const retainedDigest = retainedAdmission.requestEnvelopeDigest ?? retainedAdmission.machineSetup?.requestEnvelopeDigest;
            if (retainedDigest && retainedDigest !== params.requestEnvelopeDigest) throw new ManagedMachineError("request_conflict");
            return { machine: projectManagedMachine(existing), replayed: true };
        };
        // Home may already have retained custody before dispatching to the controller.
        // Re-admission is a read, so unrelated publication must not prevent the
        // controller from accepting an operation for that durable allocation.
        const retained = await db.managedMachine.findUnique({ where: { homeId_admittedActionRequestId: { homeId: review.homeId, admittedActionRequestId: request.requestId } }, select: { id: true } });
        const replay = () => inReadSnapshot(async tx => {
            await requireManagedControllerInTx(tx, { homeId: review.homeId, custodianAccountId: params.custodianAccountId, controller: review.controller });
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
            let launch: ValidatedLaunchSnapshotV1;
            let preset: { id: string; revision: number } | undefined;
            let setup: MachineSetupV1 | undefined;
            let declaration: ManagedDeclaration;
            let delegatedPolicy: ReturnType<typeof resolveMachineRetentionPolicyV1> | undefined;
            if (request.input.selection.kind === "one-off") {
                launch = request.input.selection.launch;
                const validated = await validateManagedLaunchInTx(tx, { accountId: params.requesterAccountId, authentication: params.authentication },
                    { homeId: review.homeId, controller: review.controller, launch }, request.input.reviewedFacts);
                if (!validated.declaration) throw new ManagedMachineError('invalid_request');
                declaration = validated.declaration;
            } else {
                const selected = await resolveMachinePresetForAcquireInTx(tx, { accountId: params.requesterAccountId, authentication: params.authentication,
                    ...request.input.selection, reviewedFacts: request.input.reviewedFacts, boundController: review.controller });
                if (selected.kind === "conflict") throw new ManagedMachineError("request_conflict");
                if (selected.kind === "refused") throw new ManagedMachineError(selected.code);
                if (!sameManagedInput(selected.preset.controller, review.controller)) throw new ManagedMachineError("controller_retired");
                // A preset is reused for many Machines: each takes its own name, or the provider's default (as a one-off Create does), never the preset's.
                launch = { ...selected.preset.launch, name: managedPresetMachineName(selected.declaration.provisioner, request.input.selection.name) };
                preset = { id: selected.preset.id, revision: selected.preset.revision };
                setup = selected.preset.setup;
                declaration = selected.declaration;
                if (selected.delegated) {
                    delegatedPolicy = resolveMachineRetentionPolicyV1({ billing: declaration.billing,
                        nativeCapabilities: declaration.retention, presetOverride: selected.preset });
                    if (!sameManagedInput(review.retention, delegatedPolicy.retention)
                        || review.wakeOnAcceptedMessage !== delegatedPolicy.wakeOnAcceptedMessage) {
                        throw new ManagedMachineError('permission_denied');
                    }
                }
            }
            if (!review.controller && request.input.reviewedFacts?.provisioner?.id !== launch.provider.localId) throw new ManagedMachineError('invalid_request');
            const parsedFacts = request.input.reviewedFacts === undefined ? undefined
                : createManagedConfigurationFactsV1Schema(createPluginJsonSchemaZodValueAdapter(declaration.launchSchema)).safeParse(request.input.reviewedFacts);
            if (parsedFacts && !parsedFacts.success) throw new ManagedMachineError("invalid_request");
            // Retained native authority comes from admission's declaration, not requester presentation facts.
            const reviewedFacts = parsedFacts?.success ? { ...parsedFacts.data, provisioner: declaration.provisioner,
                ...(review.controller ? { retentionCapabilities: declaration.retention, billing: declaration.billing } : {}) } : undefined;
            const policy = delegatedPolicy ?? qualifyManagedAcquisitionPolicy(review, declaration, reviewedFacts?.retentionCapabilities);
            const scopeChoice = request.input.creationScopeRetention;
            if (scopeChoice && !resolveMachineRetentionNativeIntentV1(scopeChoice.effect, declaration.retention.supportedIntents)) {
                throw new ManagedMachineError('invalid_request');
            }
            const creationScopeRetention = scopeChoice ? { ...scopeChoice,
                ...(policy.retention.kind === 'unused' && policy.retention.afterMs > 0 ? { afterMs: policy.retention.afterMs } : {}) } : undefined;
            const { credentials: _credentials, ...publicLaunch } = launch;
            if (reviewedFacts && (!sameManagedInput(reviewedFacts.launch, delegatedPolicy ? publicLaunch : launch)
                || !sameManagedInput(reviewedFacts.controller, review.controller)
                || !sameManagedInput(reviewedFacts.retention, policy.retention)
                || reviewedFacts.wakeOnAcceptedMessage !== policy.wakeOnAcceptedMessage
                || !sameManagedInput(reviewedFacts.preset ? { id: reviewedFacts.preset.id, revision: reviewedFacts.preset.revision } : undefined, preset))) {
                throw new ManagedMachineError("invalid_request");
            }
            const candidate = {
                id: "admission", homeId: review.homeId, custodianAccountId: params.custodianAccountId,
                enrollmentAccountId: params.requesterAccountId,
                launch, ...(preset ? { preset } : {}), controller: review.controller,
                enrollmentIdentity: request.input.enrollmentIdentity,
                allocation: "unsubmitted", creationState: "active", desired: "start", desiredWhen: "now", intentRevision: 0,
                retention: policy.retention, wakeOnAcceptedMessage: policy.wakeOnAcceptedMessage,
                ...(reviewedFacts ? { reviewedFacts } : {}),
                ...(setup ? { machineSetup: { setup, state: "pending" } } : {}),
            };
            const canonical = ManagedMachineV1Schema.parse(createManagedMachineDeclaredSchema(declaration.launchSchema, declaration.resourceSchema).parse(candidate));
            const row = await tx.managedMachine.create({ data: {
                homeId: canonical.homeId, custodianAccountId: canonical.custodianAccountId,
                controllerMachineId: canonical.controller?.machineId ?? null, controllerInstallationId: canonical.controller?.installationId ?? null,
                admittedActionRequestId: request.requestId, admittedInput: { ...admittedInputIdentity,
                    enrollmentAccountId: params.requesterAccountId,
                    ...(creationScopeRetention ? { creationScopeRetention } : {}),
                    requestEnvelopeDigest: params.requestEnvelopeDigest,
                    ...(setup ? { machineSetup: { requestEnvelopeDigest: params.requestEnvelopeDigest } } : {}) },
                ...(preset ? { presetId: preset.id, presetRevision: preset.revision } : {}),
                launch: canonical.launch, retention: canonical.retention, wakeOnAcceptedMessage: canonical.wakeOnAcceptedMessage,
                ...(canonical.reviewedFacts ? { reviewedFacts: canonical.reviewedFacts } : {}),
                ...(canonical.machineSetup ? { machineSetup: canonical.machineSetup } : {}),
            } });
            await invalidateManagedMachineInTx(tx, row);
            return { machine: projectManagedMachine(row), replayed: false };
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
