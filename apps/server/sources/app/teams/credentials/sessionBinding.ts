import { SessionTeamCredentialBindingIntentsV1Schema, encodeSessionTeamCredentialSlotKeyV1, type SessionTeamCredentialBindingIntentListV1, type SessionTeamCredentialSlotV1 } from '@happier-dev/protocol/teams/credentials/sessionBindingIntentV1';
import { randomBytes, randomUUID, createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { readManagedNativeCredentialTargetInTx } from '@/app/machines/managed/credentialDeliveryAdmission';
import { StoredSessionTeamCredentialNativeSelectionV1Schema, readSessionTeamCredentialNativeSelectionInTx, readSessionTeamCredentialNativeDeliveryRow,
    readSessionTeamCredentialNativeDeliveryInTx, readSessionTeamCredentialNativeSelectionsForManagedMachineInTx,
    type StoredSessionTeamCredentialNativeSelectionV1,
    type SessionTeamCredentialNativeSelectionBinding, type SessionTeamCredentialNativeDeliveryBinding } from './nativeDeliveryRead';
import type { ManagedCredentialInstallInputV1 } from '@happier-dev/protocol/machines/managed/actionsV1';
import { admitTeamCredentialSourceModelRowsV1 } from '@happier-dev/protocol/rpc/providers';
import { projectProviderBindingAuthorizationTicketReferenceV1 } from '@happier-dev/protocol/providers/grants/v1';
import { TeamCredentialRequestPolicyV1Schema } from '@happier-dev/protocol/teams/credentials/resourceV1';
import { projectTeamCredentialProviderModels } from './providerModelProjection';
import { type SessionTeamCredentialBindingRejectionV1 } from '@happier-dev/protocol/teams/credentials/sessionBindingV1';
import { type TeamCredentialRouteV1 } from '@happier-dev/protocol/teams/credentials/resourceV1';
import { type TeamCredentialSourceBindingV1 } from '@happier-dev/protocol/teams/credentials/sourceBindingV1';
import { readTeamCredentialSourceBinding } from './sourceBindingRead';
import type { RequiredSessionTeamCredentialV1, SessionTeamCredentialBindingConsequenceV1 } from '@happier-dev/protocol/sessions/access/sessionAccessOperationsV1';
import type { Tx } from "@/storage/inTx";
import { getDbProviderFromEnv } from "@/storage/prisma";
import { portableQueryChunks } from "@/storage/portableQueryChunks";
import { isServerFeatureEnabledForHome } from "@/app/features/catalog/serverFeatureGate";
import { assertSessionTeamReadableGrantInTx, SESSION_ACCESS_SESSION_BATCH_SIZE } from "@/app/session/access/sessionAccess";
import { putSessionAccessGrantInTx, sessionAccessGrantMutationCursorLockOptions } from "@/app/session/access/sessionAccessGrantService";
import { acquireSessionAccessTransitionCursorLocksInTx } from "@/app/session/access/sessionAccessTransitionEffects";
import {
    qualifySessionTeamAuthenticationInTx,
    type SessionAccessAuthentication,
} from "@/app/session/access/sessionAccessAuthentication";
import { resolveTeamCredentialBrokerMachineForSaveInTx } from "./brokerMachineEligibility";
import {
    readTeamCredentialBrokerPlacement,
    resolveTeamCredentialBrokerPlacementFingerprint,
    admitTeamCredentialBrokerMachineForResourceInTx,
    admitTeamCredentialBrokerPoolForBrokeredUseInTx,
    type TeamCredentialBrokerPlacementSelection,
} from "./brokerPlacementResolver";
import { resolveTeamCredentialEntitlementInTx, type TeamCredentialEntitlementDecision } from "./resourceAccess";
import { resolveTeamCredentialResourceSourceInTx, type TeamCredentialResourceSourceResolution } from "./resourceSourceResolver";
import type { ExternalActionExecutionAuthorizationBindingV1 } from '@happier-dev/protocol/actions/externalActionApi';
import { publishNativeCredentialPolicyChangesInTx } from './nativePolicyChanges';

export type SessionTeamCredentialBindingRejection =
    SessionTeamCredentialBindingRejectionV1;

export type SessionTeamCredentialBindingWriteResult =
    | Readonly<{ ok: true }>
    | Readonly<{ ok: false; reason: SessionTeamCredentialBindingRejection }>;

function key(slot: SessionTeamCredentialSlotV1): Uint8Array {
    return encodeSessionTeamCredentialSlotKeyV1(slot);
}

function persistedSlotKind(slot: SessionTeamCredentialSlotV1, deliveryMode: TeamCredentialRouteV1): string {
    return `${slot.kind}:${deliveryMode}`;
}

/** Persist accepted Session selection intent in the same transaction as its owner. */
export async function writeSessionTeamCredentialBindingsInTx(
    tx: Tx,
    input: Readonly<{
        sessionId: string;
        accountId: string;
        intents: unknown;
        authentication: SessionAccessAuthentication | undefined;
        /** Verified ordinary Session birth context, never copied from Session input. */
        creationAuthorization?: ExternalActionExecutionAuthorizationBindingV1;
        teamVisibilityGrantConsent?: Readonly<{ teamId: string }>;
        /** Agent cutover owns the complete target witness set, including an empty set. */
        replaceExisting?: boolean;
    }>,
): Promise<SessionTeamCredentialBindingWriteResult> {
    const parsed = SessionTeamCredentialBindingIntentsV1Schema.safeParse(input.intents);
    if (!parsed.success || !input.sessionId) return { ok: false, reason: "invalid_input" };
    return writeParsedSessionTeamCredentialBindingsInTx(tx, {
        sessionId: input.sessionId,
        accountId: input.accountId,
        intents: parsed.data,
        authentication: input.authentication,
        creationAuthorization: input.creationAuthorization,
        teamVisibilityGrantConsent: input.teamVisibilityGrantConsent,
        replaceExisting: input.replaceExisting,
    });
}

export async function writeParsedSessionTeamCredentialBindingsInTx(
    tx: Tx,
    input: Readonly<{
        sessionId: string;
        accountId: string;
        intents: SessionTeamCredentialBindingIntentListV1;
        authentication: SessionAccessAuthentication | undefined;
        creationAuthorization?: ExternalActionExecutionAuthorizationBindingV1;
        teamVisibilityGrantConsent?: Readonly<{ teamId: string }>;
        replaceExisting?: boolean;
    }>,
): Promise<SessionTeamCredentialBindingWriteResult> {
    // Retiring all authority during cutover remains valid with the feature off.
    if (!(input.replaceExisting && input.intents.length === 0)
        && !await isServerFeatureEnabledForHome("teams.credentialResources", { tx })) {
        return { ok: false, reason: "feature_disabled" };
    }
    const owner = await tx.session.findUnique({
        where: { id: input.sessionId },
        select: { accountId: true },
    });
    if (!owner) return { ok: false, reason: "session_missing" };
    if (owner.accountId !== input.accountId) return { ok: false, reason: "session_owner_mismatch" };
    const existingNative = await readSessionTeamCredentialNativeSelectionInTx(tx, { sessionId: input.sessionId });
    const replacement = input.intents.find(intent => intent.slot.kind === 'provider_model');
    const reuseNative = existingNative.ok && replacement !== undefined && replacement.resourceId !== null
        && replacement.deliveryMode === 'vendor-native' && replacement.resourceId === existingNative.binding.resourceId
        && replacement.expectedResourceRevision === existingNative.binding.resourceRevision
        && isDeepStrictEqual(replacement.providerModelSelection, existingNative.binding.providerModelSelection)
        && (!replacement.nativeDelivery || isDeepStrictEqual(replacement.nativeDelivery, existingNative.binding.safeFacet));
    const nativeSelections = new Map<string, StoredSessionTeamCredentialNativeSelectionV1>();
    // Validate the complete batch before mutating any row. Callers may use a
    // successful transaction for other Session state, so a rejected binding
    // batch must never leave a partially-applied witness behind.
    if (input.teamVisibilityGrantConsent && input.intents[0]?.resourceId == null) {
        return { ok: false, reason: "invalid_input" };
    }
    for (const [index, intent] of input.intents.entries()) {
        if (intent.resourceId === null) continue;
        if (!input.authentication) return { ok: false, reason: "authentication_required" };
        const bindingInput = {
            sessionId: input.sessionId,
            accountId: input.accountId,
            resourceId: intent.resourceId,
            expectedResourceRevision: intent.expectedResourceRevision,
            deliveryMode: intent.deliveryMode,
            authentication: input.authentication,
        };
        const consent = index === 0 ? input.teamVisibilityGrantConsent : undefined;
        if (consent && intent.teamId !== undefined && intent.teamId !== consent.teamId) {
            return { ok: false, reason: "invalid_input" };
        }
        const resolved = consent
            ? await resolveRequiredTeamVisibilityInTx(tx, { ...bindingInput,
                consentTeamId: consent.teamId, requiredTeamCredential: intent })
            : await validateExistingSessionTeamCredentialResourceInTx(tx, bindingInput);
        const admitted = validateResolvedSessionTeamCredentialBindingIntent(resolved, intent);
        if (!admitted.ok) return admitted;
        if (intent.deliveryMode === 'vendor-native') {
            if (!resolved.ok || intent.slot.kind !== 'provider_model') return { ok: false, reason: 'invalid_input' };
            const selection = StoredSessionTeamCredentialNativeSelectionV1Schema.shape.providerSelection.safeParse(intent.providerModelSelection);
            if (!selection.success || (!reuseNative && intent.nativeDelivery)) return { ok: false, reason: 'invalid_input' };
            const target = await readManagedNativeCredentialTargetInTx(tx, { accountId: input.accountId,
                executionMachineId: selection.data.executionMachineId, resourceCustodianAccountId: resolved.custodianAccountId });
            if (!target || (reuseNative && existingNative.ok && (target.machine.id !== existingNative.binding.managedId
                || target.machine.controllerInstallationId !== existingNative.binding.safeFacet.controllerInstallationId
                || target.guest.installationId !== existingNative.binding.safeFacet.guestInstallationId))) {
                return { ok: false, reason: 'invalid_input' };
            }
            if (!reuseNative) {
                const birth = input.creationAuthorization;
                if (birth && (birth.actionId !== 'session.spawn_new' || birth.accountId !== input.accountId
                    || birth.serverIdentityId !== target.machine.homeId || birth.machineId !== target.guest.machineId
                    || birth.installationId !== target.guest.installationId || birth.target.kind !== 'machine'
                    || birth.target.machineId !== target.guest.machineId)) return { ok: false, reason: 'invalid_input' };
                const placeholder = `happier_native_${randomBytes(32).toString('base64url')}`;
                nativeSelections.set(intent.resourceId, { providerSelection: selection.data, placeholder,
                    ...(birth ? { creationAuthorization: { serverIdentityId: birth.serverIdentityId,
                        requestId: birth.requestId, requestEnvelopeDigest: birth.requestEnvelopeDigest,
                        machineId: birth.machineId, installationId: birth.installationId } } : {}),
                    safeFacet: { managedId: target.machine.id, controllerInstallationId: target.controller.installationId,
                        guestInstallationId: target.guest.installationId, bindingKey: randomUUID(),
                        placeholderRef: createHash('sha256').update(placeholder).digest('base64url'),
                        ...selection.data.nativeSource } });
            }
        }
    }
    if (input.teamVisibilityGrantConsent) {
        if (!input.authentication) return { ok: false, reason: "authentication_required" };
        const grant = await putSessionAccessGrantInTx(tx, {
            actorAccountId: input.accountId, sessionId: input.sessionId,
            subject: { kind: "team", teamId: input.teamVisibilityGrantConsent.teamId },
            grant: { accessLevel: "edit", canApprovePermissions: false },
            authentication: input.authentication,
        });
        if (!grant.ok) return { ok: false, reason: "access_removed" };
    }
    if (!reuseNative && (input.replaceExisting || replacement)) {
        await publishNativeCredentialPolicyChangesInTx(tx, { sessionIds: [input.sessionId] });
    }
    if (input.replaceExisting) {
        await tx.sessionTeamCredentialBinding.deleteMany({ where: { sessionId: input.sessionId,
            ...(reuseNative ? { slotKind: { not: 'provider_model:vendor-native' } } : {}) } });
    }
    for (const intent of input.intents) {
        const slotKey = Buffer.from(key(intent.slot));
        if (intent.resourceId === null) {
            await tx.sessionTeamCredentialBinding.deleteMany({
                where: { sessionId: input.sessionId, slotKey },
            });
        } else {
            if (intent.deliveryMode === 'vendor-native' && reuseNative) continue;
            const native = intent.deliveryMode === 'vendor-native' ? nativeSelections.get(intent.resourceId) : undefined;
            await tx.sessionTeamCredentialBinding.upsert({
                where: { sessionId_slotKind_slotKey: { sessionId: input.sessionId, slotKind: persistedSlotKind(intent.slot, intent.deliveryMode), slotKey } },
                create: {
                    sessionId: input.sessionId,
                    slotKind: persistedSlotKind(intent.slot, intent.deliveryMode),
                    slotKey,
                    resourceId: intent.resourceId,
                    resourceRevision: intent.expectedResourceRevision,
                    nativeManagedId: native?.safeFacet.managedId ?? null,
                    nativeDeliveryJson: native ? JSON.stringify(native) : null,
                },
                update: {
                    resourceId: intent.resourceId,
                    resourceRevision: intent.expectedResourceRevision,
                    nativeManagedId: native?.safeFacet.managedId ?? null,
                    nativeDeliveryJson: native ? JSON.stringify(native) : null,
                },
            });
            await tx.sessionTeamCredentialBinding.deleteMany({
                where: {
                    sessionId: input.sessionId,
                    slotKey,
                    slotKind: { not: persistedSlotKind(intent.slot, intent.deliveryMode) },
                },
            });
        }
    }
    return { ok: true };
}

export async function readSessionTeamCredentialBindingInTx(
    tx: Tx,
    input: Readonly<{ sessionId: string; slot: SessionTeamCredentialSlotV1; deliveryMode: TeamCredentialRouteV1 }>,
): Promise<Readonly<{ resourceId: string; resourceRevision: number; deliveryMode: TeamCredentialRouteV1 } | null>> {
    const row = await tx.sessionTeamCredentialBinding.findUnique({
        where: { sessionId_slotKind_slotKey: {
            sessionId: input.sessionId, slotKind: persistedSlotKind(input.slot, input.deliveryMode), slotKey: Buffer.from(key(input.slot)),
        } },
        select: { resourceId: true, resourceRevision: true },
    });
    return row ? { ...row, deliveryMode: input.deliveryMode } : null;
}

/** Only authenticated source-custodian RPC evidence can turn pending into prepared. */
export async function stampSessionTeamCredentialNativeDeliveryInTx(tx: Tx, input: Readonly<{
    sessionId: string; accountId: string; response: unknown; authentication: SessionAccessAuthentication;
}>): Promise<import('./nativeDeliveryRead').SessionTeamCredentialNativeDeliveryRead> {
    const read = await readSessionTeamCredentialNativeSelectionInTx(tx, input);
    if (!read.ok) return read;
    const accepted = read.binding;
    if (accepted.accountId !== input.accountId) return { ok: false, code: 'resource_changed' };
    const current = await validateExistingSessionTeamCredentialResourceInTx(tx, { sessionId: input.sessionId,
        accountId: input.accountId, resourceId: accepted.resourceId, expectedResourceRevision: accepted.resourceRevision,
        deliveryMode: 'vendor-native', authentication: input.authentication });
    if (!current.ok || current.sourceBinding.kind !== 'provider_connection') return { ok: false, code: 'resource_changed' };
    const target = await readManagedNativeCredentialTargetInTx(tx, { accountId: input.accountId,
        executionMachineId: accepted.providerModelSelection.executionMachineId,
        resourceCustodianAccountId: current.custodianAccountId });
    if (!target || target.machine.id !== accepted.managedId
        || target.machine.controllerInstallationId !== accepted.safeFacet.controllerInstallationId
        || target.guest.installationId !== accepted.safeFacet.guestInstallationId) return { ok: false, code: 'resource_changed' };
    const sourceBinding = current.sourceBinding;
    const admitted = admitTeamCredentialSourceModelRowsV1(input.response);
    if (admitted.status !== 'success') return { ok: false, code: 'resource_changed' };
    const selected = admitted.rows.filter(({ group, row }) => group.connectionId === sourceBinding.connectionId
        && group.sourceAuthority?.connectionSecurityFingerprint === sourceBinding.connectionSecurityFingerprint
        && row.ref.modelId === accepted.providerModelSelection.modelId
        && isDeepStrictEqual(row.application, accepted.providerModelSelection.application));
    if (selected.length !== 1) return { ok: false, code: 'resource_changed' };
    const observed = selected[0]!;
    const source = observed.row.nativeSource;
    if (!source) return { ok: false, code: 'resource_unavailable' };
    const ticket = source.authorizationTicket;
    if (observed.sourceRevision !== accepted.safeFacet.sourceRevision
        || source.providerTicket !== accepted.safeFacet.providerTicket
        || source.providerTicket !== projectProviderBindingAuthorizationTicketReferenceV1(ticket)
        || ticket.machineId !== target.machine.controllerMachineId
        || ticket.connectionId !== sourceBinding.connectionId
        || ticket.connectionRevision !== observed.group.connectionRevision
        || ticket.connectionSecurityFingerprint !== sourceBinding.connectionSecurityFingerprint) return { ok: false, code: 'resource_changed' };
    const resource = await tx.teamCredentialResource.findUnique({ where: { id: accepted.resourceId },
        select: { teamId: true, requestPolicyJson: true } });
    if (!resource) return { ok: false, code: 'resource_changed' };
    let allowedModelIds: readonly string[] | null = null;
    if (resource.requestPolicyJson !== null) {
        let decoded: unknown;
        try { decoded = JSON.parse(resource.requestPolicyJson); } catch { return { ok: false, code: 'resource_changed' }; }
        const policy = TeamCredentialRequestPolicyV1Schema.safeParse(decoded);
        if (!policy.success) return { ok: false, code: 'resource_changed' };
        allowedModelIds = policy.data.allowedModelIds;
    }
    const projection = projectTeamCredentialProviderModels({ response: input.response, resourceId: accepted.resourceId,
        resourceRevision: accepted.resourceRevision, teamId: resource.teamId, agentTargetKey: accepted.providerModelSelection.agentTargetKey,
        application: accepted.providerModelSelection.application, allowedModelIds, source: sourceBinding, deliveryMode: 'vendor-native' });
    const model = projection.models.find(row => row.selection.modelId === accepted.providerModelSelection.modelId
        && row.sourceRevision === accepted.safeFacet.sourceRevision && row.nativeSource?.providerTicket === accepted.safeFacet.providerTicket);
    if (!model || model.availability !== 'available'
        || (read.stored.source && !isDeepStrictEqual(read.stored.source, source))) return { ok: false, code: 'resource_changed' };
    const stored = StoredSessionTeamCredentialNativeSelectionV1Schema.safeParse({ ...read.stored, source, model });
    if (!stored.success) return { ok: false, code: 'resource_changed' };
    const changed = await tx.sessionTeamCredentialBinding.updateMany({ where: { sessionId: input.sessionId,
        slotKind: 'provider_model:vendor-native', resourceId: accepted.resourceId, resourceRevision: accepted.resourceRevision,
        nativeManagedId: accepted.managedId, nativeDeliveryJson: read.storedJson }, data: { nativeDeliveryJson: JSON.stringify(stored.data) } });
    if (changed.count !== 1) return { ok: false, code: 'resource_changed' };
    return readSessionTeamCredentialNativeDeliveryInTx(tx, input);
}

type NativeDeliveryMutationInput = Readonly<{
    sessionId: string; accountId: string; bindingKey: string; expectedResourceRevision: number;
    expectedSourceRevision: string; expectedProviderTicket: string; operation: 'install' | 'release';
    requestId: string; authentication: SessionAccessAuthentication;
}>;
type NativeDeliveryMutationRefusal = Readonly<{ ok: false; code: 'resource_unavailable' | 'resource_changed' | 'action_outcome_unknown' }>;

async function readNativeDeliveryMutationInTx(tx: Tx, input: NativeDeliveryMutationInput) {
    if (!input.requestId) return { ok: false, code: 'resource_changed' } as const;
    const initial = await readSessionTeamCredentialNativeSelectionInTx(tx, input);
    if (!initial.ok) return initial;
    if (initial.binding.accountId !== input.accountId) return { ok: false, code: 'resource_changed' } as const;
    // Whole-policy native apply uncertainty belongs to this exact managed
    // vendor resource, not to a Team credential shared across other Machines.
    const provider = getDbProviderFromEnv(process.env, 'postgres');
    if (provider !== 'sqlite') await tx.$queryRawUnsafe(provider === 'mysql'
        ? 'SELECT `id` FROM `ManagedMachine` WHERE `id` = ? FOR UPDATE'
        : 'SELECT "id" FROM "ManagedMachine" WHERE "id" = $1 FOR UPDATE', initial.binding.managedId);
    const read = await readSessionTeamCredentialNativeSelectionInTx(tx, input);
    if (!read.ok) return read;
    const accepted = read.binding;
    if (accepted.accountId !== input.accountId || accepted.safeFacet.bindingKey !== input.bindingKey
        || accepted.resourceRevision !== input.expectedResourceRevision
        || accepted.safeFacet.sourceRevision !== input.expectedSourceRevision
        || accepted.safeFacet.providerTicket !== input.expectedProviderTicket) return { ok: false, code: 'resource_changed' } as const;
    const target = await readManagedNativeCredentialTargetInTx(tx, { accountId: input.accountId,
        executionMachineId: accepted.providerModelSelection.executionMachineId,
        resourceCustodianAccountId: accepted.custodianAccountId });
    if (!target || target.machine.id !== accepted.managedId
        || target.machine.controllerInstallationId !== accepted.safeFacet.controllerInstallationId
        || target.guest.installationId !== accepted.safeFacet.guestInstallationId) return { ok: false, code: 'resource_changed' } as const;
    return read;
}

/** Durable pre-I/O claim using the verified ordinary Action request identity. */
export async function submitSessionTeamCredentialNativeDeliveryInTx(tx: Tx, input: NativeDeliveryMutationInput): Promise<
    Readonly<{ ok: true; submitted: boolean }> | NativeDeliveryMutationRefusal
> {
    const read = await readNativeDeliveryMutationInTx(tx, input);
    if (!read.ok) return read;
    const accepted = read.binding;
    if (!accepted.delivery) return { ok: false, code: 'resource_unavailable' };
    if (accepted.submission?.requestId === input.requestId && accepted.submission.operation === input.operation) {
        return { ok: true, submitted: false };
    }
    if (input.operation === 'install') {
        const current = await validateExistingSessionTeamCredentialResourceInTx(tx, { sessionId: input.sessionId,
            accountId: input.accountId, resourceId: accepted.resourceId, expectedResourceRevision: accepted.resourceRevision,
            deliveryMode: 'vendor-native', authentication: input.authentication });
        if (!current.ok) return { ok: false, code: 'resource_changed' };
    } else if (accepted.installation === 'prepared') return { ok: false, code: 'resource_changed' };
    const result = await tx.sessionTeamCredentialBinding.updateMany({ where: { sessionId: input.sessionId,
        slotKind: 'provider_model:vendor-native', resourceId: accepted.resourceId, resourceRevision: accepted.resourceRevision,
        nativeManagedId: accepted.managedId, nativeDeliveryJson: read.storedJson }, data: { nativeDeliveryJson: JSON.stringify({
            ...read.stored, submission: { requestId: input.requestId, operation: input.operation },
        }) } });
    return result.count === 1 ? { ok: true, submitted: true } : { ok: false, code: 'resource_changed' };
}

/** Only the exact submitted ordinary Action may settle its awaited outcome. */
export async function completeSessionTeamCredentialNativeDeliveryInTx(tx: Tx, input: NativeDeliveryMutationInput & Readonly<{
    outcome: 'confirmed' | 'unknown' | 'refused';
    appliedPolicy?: Readonly<{ ownedBindingKeys: readonly string[]; desiredBindingKeys: readonly string[] }>;
}>): Promise<Readonly<{ ok: true }> | NativeDeliveryMutationRefusal> {
    const read = await readNativeDeliveryMutationInTx(tx, input);
    if (!read.ok) return read;
    const accepted = read.binding;
    if (accepted.submission?.requestId !== input.requestId || accepted.submission.operation !== input.operation) {
        return { ok: false, code: 'resource_changed' };
    }
    const where = { sessionId: input.sessionId, slotKind: 'provider_model:vendor-native', resourceId: accepted.resourceId,
        resourceRevision: accepted.resourceRevision, nativeManagedId: accepted.managedId, nativeDeliveryJson: read.storedJson };
    const { submission: _submission, ...settled } = read.stored;
    const retainUnknown = async (): Promise<NativeDeliveryMutationRefusal> => {
        const result = await tx.sessionTeamCredentialBinding.updateMany({ where, data: { nativeDeliveryJson: JSON.stringify({
            ...settled, installation: 'unknown',
        }) } });
        return { ok: false, code: result.count === 1 ? 'action_outcome_unknown' : 'resource_changed' };
    };
    let appliedPeers: Extract<Awaited<ReturnType<typeof readSessionTeamCredentialNativeSelectionsForManagedMachineInTx>>, { ok: true }>['selections'] = [];
    let desired = new Set<string>();
    if (input.outcome === 'confirmed') {
        const census = await readSessionTeamCredentialNativeSelectionsForManagedMachineInTx(tx, { managedId: accepted.managedId });
        if (!census.ok) return census;
        // The signed controller reports the complete policy it actually
        // applied. That outcome settles earlier unknowns and abandoned claims.
        const policy = input.appliedPolicy;
        if (!policy) return retainUnknown();
        const owned = new Set(policy.ownedBindingKeys);
        desired = new Set(policy.desiredBindingKeys);
        const currentOwned = census.bindings.filter(row => row.installation !== 'prepared'
            || row.submission || row.safeFacet.bindingKey === accepted.safeFacet.bindingKey);
        if (owned.size !== policy.ownedBindingKeys.length || desired.size !== policy.desiredBindingKeys.length
            || currentOwned.length !== owned.size || !owned.has(accepted.safeFacet.bindingKey)
            || desired.has(accepted.safeFacet.bindingKey) !== (input.operation === 'install')
            || [...desired].some(key => !owned.has(key))
            || currentOwned.some(row => !owned.has(row.safeFacet.bindingKey) || row.accountId !== accepted.accountId
                || row.custodianAccountId !== accepted.custodianAccountId
                || desired.has(row.safeFacet.bindingKey)
                    && (row.providerModelSelection.executionMachineId !== accepted.providerModelSelection.executionMachineId
                        || row.safeFacet.controllerInstallationId !== accepted.safeFacet.controllerInstallationId
                        || row.safeFacet.guestInstallationId !== accepted.safeFacet.guestInstallationId))) return retainUnknown();
        appliedPeers = census.selections.filter(row => row.binding.safeFacet.bindingKey !== accepted.safeFacet.bindingKey
            && owned.has(row.binding.safeFacet.bindingKey));
    }
    if (input.operation === 'install' && input.outcome === 'confirmed') {
        if (!accepted.delivery) return { ok: false, code: 'resource_unavailable' };
    }
    for (const peer of appliedPeers) {
        const { installation: _installation, submission: _submission, ...prepared } = peer.stored;
        const changed = await tx.sessionTeamCredentialBinding.updateMany({ where: {
            sessionId: peer.binding.sessionId, slotKind: 'provider_model:vendor-native',
            resourceId: peer.binding.resourceId, resourceRevision: peer.binding.resourceRevision,
            nativeManagedId: peer.binding.managedId, nativeDeliveryJson: peer.storedJson,
        }, data: { nativeDeliveryJson: JSON.stringify(desired.has(peer.binding.safeFacet.bindingKey)
            ? { ...prepared, installation: 'confirmed' } : prepared) } });
        if (changed.count !== 1) return retainUnknown();
    }
    const result = input.operation === 'release' && input.outcome === 'confirmed'
        ? await tx.sessionTeamCredentialBinding.deleteMany({ where })
        : await tx.sessionTeamCredentialBinding.updateMany({ where, data: { nativeDeliveryJson: JSON.stringify(input.outcome === 'refused'
            ? settled : { ...settled, installation: input.outcome === 'confirmed' ? 'confirmed' : 'unknown' }) } });
    return result.count === 1 ? { ok: true } : { ok: false, code: 'resource_changed' };
}

type NativeCensusRequest = Pick<ManagedCredentialInstallInputV1, 'managedId'> & (
    Pick<ManagedCredentialInstallInputV1, 'sessionId' | 'bindingKey' | 'operation'>
    | Readonly<{ sessionId?: never; bindingKey?: never; operation?: never }>);
type QualifiedNativeSelectionCensus = Readonly<{ ok: true;
    desiredBindings: readonly SessionTeamCredentialNativeSelectionBinding[];
    ownedBindings: readonly SessionTeamCredentialNativeSelectionBinding[];
}> | Readonly<{ ok: false; code: 'resource_changed' }>;

/** Home alone chooses the activated cohort and re-admits every desired use.
 * A pending sibling is not installed by another Session's whole-policy apply. */
export async function validateSessionTeamCredentialNativeCensusInTx(tx: Tx, input: Readonly<{
    accountId: string; request: NativeCensusRequest;
    censusBindings: readonly SessionTeamCredentialNativeSelectionBinding[];
    authentication: SessionAccessAuthentication;
}>): Promise<QualifiedNativeSelectionCensus> {
    const rows = input.censusBindings;
    const rowFree = input.request.sessionId === undefined;
    if (rows.some(row => (rowFree ? row.custodianAccountId : row.accountId) !== input.accountId
        || row.managedId !== input.request.managedId)) {
        return { ok: false, code: 'resource_changed' };
    }
    const target = rowFree ? undefined : rows.find(row => row.sessionId === input.request.sessionId && row.safeFacet.bindingKey === input.request.bindingKey);
    if (!rowFree && (!target || input.request.operation === 'release' && target.installation === 'prepared')) {
        return { ok: false, code: 'resource_changed' };
    }
    const ownedBindings = rows.filter(row => row.installation !== 'prepared' || row.submission
        || row === target && input.request.operation !== 'release');
    if (!ownedBindings.length) return { ok: true, desiredBindings: [], ownedBindings };
    // A retained Session is ownership evidence, not the current enrolment.
    const enrolled = rowFree ? await tx.managedMachine.findUnique({ where: { id: input.request.managedId },
        select: { enrolledMachineId: true } }) : undefined;
    const anchor = target ?? rows.find(row => row.providerModelSelection.executionMachineId === enrolled?.enrolledMachineId);
    if (!anchor) return { ok: true, desiredBindings: [], ownedBindings };
    const currentTarget = await readManagedNativeCredentialTargetInTx(tx, { accountId: anchor.accountId,
        executionMachineId: anchor.providerModelSelection.executionMachineId, resourceCustodianAccountId: anchor.custodianAccountId });
    if (!currentTarget || currentTarget.machine.id !== anchor.managedId
        || !rowFree && (currentTarget.machine.controllerInstallationId !== anchor.safeFacet.controllerInstallationId
            || currentTarget.guest.installationId !== anchor.safeFacet.guestInstallationId)) {
        return rowFree ? { ok: true, desiredBindings: [], ownedBindings } : { ok: false, code: 'resource_changed' };
    }
    const desiredBindings: SessionTeamCredentialNativeSelectionBinding[] = [];
    for (const row of ownedBindings) {
        if (row.providerModelSelection.executionMachineId !== currentTarget.guest.machineId
            || row.safeFacet.controllerInstallationId !== currentTarget.machine.controllerInstallationId
            || row.safeFacet.guestInstallationId !== currentTarget.guest.installationId
            || row.custodianAccountId !== currentTarget.machine.custodianAccountId) continue;
        if (input.request.operation === 'release' && row === target) continue;
        const current = await validateExistingSessionTeamCredentialResourceInTx(tx, { sessionId: row.sessionId,
            accountId: row.accountId, resourceId: row.resourceId, expectedResourceRevision: row.resourceRevision,
            deliveryMode: 'vendor-native', authentication: input.authentication });
        if (current.ok) desiredBindings.push(row);
        else if (row === target) return { ok: false, code: 'resource_changed' };
        // Withdrawn use does not authorize materialization, but its descriptor
        // remains owned until an acknowledged release settles that exact row.
    }
    return { ok: true, desiredBindings, ownedBindings };
}

/** The existing private controller projection receives only Home-qualified
 * materializable rules, never every source-ready pending sibling. */
export async function readQualifiedSessionTeamCredentialNativeDeliveriesForManagedMachineInTx(tx: Tx, input: Readonly<{
    accountId: string; request: NativeCensusRequest; authentication: SessionAccessAuthentication;
}>): Promise<Readonly<{ ok: true; bindings: readonly SessionTeamCredentialNativeDeliveryBinding[];
    desiredBindings: readonly SessionTeamCredentialNativeDeliveryBinding[];
    ownedBindings: readonly SessionTeamCredentialNativeDeliveryBinding[];
}> | Readonly<{ ok: false; code: 'resource_unavailable' | 'resource_changed' }>> {
    const census = await readSessionTeamCredentialNativeSelectionsForManagedMachineInTx(tx, { managedId: input.request.managedId });
    if (!census.ok) return census;
    const qualified = await validateSessionTeamCredentialNativeCensusInTx(tx, { ...input, censusBindings: census.bindings });
    if (!qualified.ok) return qualified;
    const bindings: SessionTeamCredentialNativeDeliveryBinding[] = [];
    const desiredBindings: SessionTeamCredentialNativeDeliveryBinding[] = [];
    const desired = new Set(qualified.desiredBindings);
    for (const row of qualified.ownedBindings) {
        if (!row.delivery) return { ok: false, code: 'resource_unavailable' };
        const binding = { ...row, delivery: row.delivery };
        bindings.push(binding);
        if (desired.has(row)) desiredBindings.push(binding);
    }
    return { ok: true, bindings, ownedBindings: bindings, desiredBindings };
}

/** Read the accepted resource/route with its current revision for a new attach.
 * The stored selection revision is not a continuing policy fence; broker use
 * still rechecks current authority without rewriting that original witness. */
export async function readAcceptedSessionTeamCredentialProviderModelBindingInTx(
    tx: Tx,
    sessionId: string,
): Promise<SessionTeamCredentialBindingIntentListV1[number] | null> {
    const result = (await readAcceptedSessionTeamCredentialProviderModelBindingsInTx(tx, [sessionId])).get(sessionId)!;
    if (result.status === 'rejected') throw result.reason;
    return result.value;
}

/** Current accepted bindings for a detail corpus; corrupt storage stays local to its Session. */
export async function readAcceptedSessionTeamCredentialProviderModelBindingsInTx(tx: Tx, sessionIds: readonly string[]):
    Promise<ReadonlyMap<string, PromiseSettledResult<SessionTeamCredentialBindingIntentListV1[number] | null>>> {
    const result = new Map<string, PromiseSettledResult<SessionTeamCredentialBindingIntentListV1[number] | null>>();
    const ids = [...new Set(sessionIds)];
    for (let offset = 0; offset < ids.length; offset += SESSION_ACCESS_SESSION_BATCH_SIZE) {
        const batch = ids.slice(offset, offset + SESSION_ACCESS_SESSION_BATCH_SIZE);
        const rows = await tx.sessionTeamCredentialBinding.findMany({
            where: { sessionId: { in: batch }, slotKey: Buffer.from(key({ kind: 'provider_model' })) },
            select: { sessionId: true, slotKind: true, slotKey: true, resourceId: true, resourceRevision: true,
                nativeManagedId: true, nativeDeliveryJson: true, session: { select: { accountId: true } },
                resource: { select: { teamId: true, revision: true, custodianAccountId: true } } },
        });
        const bySession = new Map<string, typeof rows>();
        for (const row of rows) {
            const group = bySession.get(row.sessionId) ?? [];
            group.push(row);
            bySession.set(row.sessionId, group);
        }
        for (const id of batch) {
            try {
                const bindings = bySession.get(id) ?? [];
                if (bindings.length > 1) throw new Error('Conflicting accepted Session Provider-model bindings');
                const row = bindings[0];
                if (!row) { result.set(id, { status: 'fulfilled', value: null }); continue; }
                const deliveryMode = (['direct', 'brokered', 'vendor-native'] as const).find(mode => row.slotKind === persistedSlotKind({ kind: 'provider_model' }, mode));
                if (!deliveryMode) throw new Error('Invalid accepted Session Provider-model binding');
                const native = deliveryMode === 'vendor-native' ? readSessionTeamCredentialNativeDeliveryRow(row) : null;
                if (native && !native.ok) throw new Error('Invalid accepted native Session Provider-model binding');
                result.set(id, { status: 'fulfilled', value: { v: 1, slot: { kind: 'provider_model' }, resourceId: row.resourceId,
                    expectedResourceRevision: native ? row.resourceRevision : row.resource.revision, deliveryMode, teamId: row.resource.teamId,
                    ...(native?.ok ? { providerModelSelection: native.binding.providerModelSelection, nativeDelivery: native.binding.safeFacet } : {}) } });
            } catch (reason) { result.set(id, { status: 'rejected', reason }); }
        }
    }
    return result;
}

export async function isSessionTeamCredentialBindingIntentCurrentInTx(
    tx: Tx,
    input: Readonly<{
        sessionId: string;
        intent: SessionTeamCredentialBindingIntentListV1[number];
    }>,
): Promise<boolean> {
    if (input.intent.resourceId === null) {
        const rows = await tx.sessionTeamCredentialBinding.count({
            where: { sessionId: input.sessionId, slotKey: Buffer.from(key(input.intent.slot)) },
        });
        return rows === 0;
    }
    const current = await readSessionTeamCredentialBindingInTx(tx, {
        sessionId: input.sessionId,
        slot: input.intent.slot,
        deliveryMode: input.intent.deliveryMode,
    });
    return current === null
        ? false
        : current?.resourceId === input.intent.resourceId
            && current.resourceRevision === input.intent.expectedResourceRevision;
}

export async function validateSessionTeamCredentialBindingIntentInTx(
    tx: Tx,
    input: Readonly<{
        sessionId: string;
        accountId: string;
        intent: SessionTeamCredentialBindingIntentListV1[number];
        authentication: SessionAccessAuthentication;
    }>,
): Promise<SessionTeamCredentialBindingWriteResult> {
    if (!await isServerFeatureEnabledForHome("teams.credentialResources", { tx })) {
        return { ok: false, reason: "feature_disabled" };
    }
    const session = await tx.session.findUnique({
        where: { id: input.sessionId },
        select: { accountId: true },
    });
    if (!session) return { ok: false, reason: "session_missing" };
    if (session.accountId !== input.accountId) return { ok: false, reason: "session_owner_mismatch" };
    if (input.intent.resourceId === null) return { ok: true };
    const result = await validateExistingSessionTeamCredentialResourceInTx(tx, {
        sessionId: input.sessionId,
        accountId: input.accountId,
        resourceId: input.intent.resourceId,
        expectedResourceRevision: input.intent.expectedResourceRevision,
        deliveryMode: input.intent.deliveryMode,
        authentication: input.authentication,
    });
    return validateResolvedSessionTeamCredentialBindingIntent(result, input.intent);
}

function validateResolvedSessionTeamCredentialBindingIntent(
    result: SessionTeamCredentialResourceValidationResult,
    intent: SessionTeamCredentialBindingIntentListV1[number],
): SessionTeamCredentialBindingWriteResult {
    if (!result.ok) return result;
    if (intent.resourceId !== null && intent.teamId !== undefined && result.binding.teamId !== intent.teamId) {
        return { ok: false, reason: "invalid_input" };
    }
    return { ok: true };
}

/**
 * Composes the Lane 04 access owner with binding admission in one caller-owned
 * transaction. Consent is exact to the selected resource's Team; a mismatch
 * cannot grant access to either Team.
 */
export async function grantRequiredTeamVisibilityAndValidateBindingInTx(
    tx: Tx,
    input: Readonly<{
        sessionId: string;
        accountId: string;
        intent: SessionTeamCredentialBindingIntentListV1[number];
        consentTeamId: string;
        authentication: SessionAccessAuthentication;
    }>,
): Promise<SessionTeamCredentialBindingWriteResult> {
    if (input.intent.resourceId === null) return { ok: false, reason: "invalid_input" };
    if (input.intent.teamId !== undefined && input.intent.teamId !== input.consentTeamId) {
        return { ok: false, reason: "invalid_input" };
    }
    await acquireSessionAccessTransitionCursorLocksInTx(tx, [input.sessionId], [],
        sessionAccessGrantMutationCursorLockOptions({ actorAccountId: input.accountId, sessionId: input.sessionId,
            subjects: [{ kind: "team", teamId: input.consentTeamId }],
        }));
    const admitted = await validateRequiredTeamVisibilityInTx(tx, {
        ...input,
        requiredTeamCredential: input.intent,
    });
    if (!admitted.ok) return admitted;
    const grant = await putSessionAccessGrantInTx(tx, {
        actorAccountId: input.accountId,
        sessionId: input.sessionId,
        subject: { kind: "team", teamId: input.consentTeamId },
        grant: { accessLevel: "edit", canApprovePermissions: false },
        authentication: input.authentication,
    });
    return grant.ok ? { ok: true } : { ok: false, reason: "access_removed" };
}

/** Validate the exact selected resource against consented visibility before any access effect. */
export async function validateRequiredTeamVisibilityInTx(
    tx: Tx,
    input: Readonly<{
        sessionId: string;
        accountId: string;
        consentTeamId: string;
        requiredTeamCredential: RequiredSessionTeamCredentialV1;
        authentication: SessionAccessAuthentication;
    }>,
): Promise<SessionTeamCredentialBindingWriteResult> {
    const admitted = await resolveRequiredTeamVisibilityInTx(tx, input);
    return admitted.ok ? { ok: true } : admitted;
}

async function resolveRequiredTeamVisibilityInTx(
    tx: Tx,
    input: Readonly<{
        sessionId: string;
        accountId: string;
        consentTeamId: string;
        requiredTeamCredential: RequiredSessionTeamCredentialV1;
        authentication: SessionAccessAuthentication;
    }>,
): Promise<SessionTeamCredentialResourceValidationResult> {
    const session = await tx.session.findUnique({
        where: { id: input.sessionId },
        select: { accountId: true, primaryTeamId: true },
    });
    if (!session) return { ok: false, reason: "session_missing" };
    if (session.accountId !== input.accountId) return { ok: false, reason: "session_owner_mismatch" };
    const resource = await tx.teamCredentialResource.findUnique({
        where: { id: input.requiredTeamCredential.resourceId },
        select: { teamId: true, revision: true, sessionUsePolicy: true },
    });
    if (!resource) return { ok: false, reason: "resource_missing" };
    if (resource.revision !== input.requiredTeamCredential.expectedResourceRevision) return { ok: false, reason: "resource_changed" };
    if (resource.teamId !== input.consentTeamId || resource.sessionUsePolicy !== "team_visibility_required") {
        return { ok: false, reason: "invalid_input" };
    }
    return validateSessionTeamCredentialResourceForContextInTx(tx, {
        accountId: input.accountId,
        ...input.requiredTeamCredential,
        authentication: input.authentication,
        policy: {
            primaryTeamId: session.primaryTeamId,
            isVisibleToTeam: async (teamId) => teamId === input.consentTeamId,
        },
    });
}

type SessionTeamCredentialResourceValidationResult =
    | Readonly<{
        ok: true;
        binding: Readonly<{ resourceId: string; resourceRevision: number; teamId: string; deliveryMode: TeamCredentialRouteV1 }>;
        entitlement: Extract<TeamCredentialEntitlementDecision, { ok: true }>;
        source: Extract<TeamCredentialResourceSourceResolution, { status: "current" }>;
        /** The resource's own current source binding, parsed once here so no caller reparses it. */
        sourceBinding: TeamCredentialSourceBindingV1;
        custodianAccountId: string;
        brokerPlacementFingerprint: string | null;
    }>
    | Readonly<{ ok: false; reason: SessionTeamCredentialBindingRejection }>;

export type SessionTeamCredentialAdmissionResult =
    | SessionTeamCredentialResourceValidationResult
    | Readonly<{ ok: false; reason: "binding_missing" }>;

export interface PlannedSessionTeamCredentialContext {
    readonly primaryTeamId: string | null;
    readonly teamVisibilityTeamIds: readonly string[];
}

type SessionTeamCredentialPolicyContext = Readonly<{
    primaryTeamId: string | null;
    isVisibleToTeam: (teamId: string) => Promise<boolean>;
}>;

async function validateSessionTeamCredentialResourceForContextInTx(
    tx: Tx,
    input: Readonly<{
        accountId: string;
        resourceId: string;
        expectedResourceRevision?: number;
        expectedBrokerMachineId?: string;
        brokerSelection?: TeamCredentialBrokerPlacementSelection;
        deliveryMode: TeamCredentialRouteV1;
        policy: SessionTeamCredentialPolicyContext;
        authentication: SessionAccessAuthentication;
    }>,
): Promise<SessionTeamCredentialResourceValidationResult> {
    if (!await isServerFeatureEnabledForHome("teams.credentialResources", { tx })) {
        return { ok: false, reason: "feature_disabled" };
    }
    const resource = await tx.teamCredentialResource.findUnique({
        where: { id: input.resourceId },
        select: {
            id: true, teamId: true, custodianAccountId: true, revision: true,
            sessionUsePolicy: true, sourceBindingJson: true, brokerMachineId: true, brokerPoolId: true,
            team: { select: { authenticationPolicy: true } },
        },
    });
    if (!resource) return { ok: false, reason: "resource_missing" };
    if (input.expectedResourceRevision !== undefined && resource.revision !== input.expectedResourceRevision) {
        return { ok: false, reason: "resource_changed" };
    }
    const entitlement = await resolveTeamCredentialEntitlementInTx(tx, { resourceId: resource.id, accountId: input.accountId });
    if (!entitlement.ok) return entitlement;
    // Always the presented credential's own current qualification. An
    // established broker operation presents the opening credential's
    // provenance, carried in its signed authority, so every request of an
    // existing stream is re-qualified here (`04-private-iroh-broker-transport.md`
    // §5.6); there is no "already qualified" shortcut.
    const qualification = await qualifySessionTeamAuthenticationInTx(tx, {
        accountId: input.accountId,
        team: { id: resource.teamId, authenticationPolicy: resource.team.authenticationPolicy },
        authentication: input.authentication,
    });
    if (qualification.status !== "satisfied") {
        return {
            ok: false,
            reason: qualification.status === "unavailable"
                ? "authentication_unavailable"
                : "authentication_required",
        };
    }
    switch (resource.sessionUsePolicy) {
        case "personal_allowed":
            break;
        case "team_context_required":
            if (input.policy.primaryTeamId !== resource.teamId) {
                return { ok: false, reason: "team_context_required" };
            }
            break;
        case "team_visibility_required":
            if (!await input.policy.isVisibleToTeam(resource.teamId)) {
                return { ok: false, reason: "team_visibility_required" };
            }
            break;
        default:
            return { ok: false, reason: "resource_corrupt" };
    }
    const parsedSourceBinding = readTeamCredentialSourceBinding(resource.sourceBindingJson);
    if (!parsedSourceBinding.success) return { ok: false, reason: "resource_corrupt" };
    const source = await resolveTeamCredentialResourceSourceInTx(tx, {
        custodianAccountId: resource.custodianAccountId,
        source: parsedSourceBinding.data,
    });
    if (source.status === "unavailable") {
        return { ok: false, reason: source.reason === "invalid_source_binding" ? "resource_corrupt" : "source_replaced_or_missing" };
    }
    if (input.deliveryMode === "brokered") {
        if (!entitlement.mayBroker) return { ok: false, reason: "access_removed" };
        const placement = readTeamCredentialBrokerPlacement(resource);
        if (!placement.ok) return { ok: false, reason: "resource_corrupt" };
        // A readable resource that names no broker (its Machine or Pool was
        // removed) is not corrupt: it simply has no broker now — the same
        // answer the Runner binding reader below gives for the same fact.
        if (placement.placement === null) return { ok: false, reason: "broker_unavailable" };
        // A presented broker Machine is this operation's already-selected
        // target, so the one exact-Machine admission owner decides it: the
        // placement still has to name or (for an established selection) have
        // named that Machine, and the Machine's own resource, source and
        // revocation authority is rechecked. Pool membership and priority are
        // never re-ACLed for it, and no other member is ever substituted.
        // Only a genuinely fresh open still asks the Pool for a candidate.
        const broker = input.expectedBrokerMachineId !== undefined
            ? await admitTeamCredentialBrokerMachineForResourceInTx(tx, {
                resource,
                brokerMachineId: input.expectedBrokerMachineId,
                ...(input.brokerSelection ? { selection: input.brokerSelection } : {}),
            })
            : placement.placement.kind === "machine"
                ? await resolveTeamCredentialBrokerMachineForSaveInTx(tx, resource)
                : await admitTeamCredentialBrokerPoolForBrokeredUseInTx(tx, {
                    custodianAccountId: resource.custodianAccountId,
                    poolId: placement.placement.poolId,
                });
        if (!broker.ok) {
            // The placement columns were already read above, so an unreadable
            // row is corrupt; a placement that no longer names the presented
            // Machine keeps this validator's `broker_unavailable` contract.
            return {
                ok: false,
                reason: broker.error === "resource_unavailable"
                    ? "resource_corrupt"
                    : broker.error === "resource_changed" ? "broker_unavailable" : broker.error,
            };
        }
    } else if (input.deliveryMode === 'vendor-native') {
        if (!entitlement.allowedRoutes.includes('vendor-native') || parsedSourceBinding.data.kind !== 'provider_connection') {
            return { ok: false, reason: 'access_removed' };
        }
    } else if (input.deliveryMode !== "direct" || !entitlement.mayReceiveDirect) {
        return { ok: false, reason: "access_removed" };
    }
    return {
        ok: true,
        binding: { resourceId: resource.id, resourceRevision: resource.revision, teamId: resource.teamId, deliveryMode: input.deliveryMode },
        entitlement,
        source,
        sourceBinding: parsedSourceBinding.data,
        custodianAccountId: resource.custodianAccountId,
        brokerPlacementFingerprint: resolveTeamCredentialBrokerPlacementFingerprint(resource),
    };
}

export async function validatePlannedSessionTeamCredentialResourceInTx(
    tx: Tx,
    input: Readonly<{
        accountId: string;
        resourceId: string;
        /** Omitted only when an established operation intentionally adopts the current resource revision. */
        expectedResourceRevision?: number;
        expectedBrokerMachineId?: string;
        brokerSelection?: TeamCredentialBrokerPlacementSelection;
        deliveryMode: TeamCredentialRouteV1;
        plannedSession: PlannedSessionTeamCredentialContext;
        authentication: SessionAccessAuthentication;
    }>,
): Promise<SessionTeamCredentialResourceValidationResult> {
    const visibleTeamIds = new Set(input.plannedSession.teamVisibilityTeamIds);
    return validateSessionTeamCredentialResourceForContextInTx(tx, {
        accountId: input.accountId,
        resourceId: input.resourceId,
        expectedResourceRevision: input.expectedResourceRevision,
        expectedBrokerMachineId: input.expectedBrokerMachineId,
        ...(input.brokerSelection ? { brokerSelection: input.brokerSelection } : {}),
        deliveryMode: input.deliveryMode,
        authentication: input.authentication,
        policy: {
            primaryTeamId: input.plannedSession.primaryTeamId,
            isVisibleToTeam: async (teamId) => visibleTeamIds.has(teamId),
        },
    });
}

/** Validate a fresh Session's exact resource intent before any Session row is written. */
export async function validatePlannedSessionTeamCredentialBindingIntentInTx(
    tx: Tx,
    input: Readonly<{
        accountId: string;
        intent: SessionTeamCredentialBindingIntentListV1[number];
        plannedSession: PlannedSessionTeamCredentialContext;
        authentication: SessionAccessAuthentication;
    }>,
): Promise<SessionTeamCredentialBindingWriteResult> {
    if (input.intent.resourceId === null) return { ok: true };
    const result = await validatePlannedSessionTeamCredentialResourceInTx(tx, {
        accountId: input.accountId,
        resourceId: input.intent.resourceId,
        expectedResourceRevision: input.intent.expectedResourceRevision,
        deliveryMode: input.intent.deliveryMode,
        plannedSession: input.plannedSession,
        authentication: input.authentication,
    });
    return validateResolvedSessionTeamCredentialBindingIntent(result, input.intent);
}

/**
 * Canonical pre-Session producer for the Runner's reviewed credential binding.
 * It reuses the planned Session admission owner and reveals one exact broker
 * Machine: the resource's own placement when it names a Machine, and otherwise
 * the Pool member the placement owner already selected for this activation. No
 * Session or broker lease is created by this bounded read.
 */
export async function resolvePlannedRunnerCredentialSelectionBindingInTx(
    tx: Tx,
    input: Readonly<{
        accountId: string;
        resourceId: string;
        expectedResourceRevision: number;
        plannedSession: PlannedSessionTeamCredentialContext;
        authentication: SessionAccessAuthentication;
        /** Exact persistent Machine already selected for this activation before review. */
        selectedBrokerMachineId?: string;
        /**
         * `per_request` while this activation is still choosing its broker, and
         * `established` for every later read of the exact target it froze.
         */
        selection?: TeamCredentialBrokerPlacementSelection;
    }>,
): Promise<
    | Readonly<{ ok: true; binding: Readonly<{ v: 1; resourceId: string; brokerMachineId: string; revision: number }> }>
    | Readonly<{ ok: false; reason: SessionTeamCredentialBindingRejection }>
> {
    const resource = await tx.teamCredentialResource.findUnique({
        where: { id: input.resourceId },
        select: { custodianAccountId: true, brokerMachineId: true, brokerPoolId: true },
    });
    if (!resource) return { ok: false, reason: "resource_missing" };
    const placement = readTeamCredentialBrokerPlacement(resource);
    if (!placement.ok) return { ok: false, reason: "resource_corrupt" };
    if (placement.placement === null) return { ok: false, reason: "broker_unavailable" };
    let brokerMachineId: string;
    if (placement.placement.kind === "machine") {
        brokerMachineId = placement.placement.machineId;
        if (input.selectedBrokerMachineId !== undefined && input.selectedBrokerMachineId !== brokerMachineId) {
            return { ok: false, reason: "broker_unavailable" };
        }
    } else {
        // A Pool placement names no single Machine of its own. The exact member
        // is chosen once by the placement owner before review and then travels
        // in this activation's binding: a fresh selection must still be a
        // current member, while a later read of the established target is not
        // re-ACLed against membership edits made after the freeze.
        if (input.selectedBrokerMachineId === undefined) return { ok: false, reason: "broker_unavailable" };
        brokerMachineId = input.selectedBrokerMachineId;
    }
    const admitted = await validatePlannedSessionTeamCredentialResourceInTx(tx, {
        ...input,
        deliveryMode: "brokered",
        expectedBrokerMachineId: brokerMachineId,
        ...(input.selection ? { brokerSelection: input.selection } : {}),
    });
    if (!admitted.ok) return admitted;
    return {
        ok: true,
        binding: {
            v: 1,
            resourceId: admitted.binding.resourceId,
            brokerMachineId,
            revision: admitted.binding.resourceRevision,
        },
    };
}

export async function validateExistingSessionTeamCredentialResourceInTx(
    tx: Tx,
    input: Readonly<{
        sessionId: string;
        accountId: string;
        resourceId: string;
        expectedResourceRevision?: number;
        expectedBrokerMachineId?: string;
        brokerSelection?: TeamCredentialBrokerPlacementSelection;
        deliveryMode: TeamCredentialRouteV1;
        authentication: SessionAccessAuthentication;
    }>,
): Promise<SessionTeamCredentialResourceValidationResult> {
    const session = await tx.session.findUnique({
        where: { id: input.sessionId },
        select: { accountId: true, primaryTeamId: true },
    });
    if (!session) return { ok: false, reason: "session_missing" };
    if (session.accountId !== input.accountId) return { ok: false, reason: "session_owner_mismatch" };
    return validateSessionTeamCredentialResourceForContextInTx(tx, {
        accountId: input.accountId,
        resourceId: input.resourceId,
        expectedResourceRevision: input.expectedResourceRevision,
        ...(input.expectedBrokerMachineId !== undefined
            ? { expectedBrokerMachineId: input.expectedBrokerMachineId }
            : {}),
        ...(input.brokerSelection ? { brokerSelection: input.brokerSelection } : {}),
        authentication: input.authentication,
        deliveryMode: input.deliveryMode,
        policy: {
            primaryTeamId: session.primaryTeamId,
            isVisibleToTeam: async (teamId) => (
                await assertSessionTeamReadableGrantInTx({ tx, sessionId: input.sessionId, teamId })
            ).ok,
        },
    });
}

export type SessionTeamCredentialBindingConsequence = SessionTeamCredentialBindingConsequenceV1;

/** The two session-use policies a Session-level access edit can invalidate. */
const CONDITIONAL_SESSION_USE_POLICIES = ["team_visibility_required", "team_context_required"] as const;

/**
 * Read-only preview for the Session access editor: the credential selections
 * this Session keeps only while one of the named Teams still holds the standing
 * it currently has.
 *
 * Both conditional policies travel because the editor offers both edits that can
 * invalidate them: removing a Team's grant ends `team_visibility_required`, and
 * moving the Session's context off a Team ends that Team's
 * `team_context_required`. The row carries which policy it depends on so the
 * confirmation names only what the edit in hand actually breaks. It names
 * resources through their display names alone and guards nothing; the later
 * admission repeats every decision and still fails closed.
 *
 * The editor asks about every Team in one call, so the preview costs one query
 * rather than one per grant row.
 */
export async function listSessionTeamCredentialBindingConsequencesInTx(
    tx: Tx,
    input: Readonly<{ sessionId: string; teamIds: readonly string[] }>,
): Promise<readonly SessionTeamCredentialBindingConsequence[]> {
    if (input.teamIds.length === 0) return [];
    const rows = (await Promise.all(portableQueryChunks({
        values: [...new Set(input.teamIds)], bindingsPerValue: 1,
        fixedBindings: CONDITIONAL_SESSION_USE_POLICIES.length + 2, // Session id and Prisma OFFSET.
    }).map(teamIds => tx.sessionTeamCredentialBinding.findMany({
        where: {
            sessionId: input.sessionId,
            resource: {
                teamId: { in: [...teamIds] },
                sessionUsePolicy: { in: [...CONDITIONAL_SESSION_USE_POLICIES] },
            },
        },
        select: { resource: { select: { id: true, displayName: true, teamId: true, sessionUsePolicy: true } } },
        orderBy: [{ resourceId: "asc" }],
    })))).flat().sort((left, right) => left.resource.id < right.resource.id ? -1 : left.resource.id > right.resource.id ? 1 : 0);
    const seen = new Set<string>();
    return rows.flatMap(({ resource }) => {
        if (seen.has(resource.id)) return [];
        seen.add(resource.id);
        const policy = CONDITIONAL_SESSION_USE_POLICIES
            .find((candidate) => candidate === resource.sessionUsePolicy);
        if (!policy) return [];
        return [{ resourceId: resource.id, displayName: resource.displayName, teamId: resource.teamId, policy }];
    });
}

/**
 * Admit a bound resource using current Team authority; the binding is only a
 * witness of the accepted selection — which resource, on which route.
 *
 * The witness's recorded revision is deliberately not a precondition here. The
 * resource revision is a mutable policy fact rechecked online against the
 * current resource on every use; the expected revision is a precondition of the
 * selection mutation only, not a second persisted mirror that every later
 * policy edit would strand (`04-private-iroh-broker-transport.md:272`,
 * `11-integrated-security-qa-and-completion.md` A2(4)). No production writer
 * advances the witness after a resource edit, and none is needed.
 */
export async function admitSessionTeamCredentialBindingInTx(
    tx: Tx,
    input: Readonly<{
        sessionId: string;
        accountId: string;
        slot: SessionTeamCredentialSlotV1;
        deliveryMode: TeamCredentialRouteV1;
        authentication: SessionAccessAuthentication;
        /**
         * A revision the caller itself presents (a fresh open's accepted one);
         * never the witness's recorded revision.
         */
        expectedResourceRevision?: number;
        /** The broker Machine this operation already froze, when it has one. */
        expectedBrokerMachineId?: string;
        brokerSelection?: TeamCredentialBrokerPlacementSelection;
    }>,
): Promise<SessionTeamCredentialAdmissionResult> {
    const binding = await readSessionTeamCredentialBindingInTx(tx, input);
    if (!binding) return { ok: false, reason: "binding_missing" };
    return validateExistingSessionTeamCredentialResourceInTx(tx, {
        sessionId: input.sessionId,
        accountId: input.accountId,
        resourceId: binding.resourceId,
        ...(input.expectedResourceRevision !== undefined
            ? { expectedResourceRevision: input.expectedResourceRevision }
            : {}),
        ...(input.expectedBrokerMachineId !== undefined
            ? { expectedBrokerMachineId: input.expectedBrokerMachineId }
            : {}),
        ...(input.brokerSelection ? { brokerSelection: input.brokerSelection } : {}),
        deliveryMode: binding.deliveryMode,
        authentication: input.authentication,
    });
}

/** The effect that uses a Team credential: a Session, or an Execution Run. */
export type TeamCredentialOperationConsumer =
    | Readonly<{ kind: "session"; sessionId: string }>
    | Readonly<{
        kind: "execution_run";
        /** The Run's host Session, or null for a detached Run. */
        parentSessionId: string | null;
        /** The resource this Run's own admitted operation names. */
        resourceId: string;
    }>;

/**
 * The one current-authority admission for a credential consumer.
 *
 * A Session is admitted through its accepted selection witness. An Execution
 * Run is its own independently owned binding (`PLAN.md` §2.3): it is admitted
 * for the exact resource its Home-admitted operation names — never through its
 * parent Session's selection, so a Run on B beside a parent on A works and does
 * not follow later parent edits. An attached Run still runs in its parent
 * Session's context, so the parent's ownership and Session-use policy (Team
 * context and visibility) apply to it; a detached Run has no Session context.
 */
export async function admitTeamCredentialOperationBindingInTx(
    tx: Tx,
    input: Readonly<{
        consumer: TeamCredentialOperationConsumer;
        accountId: string;
        slot: SessionTeamCredentialSlotV1;
        deliveryMode: TeamCredentialRouteV1;
        authentication: SessionAccessAuthentication;
        /** A fresh open's accepted revision; every other use adopts the current one. */
        expectedResourceRevision?: number;
        expectedBrokerMachineId?: string;
        brokerSelection?: TeamCredentialBrokerPlacementSelection;
    }>,
): Promise<SessionTeamCredentialAdmissionResult> {
    const placement = {
        ...(input.expectedResourceRevision !== undefined
            ? { expectedResourceRevision: input.expectedResourceRevision }
            : {}),
        ...(input.expectedBrokerMachineId !== undefined
            ? { expectedBrokerMachineId: input.expectedBrokerMachineId }
            : {}),
        ...(input.brokerSelection ? { brokerSelection: input.brokerSelection } : {}),
    };
    if (input.consumer.kind === "session") {
        return await admitSessionTeamCredentialBindingInTx(tx, {
            sessionId: input.consumer.sessionId,
            accountId: input.accountId,
            slot: input.slot,
            deliveryMode: input.deliveryMode,
            authentication: input.authentication,
            ...placement,
        });
    }
    return input.consumer.parentSessionId === null
        ? await validatePlannedSessionTeamCredentialResourceInTx(tx, {
            accountId: input.accountId,
            resourceId: input.consumer.resourceId,
            ...placement,
            deliveryMode: input.deliveryMode,
            plannedSession: { primaryTeamId: null, teamVisibilityTeamIds: [] },
            authentication: input.authentication,
        })
        : await validateExistingSessionTeamCredentialResourceInTx(tx, {
            sessionId: input.consumer.parentSessionId,
            accountId: input.accountId,
            resourceId: input.consumer.resourceId,
            ...placement,
            deliveryMode: input.deliveryMode,
            authentication: input.authentication,
        });
}
