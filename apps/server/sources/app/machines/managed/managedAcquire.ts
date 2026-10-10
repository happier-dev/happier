import {
    ManagedAdmissionInputV1Schema,
    ManagedMachineV1Schema,
    createManagedConfigurationFactsV1Schema,
    resolveManagedAcquireReviewV1,
    type ManagedAdmissionInputV1,
    type ManagedMachineV1,
    type ValidatedLaunchSnapshotV1,
    type MachineEnvironmentV1,
} from "@happier-dev/protocol";
import { inTx } from "@/storage/inTx";
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
} from "./managedRows";
import { resolveMachinePresetForAcquireInTx, validateManagedRecipeInTx } from "./machinePresetService";
import type { TeamOperationAuthenticationContext } from "@/app/teams/actorContext";

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
    const request = ManagedAdmissionInputV1Schema.parse(params.input);
    const review = resolveManagedAcquireReviewV1(request.input);
    // Dedupe includes the private continuation without retaining its prompt,
    // attachments, or startup instructions in a Home-visible resource row.
    const admittedInputIdentity = { computeInput: request.input, continuation: request.continuationPresent ? { requestEnvelopeDigest: params.requestEnvelopeDigest } : null };
    const execute = () => inTx(async (tx) => {
        await requireManagedControllerInTx(tx, { homeId: review.homeId, custodianAccountId: params.custodianAccountId, controller: review.controller });
        const existing = await tx.managedMachine.findUnique({ where: { homeId_admittedActionRequestId: { homeId: review.homeId, admittedActionRequestId: request.requestId } } });
        if (existing) {
            if (existing.custodianAccountId !== params.custodianAccountId || !sameManagedInput(readManagedAcquisitionIdentity(existing.admittedInput), admittedInputIdentity)) throw new ManagedMachineError("request_conflict");
            const setupAdmission = readManagedAdmissionState(existing.admittedInput).environmentSetup;
            if (setupAdmission && setupAdmission.requestEnvelopeDigest !== params.requestEnvelopeDigest) throw new ManagedMachineError("request_conflict");
            const declaration = await resolveManagedDeclarationInTx(tx, { homeId: existing.homeId, custodianAccountId: existing.custodianAccountId, controller: review.controller, provider: readManagedLaunchSnapshot(existing.launch).provider });
            return { machine: projectManagedMachine(existing, declaration), replayed: true };
        }
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
    });
    try { return await execute(); }
    catch (error) {
        // A concurrent retry may win the database correlation. Re-enter the
        // real transaction owner and compare the retained canonical input.
        if (!isPrismaUniqueConstraintError(error)) throw error;
        const existing = await db.managedMachine.findUnique({ where: { homeId_admittedActionRequestId: { homeId: review.homeId, admittedActionRequestId: request.requestId } } });
        if (!existing) throw error;
        return await execute();
    }
}
