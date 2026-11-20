import type { ExternalActionSessionPresetAcquisitionV1 } from '@happier-dev/protocol/actions/externalActionApi';
import { ManagedMachinePresetV1Schema } from '@happier-dev/protocol/machines/managed/managedMachinePresetV1';
import { isStoredOpaquePresetMachine, projectManagedMachineFull, projectManagedMachineOpaque } from './managedMachineProjection';
import { ManagedAdmissionInputV1Schema, ManagedAdmissionPresetContentV1Schema, resolveManagedAcquireReviewV1, isManagedPresetAcquireInputV1, managedWorkspaceAttachmentIdV1, type ManagedAdmissionInputV1, type ManagedAdmissionOutputV1, type ManagedAdmissionPresetContentV1 } from '@happier-dev/protocol/machines/managed/actionsV1';
import { ManagedMachineFullV1Schema, type ManagedMachineV1, type ValidatedLaunchSnapshotV1 } from '@happier-dev/protocol/machines/managed/managedMachineV1';
import { createManagedConfigurationFactsV1Schema } from '@happier-dev/protocol/machines/managed/managedConfigurationV1';
import { createPluginJsonSchemaZodValueAdapter } from "@happier-dev/protocol/plugins/actions/json-schema-validation";
import { db, isPrismaUniqueConstraintError } from "@/storage/db";
import { resolveMachineRetentionNativeIntentV1, resolveMachineRetentionPolicyV1 } from "@happier-dev/protocol/machines/managed/resolveMachineRetentionPolicyV1";
import type { RetentionCapabilitiesV1 } from "@happier-dev/protocol/machines/managed/providerFactsV1";
import { isMachineProvisionerWorkspaceAttachmentV1 } from '@happier-dev/protocol/plugins/contributions/machineProvisioners';
import { readInputPath } from '@happier-dev/protocol/inputs';
import {
    ManagedMachineError, invalidateManagedMachineInTx, publishManagedMachinePolicyChangeInTx,
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
    acquireManagedMachinePublicationAccountsInTx,
    readManagedProjectionFactsInTx,
} from "./managedRows";
import { hasMachinePresetAcquireCapacityInTx, resolveMachinePresetForAcquireInTx, validateManagedLaunchInTx } from "./machinePresetService";
import { jsonPathEquals } from '@/storage/jsonPathFilter';
import type { TeamOperationAuthenticationContext } from "@/app/teams/actorContext";
import { inReadSnapshot, inTx, type Tx } from "@/storage/inTx";
import type { ExternalActionRetainedWorkflowRootV1 } from '@happier-dev/protocol/actions/externalActionEncryption';
import { readServerGuestCliIdentity } from '@/app/runtime/serverRelease';

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
    /** Exact scope consumed from a verified reviewed Session child, never request input. */
    sessionPresetAcquisition?: ExternalActionSessionPresetAcquisitionV1;
    /** Installed controller selected a preset through its Machine policy on the verified Session child. */
    machinePolicySandbox?: true;
    authentication?: TeamOperationAuthenticationContext;
    requestEnvelopeDigest: string;
    /** Original transport, derived by the route from its verified Workflow root. */
    workflowRoot?: ExternalActionRetainedWorkflowRootV1;
    input: ManagedAdmissionInputV1;
}>): Promise<ManagedAcquireAdmissionResult> {
    let transactionStarted = false;
    try {
        const request = ManagedAdmissionInputV1Schema.parse(params.input);
        const review = resolveManagedAcquireReviewV1(request.input);
        const admittedSessionPreset = params.sessionPresetAcquisition !== undefined
            && sameManagedInput({ selection: params.sessionPresetAcquisition.selection, controller: params.sessionPresetAcquisition.controller },
                { selection: request.input.selection, controller: review.controller });
        const crossAccount = params.custodianAccountId !== params.requesterAccountId;
        const attaching = request.input.selection.kind === 'one-off' && request.input.selection.attachWorkspace === true;
        const prepared = request.preparedAttachment;
        if (attaching ? !prepared || !review.controller || request.continuationPresent
            || request.acquisitionMode || request.input.creationScopeRetention || prepared.resource.origin === 'created'
            : prepared !== undefined) throw new ManagedMachineError('permission_denied');
        const custodianPolicyPreset = crossAccount && request.acquisitionMode === 'resource-bound' && params.machinePolicySandbox === true;
        if (request.acquisitionMode && (!isManagedPresetAcquireInputV1(request.input) || !review.controller
            || crossAccount && !admittedSessionPreset && !custodianPolicyPreset)) {
            throw new ManagedMachineError('invalid_request');
        }
        if (!review.controller && params.custodianAccountId !== params.requesterAccountId) throw new ManagedMachineError('permission_denied');
        // The Workflow continuation retains its original transport for private
        // retry comparison; an E2EE transport remains ciphertext at Home.
        const admittedInputIdentity = { computeInput: projectManagedAcquisitionComputeInput(request.input),
            continuation: request.continuationPresent ? { requestEnvelopeDigest: params.requestEnvelopeDigest,
                ...(params.workflowRoot ? { workflowRoot: params.workflowRoot } : {}) } : null,
            ...(request.acquisitionMode ? { acquisitionMode: request.acquisitionMode } : {}),
            ...(request.reuseIdle ? { reuseIdle: true } : {}) };
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
        const execute = () => inTx(async (tx) => {
            const declarationInput = isManagedPresetAcquireInputV1(request.input) ? undefined
                : { homeId: review.homeId, custodianAccountId: params.custodianAccountId, controller: review.controller,
                    provider: request.input.selection.launch.provider };
            const projection = declarationInput ? await readManagedProjectionFactsInTx(tx, [declarationInput]) : undefined;
            const attachmentDeclaration = attaching && declarationInput ? projection?.declarationFor(declarationInput) : undefined;
            await acquireManagedMachinePublicationAccountsInTx(tx, { controllerMachineId: review.controller?.machineId },
                { intent: 'serializing', additionalAccountIds: [params.requesterAccountId, params.custodianAccountId] });
            await requireManagedControllerInTx(tx, { homeId: review.homeId, custodianAccountId: params.custodianAccountId, controller: review.controller });
            const existing = await existingAdmission(tx);
            if (existing) return existing;
            // This enrolling admission captures Home's producer, never a
            // requester descriptor. Retained admissions return above unchanged.
            const guestCli = attaching || request.acquisitionMode === 'resource-bound' ? undefined : readServerGuestCliIdentity();
            if (isManagedPresetAcquireInputV1(request.input)) {
                const snapshot = admittedSessionPreset ? params.sessionPresetAcquisition?.admission : undefined;
                const selected = snapshot ? { kind: 'ready' as const,
                    preset: ManagedMachinePresetV1Schema.parse({ ...snapshot.preset, ...snapshot.presetContent }),
                    presetContent: snapshot.presetContent, custodianAccountId: params.custodianAccountId,
                    delegated: snapshot.delegated,
                } : await resolveMachinePresetForAcquireInTx(tx, {
                    ...(custodianPolicyPreset ? { accountId: params.custodianAccountId, accountOwned: true }
                        : { accountId: params.requesterAccountId, authentication: params.authentication }),
                    ...request.input.selection, boundController: review.controller,
                    ...(request.reuseIdle ? { checkCapacity: false } : {}) });
                if (selected.kind === "conflict") throw new ManagedMachineError("request_conflict");
                if (selected.kind === "refused") throw new ManagedMachineError(selected.code);
                if (selected.delegated && params.managedAcquireDelegation !== true && !admittedSessionPreset) throw new ManagedMachineError('permission_denied');
                if (snapshot && !request.reuseIdle && !await hasMachinePresetAcquireCapacityInTx(tx, {
                    homeId: review.homeId, id: selected.preset.id, maximum: selected.preset.simultaneousLimit?.maximum ?? null,
                })) throw new ManagedMachineError('preset_limit_reached');
                const controller = selected.preset.controller ?? (request.acquisitionMode ? review.controller : undefined);
                if (!sameManagedInput(controller, review.controller)) throw new ManagedMachineError("controller_retired");
                if (request.acquisitionMode && selected.custodianAccountId !== params.custodianAccountId) throw new ManagedMachineError('permission_denied');
                const preset = { id: selected.preset.id, revision: selected.preset.revision,
                    setupRevision: selected.preset.setupRevision ?? 0,
                    configurationRevision: selected.preset.configurationRevision ?? 0 } as const;
                const presetContent = ManagedAdmissionPresetContentV1Schema.parse(selected.presetContent);
                const presetContentOverride = request.input.presetContentOverride;
                if (presetContentOverride && presetContentOverride.content.t !== presetContent.content.t) {
                    throw new ManagedMachineError('account_mode_mismatch');
                }
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
                if (request.reuseIdle) {
                    if (retention.kind !== 'until-delete' || request.input.creationScopeRetention) throw new ManagedMachineError('invalid_request');
                    // Selection is optimistic. Session birth locks this exact row and
                    // excludes an incumbent nonarchived Session before guest execution.
                    // A never-born resource remains owned by its creating request's Retry.
                    const idle = await tx.managedMachine.findFirst({ where: {
                        homeId: review.homeId, custodianAccountId: selected.custodianAccountId,
                        controllerMachineId: controller?.machineId, controllerInstallationId: controller?.installationId,
                        presetId: preset.id, presetConfigurationRevision: preset.configurationRevision, allocation: 'bound', creationState: 'active',
                        archivedAt: null, desired: 'start', birthSessions: { none: { archivedAt: null } },
                        OR: [{ birthSessions: { some: { archivedAt: { not: null } } } },
                            { admittedInput: jsonPathEquals(['resourceBoundSessionEnded'], true) }],
                        AND: [{ admittedInput: jsonPathEquals(['acquisitionMode'], 'resource-bound') },
                            { admittedInput: jsonPathEquals(['reuseIdle'], true) },
                            { admittedInput: jsonPathEquals(['enrollmentAccountId'], params.requesterAccountId) },
                            { retention: jsonPathEquals(['kind'], 'until-delete') }],
                    }, orderBy: { createdAt: 'asc' } });
                    if (idle) {
                        const { resourceBoundSessionEnded, ...admission } = readManagedAdmissionState(idle.admittedInput);
                        if (resourceBoundSessionEnded) {
                            await tx.managedMachine.update({ where: { id: idle.id }, data: { admittedInput: admission } });
                            await publishManagedMachinePolicyChangeInTx(tx, idle, [params.requesterAccountId]);
                        }
                        return { machine: projectManagedMachineOpaque(idle),
                            presetContent: readManagedOpaquePresetContent(idle), replayed: true };
                    }
                    if (!await hasMachinePresetAcquireCapacityInTx(tx, { homeId: review.homeId,
                        id: preset.id, maximum: selected.preset.simultaneousLimit?.maximum ?? null })) {
                        throw new ManagedMachineError('preset_limit_reached');
                    }
                }
                const scopeChoice = request.input.creationScopeRetention;
                const creationScopeRetention = scopeChoice ? { ...scopeChoice } : undefined;
                const admittedInput = { ...admittedInputIdentity,
                    ...(guestCli ? { guestCli } : {}),
                    enrollmentAccountId: params.requesterAccountId,
                    ...(creationScopeRetention ? { creationScopeRetention } : {}),
                    requestEnvelopeDigest: params.requestEnvelopeDigest,
                    ...(presetContentOverride ? { presetContentOverride } : {}),
                };
                const row = await tx.managedMachine.create({ data: {
                    homeId: review.homeId, custodianAccountId: selected.custodianAccountId,
                    controllerMachineId: controller?.machineId ?? null, controllerInstallationId: controller?.installationId ?? null,
                    admittedActionRequestId: request.requestId, admittedInput,
                    presetId: preset.id, presetRevision: preset.revision, presetConfigurationRevision: preset.configurationRevision,
                    presetSetupRevision: preset.setupRevision,
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
            // The attached guest's read-only native roles already spent the selected
            // credential through custody. Home uses the declared schemas and binds
            // the row here without the enrolled launch/credential read under lock.
            const qualified = attaching ? attachmentDeclaration
                : (await validateManagedLaunchInTx(tx, { accountId: params.requesterAccountId, authentication: params.authentication },
                    { homeId: review.homeId, controller: review.controller, launch }, request.input.reviewedFacts, projection?.declarationBodies)).declaration;
            if (!qualified || qualified.schemaVersion !== launch.schemaVersion) throw new ManagedMachineError('invalid_request');
            declaration = qualified;
            if (attaching !== isMachineProvisionerWorkspaceAttachmentV1(declaration.provisioner, launch.choices)) {
                throw new ManagedMachineError('invalid_request');
            }
            if (!review.controller && request.input.reviewedFacts?.provisioner?.id !== launch.provider.localId) throw new ManagedMachineError('invalid_request');
            const parsedFacts = attaching || request.input.reviewedFacts === undefined ? undefined
                : createManagedConfigurationFactsV1Schema(createPluginJsonSchemaZodValueAdapter(declaration.launchSchema)).safeParse(request.input.reviewedFacts);
            if (parsedFacts && !parsedFacts.success) throw new ManagedMachineError("invalid_request");
            // Retained native authority comes from admission's declaration, not requester presentation facts.
            const reviewedFacts = parsedFacts?.success ? { ...parsedFacts.data, provisioner: declaration.provisioner,
                ...(review.controller ? { retentionCapabilities: declaration.retention, billing: declaration.billing } : {}) } : undefined;
            const policy = attaching ? { retention: { kind: 'until-delete' as const }, wakeOnAcceptedMessage: false }
                : qualifyManagedAcquisitionPolicy(review, declaration, reviewedFacts?.retentionCapabilities);
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
                id: prepared ? managedWorkspaceAttachmentIdV1(review.homeId, params.custodianAccountId, request.requestId) : "admission",
                homeId: review.homeId, custodianAccountId: params.custodianAccountId,
                enrollmentAccountId: params.requesterAccountId,
                launch, controller: review.controller,
                enrollmentIdentity: request.input.enrollmentIdentity,
                allocation: prepared ? 'bound' : 'unsubmitted', creationState: 'active', desired: 'start', desiredWhen: 'now', intentRevision: 0,
                ...(prepared ? { resource: prepared.resource, workspaceAttachment: prepared.platform } : {}),
                retention: policy.retention, wakeOnAcceptedMessage: policy.wakeOnAcceptedMessage,
                ...(reviewedFacts ? { reviewedFacts } : {}),
            };
            const declared = createManagedMachineDeclaredSchema(declaration.launchSchema, declaration.resourceSchema);
            const parsed = declared.safeParse(candidate);
            if (!parsed.success) {
                if (prepared) throw new ManagedMachineError('resource_mismatch');
                throw parsed.error;
            }
            const canonical = ManagedMachineFullV1Schema.parse(parsed.data);
            const identityPaths = declaration.provisioner.workspaceAttachment?.resourceIdentityPaths;
            if (prepared && identityPaths && canonical.controller) {
                const resourceIdentity = identityPaths.map(path => {
                    const value = readInputPath(prepared.resource.value, path);
                    if (!(typeof value === 'string' && value.length > 0) && typeof value !== 'number') {
                        throw new ManagedMachineError('resource_mismatch');
                    }
                    return { resource: jsonPathEquals(['value', ...path.split('.')], value) };
                });
                // Native custody proved this workspace anew. Reuse only an active attachment
                // of the same origin and credential selection, under the Account publication lock.
                const retained = await tx.managedMachine.findMany({ where: {
                    homeId: canonical.homeId, custodianAccountId: canonical.custodianAccountId,
                    controllerMachineId: canonical.controller.machineId,
                    controllerInstallationId: canonical.controller.installationId,
                    presetId: null, allocation: 'bound', creationState: 'active', archivedAt: null,
                    AND: [
                        { resource: jsonPathEquals(['contributionRef', 'pluginId'], launch.provider.pluginId) },
                        { resource: jsonPathEquals(['contributionRef', 'localId'], launch.provider.localId) },
                        { resource: jsonPathEquals(['schemaVersion'], launch.schemaVersion) },
                        ...resourceIdentity,
                    ],
                }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] });
                for (const row of retained) {
                    if (readManagedEnrollmentAccountId(row) !== params.requesterAccountId
                        || !readManagedAdmissionState(row.admittedInput).workspaceAttachment) continue;
                    const machine = projectManagedMachineFull(row);
                    if (sameManagedInput(machine.launch.credentials ?? [], launch.credentials ?? [])) return { machine, replayed: true };
                }
            }
            const row = await tx.managedMachine.create({ data: {
                ...(prepared ? { id: canonical.id } : {}),
                homeId: canonical.homeId, custodianAccountId: canonical.custodianAccountId,
                controllerMachineId: canonical.controller?.machineId ?? null, controllerInstallationId: canonical.controller?.installationId ?? null,
                admittedActionRequestId: request.requestId, admittedInput: { ...admittedInputIdentity,
                    ...(guestCli ? { guestCli } : {}),
                    enrollmentAccountId: params.requesterAccountId,
                    ...(creationScopeRetention ? { creationScopeRetention } : {}),
                    requestEnvelopeDigest: params.requestEnvelopeDigest,
                    ...(canonical.workspaceAttachment ? { workspaceAttachment: canonical.workspaceAttachment } : {}),
                    },
                launch: canonical.launch, retention: canonical.retention, wakeOnAcceptedMessage: canonical.wakeOnAcceptedMessage,
                ...(canonical.resource ? { allocation: 'bound', resource: canonical.resource } : {}),
                ...(canonical.reviewedFacts ? { reviewedFacts: canonical.reviewedFacts } : {}),
                ...(canonical.machineSetup ? { machineSetup: canonical.machineSetup } : {}),
            } });
            await invalidateManagedMachineInTx(tx, row);
            const machine = projectManagedMachineFull(row);
            return { machine, replayed: false };
        }, { transactionClass: 'managed-machine-acquire' });
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
