import { decodeMachineStoredContent, withMachineContentSelect } from '@/storage/sessionMachineStoredContent';
import type { ManagedMachinePresetV1 } from '@happier-dev/protocol/machines/managed/managedMachinePresetV1';
import { isStoredOpaquePresetMachine } from './managedMachineProjection';
import { withManagedWakeAvailabilityInTx } from './managedWakeAvailability';
import { resolvePluginLocalizedStringV2Text } from "@happier-dev/protocol/plugins/contributions/publicTypes";
import { readManagedController, readManagedAdmissionState, projectManagedMachine, readStoredOpaquePresetLaunch, storeOpaquePresetLaunch } from './managedMachineProjection';
import { MANAGED_RESIZE_ACTION_ID_V1, isManagedResizeActionIdV1, isManagedPowerOrDeleteActionIdV1 } from '@happier-dev/protocol/machines/managed/actionIdsV1';
export { readManagedController, readManagedAdmissionState, projectManagedMachine, readStoredOpaquePresetLaunch, storeOpaquePresetLaunch } from './managedMachineProjection';
import type { Prisma } from "@prisma/client";
import * as z from "zod/mini";
import { createStoredReadSchema } from '@happier-dev/protocol/json/storedReadSchema';
import { StrictJsonValueSchema } from '@happier-dev/protocol/json/strictJsonValue';
import { ManagedCreationScopeRetentionV1Schema, createManagedMachineV1Schema, RetainedManagedLaunchSnapshotV1Schema, type ManagedMachineV1, type ValidatedLaunchSnapshotV1, type RetainedManagedLaunchSnapshotV1 } from '@happier-dev/protocol/machines/managed/managedMachineV1';
import { ManagedAdmissionComputeInputV1Schema, ManagedAdmissionPresetContentV1Schema, ManagedControllerCurrentnessV1Schema, ManagedControlAdmissionInputV1Schema, isManagedPresetAcquireInputV1, type ManagedControllerCurrentnessV1, type ManagedAdmissionInputV1 } from '@happier-dev/protocol/machines/managed/actionsV1';
import { ManagedMachinePresetLaunchNameOverrideV1Schema } from '@happier-dev/protocol/machines/managed/managedMachinePresetContentV1';
import { ExternalActionRetainedWorkflowRootV1Schema } from '@happier-dev/protocol/actions/externalActionEncryption';
import { ManagedPolicyAdmissionInputV1Schema, type ManagedMachinePolicyChangeHintV1 } from '@happier-dev/protocol/machines/managed/managedPolicyV1';
import { SupportedNativeIntentSchema, ManagedResourceV1Schema, type ManagedResourceV1, type SupportedNativeIntent, type ManagedRefusalCodeV1Schema } from '@happier-dev/protocol/machines/managed/providerFactsV1';
import { deriveManagedDevcontainerChildProjectionV1, type DevcontainerChildProjectionV1, managedDevcontainerChildProjectionsEqualV1 } from '@happier-dev/protocol/machines/managed/devcontainerV1';
import { resolvePluginActionConnectedAccountUseRequestsV2, type PluginActionConnectedAccountUseRequestV2 } from "@happier-dev/protocol/plugins/manifest/v2";
import { MachineProvisionerContributionV1Schema, type MachineProvisionerContributionV1 } from "@happier-dev/protocol/plugins/contributions/machineProvisioners";
import { PluginJsonValueV2Schema, type PluginJsonSchemaV2 } from "@happier-dev/protocol/plugins/contributions/jsonSchema";
import { createPluginJsonSchemaZodValueAdapter } from "@happier-dev/protocol/plugins/actions/json-schema-validation";
import { pluginJsonValuesEqual } from "@happier-dev/protocol/plugins/actions/protocol-composable-schema";
import { acquireAccountChangePublicationLocksInTx, assertAccountChangePublicationAudienceInTx, beforeAccountChangePublication, markAccountsChanged } from "@/app/changes/markAccountChanged";
import type { AccountAdmissionIntent } from "@/app/encryption/accountSessionOwnerMetadataFence";
import { resolveCurrentMachineRecipientAccountIdsInTx, resolveMachineAccessInTx } from "@/app/machines/machineAccess";
import { readCurrentServerIdentityId } from "@/app/serverIdentity/serverIdentity";
import { classifyMachineAvailabilityState } from "@/app/machines/machineStateGuards";
import { isMachineOperationSupportedForRequester, type MachineOperationRequesterContext } from '@/app/machines/machineOperationSupport';
import { resolveCurrentClaimablePluginMachineMaterializationsTx } from "@/app/plugins/availability/operations";
import { currentPluginDeclarationKeyV1, resolveCurrentPluginDeclarationsTx, type CurrentPluginDeclarationV1 } from "@/app/plugins/availability/currentDeclaration";
import { afterTx, inTx, TransactionReplayRequiredError, type ResolvedTransactionResult, type Tx } from "@/storage/inTx";
import { buildUpdateMachineUpdate, eventRouter } from '@/app/events/eventRouter';
import { randomKeyNaked } from '@/utils/keys/randomKeyNaked';
import { portableQueryChunks } from '@/storage/portableQueryChunks';
import { ManagedMachineEnrollmentIdentityV1Schema, SubmittedNativeEffectV1Schema } from '@happier-dev/protocol/machines/managed/managedMachineV1';
import { ManagedControllerAccessV1Schema } from '@happier-dev/protocol/machines/managed/managedMachineV1';
import { encodeBase64 } from 'privacy-kit';
import { jsonPathEquals } from '@/storage/jsonPathFilter';
import { ManagedConfigurationFactsV1ReadSchema } from '@happier-dev/protocol/machines/managed/managedConfigurationV1';
import type { ManagedControllerV1 } from '@happier-dev/protocol/machines/managed/managedMachineV1';
import { GuestCliIdentityV1Schema } from '@happier-dev/protocol/features/payload/capabilities/guestCliIdentityV1';
import { resolveEffectiveMachineAccessForMachinesInTx } from '@/app/machines/machineAccess';
import { inheritManagedControllerRole, resolveManagedMachineRole } from './managedRole';
import type { MachineAccessRoleV1 } from '@happier-dev/protocol/machines/machineAccessV1';
export { resolveManagedMachineRole } from './managedRole';
import { readMachineAudienceAccountIdsForMachinesInTx } from '@/app/machines/machineRecipientWork';
import { serializeManagedMachineRef, serializeManagedInputRuntime } from '@/app/machines/machineSerialization';

export type StoredManagedMachine = Prisma.ManagedMachineGetPayload<Record<string, never>>;

/** Only submitted or bound allocations can require native cleanup. */
export function hasPossibleManagedNativeResource(row: Pick<StoredManagedMachine, 'allocation'>): boolean {
    return row.allocation !== 'unsubmitted' && row.allocation !== 'confirmed-absent';
}

/** Acquire once; native resource power and guest activity have distinct existing authorities. */
export async function resolveManagedMachineRolesInTx(tx: Tx, row: Pick<StoredManagedMachine, 'custodianAccountId' | 'controllerMachineId' | 'enrolledMachineId'>, actorAccountId: string): Promise<Readonly<{
    resourceRole: MachineAccessRoleV1 | null; guestActivityRole: MachineAccessRoleV1 | null;
}>> {
    const access = await resolveEffectiveMachineAccessForMachinesInTx(tx, {
        machineIds: [row.controllerMachineId, row.enrolledMachineId].filter((id): id is string => id !== null), accountIds: [actorAccountId],
    });
    const guestRole = row.enrolledMachineId ? access.get(row.enrolledMachineId)?.get(actorAccountId) ?? null : null;
    const resourceRole = resolveManagedMachineRole(row, actorAccountId,
        row.controllerMachineId ? access.get(row.controllerMachineId)?.get(actorAccountId) ?? null : null,
        guestRole);
    return { resourceRole, guestActivityRole: inheritManagedControllerRole(resourceRole, guestRole) };
}

export async function resolveManagedMachineRoleInTx(tx: Tx, row: Pick<StoredManagedMachine, 'custodianAccountId' | 'controllerMachineId' | 'enrolledMachineId'>, actorAccountId: string) {
    return (await resolveManagedMachineRolesInTx(tx, row, actorAccountId)).resourceRole;
}

/** The invoking host admitted this person's descriptor; it is not a server plugin declaration. */
export function readManagedReviewedDeclaration(facts: unknown): ManagedDeclaration | null {
    const parsed = ManagedConfigurationFactsV1ReadSchema.safeParse(facts);
    if (!parsed.success || !parsed.data.provisioner) return null;
    return { ...parsed.data.provisioner, provisioner: parsed.data.provisioner, accountAcquire: true,
        retention: parsed.data.retentionCapabilities, acquireCredentialRequests: [] };
}
/** Public installation carrier only; its containing preset/resource owns caller admission. */
export function projectManagedControllerAccess(controller: Readonly<{
    kind: string; accountId: string; installationId: string | null; installationPublicKey: Uint8Array | null;
    revokedAt: Date | null; replacedByMachineId: string | null;
}> | null | undefined, expected: Readonly<{ installationId: string }>) {
    if (!controller || controller.kind !== 'persistent' || classifyMachineAvailabilityState(controller) !== 'available'
        || controller.installationId !== expected.installationId || !controller.installationPublicKey) return null;
    const parsed = ManagedControllerAccessV1Schema.safeParse({ custodian: { accountId: controller.accountId },
        installationPublicKey: encodeBase64(new Uint8Array(controller.installationPublicKey), 'base64url').replace(/=+$/u, '') });
    return parsed.success ? parsed.data : null;
}
export type ManagedDeclaration = Pick<MachineProvisionerContributionV1, "resourceKind" | "actions" | "schemaVersion" | "launchSchema" | "resourceSchema" | "billing" | "retention" | "reconciliation" | "credentialPurposeRequirements" | "nativeCredentialDelivery"> & Readonly<{
    acquireCredentialRequests: readonly PluginActionConnectedAccountUseRequestV2[];
    provisioner: MachineProvisionerContributionV1;
    accountAcquire: boolean;
}>;
export function createManagedMachineDeclaredSchema(launch: PluginJsonSchemaV2, native: PluginJsonSchemaV2, nativeOperation?: PluginJsonSchemaV2) {
    return createManagedMachineV1Schema(createPluginJsonSchemaZodValueAdapter(launch), createPluginJsonSchemaZodValueAdapter(native),
        nativeOperation ? createPluginJsonSchemaZodValueAdapter(nativeOperation) : undefined);
}
/** Validate incoming native values by declaration; other retained values stay opaque. */
export function createManagedMachineRetainedSchema(native: PluginJsonSchemaV2 | undefined, nativeOperation?: PluginJsonSchemaV2) {
    return createManagedMachineV1Schema(RetainedManagedLaunchSnapshotV1Schema.shape.choices,
        native ? createPluginJsonSchemaZodValueAdapter(native) : PluginJsonValueV2Schema,
        nativeOperation ? createPluginJsonSchemaZodValueAdapter(nativeOperation) : undefined);
}
export function readManagedLaunchSnapshot(value: unknown): RetainedManagedLaunchSnapshotV1 {
    return createStoredReadSchema(RetainedManagedLaunchSnapshotV1Schema).parse(value);
}
export class ManagedMachineError extends Error {
    constructor(readonly code: z.infer<typeof ManagedRefusalCodeV1Schema>) {
        super(code);
    }
}

/** Exact raw-row CAS retains unknown stored members rather than the read projection. */
export function readManagedJsonEqualityOperand(value: unknown): Prisma.InputJsonValue {
    const parsed = StrictJsonValueSchema.safeParse(value);
    if (!parsed.success || parsed.data === null) throw new ManagedMachineError("request_conflict");
    return parsed.data;
}

const StoredManagedOpaquePresetComputeInputSchema = z.omit(ManagedAdmissionComputeInputV1Schema.def.options[1], { presetContentOverride: true });
const StoredManagedComputeInputSchema = z.union([
    z.extend(z.omit(ManagedAdmissionComputeInputV1Schema.def.options[0], { enrollmentIdentity: true }), {
        enrollmentIdentity: z.optional(ManagedMachineEnrollmentIdentityV1Schema),
    }),
    // Preset identity is private sealed content, not retained Home input.
    z.extend(StoredManagedOpaquePresetComputeInputSchema, {
        enrollmentIdentity: z.optional(ManagedMachineEnrollmentIdentityV1Schema),
        reviewedFacts: z.optional(ManagedConfigurationFactsV1ReadSchema),
    }),
]);
const StoredManagedAdmissionSchema = z.strictObject({
    guestCli: z.optional(GuestCliIdentityV1Schema),
    acquisitionMode: z.optional(z.literal('resource-bound')),
    reuseIdle: z.optional(z.literal(true)),
    bootstrapInstalled: z.optional(z.literal(true)),
    creationScopeRetention: z.optional(ManagedCreationScopeRetentionV1Schema),
    enrollmentAccountId: z.optional(z.string().check(z.minLength(1))),
    requestEnvelopeDigest: z.optional(z.string().check(z.minLength(1))),
    /** First admitted opaque name override, retained only until the controller snapshots it into launch content. */
    presetContentOverride: z.optional(ManagedMachinePresetLaunchNameOverrideV1Schema),
    computeInput: z.optional(StoredManagedComputeInputSchema),
    continuation: z.optional(z.nullable(z.strictObject({ requestEnvelopeDigest: z.string().check(z.minLength(1)),
        workflowRoot: z.optional(ExternalActionRetainedWorkflowRootV1Schema) }))),
    machineSetup: z.optional(z.strictObject({ requestEnvelopeDigest: z.string().check(z.minLength(1)) })),
    currentAdmission: z.optional(z.discriminatedUnion("kind", [
        z.strictObject({ kind: z.literal("control"), request: ManagedControlAdmissionInputV1Schema,
            rebuildSettled: z.optional(z.literal(true)), resizeSettled: z.optional(z.literal(true)),
            resizeProvisioner: z.optional(MachineProvisionerContributionV1Schema) }),
        z.strictObject({ kind: z.literal("policy"), request: ManagedPolicyAdmissionInputV1Schema }),
    ])),
    submittedEffect: z.optional(z.strictObject({ ...ManagedControllerCurrentnessV1Schema.shape, intent: SupportedNativeIntentSchema,
        reviewedEffectDigest: SubmittedNativeEffectV1Schema.def.shape.reviewedEffectDigest })),
    replacementEnrollment: z.optional(z.strictObject({ machineId: z.string().check(z.minLength(1)) })),
});
const StoredManagedAdmissionReadSchema = createStoredReadSchema(StoredManagedAdmissionSchema);
export type StoredManagedAdmission = z.infer<typeof StoredManagedAdmissionSchema>;

/** Installation completion is retained in the existing admission, independently of Setup. */
export function markManagedBootstrapInstalled(admittedInput: unknown) {
    return { ...readManagedAdmissionState(admittedInput), bootstrapInstalled: true as const };
}

/** Migration has already carried legacy private compute facts into the sealed body. */
export function projectManagedPresetAdmissionForOpaqueStorage(value: unknown,
    content: ManagedMachinePresetV1['content']) {
    const admitted = readManagedAdmissionState(value);
    const current = admitted.currentAdmission;
    const currentAdmission = current?.kind === 'control' && current.request.action === MANAGED_RESIZE_ACTION_ID_V1
        ? { kind: 'control' as const, resizeSettled: true as const,
            request: ManagedControlAdmissionInputV1Schema.parse({ ...current.request, input: {
                homeId: current.request.input.homeId, managedId: current.request.input.managedId,
                presetContentOverride: { content },
            } }) }
        : current;
    return { ...admitted, ...(currentAdmission ? { currentAdmission } : {}),
        ...(admitted.computeInput === undefined ? {} : {
            computeInput: createStoredReadSchema(StoredManagedOpaquePresetComputeInputSchema).parse(admitted.computeInput),
        }) };
}


/** The row launch envelope is the sole persisted source of opaque preset content. */
export function readManagedOpaquePresetContent(row: Pick<StoredManagedMachine, 'presetId' | 'launch'>) {
    if (!isStoredOpaquePresetMachine(row)) throw new ManagedMachineError('request_conflict');
    const { content, recipients } = readStoredOpaquePresetLaunch(row.launch);
    return ManagedAdmissionPresetContentV1Schema.parse({ content, recipients });
}

/** The row's active admitted action owns any private content override and its settlement. */
export function readManagedOpaquePresetContentOverride(row: Pick<StoredManagedMachine, 'presetId' | 'launch' | 'admittedInput'>) {
    if (!isStoredOpaquePresetMachine(row)) return undefined;
    const admitted = readManagedAdmissionState(row.admittedInput);
    if (admitted.presetContentOverride) return admitted.presetContentOverride;
    const current = admitted.currentAdmission;
    if (current?.kind !== 'control' || !isManagedResizeActionIdV1(current.request.action) || current.resizeSettled) return undefined;
    const input = current.request.input;
    return 'presetContentOverride' in input ? input.presetContentOverride : undefined;
}

/** Optional replacement content is carried separately from the admitted request identity. */
export function projectManagedAcquisitionComputeInput(input: ManagedAdmissionInputV1['input']): NonNullable<StoredManagedAdmission['computeInput']> {
    if (!isManagedPresetAcquireInputV1(input)) return input;
    // A replay returns the first retained ciphertext even when a retry carries another one.
    const { presetContentOverride: _override, ...computeInput } = input;
    return computeInput;
}

export function readManagedAcquisitionIdentity(value: unknown) {
    // Request correlation is a new admission boundary. Normalize retained
    // additive fields here so they cannot turn a legitimate replay into a conflict.
    const parsed = StoredManagedAdmissionReadSchema.safeParse(value);
    if (!parsed.success) throw new ManagedMachineError('request_conflict');
    const { computeInput, continuation, acquisitionMode, reuseIdle } = parsed.data;
    // Historical preset requests retained private review facts separately. The
    // signed request digest binds those bytes; replay identity is structural.
    return { computeInput: computeInput?.selection.kind === 'preset'
        ? createStoredReadSchema(StoredManagedOpaquePresetComputeInputSchema).parse(computeInput)
        : computeInput, continuation, ...(acquisitionMode ? { acquisitionMode } : {}), ...(reuseIdle ? { reuseIdle } : {}) };
}
/** New admission binds the authenticated requester; only historical absence retains custody. */
export function readManagedEnrollmentAccountId(row: Pick<StoredManagedMachine, 'admittedInput' | 'custodianAccountId'>): string {
    return readManagedAdmissionState(row.admittedInput).enrollmentAccountId ?? row.custodianAccountId;
}
export function readManagedCurrentRequestId(row: Pick<StoredManagedMachine, "admittedInput" | "admittedActionRequestId">): string {
    return readManagedAdmissionState(row.admittedInput).currentAdmission?.request.requestId ?? row.admittedActionRequestId;
}

/** Observing native truth can retire custody before the same admitted command reports. */
export function readManagedIntentReportAuthority(row: StoredManagedMachine,
    report: ManagedControllerCurrentnessV1): StoredManagedAdmission['submittedEffect'] {
    const admitted = readManagedAdmissionState(row.admittedInput);
    let authority = admitted.submittedEffect;
    if (!authority) {
        const admission = admitted.currentAdmission;
        if (!admission) return;
        let intent: SupportedNativeIntent;
        if (admission.kind === 'control') {
            const request = admission.request;
            if (!isManagedPowerOrDeleteActionIdV1(request.action) || !('intent' in request.input)) return;
            intent = request.input.intent;
        } else {
            const desired = SupportedNativeIntentSchema.safeParse(row.desired);
            if (!desired.success) return;
            intent = desired.data;
        }
        // Replacement identity has separate settlement semantics.
        if (intent === 'rebuild') return;
        authority = { homeId: row.homeId, managedId: row.id, expectedIntentRevision: row.intentRevision,
            requestId: admission.request.requestId, intent,
            controller: readManagedController(row) ?? (admission.kind === 'policy' ? admission.request.controller : undefined) };
    }
    return authority.homeId === report.homeId && authority.managedId === report.managedId
        && authority.expectedIntentRevision === report.expectedIntentRevision && authority.requestId === report.requestId
        && sameManagedInput(authority.controller, report.controller) ? authority : undefined;
}

/** Finite resize follow-ups consume this admitted request, not current intent or policy. */
export async function requireActiveManagedResizeInTx(tx: Tx, input: Readonly<{ homeId: string; managedId: string; requestId: string }>) {
    const row = await readManagedMachineInTx(tx, input);
    const admission = readManagedAdmissionState(row.admittedInput).currentAdmission;
    if (admission?.kind !== 'control' || !isManagedResizeActionIdV1(admission.request.action)
        || admission.request.requestId !== input.requestId) throw new ManagedMachineError('request_conflict');
    return row;
}

/** Retained jobs keep their Home routing identity without re-admitting controller availability. */
export async function requireManagedHomeInTx(tx: Tx, homeId: string): Promise<void> {
    if (await readCurrentServerIdentityId(process.env, tx) !== homeId) throw new ManagedMachineError("permission_denied");
}

/** Fresh admission checks the selected controller's lifecycle. */
export async function requireManagedControllerInTx(tx: Tx, input: Readonly<{
    homeId: string; custodianAccountId: string; controller?: { machineId: string; installationId: string };
}>, projection?: ManagedProjectionFacts): Promise<ManagedProjectionController | undefined> {
    await requireManagedHomeInTx(tx, input.homeId);
    if (!input.controller) return;
    const machine = projection ? projection.controllers.get(input.controller.machineId)
        : await tx.machine.findUnique({ where: { id: input.controller.machineId }, select: withMachineContentSelect(MANAGED_PROJECTION_CONTROLLER_SELECT) }).then(decodeMachineStoredContent);
    return requireManagedControllerFromFacts(input, machine);
}

/** The same installation/custody decision for a controller captured in a set read. */
export function requireManagedControllerFromFacts(input: Readonly<{
    custodianAccountId: string; controller?: { machineId: string; installationId: string };
}>, machine: ManagedProjectionController | null | undefined): ManagedProjectionController | undefined {
    if (!input.controller) return;
    if (!machine || machine.accountId !== input.custodianAccountId) throw new ManagedMachineError("permission_denied");
    if (classifyMachineAvailabilityState(machine) !== "available" || machine.installationId !== input.controller.installationId) {
        throw new ManagedMachineError("controller_retired");
    }
    return machine;
}

/** Consume the incumbent current declaration/materialization owners, never a provider registry. */
export async function resolveManagedDeclarationInTx(tx: Tx, input: Readonly<{
    homeId: string; custodianAccountId: string; controller?: { machineId: string; installationId: string };
    provider: ValidatedLaunchSnapshotV1["provider"];
    reviewedFacts?: unknown;
}>, options: Readonly<{ retainedInstallation?: boolean; declarationBodies?: ManagedDeclarationBodies }> = {}): Promise<ManagedDeclaration | null> {
    if (!input.controller) return readManagedReviewedDeclaration(input.reviewedFacts);
    return (await readManagedProjectionFactsInTx(tx, [input], options)).declarationFor(input);
}

/** An admitted row keeps its reviewed native schema across controller publication changes. */
export async function resolveManagedRowDeclarationInTx(tx: Tx, row: StoredManagedMachine, declarationBodies?: ManagedDeclarationBodies) {
    // Preset declaration lives in the opaque content envelope. The server
    // retains routing/lifecycle facts only; a keyholding daemon resolves it.
    if (isStoredOpaquePresetMachine(row)) return null;
    const reviewed = readManagedReviewedDeclaration(row.reviewedFacts);
    if (reviewed) return reviewed;
    // An unreviewed row reads the declaration its exact retained installation
    // published, also after retirement; admission owns controller lifecycle.
    return resolveManagedDeclarationInTx(tx, { homeId: row.homeId, custodianAccountId: row.custodianAccountId,
        controller: readManagedController(row), provider: readManagedLaunchSnapshot(row.launch).provider, reviewedFacts: row.reviewedFacts },
        { retainedInstallation: true, declarationBodies });
}

/** A strong publication fence reuses these bodies through the declaration owner's identity check. */
export type ManagedDeclarationBodies = ReadonlyMap<string, CurrentPluginDeclarationV1>;

function managedDeclarationBodyKey(accountId: string, declarationKey: string): string {
    return JSON.stringify([accountId, declarationKey]);
}

/** Legacy unreviewed enrollment reads its immutable schema before registration's exclusive fence. */
export async function readManagedRowDeclarationBodiesInTx(tx: Tx, row: StoredManagedMachine): Promise<ManagedDeclarationBodies> {
    if (isStoredOpaquePresetMachine(row) || readManagedReviewedDeclaration(row.reviewedFacts)) return new Map();
    return (await readManagedProjectionFactsInTx(tx, [{ homeId: row.homeId, custodianAccountId: row.custodianAccountId,
        controller: readManagedController(row), provider: readManagedLaunchSnapshot(row.launch).provider }],
        { retainedInstallation: true })).declarationBodies;
}

type ManagedProjectionInput = Readonly<{
    homeId: string; custodianAccountId?: string;
    controller?: Readonly<{ machineId: string; installationId: string }>;
    provider: ValidatedLaunchSnapshotV1['provider'];
}>;
const MANAGED_PROJECTION_CONTROLLER_SELECT = {
    id: true, accountId: true, kind: true, installationId: true, installationPublicKey: true, active: true,
    revokedAt: true, replacedByMachineId: true, account: { select: { status: true } },
} as const;
export type ManagedProjectionController = Prisma.MachineGetPayload<{ select: typeof MANAGED_PROJECTION_CONTROLLER_SELECT }>;
export interface ManagedProjectionFacts {
    controllers: ReadonlyMap<string, ManagedProjectionController>;
    declarationBodies: ManagedDeclarationBodies;
    declarationFor(input: ManagedProjectionInput): ManagedDeclaration | null;
}

/** Admitted facts live only for this projection; every new request reads current authority. */
export async function readManagedProjectionFactsInTx(tx: Tx, inputs: readonly ManagedProjectionInput[],
    options: Readonly<{ retainedInstallation?: boolean; declarationBodies?: ManagedDeclarationBodies }> = {}): Promise<ManagedProjectionFacts> {
    inputs = inputs.filter((input): input is ManagedProjectionInput & { controller: ManagedControllerV1 } => input.controller !== undefined);
    const controllers = new Map<string, ManagedProjectionController>();
    // Exact controller IDs plus Prisma's nested Account and pagination bindings.
    for (const ids of portableQueryChunks({ values: [...new Set(inputs.flatMap(input => input.controller ? [input.controller.machineId] : []))], bindingsPerValue: 1, fixedBindings: 2 })) {
        for (const controller of await tx.machine.findMany({ where: { id: { in: [...ids] } }, select: withMachineContentSelect(MANAGED_PROJECTION_CONTROLLER_SELECT) }).then(decodeMachineStoredContent)) {
            controllers.set(controller.id, controller);
        }
    }
    const keyOf = (input: ManagedProjectionInput) => JSON.stringify([input.homeId,
        input.custodianAccountId ?? controllers.get(input.controller!.machineId)?.accountId,
        input.controller!.machineId, input.controller!.installationId, input.provider.pluginId, input.provider.localId]);
    const distinct = [...new Map(inputs.map(input => [keyOf(input), input])).values()];
    const groups = new Map<string, { accountId: string; homeId: string; inputs: ManagedProjectionInput[] }>();
    for (const input of distinct) {
        const accountId = input.custodianAccountId ?? controllers.get(input.controller!.machineId)?.accountId;
        if (!accountId) continue;
        const key = JSON.stringify([accountId, input.homeId]);
        const group = groups.get(key) ?? { accountId, homeId: input.homeId, inputs: [] };
        group.inputs.push(input);
        groups.set(key, group);
    }
    const declarations = new Map<string, ManagedDeclaration | null>();
    const declarationBodies = new Map<string, CurrentPluginDeclarationV1>();
    for (const group of groups.values()) {
        const occurrences = await resolveCurrentClaimablePluginMachineMaterializationsTx({ tx,
            accountId: group.accountId, serverIdentityId: group.homeId, retainedInstallation: options.retainedInstallation,
            targets: group.inputs.map(input => ({ machineId: input.controller!.machineId,
                machineInstallationId: input.controller!.installationId, pluginId: input.provider.pluginId })),
        });
        const current = await resolveCurrentPluginDeclarationsTx({ tx, accountId: group.accountId,
            refs: occurrences.flatMap(occurrence => {
                const ref = { pluginId: occurrence.pluginId, version: occurrence.version,
                    machineId: occurrence.machineId,
                    // Availability admitted these occurrences against the current controller installation above.
                    machineInstallationId: controllers.get(occurrence.machineId)!.installationId! };
                const admittedDeclaration = options.declarationBodies?.get(managedDeclarationBodyKey(group.accountId,
                    currentPluginDeclarationKeyV1(ref.pluginId, ref.version, ref.machineId, ref.machineInstallationId)));
                // A prepared admission never falls back to loading a new body under the fence.
                if (options.declarationBodies && !admittedDeclaration) return [];
                return [{ ...ref, ...(admittedDeclaration ? { admittedDeclaration } : {}) }];
            }) });
        for (const [key, declaration] of current) {
            declarationBodies.set(managedDeclarationBodyKey(group.accountId, key), declaration);
        }
        const byProvider = new Map<string, typeof occurrences[number][]>();
        for (const occurrence of occurrences) {
            const key = JSON.stringify([occurrence.machineId, occurrence.pluginId]);
            const selected = byProvider.get(key) ?? [];
            selected.push(occurrence);
            byProvider.set(key, selected);
        }
        for (const input of group.inputs) {
            let admitted: ManagedDeclaration | null = null;
            for (const occurrence of byProvider.get(JSON.stringify([input.controller!.machineId, input.provider.pluginId])) ?? []) {
                // A retained old installation must not inherit the current schema.
                if (controllers.get(input.controller!.machineId)?.installationId !== input.controller!.installationId) continue;
                const declaration = current.get(currentPluginDeclarationKeyV1(occurrence.pluginId, occurrence.version,
                    input.controller!.machineId, input.controller!.installationId));
                const contribution = declaration?.manifest.contributes?.machineProvisioners?.find(entry => entry.id === input.provider.localId);
                if (!contribution || !declaration) continue;
                const acquireCredentialRequests = resolvePluginActionConnectedAccountUseRequestsV2(declaration.manifest, contribution.actions.acquire);
                if (acquireCredentialRequests) {
                    const acquire = declaration.manifest.contributes?.actions?.find(action => action.id === contribution.actions.acquire);
                    admitted = { ...contribution, acquireCredentialRequests, provisioner: contribution,
                        accountAcquire: acquire?.execution.target === 'account' };
                    break;
                }
            }
            declarations.set(keyOf(input), admitted);
        }
    }
    return { controllers, declarationBodies, declarationFor: input => input.controller ? declarations.get(keyOf(input)) ?? null : null };
}

export async function projectManagedMachineInTx(tx: Tx, row: StoredManagedMachine): Promise<ManagedMachineV1> {
    return (await projectManagedMachinesInTx(tx, [row]))[0];
}

/** Listing retained allocations needs no provider discovery or declaration admission. */
export async function projectManagedMachinesInTx(_tx: Tx, rows: readonly StoredManagedMachine[]): Promise<ManagedMachineV1[]> {
    return rows.map(row => projectManagedMachine(row));
}

export async function readManagedMachineInTx(tx: Tx, input: Readonly<{ homeId: string; managedId: string }>): Promise<StoredManagedMachine> {
    const row = await tx.managedMachine.findFirst({ where: { id: input.managedId, homeId: input.homeId } });
    if (!row) throw new ManagedMachineError("managed_not_found");
    return row;
}

/** Reuse publication's ordered locks; an expanded audience restarts the owning transaction. */
async function fenceManagedMachinePublicationInTx<T extends Readonly<{ accountIds: readonly string[] }>>(
    tx: Tx, read: () => Promise<T>, intent: AccountAdmissionIntent = 'content',
): Promise<T> {
    const captured = await read();
    await acquireAccountChangePublicationLocksInTx(tx, captured.accountIds, { includeSingleAccount: true, intent });
    const current = await read();
    const locked = new Set(captured.accountIds);
    if (current.accountIds.some(accountId => !locked.has(accountId))) {
        throw new TransactionReplayRequiredError('transaction-account-audience-changed');
    }
    beforeAccountChangePublication(tx, captured.accountIds, async () => {
        assertAccountChangePublicationAudienceInTx(tx, (await read()).accountIds);
    });
    return current;
}

/**
 * ReadCommitted writers share the ordered Account publication fence. Discover
 * the audience afresh on each attempt, then recheck it before authority/domain
 * reads; growth replays instead of extending an acquired lock set out of order.
 */
type ManagedPublicationTarget = Readonly<{ homeId: string; managedId: string; nextControllerMachineId?: string }>
    | Readonly<{ controllerMachineId?: string }>;

/** The same pure census serves managed endpoints and ordinary enrollment before Machine writes. */
export async function readManagedMachinePublicationAudienceInTx(tx: Tx, target: ManagedPublicationTarget,
    additionalMachineIds: readonly string[] = []): Promise<string[]> {
    let machineIds: string[];
    let creatorAccountId: string | undefined;
    if (!('managedId' in target)) machineIds = target.controllerMachineId ? [target.controllerMachineId] : [];
    else {
        const row = await readManagedMachineInTx(tx, target);
        creatorAccountId = readManagedAdmissionState(row.admittedInput).enrollmentAccountId ?? row.custodianAccountId;
        machineIds = [row.controllerMachineId, row.enrolledMachineId, target.nextControllerMachineId]
            .filter((id): id is string => typeof id === 'string');
    }
    const audiences = await Promise.all([...new Set([...machineIds, ...additionalMachineIds])]
        .map(machineId => resolveCurrentMachineRecipientAccountIdsInTx(tx, machineId)));
    return [...new Set([...audiences.flat(), ...(creatorAccountId ? [creatorAccountId] : [])])];
}

export async function acquireManagedMachinePublicationAccountsInTx(tx: Tx, target: ManagedPublicationTarget,
    admission?: Readonly<{ intent?: AccountAdmissionIntent; additionalAccountIds?: readonly string[]; additionalMachineIds?: readonly string[] }>,
): Promise<void> {
    await fenceManagedMachinePublicationInTx(tx, async () => ({ accountIds: [
        ...await readManagedMachinePublicationAudienceInTx(tx, target, admission?.additionalMachineIds),
        ...admission?.additionalAccountIds ?? [],
    ] }), admission?.intent);
}

export async function inManagedMachinePublicationTx<T>(
    target: ManagedPublicationTarget,
    write: (tx: Tx) => Promise<T>,
    admission?: Readonly<{ intent: AccountAdmissionIntent; additionalAccountIds?: readonly string[]; transactionClass?: string }>,
): Promise<ResolvedTransactionResult<T>> {
    return inTx(async tx => {
        await acquireManagedMachinePublicationAccountsInTx(tx, target, admission);
        return write(tx);
    }, { transactionClass: admission?.transactionClass });
}

/** The existing unique enrollment association is the ordinary Machine fact owner. */
export async function readMachineDevcontainerChildInTx(tx: Tx, machineId: string): Promise<DevcontainerChildProjectionV1 | null> {
    return (await readMachineDevcontainerChildrenInTx(tx, [machineId])).get(machineId) ?? null;
}

/** Fleet projections use the same current-enrollment authority as point reads. */
export async function readMachineDevcontainerChildrenInTx(tx: Tx, machineIds: readonly string[]): Promise<ReadonlyMap<string, DevcontainerChildProjectionV1 | null>> {
    const rows = await readCurrentMachineManagedEnrollmentsInTx(tx, machineIds);
    return new Map([...rows].map(([machineId, row]) => [machineId, readStoredManagedDevcontainerChild(row)]));
}

async function readCurrentMachineManagedEnrollmentInTx(tx: Tx, machineId: string): Promise<StoredManagedMachine | null> {
    return (await readCurrentMachineManagedEnrollmentsInTx(tx, [machineId])).get(machineId) ?? null;
}

async function readCurrentMachineManagedEnrollmentsInTx(tx: Tx, machineIds: readonly string[]): Promise<ReadonlyMap<string, StoredManagedMachine>> {
    const result = new Map<string, StoredManagedMachine>();
    if (machineIds.length === 0) return result;
    const rows: StoredManagedMachine[] = [];
    for (const ids of portableQueryChunks({ values: [...new Set(machineIds)], bindingsPerValue: 1, fixedBindings: 1 })) {
        rows.push(...await tx.managedMachine.findMany({ where: { enrolledMachineId: { in: [...ids] } } }));
    }
    if (rows.length === 0) return result;
    const homeId = await readCurrentServerIdentityId(process.env, tx);
    const byId = new Map<string, Pick<Prisma.MachineGetPayload<Record<string, never>>, 'id' | 'accountId' | 'revokedAt' | 'replacedByMachineId'>>();
    for (const ids of portableQueryChunks({
        values: rows.flatMap(row => row.enrolledMachineId ? [row.enrolledMachineId] : []), bindingsPerValue: 1, fixedBindings: 1,
    })) {
        const machines = await tx.machine.findMany({ where: { id: { in: [...ids] } },
            select: { id: true, accountId: true, revokedAt: true, replacedByMachineId: true } });
        for (const machine of machines) byId.set(machine.id, machine);
    }
    for (const row of rows) {
        const machine = row.enrolledMachineId ? byId.get(row.enrolledMachineId) : null;
        if (row.homeId === homeId && machine && machine.accountId === readManagedEnrollmentAccountId(row)
            && classifyMachineAvailabilityState(machine) === 'available') result.set(machine.id, row);
    }
    return result;
}

/** A current workspace executes on the admitted Machine's own storage. */
export async function readMachineDevcontainerWorkspaceSyncEndpointInTx(tx: Tx, input: Readonly<{
    accountServerId: string; machineId: string; rootPath: string;
    operation: Readonly<{ actorAccountId: string; rpcMethod: string }> & MachineOperationRequesterContext;
}>): Promise<Readonly<{ custodianAccountId: string; machineId: string; installationId: string }> | null> {
    if (input.accountServerId !== await readCurrentServerIdentityId(process.env, tx)) return null;
    const machine = await tx.machine.findUnique({ where: { id: input.machineId } }).then(decodeMachineStoredContent);
    if (!machine?.installationId || classifyMachineAvailabilityState(machine) !== 'available'
        || !isMachineOperationSupportedForRequester({ ...input.operation, machine })) return null;
    const enrollment = await tx.managedMachine.findUnique({ where: { enrolledMachineId: input.machineId } });
    if (!enrollment) return { custodianAccountId: machine.accountId, machineId: machine.id, installationId: machine.installationId };
    // A stale enrollment is not an ordinary-Machine fallback.
    const row = await readCurrentMachineManagedEnrollmentInTx(tx, input.machineId);
    if (!row || row.homeId !== input.accountServerId) return null;
    const resource = readCurrentStoredManagedResource(row);
    if (!resource) return null;
    return { custodianAccountId: machine.accountId, machineId: machine.id, installationId: machine.installationId };
}

/** Physical workspace routing consumes the retained enrollment/controller fact, never Machine metadata. */
export async function readMachineDevcontainerWorkspaceSyncRouteInTx(tx: Tx, input: Readonly<{
    accountServerId: string; childMachineId: string; childRootPath: string;
    parentMachineId: string; releaseOnly: boolean;
    operation: Readonly<{ actorAccountId: string; rpcMethod: string }> & MachineOperationRequesterContext;
}>): Promise<Readonly<{ custodianAccountId: string; parentMachineId: string; parentInstallationId: string }> | null> {
    if (input.releaseOnly) {
        // Past workspace custody belongs to the parent's existing prepared-operation map.
        // Rebuild may clear enrollment or revoke the borrower's grant before release;
        // this route can only reach commit/abort/release, never a fresh native/copy operation.
        if (input.accountServerId !== await readCurrentServerIdentityId(process.env, tx)) return null;
        const [source, parent] = await Promise.all([
            tx.machine.findUnique({ where: { id: input.childMachineId } }).then(decodeMachineStoredContent),
            tx.machine.findUnique({ where: { id: input.parentMachineId } }).then(decodeMachineStoredContent),
        ]);
        if (!source || !parent
            || classifyMachineAvailabilityState(source) !== 'available'
            || !isMachineOperationSupportedForRequester({ ...input.operation, machine: parent })
            || classifyMachineAvailabilityState(parent) !== 'available' || !parent.installationId) return null;
        if (source.accountId !== parent.accountId) {
            // Foreign physical custody must still be this managed guest's exact
            // controller. Rebuild already retains the former enrollment until
            // its replacement retires the old Machine; no workspace history is
            // needed. The prepared-operation owner checks the original root,
            // operation and caller authority, not the rebuilt resource's root.
            const retained = await tx.managedMachine.findMany({ where: {
                homeId: input.accountServerId, custodianAccountId: parent.accountId,
                controllerMachineId: parent.id, controllerInstallationId: parent.installationId,
                OR: [{ enrolledMachineId: source.id },
                    { admittedInput: jsonPathEquals(['replacementEnrollment', 'machineId'], source.id) }],
            }, select: { admittedInput: true, custodianAccountId: true, enrolledMachineId: true } });
            if (!retained.some(row => readManagedEnrollmentAccountId(row) === source.accountId
                && (row.enrolledMachineId === source.id
                    || readManagedAdmissionState(row.admittedInput).replacementEnrollment?.machineId === source.id))) return null;
        }
        return { custodianAccountId: parent.accountId, parentMachineId: input.parentMachineId,
            parentInstallationId: parent.installationId };
    }
    // Former host-root forwarding cannot admit new filesystem work. Retained
    // prepared operations above may still release their original custody.
    return null;
}

function readCurrentStoredManagedResource(row: StoredManagedMachine): ManagedResourceV1 | null {
    if (row.creationState !== 'active' || row.allocation !== 'bound' || row.archivedAt !== null) return null;
    const resource = createStoredReadSchema(ManagedResourceV1Schema).safeParse(row.resource);
    return resource.success ? resource.data : null;
}

function readStoredManagedDevcontainerChild(row: StoredManagedMachine): DevcontainerChildProjectionV1 | null {
    if (!row.controllerMachineId) return null;
    const resource = readCurrentStoredManagedResource(row);
    if (!resource) return null;
    return deriveManagedDevcontainerChildProjectionV1({ managedMachineId: row.id, controllerMachineId: row.controllerMachineId,
        enrolledMachineId: row.enrolledMachineId ?? undefined, resource }) ?? null;
}

export async function requireCurrentManagedMachineInTx(tx: Tx, input: Readonly<{
    homeId: string; managedId: string; expectedIntentRevision: number; requestId: string;
    controller?: { machineId: string; installationId: string };
}>, options: Readonly<{ requestAuthority?: "creation" | "intent"; allowCanceledResourceReport?: boolean; allowInactiveCurrentIntent?: boolean }> = {}): Promise<StoredManagedMachine> {
    const row = await readManagedMachineInTx(tx, input);
    // Native work was admitted with the controller's then-current authority.
    // Follow-ups prove the retained controller identity below; fresh admission
    // and the signed-request verifier own controller lifecycle, not this check.
    await requireManagedHomeInTx(tx, input.homeId);
    const creation = options.requestAuthority === "creation" || options.allowCanceledResourceReport === true;
    const currentAdmission = !creation && !row.controllerMachineId && input.controller
        ? readManagedAdmissionState(row.admittedInput).currentAdmission : undefined;
    const controller = readManagedController(row)
        ?? (currentAdmission?.kind === 'policy' ? currentAdmission.request.controller : undefined);
    if (!sameManagedInput(controller, input.controller)) {
        throw new ManagedMachineError("controller_retired");
    }
    if ((creation ? row.admittedActionRequestId : readManagedCurrentRequestId(row)) !== input.requestId) throw new ManagedMachineError("request_conflict");
    const retiredCreation = row.creationState !== "active" || row.archivedAt !== null;
    if (!options.allowCanceledResourceReport && !options.allowInactiveCurrentIntent && retiredCreation) throw new ManagedMachineError("enrollment_retired");
    const lateInactiveAllocation = options.allowCanceledResourceReport === true && retiredCreation;
    if (!lateInactiveAllocation && row.intentRevision !== input.expectedIntentRevision) throw new ManagedMachineError("intent_changed");
    if (lateInactiveAllocation && input.expectedIntentRevision > row.intentRevision) throw new ManagedMachineError("intent_changed");
    return row;
}

export function sameManagedInput(left: unknown, right: unknown): boolean {
    return left === undefined || right === undefined ? left === right : pluginJsonValuesEqual(left, right);
}

/** Opaque rows retain bound lifecycle authority without retaining a provider-native identity at Home. */
export function hasBoundManagedLifecycle(row: Pick<StoredManagedMachine, 'presetId' | 'launch' | 'allocation' | 'resource'>): boolean {
    return row.allocation === 'bound' && (isStoredOpaquePresetMachine(row) || row.resource !== null);
}

/** The retained carrier owns whether enrollment compares public native identity or keeps it sealed. */
export function matchesManagedEnrollmentResource(row: Pick<StoredManagedMachine, 'presetId' | 'launch'> & { resource: unknown }, resource: unknown): boolean {
    return isStoredOpaquePresetMachine(row) ? resource === undefined : sameManagedInput(row.resource, resource);
}

/** The digest of the admitted acquisition; historical rows retained it only under their Setup carrier. */
export function readManagedAcquisitionDigest(admitted: StoredManagedAdmission): string | undefined {
    return admitted.requestEnvelopeDigest ?? admitted.machineSetup?.requestEnvelopeDigest;
}

/**
 * Creation Setup children bind the exact admitted acquisition. Like enrollment,
 * an opaque row retains only Setup lifecycle and the sealed preset address:
 * whether the sealed recipe declares Setup is the keyholder's decision, so an
 * unrecorded opaque Setup may still run. Readable rows keep their recorded Setup.
 */
export function readManagedCreationSetup(row: StoredManagedMachine): Readonly<{
    requestEnvelopeDigest: string | undefined;
    state: NonNullable<ManagedMachineV1['machineSetup']>['state'] | undefined;
    runnable: boolean;
    preset: Readonly<{ id: string; revision: number; contentEncryptionMode: 'plain' | 'e2ee' }> | undefined;
}> {
    const machine = projectManagedMachine(row);
    const opaque = isStoredOpaquePresetMachine(row);
    const state = machine.machineSetup?.state;
    const recorded = opaque || machine.machineSetup !== undefined;
    const preset = machine.preset && recorded ? { id: machine.preset.id, revision: machine.preset.revision,
        contentEncryptionMode: machine.preset.contentEncryptionMode } : undefined;
    return { requestEnvelopeDigest: readManagedAcquisitionDigest(readManagedAdmissionState(row.admittedInput)), state,
        runnable: recorded && state !== 'succeeded' && state !== 'skipped', preset };
}

/** The same audience is prepared by enclosing lifecycle mutations before locks. */
export async function readManagedMachinePolicyPublicationAudienceInTx(tx: Tx, row: StoredManagedMachine,
    admittedInput = row.admittedInput) {
    const machineIds = [row.controllerMachineId, row.enrolledMachineId].filter((id): id is string => id !== null);
    const audiences = await readMachineAudienceAccountIdsForMachinesInTx(tx, machineIds);
    const controllerAccountIds = row.controllerMachineId ? audiences.get(row.controllerMachineId) ?? [] : [row.custodianAccountId];
    const candidates = [...new Set([...controllerAccountIds, ...(row.enrolledMachineId ? audiences.get(row.enrolledMachineId) ?? [] : [])])];
    const access = await resolveEffectiveMachineAccessForMachinesInTx(tx, { machineIds, accountIds: candidates });
    const recipients = candidates.filter(accountId => resolveManagedMachineRole(row, accountId,
        row.controllerMachineId ? access.get(row.controllerMachineId)?.get(accountId) ?? null : null,
        row.enrolledMachineId ? access.get(row.enrolledMachineId)?.get(accountId) ?? null : null));
    const creatorAccountId = readManagedAdmissionState(admittedInput).enrollmentAccountId;
    return { controllerAccountIds,
        resourceAccountIds: [...new Set([...recipients, ...(creatorAccountId ? [creatorAccountId] : [])])] };
}

export async function invalidateManagedMachineInTx(tx: Tx, row: StoredManagedMachine): Promise<void> {
    const { controllerAccountIds, resourceAccountIds, controllerReplaced, children } = await fenceManagedMachinePublicationInTx(tx, async () => {
        const fresh = await tx.managedMachine.findUnique({ where: { id: row.id } });
        const { controllerAccountIds, resourceAccountIds } = await readManagedMachinePolicyPublicationAudienceInTx(tx, row,
            fresh ? fresh.admittedInput : row.admittedInput);
        const previous = readStoredManagedDevcontainerChild(row);
        const machineIds = new Set([row.enrolledMachineId, fresh?.enrolledMachineId].filter((id): id is string => typeof id === 'string'));
        const enrollmentChanged = row.enrolledMachineId !== (fresh?.enrolledMachineId ?? null);
        const observedMachines = enrollmentChanged ? await tx.machine.findMany({ where: { id: { in: [...machineIds] } },
            select: { id: true, managedResource: { select: { id: true, homeId: true } } } }) : [];
        const enrollmentReferences = new Map(observedMachines.map(machine => [machine.id, serializeManagedMachineRef(machine)]));
        const [beforeWakeProjection, currentWakeProjection] = await withManagedWakeAvailabilityInTx(tx,
            [{ managedResource: row }, { managedResource: fresh }]);
        const children: Array<{ machineId: string; child: Awaited<ReturnType<typeof readMachineDevcontainerChildInTx>>;
            managedMachineRef?: ReturnType<typeof serializeManagedMachineRef>;
            managedInputRuntime: ReturnType<typeof serializeManagedInputRuntime>; accountIds: string[] }> = [];
        for (const machineId of machineIds) {
            const child = await readMachineDevcontainerChildInTx(tx, machineId);
            const before = row.enrolledMachineId === machineId ? previous : null;
            const beforeWake = serializeManagedInputRuntime({ id: machineId, ...beforeWakeProjection });
            const managedInputRuntime = serializeManagedInputRuntime({ id: machineId, ...currentWakeProjection });
            if (!enrollmentReferences.has(machineId) && pluginJsonValuesEqual(beforeWake, managedInputRuntime)
                && managedDevcontainerChildProjectionsEqualV1(before ?? undefined, child ?? undefined)) continue;
            children.push({ machineId, child, managedInputRuntime, ...(enrollmentReferences.has(machineId) ? { managedMachineRef: enrollmentReferences.get(machineId) } : {}),
                accountIds: await resolveCurrentMachineRecipientAccountIdsInTx(tx, machineId) });
        }
        return { accountIds: [...resourceAccountIds, ...children.flatMap(child => child.accountIds)], controllerAccountIds, resourceAccountIds,
            controllerReplaced: fresh !== null && fresh.controllerMachineId !== row.controllerMachineId, children };
    });
    await markAccountsChanged(tx, { accountIds: resourceAccountIds, kind: "account", entityId: row.id,
        hint: { managedMachinePolicy: true, ...(row.controllerMachineId ? { machineId: row.controllerMachineId } : {}) } satisfies ManagedMachinePolicyChangeHintV1 });
    // Old/new controller publications coalesce at the same Account-row key.
    // Retain the former controller's retirement wake under its own Machine key.
    if (controllerReplaced && row.controllerMachineId) await markAccountsChanged(tx, {
        accountIds: controllerAccountIds, kind: 'machine', entityId: row.controllerMachineId,
    });
    for (const { machineId, child, managedMachineRef, managedInputRuntime, accountIds: childAccountIds } of children) {
        const cursors = await markAccountsChanged(tx, { accountIds: childAccountIds, kind: 'machine', entityId: machineId });
        for (const publication of cursors) {
            const { accountId } = publication;
            const access = await resolveMachineAccessInTx(tx, { actorAccountId: accountId, machineId });
            const devcontainerChild = access?.accessState === 'ready' ? child : null;
            afterTx(tx, () => eventRouter.emitUpdate({ userId: accountId,
                payload: buildUpdateMachineUpdate(machineId, publication.resolveCursor(), randomKeyNaked(12), undefined, undefined, {
                    devcontainerChild, managedInputRuntime, ...(managedMachineRef !== undefined ? { managedMachineRef } : {}),
                }),
                recipientFilter: { type: 'machine-scoped-only', machineId } }));
        }
    }
}
