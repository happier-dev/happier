import { ManagedAdmissionInputV1Schema, resolveManagedAcquireReviewV1, type ManagedAdmissionInputV1 } from '@happier-dev/protocol/machines/managed/actionsV1';
import { ManagedMachineV1Schema, type ManagedMachineV1, type ValidatedLaunchSnapshotV1 } from '@happier-dev/protocol/machines/managed/managedMachineV1';
import { createManagedConfigurationFactsV1Schema } from '@happier-dev/protocol/machines/managed/managedConfigurationV1';
import { type MachineEnvironmentV1 } from '@happier-dev/protocol/machines/managed/machineEnvironmentV1';
import { createPluginJsonSchemaZodValueAdapter } from "@happier-dev/protocol/plugins/actions/json-schema-validation";
import { db, isPrismaUniqueConstraintError } from "@/storage/db";
import { resolveMachineRetentionPolicyV1 } from "@happier-dev/protocol/machines/managed/resolveMachineRetentionPolicyV1";
import type { RetentionCapabilitiesV1 } from "@happier-dev/protocol/machines/managed/providerFactsV1";
import {
    ManagedMachineError, invalidateManagedMachineInTx, projectManagedMachine,
    requireManagedControllerInTx, resolveManagedDeclarationInTx, sameManagedInput,
    type ManagedDeclaration,
    createManagedMachineDeclaredSchema,
    readManagedLaunchSnapshot,
    readManagedAcquisitionIdentity,
    readManagedAdmissionState,
    inManagedMachinePublicationTx,
} from "./managedRows";
import { resolveMachinePresetForAcquireInTx, validateManagedRecipeInTx } from "./machinePresetService";
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
        // Dedupe includes the private continuation without retaining its prompt,
        // attachments, or startup instructions in a Home-visible resource row.
        const admittedInputIdentity = { computeInput: request.input, continuation: request.continuationPresent ? { requestEnvelopeDigest: params.requestEnvelopeDigest } : null };
        const existingAdmission = async (tx: Tx) => {
            const existing = await tx.managedMachine.findUnique({ where: { homeId_admittedActionRequestId: { homeId: review.homeId, admittedActionRequestId: request.requestId } } });
            if (!existing) return null;
            if (existing.custodianAccountId !== params.custodianAccountId || !sameManagedInput(readManagedAcquisitionIdentity(existing.admittedInput), admittedInputIdentity)) throw new ManagedMachineError("request_conflict");
            const setupAdmission = readManagedAdmissionState(existing.admittedInput).environmentSetup;
            if (setupAdmission && setupAdmission.requestEnvelopeDigest !== params.requestEnvelopeDigest) throw new ManagedMachineError("request_conflict");
            const declaration = await resolveManagedDeclarationInTx(tx, { homeId: existing.homeId, custodianAccountId: existing.custodianAccountId, controller: review.controller, provider: readManagedLaunchSnapshot(existing.launch).provider });
            return { machine: projectManagedMachine(existing, declaration), replayed: true };
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
        const execute = () => inManagedMachinePublicationTx({ controllerMachineId: review.controller.machineId }, async (tx) => {
            await requireManagedControllerInTx(tx, { homeId: review.homeId, custodianAccountId: params.custodianAccountId, controller: review.controller });
            const existing = await existingAdmission(tx);
            if (existing) return existing;
            let launch: ValidatedLaunchSnapshotV1;
            let preset: { id: string; revision: number } | undefined;
            let environment: MachineEnvironmentV1 | undefined;
            let declaration: ManagedDeclaration;
            if (request.input.selection.kind === "one-off") {
                launch = request.input.selection.launch;
                ({ declaration } = await validateManagedRecipeInTx(tx, { accountId: params.requesterAccountId, authentication: params.authentication }, { homeId: review.homeId, controller: review.controller, recipe: launch }));
            } else {
                const selected = await resolveMachinePresetForAcquireInTx(tx, { accountId: params.requesterAccountId, authentication: params.authentication, ...request.input.selection });
                if (selected.kind === "conflict") throw new ManagedMachineError("request_conflict");
                if (selected.kind === "refused") throw new ManagedMachineError(selected.code);
                if (!sameManagedInput(selected.preset.controller, review.controller)) throw new ManagedMachineError("controller_retired");
                launch = selected.preset.recipe;
                preset = { id: selected.preset.id, revision: selected.preset.revision };
                environment = selected.preset.environment;
                declaration = selected.declaration;
            }
            const parsedFacts = request.input.reviewedFacts === undefined ? undefined
                : createManagedConfigurationFactsV1Schema(createPluginJsonSchemaZodValueAdapter(declaration.launchSchema)).safeParse(request.input.reviewedFacts);
            if (parsedFacts && !parsedFacts.success) throw new ManagedMachineError("invalid_request");
            const reviewedFacts = parsedFacts?.success ? parsedFacts.data : undefined;
            const policy = qualifyManagedAcquisitionPolicy(review, declaration, reviewedFacts?.retentionCapabilities);
            if (reviewedFacts && (!sameManagedInput(reviewedFacts.launch, launch)
                || !sameManagedInput(reviewedFacts.controller, review.controller)
                || !sameManagedInput(reviewedFacts.retention, policy.retention)
                || reviewedFacts.wakeOnAcceptedMessage !== policy.wakeOnAcceptedMessage
                || !sameManagedInput(reviewedFacts.preset ? { id: reviewedFacts.preset.id, revision: reviewedFacts.preset.revision } : undefined, preset))) {
                throw new ManagedMachineError("invalid_request");
            }
            const candidate = {
                id: "admission", homeId: review.homeId, custodianAccountId: params.custodianAccountId,
                launch, ...(preset ? { preset } : {}), controller: review.controller,
                allocation: "unsubmitted", creationState: "active", desired: "start", desiredWhen: "now", intentRevision: 0,
                retention: policy.retention, wakeOnAcceptedMessage: policy.wakeOnAcceptedMessage,
                ...(reviewedFacts ? { reviewedFacts } : {}),
                ...(environment ? { environmentSetup: { environment, state: "pending" } } : {}),
            };
            const canonical = ManagedMachineV1Schema.parse(createManagedMachineDeclaredSchema(declaration.launchSchema, declaration.resourceSchema).parse(candidate));
            const row = await tx.managedMachine.create({ data: {
                homeId: canonical.homeId, custodianAccountId: canonical.custodianAccountId,
                controllerMachineId: canonical.controller.machineId, controllerInstallationId: canonical.controller.installationId,
                admittedActionRequestId: request.requestId, admittedInput: { ...admittedInputIdentity,
                    ...(environment ? { environmentSetup: { requestEnvelopeDigest: params.requestEnvelopeDigest } } : {}) },
                ...(preset ? { presetId: preset.id, presetRevision: preset.revision } : {}),
                launch: canonical.launch, retention: canonical.retention, wakeOnAcceptedMessage: canonical.wakeOnAcceptedMessage,
                ...(canonical.reviewedFacts ? { reviewedFacts: canonical.reviewedFacts } : {}),
                ...(canonical.environmentSetup ? { environmentSetup: canonical.environmentSetup } : {}),
            } });
            await invalidateManagedMachineInTx(tx, row);
            return { machine: projectManagedMachine(row, declaration), replayed: false };
        }, { intent: 'exclusive', additionalAccountIds: [params.requesterAccountId, params.custodianAccountId],
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
