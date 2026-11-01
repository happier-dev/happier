import type { ManagedControllerV1 } from '@happier-dev/protocol/machines/managed/managedMachineV1';
import type { Prisma } from "@prisma/client";
import * as z from "zod/mini";
import { createStoredReadSchema } from '@happier-dev/protocol/json/storedReadSchema';
import { StrictJsonValueSchema } from '@happier-dev/protocol/json/strictJsonValue';
import { createManagedMachineV1Schema, ManagedMachineV1Schema, RetainedManagedLaunchSnapshotV1Schema, type ManagedMachineV1, type ValidatedLaunchSnapshotV1, type RetainedManagedLaunchSnapshotV1 } from '@happier-dev/protocol/machines/managed/managedMachineV1';
import { ManagedAdmissionComputeInputV1Schema, ManagedControllerCurrentnessV1Schema, ManagedControlAdmissionInputV1Schema } from '@happier-dev/protocol/machines/managed/actionsV1';
import { ManagedPolicyAdmissionInputV1Schema, type ManagedMachinePolicyChangeHintV1 } from '@happier-dev/protocol/machines/managed/managedPolicyV1';
import { SupportedNativeIntentSchema, ManagedResourceV1Schema } from '@happier-dev/protocol/machines/managed/providerFactsV1';
import { deriveManagedDevcontainerChildProjectionV1, type DevcontainerChildProjectionV1, managedDevcontainerChildProjectionsEqualV1 } from '@happier-dev/protocol/machines/managed/devcontainerV1';
import { resolvePluginActionConnectedAccountUseRequestsV2, type PluginActionConnectedAccountUseRequestV2 } from "@happier-dev/protocol/plugins/manifest/v2";
import { SubmittedNativeEffectV1Schema } from "@happier-dev/protocol/machines/managed/managedMachineV1";
import type { MachineProvisionerContributionV1 } from "@happier-dev/protocol/plugins/contributions/machineProvisioners";
import type { PluginJsonSchemaV2 } from "@happier-dev/protocol/plugins/contributions/jsonSchema";
import { createPluginJsonSchemaZodValueAdapter } from "@happier-dev/protocol/plugins/actions/json-schema-validation";
import { pluginJsonValuesEqual } from "@happier-dev/protocol/plugins/actions/protocol-composable-schema";
import { acquireAccountChangePublicationLocksInTx, assertAccountChangePublicationAudienceInTx, beforeAccountChangePublication, markAccountsChanged } from "@/app/changes/markAccountChanged";
import { resolveCurrentMachineRecipientAccountIdsInTx, resolveMachineAccessInTx, resolveEffectiveMachineRoleInTx } from "@/app/machines/machineAccess";
import { readCurrentServerIdentityId } from "@/app/serverIdentity/serverIdentity";
import { classifyMachineAvailabilityState } from "@/app/machines/machineStateGuards";
import { resolveCurrentClaimablePluginMachineMaterializationsTx } from "@/app/plugins/availability/operations";
import { resolveCurrentPluginDeclarationTx } from "@/app/plugins/availability/currentDeclaration";
import { afterTx, inTx, TransactionReplayRequiredError, type ResolvedTransactionResult, type Tx } from "@/storage/inTx";
import { buildUpdateMachineUpdate, eventRouter } from '@/app/events/eventRouter';
import { randomKeyNaked } from '@/utils/keys/randomKeyNaked';
import { portableQueryChunks } from '@/storage/portableQueryChunks';

export type StoredManagedMachine = Prisma.ManagedMachineGetPayload<Record<string, never>>;
/** The persisted pair is absent for Account-controlled cloud resources. */
export function readManagedController(row: Readonly<{ controllerMachineId: string | null; controllerInstallationId: string | null }>): ManagedControllerV1 | undefined {
    return row.controllerMachineId && row.controllerInstallationId
        ? { machineId: row.controllerMachineId, installationId: row.controllerInstallationId } : undefined;
}

/** Vendor control belongs to custody when no actual controller was selected. */
export function resolveManagedMachineRole(row: Pick<StoredManagedMachine, 'custodianAccountId' | 'controllerMachineId'>,
    actorAccountId: string, controllerRole: 'manage' | 'use' | null = null): 'manage' | 'use' | null {
    return row.controllerMachineId === null ? row.custodianAccountId === actorAccountId ? 'manage' : null : controllerRole;
}
export async function resolveManagedMachineRoleInTx(tx: Tx, row: Pick<StoredManagedMachine, 'custodianAccountId' | 'controllerMachineId'>, actorAccountId: string) {
    const role = row.controllerMachineId ? await resolveEffectiveMachineRoleInTx(tx, { actorAccountId, machineId: row.controllerMachineId }) : null;
    return resolveManagedMachineRole(row, actorAccountId, role);
}


export type ManagedDeclaration = Pick<MachineProvisionerContributionV1, "resourceKind" | "actions" | "schemaVersion" | "launchSchema" | "resourceSchema" | "billing" | "retention" | "reconciliation" | "credentialPurposeRequirements"> & Readonly<{
    acquireCredentialRequests: readonly PluginActionConnectedAccountUseRequestV2[];
}>;
export function createManagedMachineDeclaredSchema(launch: PluginJsonSchemaV2, native: PluginJsonSchemaV2, nativeOperation?: PluginJsonSchemaV2) {
    return createManagedMachineV1Schema(createPluginJsonSchemaZodValueAdapter(launch), createPluginJsonSchemaZodValueAdapter(native),
        nativeOperation ? createPluginJsonSchemaZodValueAdapter(nativeOperation) : undefined);
}
export function readManagedLaunchSnapshot(value: unknown): RetainedManagedLaunchSnapshotV1 {
    return createStoredReadSchema(RetainedManagedLaunchSnapshotV1Schema).parse(value);
}
export class ManagedMachineError extends Error {
    constructor(readonly code: "invalid_request" | "permission_denied" | "admission_unavailable" | "acquisition_disabled" | "controller_unavailable" | "controller_retired" | "credential_unavailable" | "provider_unavailable" | "request_conflict" | "intent_changed" | "managed_not_found" | "enrollment_retired" | "resource_mismatch" | "preset_not_found" | "preset_archived" | "preset_limit_reached") {
        super(code);
    }
}

/** Exact raw-row CAS retains unknown stored members rather than the read projection. */
export function readManagedJsonEqualityOperand(value: unknown): Prisma.InputJsonValue {
    const parsed = StrictJsonValueSchema.safeParse(value);
    if (!parsed.success || parsed.data === null) throw new ManagedMachineError("request_conflict");
    return parsed.data;
}

// One private row contains immutable acquisition identity, current intent admission,
// and the independently outstanding native effect. Request bodies keep their
// canonical owners; this stored envelope is not another admission parser.
const StoredManagedAdmissionSchema = z.strictObject({
    computeInput: z.optional(ManagedAdmissionComputeInputV1Schema),
    continuation: z.optional(z.nullable(z.strictObject({ requestEnvelopeDigest: z.string().check(z.minLength(1)) }))),
    environmentSetup: z.optional(z.strictObject({ requestEnvelopeDigest: z.string().check(z.minLength(1)) })),
    currentAdmission: z.optional(z.discriminatedUnion("kind", [
        z.strictObject({ kind: z.literal("control"), request: ManagedControlAdmissionInputV1Schema,
            rebuildSettled: z.optional(z.literal(true)) }),
        z.strictObject({ kind: z.literal("policy"), request: ManagedPolicyAdmissionInputV1Schema }),
    ])),
    submittedEffect: z.optional(z.strictObject({ ...ManagedControllerCurrentnessV1Schema.shape, intent: SupportedNativeIntentSchema,
        reviewedEffectDigest: SubmittedNativeEffectV1Schema.def.shape.reviewedEffectDigest })),
    replacementEnrollment: z.optional(z.strictObject({ machineId: z.string().check(z.minLength(1)) })),
});
const StoredManagedAdmissionReadSchema = createStoredReadSchema(StoredManagedAdmissionSchema);
export function readManagedAdmissionState(value: unknown) {
    const parsed = StoredManagedAdmissionReadSchema.safeParse(value);
    if (!parsed.success) throw new ManagedMachineError("request_conflict");
    return parsed.data;
}
export function readManagedAcquisitionIdentity(value: unknown) {
    const { computeInput, continuation } = readManagedAdmissionState(value);
    return { computeInput, continuation };
}
export function readManagedCurrentRequestId(row: Pick<StoredManagedMachine, "admittedInput" | "admittedActionRequestId">): string {
    return readManagedAdmissionState(row.admittedInput).currentAdmission?.request.requestId ?? row.admittedActionRequestId;
}

/** Home identity and controller lifecycle are rechecked inside each row mutation. */
export async function requireManagedControllerInTx(tx: Tx, input: Readonly<{
    homeId: string; custodianAccountId: string; controller?: { machineId: string; installationId: string };
}>): Promise<void> {
    if (await readCurrentServerIdentityId(process.env, tx) !== input.homeId) throw new ManagedMachineError("permission_denied");
    if (!input.controller) return;
    const machine = await tx.machine.findUnique({ where: { id: input.controller.machineId } });
    if (!machine || machine.accountId !== input.custodianAccountId) throw new ManagedMachineError("permission_denied");
    if (classifyMachineAvailabilityState(machine) !== "available" || machine.installationId !== input.controller.installationId) {
        throw new ManagedMachineError("controller_retired");
    }
}

/** Consume the incumbent current declaration/materialization owners, never a provider registry. */
export async function resolveManagedDeclarationInTx(tx: Tx, input: Readonly<{
    homeId: string; custodianAccountId: string; controller: { machineId: string; installationId: string };
    provider: ValidatedLaunchSnapshotV1["provider"];
}>): Promise<ManagedDeclaration | null> {
    const occurrences = await resolveCurrentClaimablePluginMachineMaterializationsTx({
        tx, accountId: input.custodianAccountId, serverIdentityId: input.homeId,
        machineId: input.controller.machineId, machineInstallationId: input.controller.installationId,
        pluginId: input.provider.pluginId,
    });
    for (const occurrence of occurrences) {
        const declaration = await resolveCurrentPluginDeclarationTx({ tx, accountId: input.custodianAccountId, pluginId: occurrence.pluginId, version: occurrence.version });
        const contribution = declaration?.manifest.contributes?.machineProvisioners?.find((entry) => entry.id === input.provider.localId);
        if (contribution && declaration) {
            const acquireCredentialRequests = resolvePluginActionConnectedAccountUseRequestsV2(declaration.manifest, contribution.actions.acquire);
            if (acquireCredentialRequests) return { ...contribution, acquireCredentialRequests };
        }
    }
    return null;
}

/** The canonical stored projection drops extras using the declared native/launch schemas. */
export function projectManagedMachine(row: StoredManagedMachine, declaration?: ManagedDeclaration | null): ManagedMachineV1 {
    const submitted = readManagedAdmissionState(row.admittedInput).submittedEffect;
    const resource = row.resource === null ? undefined : createStoredReadSchema(ManagedResourceV1Schema).parse(row.resource);
    const devcontainerChild = deriveManagedDevcontainerChildProjectionV1({ managedMachineId: row.id,
        controllerMachineId: row.controllerMachineId, enrolledMachineId: row.enrolledMachineId ?? undefined, resource });
    const value = {
        id: row.id, homeId: row.homeId, custodianAccountId: row.custodianAccountId,
        ...(row.presetId && row.presetRevision !== null ? { preset: { id: row.presetId, revision: row.presetRevision } } : {}),
        launch: row.launch, controller: { machineId: row.controllerMachineId, installationId: row.controllerInstallationId },
        ...(row.reviewedFacts !== null ? { reviewedFacts: row.reviewedFacts } : {}),
        ...(row.environmentSetup !== null ? { environmentSetup: row.environmentSetup } : {}),
        allocation: row.allocation, creationState: row.creationState,
        ...(resource ? { resource } : {}),
        ...(devcontainerChild ? { devcontainerChild } : {}),
        ...(row.nativeOperationRef !== null ? { nativeOperationRef: row.nativeOperationRef } : {}),
        ...(row.recovery !== null ? { recovery: row.recovery } : {}),
        ...(row.bootstrapCredentialRef !== null ? { bootstrapCredentialRef: row.bootstrapCredentialRef } : {}),
        ...(row.enrolledMachineId !== null ? { enrolledMachineId: row.enrolledMachineId } : {}),
        desired: row.desired, desiredWhen: row.desiredWhen,
        ...(row.desiredAfterMs !== null ? { desiredAfterMs: Number(row.desiredAfterMs) } : {}),
        intentRevision: row.intentRevision,
        ...(submitted ? { submittedNativeEffect: { intentRevision: submitted.expectedIntentRevision, requestId: submitted.requestId,
            intent: submitted.intent, controller: submitted.controller,
            ...(submitted.reviewedEffectDigest ? { reviewedEffectDigest: submitted.reviewedEffectDigest } : {}) } } : {}),
        ...(row.archivedAt !== null ? { archivedAt: row.archivedAt.getTime() } : {}),
        retention: row.retention, wakeOnAcceptedMessage: row.wakeOnAcceptedMessage,
        ...(row.observation !== null ? { observation: row.observation } : {}),
        ...(row.cleanup !== null ? { cleanup: row.cleanup } : {}),
    };
    const schema = declaration
        ? createManagedMachineDeclaredSchema(declaration.launchSchema, declaration.resourceSchema, declaration.reconciliation?.nativeOperationSchema)
        : ManagedMachineV1Schema;
    return ManagedMachineV1Schema.parse(createStoredReadSchema(schema).parse(value));
}
export async function projectManagedMachineInTx(tx: Tx, row: StoredManagedMachine): Promise<ManagedMachineV1> {
    return (await projectManagedMachinesInTx(tx, [row]))[0];
}

/** Resolve each controller/provider once within this projection's coherent read view. */
export async function projectManagedMachinesInTx(tx: Tx, rows: readonly StoredManagedMachine[]): Promise<ManagedMachineV1[]> {
    const declarations = new Map<string, ManagedDeclaration | null>();
    const machines: ManagedMachineV1[] = [];
    for (const row of rows) {
        const launch = readManagedLaunchSnapshot(row.launch);
        const key = JSON.stringify([row.homeId, row.custodianAccountId, row.controllerMachineId,
            row.controllerInstallationId, launch.provider.pluginId, launch.provider.localId]);
        if (!declarations.has(key)) {
            declarations.set(key, await resolveManagedDeclarationInTx(tx, {
                homeId: row.homeId, custodianAccountId: row.custodianAccountId,
                controller: { machineId: row.controllerMachineId, installationId: row.controllerInstallationId }, provider: launch.provider,
            }));
        }
        const declaration = declarations.get(key);
        machines.push(projectManagedMachine(row, declaration?.schemaVersion === launch.schemaVersion ? declaration : null));
    }
    return machines;
}

export async function readManagedMachineInTx(tx: Tx, input: Readonly<{ homeId: string; managedId: string }>): Promise<StoredManagedMachine> {
    const row = await tx.managedMachine.findFirst({ where: { id: input.managedId, homeId: input.homeId } });
    if (!row) throw new ManagedMachineError("managed_not_found");
    return row;
}

/** Reuse publication's ordered locks; an expanded audience restarts the owning transaction. */
async function fenceManagedMachinePublicationInTx<T extends Readonly<{ accountIds: readonly string[] }>>(
    tx: Tx, read: () => Promise<T>, intent: 'content' | 'exclusive' = 'content',
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
    | Readonly<{ controllerMachineId: string }>;

/** The same pure census serves managed endpoints and ordinary enrollment before Machine writes. */
export async function readManagedMachinePublicationAudienceInTx(tx: Tx, target: ManagedPublicationTarget,
    additionalMachineIds: readonly string[] = []): Promise<string[]> {
    let machineIds: string[];
    if ('controllerMachineId' in target) machineIds = [target.controllerMachineId];
    else {
        const row = await readManagedMachineInTx(tx, target);
        machineIds = [row.controllerMachineId, row.enrolledMachineId, target.nextControllerMachineId]
            .filter((id): id is string => typeof id === 'string');
    }
    const audiences = await Promise.all([...new Set([...machineIds, ...additionalMachineIds])]
        .map(machineId => resolveCurrentMachineRecipientAccountIdsInTx(tx, machineId)));
    return [...new Set(audiences.flat())];
}

export async function acquireManagedMachinePublicationAccountsInTx(tx: Tx, target: ManagedPublicationTarget,
    admission?: Readonly<{ intent?: 'content' | 'exclusive'; additionalAccountIds?: readonly string[]; additionalMachineIds?: readonly string[] }>,
): Promise<void> {
    await fenceManagedMachinePublicationInTx(tx, async () => ({ accountIds: [
        ...await readManagedMachinePublicationAudienceInTx(tx, target, admission?.additionalMachineIds),
        ...admission?.additionalAccountIds ?? [],
    ] }), admission?.intent);
}

export async function inManagedMachinePublicationTx<T>(
    target: ManagedPublicationTarget,
    write: (tx: Tx) => Promise<T>,
    admission?: Readonly<{ intent: 'content' | 'exclusive'; additionalAccountIds?: readonly string[] }>,
): Promise<ResolvedTransactionResult<T>> {
    return inTx(async tx => {
        await acquireManagedMachinePublicationAccountsInTx(tx, target, admission);
        return write(tx);
    });
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
        if (row.homeId === homeId && machine && machine.accountId === row.custodianAccountId
            && classifyMachineAvailabilityState(machine) === 'available') result.set(machine.id, row);
    }
    return result;
}

/** A current workspace executes on its bind controller, or on the admitted Machine's own storage. */
export async function readMachineDevcontainerWorkspaceSyncEndpointInTx(tx: Tx, input: Readonly<{
    accountServerId: string; machineId: string; rootPath: string;
}>): Promise<Readonly<{ custodianAccountId: string; machineId: string; installationId: string }> | null> {
    if (input.accountServerId !== await readCurrentServerIdentityId(process.env, tx)) return null;
    const machine = await tx.machine.findUnique({ where: { id: input.machineId } });
    if (!machine?.installationId || classifyMachineAvailabilityState(machine) !== 'available') return null;
    const enrollment = await tx.managedMachine.findUnique({ where: { enrolledMachineId: input.machineId } });
    if (!enrollment) return { custodianAccountId: machine.accountId, machineId: machine.id, installationId: machine.installationId };
    // A stale or malformed retained row is not an ordinary-Machine fallback.
    const row = await readCurrentMachineManagedEnrollmentInTx(tx, input.machineId);
    if (!row || row.homeId !== input.accountServerId) return null;
    const child = readStoredManagedDevcontainerChild(row);
    if (!child || child.observation.storage.childPath !== input.rootPath) return null;
    if (child.observation.storage.kind === 'child') {
        return { custodianAccountId: machine.accountId, machineId: machine.id, installationId: machine.installationId };
    }
    const parent = await tx.machine.findUnique({ where: { id: row.controllerMachineId } });
    if (!parent || parent.accountId !== row.custodianAccountId
        || classifyMachineAvailabilityState(parent) !== 'available'
        || parent.installationId !== row.controllerInstallationId) return null;
    return { custodianAccountId: row.custodianAccountId, machineId: parent.id, installationId: row.controllerInstallationId };
}

/** Physical workspace routing consumes the retained enrollment/controller fact, never Machine metadata. */
export async function readMachineDevcontainerWorkspaceSyncRouteInTx(tx: Tx, input: Readonly<{
    accountServerId: string; childMachineId: string; childRootPath: string;
    parentMachineId: string; releaseOnly: boolean;
}>): Promise<Readonly<{ custodianAccountId: string; parentMachineId: string; parentInstallationId: string }> | null> {
    if (input.releaseOnly) {
        // Past workspace custody belongs to the parent's existing prepared-operation map.
        // Rebuild may clear enrollment or revoke the borrower's grant before release;
        // this route can only reach commit/abort, never a fresh native/copy operation.
        if (input.accountServerId !== await readCurrentServerIdentityId(process.env, tx)) return null;
        const [source, parent] = await Promise.all([
            tx.machine.findUnique({ where: { id: input.childMachineId } }),
            tx.machine.findUnique({ where: { id: input.parentMachineId } }),
        ]);
        if (!source || !parent || source.accountId !== parent.accountId
            || classifyMachineAvailabilityState(source) !== 'available'
            || classifyMachineAvailabilityState(parent) !== 'available' || !parent.installationId) return null;
        return { custodianAccountId: source.accountId, parentMachineId: input.parentMachineId,
            parentInstallationId: parent.installationId };
    }
    const endpoint = await readMachineDevcontainerWorkspaceSyncEndpointInTx(tx, {
        accountServerId: input.accountServerId, machineId: input.childMachineId, rootPath: input.childRootPath });
    if (!endpoint || endpoint.machineId === input.childMachineId || endpoint.machineId !== input.parentMachineId) return null;
    return { custodianAccountId: endpoint.custodianAccountId, parentMachineId: endpoint.machineId,
        parentInstallationId: endpoint.installationId };
}

function readStoredManagedDevcontainerChild(row: StoredManagedMachine): DevcontainerChildProjectionV1 | null {
    if (row.creationState !== 'active' || row.allocation !== 'bound' || row.archivedAt !== null) return null;
    const resource = createStoredReadSchema(ManagedResourceV1Schema).safeParse(row.resource);
    if (!resource.success) return null;
    return deriveManagedDevcontainerChildProjectionV1({ managedMachineId: row.id, controllerMachineId: row.controllerMachineId,
        enrolledMachineId: row.enrolledMachineId ?? undefined, resource: resource.data }) ?? null;
}

export async function requireCurrentManagedMachineInTx(tx: Tx, input: Readonly<{
    homeId: string; managedId: string; expectedIntentRevision: number; requestId: string;
    controller?: { machineId: string; installationId: string };
}>, options: Readonly<{ requestAuthority?: "creation" | "intent"; allowCanceledResourceReport?: boolean; allowInactiveCurrentIntent?: boolean }> = {}): Promise<StoredManagedMachine> {
    const row = await readManagedMachineInTx(tx, input);
    await requireManagedControllerInTx(tx, { ...input, custodianAccountId: row.custodianAccountId });
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

export async function invalidateManagedMachineInTx(tx: Tx, row: StoredManagedMachine): Promise<void> {
    const { controllerAccountIds, controllerReplaced, children } = await fenceManagedMachinePublicationInTx(tx, async () => {
        const controllerAccountIds = await resolveCurrentMachineRecipientAccountIdsInTx(tx, row.controllerMachineId);
        const fresh = await tx.managedMachine.findUnique({ where: { id: row.id } });
        const previous = readStoredManagedDevcontainerChild(row);
        const machineIds = new Set([row.enrolledMachineId, fresh?.enrolledMachineId].filter((id): id is string => typeof id === 'string'));
        const children: Array<{ machineId: string; child: Awaited<ReturnType<typeof readMachineDevcontainerChildInTx>>; accountIds: string[] }> = [];
        for (const machineId of machineIds) {
            const child = await readMachineDevcontainerChildInTx(tx, machineId);
            const before = row.enrolledMachineId === machineId ? previous : null;
            if (managedDevcontainerChildProjectionsEqualV1(before ?? undefined, child ?? undefined)) continue;
            children.push({ machineId, child, accountIds: await resolveCurrentMachineRecipientAccountIdsInTx(tx, machineId) });
        }
        return { accountIds: [...controllerAccountIds, ...children.flatMap(child => child.accountIds)], controllerAccountIds,
            controllerReplaced: fresh !== null && fresh.controllerMachineId !== row.controllerMachineId, children };
    });
    await markAccountsChanged(tx, { accountIds: controllerAccountIds, kind: "account", entityId: row.id,
        hint: { managedMachinePolicy: true, machineId: row.controllerMachineId } satisfies ManagedMachinePolicyChangeHintV1 });
    // Old/new controller publications coalesce at the same Account-row key.
    // Retain the former controller's retirement wake under its own Machine key.
    if (controllerReplaced) await markAccountsChanged(tx, {
        accountIds: controllerAccountIds, kind: 'machine', entityId: row.controllerMachineId,
    });
    for (const { machineId, child, accountIds: childAccountIds } of children) {
        const cursors = await markAccountsChanged(tx, { accountIds: childAccountIds, kind: 'machine', entityId: machineId });
        for (const publication of cursors) {
            const { accountId } = publication;
            const access = await resolveMachineAccessInTx(tx, { actorAccountId: accountId, machineId });
            const devcontainerChild = access?.accessState === 'ready' ? child : null;
            afterTx(tx, () => eventRouter.emitUpdate({ userId: accountId,
                payload: buildUpdateMachineUpdate(machineId, publication.resolveCursor(), randomKeyNaked(12), undefined, undefined, { devcontainerChild }),
                recipientFilter: { type: 'machine-scoped-only', machineId } }));
        }
    }
}
