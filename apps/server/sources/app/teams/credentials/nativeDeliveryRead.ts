import { z } from 'zod/mini';
import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import {
    SessionTeamCredentialNativeDeliveryV1Schema,
    SessionTeamCredentialNativeSourceV1Schema,
    SessionTeamCredentialProviderModelSelectionV1Schema,
    encodeSessionTeamCredentialSlotKeyV1,
} from '@happier-dev/protocol/teams/credentials/sessionBindingIntentV1';
import { ProviderBrokerApplicationBindingV1Schema } from '@happier-dev/protocol/providers/brokerRouteGrantV1';
import { ProviderMachineIdSchema } from '@happier-dev/protocol/providers/ids';
import { projectProviderBindingAuthorizationTicketReferenceV1 } from '@happier-dev/protocol/providers/grants/v1';
import { DaemonProviderNativeSourceV1Schema } from '@happier-dev/protocol/rpc/providers';
import { TeamCredentialProviderModelCatalogEntryV1Schema } from '@happier-dev/protocol/teams/credentials/resourceV1';
import type { Tx } from '@/storage/inTx';

export const StoredSessionTeamCredentialNativeSelectionV1Schema = z.strictObject({
    providerSelection: z.strictObject({
        ...SessionTeamCredentialProviderModelSelectionV1Schema.shape,
        application: ProviderBrokerApplicationBindingV1Schema,
        executionMachineId: ProviderMachineIdSchema,
        nativeSource: SessionTeamCredentialNativeSourceV1Schema,
    }),
    safeFacet: SessionTeamCredentialNativeDeliveryV1Schema,
    /** Exact birth association, not an approval receipt. The installed post-approval child must still sign. */
    creationAuthorization: z.optional(z.strictObject({
        serverIdentityId: z.string().check(z.minLength(1)),
        requestId: z.string().check(z.minLength(1)),
        requestEnvelopeDigest: z.string().check(z.regex(/^[A-Za-z0-9_-]{43}$/u)),
        machineId: z.string().check(z.minLength(1)),
        installationId: z.string().check(z.minLength(1)),
    })),
    placeholder: z.string().check(z.minLength(1)),
    source: z.optional(DaemonProviderNativeSourceV1Schema),
    model: z.optional(TeamCredentialProviderModelCatalogEntryV1Schema),
    installation: z.optional(z.enum(['confirmed', 'unknown'])),
    submission: z.optional(z.strictObject({ requestId: z.string().check(z.minLength(1)), operation: z.enum(['install', 'release']) })),
});
export type StoredSessionTeamCredentialNativeSelectionV1 = z.infer<typeof StoredSessionTeamCredentialNativeSelectionV1Schema>;

type NativeBindingStorageRow = Readonly<{
    sessionId: string; slotKind: string; slotKey: Uint8Array;
    resourceId: string; resourceRevision: number;
    nativeManagedId: string | null; nativeDeliveryJson: string | null;
}>;
type NativeBindingRow = NativeBindingStorageRow & Readonly<{
    session: Readonly<{ accountId: string }>;
    resource: Readonly<{ custodianAccountId: string }>;
}>;

export type SessionTeamCredentialNativeSelectionBinding = Readonly<{
    sessionId: string; accountId: string; custodianAccountId: string;
    resourceId: string; resourceRevision: number; managedId: string;
    providerModelSelection: StoredSessionTeamCredentialNativeSelectionV1['providerSelection'];
    creationAuthorization?: StoredSessionTeamCredentialNativeSelectionV1['creationAuthorization'];
    safeFacet: StoredSessionTeamCredentialNativeSelectionV1['safeFacet'];
    installation: 'prepared' | 'confirmed' | 'unknown';
    submission?: Readonly<{ requestId: string; operation: 'install' | 'release' }>;
    delivery: Readonly<{
        safeFacet: StoredSessionTeamCredentialNativeSelectionV1['safeFacet'];
        placeholder: string;
        providerAuthorizationTicket: NonNullable<StoredSessionTeamCredentialNativeSelectionV1['source']>['authorizationTicket'];
        endpoint: NonNullable<StoredSessionTeamCredentialNativeSelectionV1['source']>['endpoint'];
        credentialTransport: NonNullable<StoredSessionTeamCredentialNativeSelectionV1['source']>['credentialTransport'];
        model: NonNullable<StoredSessionTeamCredentialNativeSelectionV1['model']>;
    }> | null;
}>;
export type SessionTeamCredentialNativeDeliveryBinding = SessionTeamCredentialNativeSelectionBinding & Readonly<{
    delivery: NonNullable<SessionTeamCredentialNativeSelectionBinding['delivery']>;
}>;
export type SessionTeamCredentialNativeSelectionRead = Readonly<{ ok: true; binding: SessionTeamCredentialNativeSelectionBinding;
    stored: StoredSessionTeamCredentialNativeSelectionV1; storedJson: string }>
    | Readonly<{ ok: false; code: 'resource_unavailable' | 'resource_changed' }>;
export type SessionTeamCredentialNativeDeliveryRead = Readonly<{ ok: true; binding: SessionTeamCredentialNativeDeliveryBinding }>
    | Readonly<{ ok: false; code: 'resource_unavailable' | 'resource_changed' }>;

/** The persisted-envelope parser serves private selection and delivery reads. */
function readStoredNativeSelection(row: NativeBindingStorageRow | null):
    Readonly<{ ok: true; stored: StoredSessionTeamCredentialNativeSelectionV1; storedJson: string }>
    | Readonly<{ ok: false; code: 'resource_unavailable' | 'resource_changed' }> {
    if (!row || row.nativeManagedId === null || row.nativeDeliveryJson === null) return { ok: false, code: 'resource_unavailable' };
    if (row.slotKind !== 'provider_model:vendor-native'
        || !Buffer.from(row.slotKey).equals(Buffer.from(encodeSessionTeamCredentialSlotKeyV1({ kind: 'provider_model' })))) {
        return { ok: false, code: 'resource_changed' };
    }
    let decoded: unknown;
    try { decoded = JSON.parse(row.nativeDeliveryJson); } catch { return { ok: false, code: 'resource_changed' }; }
    // The development stamp writer formerly retained Team consent presentation
    // on the model. Drop only those retired fields before strict admission.
    if (decoded && typeof decoded === 'object' && !Array.isArray(decoded) && 'model' in decoded
        && decoded.model && typeof decoded.model === 'object' && !Array.isArray(decoded.model)) {
        const { confirmationSource: _retiredSource, experimentalBindingConfirmations: _retiredConsent, ...model } = decoded.model as Record<string, unknown>;
        decoded = { ...decoded, model };
    }
    const parsed = StoredSessionTeamCredentialNativeSelectionV1Schema.safeParse(decoded);
    if (!parsed.success) return { ok: false, code: 'resource_changed' };
    const { providerSelection, safeFacet, placeholder, source, model } = parsed.data;
    if (((parsed.data.submission || parsed.data.installation) && (!source || !model))
        || safeFacet.managedId !== row.nativeManagedId
        || safeFacet.placeholderRef !== createHash('sha256').update(placeholder).digest('base64url')
        || providerSelection.agentTargetKey !== providerSelection.application.agentTargetKey
        || safeFacet.sourceRevision !== providerSelection.nativeSource.sourceRevision
        || safeFacet.providerTicket !== providerSelection.nativeSource.providerTicket
        || (source && (!model || source.providerTicket !== safeFacet.providerTicket
            || source.providerTicket !== projectProviderBindingAuthorizationTicketReferenceV1(source.authorizationTicket)
            || source.endpoint.endpointTemplateId !== providerSelection.application.endpointTemplateId
            || source.endpoint.protocol !== providerSelection.application.protocol
            || model.selection.resourceId !== row.resourceId
            || model.selection.deliveryMode !== 'vendor-native'
            || model.selection.agentTargetKey !== providerSelection.agentTargetKey
            || model.selection.modelId !== providerSelection.modelId
            || !isDeepStrictEqual(model.application, providerSelection.application)
            || model.nativeSource?.providerTicket !== safeFacet.providerTicket
            || model.sourceRevision !== safeFacet.sourceRevision))) {
        return { ok: false, code: 'resource_changed' };
    }
    return { ok: true, stored: parsed.data, storedJson: row.nativeDeliveryJson };
}

/** One parser for single and exact-managed reads; pending never means installed. */
export function readSessionTeamCredentialNativeDeliveryRow(row: NativeBindingRow | null): SessionTeamCredentialNativeSelectionRead {
    const read = readStoredNativeSelection(row);
    if (!read.ok || !row) return read.ok ? { ok: false, code: 'resource_unavailable' } : read;
    const { providerSelection, safeFacet, placeholder, source, model } = read.stored;
    return { ...read, binding: {
        sessionId: row.sessionId, accountId: row.session.accountId, custodianAccountId: row.resource.custodianAccountId,
        resourceId: row.resourceId, resourceRevision: row.resourceRevision, managedId: safeFacet.managedId,
        providerModelSelection: providerSelection, safeFacet,
        ...(read.stored.creationAuthorization ? { creationAuthorization: read.stored.creationAuthorization } : {}),
        installation: read.stored.installation ?? 'prepared',
        ...(read.stored.submission ? { submission: read.stored.submission } : {}),
        delivery: source && model ? { safeFacet, placeholder, providerAuthorizationTicket: source.authorizationTicket,
            endpoint: source.endpoint, credentialTransport: source.credentialTransport, model } : null,
    } };
}

const privateRelations = { session: { select: { accountId: true } }, resource: { select: { custodianAccountId: true } } } as const;

export async function readSessionTeamCredentialNativeSelectionInTx(tx: Tx, input: Readonly<{ sessionId: string }>): Promise<SessionTeamCredentialNativeSelectionRead> {
    const row = await tx.sessionTeamCredentialBinding.findUnique({
        where: { sessionId_slotKind_slotKey: { sessionId: input.sessionId, slotKind: 'provider_model:vendor-native',
            slotKey: Buffer.from(encodeSessionTeamCredentialSlotKeyV1({ kind: 'provider_model' })) } },
        include: privateRelations,
    });
    return readSessionTeamCredentialNativeDeliveryRow(row);
}

export async function readSessionTeamCredentialNativeDeliveryInTx(tx: Tx, input: Readonly<{ sessionId: string }>): Promise<SessionTeamCredentialNativeDeliveryRead> {
    const read = await readSessionTeamCredentialNativeSelectionInTx(tx, input);
    return read.ok && read.binding.delivery
        ? { ok: true, binding: { ...read.binding, delivery: read.binding.delivery } }
        : read.ok ? { ok: false, code: 'resource_unavailable' } : read;
}

/** Pending-aware indexed census used before source preparation/admission. */
export async function readSessionTeamCredentialNativeSelectionsForManagedMachineInTx(tx: Tx, input: Readonly<{ managedId: string }>): Promise<
    Readonly<{ ok: true; bindings: readonly SessionTeamCredentialNativeSelectionBinding[];
        selections: readonly Extract<SessionTeamCredentialNativeSelectionRead, { ok: true }>[] }>
    | Readonly<{ ok: false; code: 'resource_unavailable' | 'resource_changed' }>
> {
    const rows = await tx.sessionTeamCredentialBinding.findMany({ where: { nativeManagedId: input.managedId }, include: privateRelations });
    const bindings: SessionTeamCredentialNativeSelectionBinding[] = [];
    const selections: Extract<SessionTeamCredentialNativeSelectionRead, { ok: true }>[] = [];
    for (const row of rows) {
        const read = readSessionTeamCredentialNativeDeliveryRow(row);
        if (!read.ok) return read;
        bindings.push(read.binding);
        selections.push(read);
    }
    return { ok: true, bindings, selections };
}
