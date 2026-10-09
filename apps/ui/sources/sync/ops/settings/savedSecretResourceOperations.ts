import { computeContentPublicKeyFingerprint } from '@happier-dev/protocol/machines/identity/contentPublicKeyFingerprint';
import { formatSavedSecretCatalogReferenceV1, formatSavedSecretCatalogFingerprintV1, SavedSecretResourceEnvelopeCensusRequestV1Schema, SavedSecretResourceEnvelopeCensusResponseV1Schema, type SavedSecretResourceEnvelopeCensusRecipientV1, type SavedSecretResourceMaterialV1 } from '@happier-dev/protocol/account/settings/savedSecretCatalogV1';
import { listAccountSettingsSavedSecretReferences, listSavedSecretReferenceCatalogRefsV1, type AccountSettingsSavedSecretReference, promotePersonalSavedSecretReference,
    promoteLegacyInferenceSavedSecretReferenceV1, type SavedSecretLegacyInferenceCredentialV1,
    deriveSavedSecretImportResourceIdV1, readSavedSecretTransferSourceV1, type SavedSecretReferenceCatalogsV1 } from '@happier-dev/protocol/account/settings/savedSecretMutationOwner';
import type { AccountSettingsHistorySavedSecretTransferV1 } from '@happier-dev/protocol/account/settings/accountSettingsApiV2';
import { openSavedSecretResourceStoredContentV1, sealSavedSecretResourceStoredContentV1 } from '@happier-dev/protocol/account/settings/savedSecretResourceContentV1';
import { SharedSavedSecretCreateInputV1Schema, SharedSavedSecretPromoteInputV1Schema, SharedSavedSecretDeleteOutputV1Schema, SharedSavedSecretMutationOutputV1Schema, SavedSecretResourceEnvelopeRepairOutputV1Schema, SharedSavedSecretPromoteOutputV1Schema, SavedSecretResourceActionErrorV1Schema } from '@happier-dev/protocol/account/settings/savedSecretResourceActionsV1';
import type { ManagedResourceDependencyV1, ManagedResourceDispositionV1 } from '@happier-dev/protocol/machines/managed/managedDependencyV1';
import type { SavedSecret } from '@happier-dev/protocol/profiles/backendProfileSchema';
import type { SavedSecretLegacyImportResult } from '@/sync/domains/settings/savedSecretTypes';
import { bindHomeDomainHttpRequestV1 } from '@happier-dev/protocol/actions/homeDomainHttpBinding';

import { readSavedSecretCatalog, readSavedSecretCatalogInContext } from '@/sync/api/account/apiSavedSecretCatalog';
import { readRemoteHostCatalogInContext } from '@/sync/api/account/apiRemoteHostCatalog';
import { withProfileAccount, admitProfileAccount, readProfileCatalogInContext, readProfileTransferSourceInContext, prepareProfileRecordMutationsInContext, type ProfileAccountContext } from '@/sync/api/account/apiProfileCatalog';
import { loadAiLaunchProfileArtifacts, resolveProfileCatalogAuthorityV1, removeTransferredProfileSourcesV1, listTransferredProfileIdsV1 } from '@happier-dev/protocol/profiles/read';
import type { ArtifactSharingResourceV1 } from '@happier-dev/protocol/artifacts/artifactSharingV1';
import { syncSettings } from '@/sync/engine/settings/syncSettings';
import { normalizeAccountSettingsHistoryAfterTransfer } from '@/sync/engine/settings/accountSettingsHistoryRestore';
import type { AccountSettingsHistorySavedSecretRecoveryV1 } from '@happier-dev/protocol/account/settings/accountSettingsHistoryClientV1';
import { materializeSavedSecretResources } from '@/sync/engine/settings/materializeSavedSecretResources';
import { decryptSecretValueWithKeys, deriveSettingsSecretsKeySet } from '@/sync/encryption/secretSettings';
import { resolveSettingsSecretsKeySet } from '@/sync/encryption/resolveSettingsSecretsKeySet';
import { resolveAccountStorageContext } from '@/sync/encryption/accountStorageContext';
import { fetchAccountEncryptionMode } from '@/sync/api/account/apiAccountEncryptionMode';
import type { ProfileRecordV1 } from '@happier-dev/protocol/profiles/profileRecordV1';
import type { ProfileCatalogSnapshotV1 } from '@happier-dev/protocol/profiles/profileCatalogV1';
import { requestHomeDomain } from '@/sync/api/home/homeServerActionTransport';
import { homeDomainFailureFromActionFailure } from '@/sync/api/home/homeDomainActions';
import type { ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';
import { encryptDataKeyForRecipientV0 } from '@/sync/encryption/directShareEncryption';
import { encodeBase64 } from '@/encryption/base64';
import { getRandomBytes } from '@/platform/cryptoRandom';
import { randomUUID } from '@/platform/randomUUID';
import { isTeamActionApprovalPendingError, runTeamAction, type HomeDomainFailure } from '@/sync/ops/teams/teamActionClient';
import { captureSavedSecretReferenceCatalogsInContext, captureSavedSecretNotificationChannelsInContext, prepareSavedSecretReferenceCatalogMutationsInContext,
    type SavedSecretReferenceCatalogFacets, type SavedSecretReferenceCatalogKey } from './savedSecretReferenceCatalogs';
import type { SavedSecretCatalogRevisionsV1, SavedSecretReferenceCensusV1 } from '@happier-dev/protocol/account/settings/savedSecretResourceActionsV1';
import { resolveAuthCredentialsScopeKey } from '@/auth/storage/resolveAuthCredentialsScopeKey';
import { sameStrictJsonValue } from '@happier-dev/protocol/json/strictJsonValue';

export type { SavedSecretLegacyImportResult } from '@/sync/domains/settings/savedSecretTypes';

type SavedSecretMutationOutput = Readonly<{ resourceId: string; revision: number }>;
type SavedSecretDeleteOutput = Readonly<{ resourceId: string }>;
type SavedSecretApprovalHandlers<T> = Readonly<{
    onApprovalSucceeded?: (value: T) => void | Promise<void>;
    onApprovalFailed?: (code: string) => void;
}>;

type HealthySavedSecretResourceMaterialV1 = Extract<
    SavedSecretResourceMaterialV1,
    Readonly<{ resourceId: string }>
>;

function isHealthySavedSecretResourceMaterialV1(
    resource: SavedSecretResourceMaterialV1,
): resource is HealthySavedSecretResourceMaterialV1 {
    return 'resourceId' in resource;
}

export type SavedSecretResourceOperationResult =
    | Readonly<{ ok: true }>
    | Readonly<{ ok: false; reason: 'changed' | 'unavailable' | 'failed' | 'outcome_unknown' }>;

/**
 * Deleting a shared Saved Secret additionally reports the owner's own current
 * references, so the surface can name where it is still used instead of
 * offering a delete that would leave those bindings dangling.
 */
export type SavedSecretResourceDeleteResult =
    | SavedSecretResourceOperationResult
    | Readonly<{ ok: false; reason: 'managed_resources_review_required'; resources: readonly ManagedResourceDependencyV1[] }>
    | Readonly<{
        ok: false;
        reason: 'in_use';
        references: readonly AccountSettingsSavedSecretReference[];
    }>;

type SavedSecretResourceDeleteFailure = Exclude<SavedSecretResourceDeleteResult, Readonly<{ ok: true }>>;

function savedSecretDeleteFailure(failure: HomeDomainFailure<string>): SavedSecretResourceDeleteFailure {
    if (failure.code === 'managed_resources_review_required') {
        const review = SavedSecretResourceActionErrorV1Schema.safeParse(failure.details);
        if (review.success && review.data.error === 'managed_resources_review_required') {
            return { ok: false, reason: 'managed_resources_review_required', resources: review.data.resources };
        }
    }
    return { ok: false, reason: operationFailureReason(failure.kind) };
}

export type SavedSecretPromotionResult =
    | Readonly<{ ok: true; resourceRef: string }>
    | Exclude<SavedSecretResourceOperationResult, Readonly<{ ok: true }>>;

export type SavedSecretCreationResult =
    | Readonly<{ ok: true; resourceRef: string; revision: number }>
    | Exclude<SavedSecretResourceOperationResult, Readonly<{ ok: true }>>;

function operationFailureReason(kind: 'conflict' | 'outcome_unknown' | string): Exclude<SavedSecretResourceOperationResult, Readonly<{ ok: true }>>['reason'] {
    if (kind === 'conflict') return 'changed';
    if (kind === 'outcome_unknown') return 'outcome_unknown';
    return 'failed';
}

type RemoteHostReferenceCapture = Readonly<{ revision: number | 'absent'; resourceRefs: readonly string[] }>;
async function captureRemoteHostReferences(context: ProfileAccountContext) {
    const catalog = await readRemoteHostCatalogInContext(context);
    if (catalog.status !== 'ready') return null;
    return { catalog, capture: { revision: catalog.revision,
        resourceRefs: [...new Set(catalog.hosts.flatMap(host => [host.ssh.passwordSecretRef, host.ssh.identityPrivateKeySecretRef])
            .filter((ref): ref is string => typeof ref === 'string'))] } satisfies RemoteHostReferenceCapture };
}
function profileReferenceCensus(catalog: Extract<ProfileCatalogSnapshotV1, { status: 'ready' }>, accountMode: 'plain' | 'e2ee',
    artifactsById: ReadonlyMap<string, ArtifactSharingResourceV1> | undefined, remoteHosts: RemoteHostReferenceCapture,
    catalogs: SavedSecretCatalogRevisionsV1, notificationChannels: NonNullable<SavedSecretReferenceCensusV1['notificationChannels']>) {
    const artifacts = [...(artifactsById?.values() ?? [])].map(artifact => {
        if (!artifact.revision || !artifact.access) throw new Error('saved_secret_artifact_census_unavailable');
        return { artifactId: artifact.artifactId, ...artifact.revision };
    });
    return { accountMode, remoteHosts, catalogs, notificationChannels, profileTransferRevision: catalog.controlRevision, ...(artifacts.length ? { artifacts } : {}), profiles: {
        referenceGuardRevision: catalog.referenceGuardRevision,
        rows: [
            ...catalog.records.map(({ record, revision }) => ({ id: record.id, revision })),
            ...(catalog.tombstones ?? []).map(({ id, revision }) => ({ id, revision })),
        ],
    } };
}

export type SavedSecretReferenceStateCaptureResult =
    | Readonly<{ ok: false; reason: 'changed' | 'unavailable' }>
    | Readonly<{
        ok: true;
        baseline: Awaited<ReturnType<typeof readProfileTransferSourceInContext>>;
        profiles: Extract<ProfileCatalogSnapshotV1, { status: 'ready' }>;
        catalogs: SavedSecretReferenceCatalogsV1;
        referenceCensus: SavedSecretReferenceCensusV1;
    }>;

/** One complete captured source/reference inventory for composite credential mutations. */
export async function captureSavedSecretReferenceStateInContext(context: ProfileAccountContext, accountMode: 'plain' | 'e2ee',
    expected: Readonly<{ expectedSettingsVersion?: number; expectedProfileTransferRevision?: number | 'absent' }> = {},
): Promise<SavedSecretReferenceStateCaptureResult> {
    try {
        const [profiles, remoteHosts, referenceCatalogs, notificationChannels, baseline] = await Promise.all([
            readProfileCatalogInContext(context, undefined, { readSourceBaseline: true }),
            captureRemoteHostReferences(context),
            captureSavedSecretReferenceCatalogsInContext(context, accountMode),
            captureSavedSecretNotificationChannelsInContext(context, accountMode),
            readProfileTransferSourceInContext(context),
        ]);
        context.assertCurrent();
        if (profiles.status !== 'ready' || !remoteHosts || !referenceCatalogs || !notificationChannels) return { ok: false, reason: 'unavailable' };
        if (baseline.mode !== accountMode
            || expected.expectedSettingsVersion !== undefined && baseline.source.version !== expected.expectedSettingsVersion
            || expected.expectedProfileTransferRevision !== undefined && profiles.controlRevision !== expected.expectedProfileTransferRevision) {
            return { ok: false, reason: 'changed' };
        }
        const control = profiles.control?.record ?? null;
        const effectiveSource = control && resolveProfileCatalogAuthorityV1({ rawSettings: baseline.source.raw, control }) === 'destination'
            ? removeTransferredProfileSourcesV1(baseline.source.raw, listTransferredProfileIdsV1(control)) : baseline.source.raw;
        const artifactsById = await loadAiLaunchProfileArtifacts([...profiles.records.map(row => row.record),
            ...(Array.isArray(effectiveSource.profiles) ? effectiveSource.profiles : [])],
            { read: (id, options) => context.workflowArtifacts.read(id, options) });
        const { encryption } = await context.resolveAccountEncryption();
        const storage = await resolveAccountStorageContext(context.credentials, { encryption, request: context.request });
        context.assertCurrent();
        if (storage.mode !== accountMode) return { ok: false, reason: 'changed' };
        const catalogs: SavedSecretReferenceCatalogsV1 = { ...referenceCatalogs.catalogs, notificationChannels: notificationChannels.catalog,
            profileRecords: profiles.records.map(({ record }) => record), artifactsById, profileControl: control,
            remoteHostRecords: remoteHosts.catalog.hosts };
        listSavedSecretReferenceCatalogRefsV1(catalogs);
        return { ok: true, baseline, profiles, catalogs,
            referenceCensus: profileReferenceCensus(profiles, accountMode, artifactsById, remoteHosts.capture, referenceCatalogs.revisions, notificationChannels.census) };
    } catch {
        try { context.assertCurrent(); }
        catch { return { ok: false, reason: 'changed' }; }
        return { ok: false, reason: 'unavailable' };
    }
}

/**
 * The owner's own envelope for a resource data key this device just sealed.
 * Creation, promotion and conversion into E2EE each submit exactly this one
 * envelope with their write; every other recipient is prepared afterwards by
 * the census repair below.
 */
function sealOwnerSavedSecretResourceEnvelope(
    accountId: string,
    resourceDataKey: Uint8Array,
    contentDataKey: Uint8Array,
): Readonly<{ recipientAccountId: string; encryptedDataKey: string; recipientContentPublicKeyFingerprint: string }> {
    return {
        recipientAccountId: accountId,
        encryptedDataKey: encryptDataKeyForRecipientV0(resourceDataKey, encodeBase64(contentDataKey, 'base64')),
        recipientContentPublicKeyFingerprint: computeContentPublicKeyFingerprint(contentDataKey),
    };
}

export type SavedSecretResourceRecipientReadiness =
    | Readonly<{ ok: true; revision: number; recipients: readonly SavedSecretResourceEnvelopeCensusRecipientV1[] }>
    | Readonly<{ ok: false }>;

/**
 * The owner's per-recipient view of one E2EE resource: who is authorized, whether
 * each can hold an envelope at all (Plain Account, encryption not set up, keys
 * inconsistent) and whether their envelope is prepared. It is the one census
 * reader; envelope preparation consumes the same answer.
 */
export async function readSavedSecretResourceRecipientReadiness(params: Readonly<{
    scope: ServerAccountScope;
    resourceId: string;
}>): Promise<SavedSecretResourceRecipientReadiness> {
    const recipients: SavedSecretResourceEnvelopeCensusRecipientV1[] = [];
    let revision: number | null = null;
    let cursor: string | undefined;
    do {
        const request = bindHomeDomainHttpRequestV1({
            transport: { method: 'GET', path: '/v1/account/saved-secrets/resources/envelope-census' },
            inputSchema: SavedSecretResourceEnvelopeCensusRequestV1Schema,
            input: { resourceId: params.resourceId, ...(cursor ? { cursor } : {}), limit: 100 },
        });
        const census = await requestHomeDomain({
            scope: params.scope,
            path: request.path,
            method: request.method,
            effect: 'read',
            input: request.body,
            schema: SavedSecretResourceEnvelopeCensusResponseV1Schema,
        });
        // A page from another revision describes a different audience.
        if (!census.ok || (revision !== null && census.value.revision !== revision)) return { ok: false };
        revision = census.value.revision;
        recipients.push(...census.value.recipients);
        cursor = census.value.nextCursor ?? undefined;
    } while (cursor);
    return revision === null ? { ok: false } : { ok: true, revision, recipients };
}

async function repairSavedSecretResourceEnvelopesBestEffort(params: Readonly<{
    scope: ServerAccountScope;
    resourceId: string;
    expectedRevision: number;
    resourceDataKey: Uint8Array;
}>): Promise<void> {
    const census = await readSavedSecretResourceRecipientReadiness(params);
    if (!census.ok || census.revision !== params.expectedRevision) return;
    const keyEnvelopes = census.recipients.flatMap((recipient) => (
        recipient.readiness.status !== 'available' || recipient.envelopeStatus === 'prepared'
            ? []
            : [{
                recipientAccountId: recipient.account.accountId,
                encryptedDataKey: encryptDataKeyForRecipientV0(
                    params.resourceDataKey,
                    recipient.readiness.contentPublicKey,
                ),
                recipientContentPublicKeyFingerprint: recipient.readiness.contentPublicKeyFingerprint,
            }]
    ));
    if (keyEnvelopes.length === 0) return;
    await requestHomeDomain({
        scope: params.scope,
        path: '/v1/account/saved-secrets/resources/envelopes/repair',
        method: 'POST',
        effect: 'write',
        input: {
            resourceId: params.resourceId,
            expectedRevision: params.expectedRevision,
            keyEnvelopes,
        },
        schema: SavedSecretResourceEnvelopeRepairOutputV1Schema,
    });
}

async function repairCatalogedSavedSecretResourceEnvelopesBestEffort(params: Readonly<{
    scope: ServerAccountScope;
    resource: HealthySavedSecretResourceMaterialV1;
    expectedRevision: number;
    decryptDataKeyEnvelope: (encryptedDataKey: string) => Promise<Uint8Array | null>;
}>): Promise<void> {
    if (!params.resource.recipientEnvelope) return;
    const resourceDataKey = await params.decryptDataKeyEnvelope(params.resource.recipientEnvelope.encryptedDataKey);
    if (!resourceDataKey) return;
    try {
        await repairSavedSecretResourceEnvelopesBestEffort({
            scope: params.scope,
            resourceId: params.resource.resourceId,
            expectedRevision: params.expectedRevision,
            resourceDataKey,
        });
    } finally {
        resourceDataKey.fill(0);
    }
}

/**
 * Prepares every owed recipient envelope of one owned E2EE resource at its
 * current revision, opening the data key from this owner's own envelope. Used
 * after an approved write and by the owner's explicit "Finish sharing".
 */
export async function repairApprovedSavedSecretResourceEnvelopesBestEffort(params: Readonly<{
    scope: ServerAccountScope;
    resourceId: string;
    expectedRevision: number;
    decryptDataKeyEnvelope?: (encryptedDataKey: string) => Promise<Uint8Array | null>;
}>): Promise<void> {
    await withProfileAccount(params.scope, undefined, async (context, mode) => {
        if (mode !== 'e2ee') return;
        const { encryption } = await context.resolveAccountEncryption();
        if (!encryption) return;
        const catalog = await readSavedSecretCatalogInContext(context);
        context.assertCurrent();
        if (!catalog.ok) return;
        const resource = catalog.resources.find((candidate): candidate is HealthySavedSecretResourceMaterialV1 => (
            isHealthySavedSecretResourceMaterialV1(candidate)
            && candidate.resourceId === params.resourceId
        ));
        if (!resource || resource.entry.revision !== params.expectedRevision) return;
        await repairCatalogedSavedSecretResourceEnvelopesBestEffort({
            scope: params.scope,
            resource,
            expectedRevision: params.expectedRevision,
            decryptDataKeyEnvelope: params.decryptDataKeyEnvelope ?? (encryptedDataKey => encryption.decryptEncryptionKey(encryptedDataKey, params.scope)),
        });
    }).catch(() => undefined);
}

/**
 * Prepares the envelopes this Account owes as a custodian, without changing any
 * resource.
 *
 * A recipient becomes able to open a shared Saved Secret only once the
 * custodian has wrapped its data key for that recipient's content key, and the
 * mutation paths do that only for the mutation they are already performing. A
 * recipient who became E2EE-ready afterwards — or whose own content key
 * changed — therefore waits for a custodian mutation that may never come. This
 * sweep closes that gap from the Saved Secrets surface: it asks the Home's
 * census which authorized recipients are ready and still lack a usable
 * envelope, and prepares exactly those.
 *
 * Both Home routes it reaches are custodian-only and E2EE-only, so a resource
 * received from someone else, or one this Account keeps in plaintext, is not
 * asked about at all.
 */
export async function repairCustodiedSavedSecretResourceEnvelopesBestEffort(params: Readonly<{
    scope: ServerAccountScope;
    decryptDataKeyEnvelope: (encryptedDataKey: string) => Promise<Uint8Array | null>;
}>): Promise<void> {
    const catalog = await readSavedSecretCatalog(params.scope);
    if (!catalog.ok) return;
    for (const candidate of catalog.resources) {
        if (!isHealthySavedSecretResourceMaterialV1(candidate)) continue;
        if (candidate.encryptionMode !== 'e2ee' || candidate.entry.relationship !== 'owner') continue;
        const expectedRevision = candidate.entry.revision;
        if (expectedRevision === null) continue;
        await repairCatalogedSavedSecretResourceEnvelopesBestEffort({
            scope: params.scope,
            resource: candidate,
            expectedRevision,
            decryptDataKeyEnvelope: params.decryptDataKeyEnvelope,
        }).catch(() => undefined);
    }
}

/** Sealing and the owner envelope have one owner for standalone and atomic domain writes. */
export async function prepareSavedSecretResourceCreateInContext(
    context: Pick<ProfileAccountContext, 'resolveAccountEncryption' | 'assertCurrent' | 'accountId'>,
    mode: 'plain' | 'e2ee',
    input: Readonly<{ resourceId: string; displayName: string; kind: SavedSecret['kind']; value: string;
        accountGrants: readonly string[]; teamGrants: readonly string[]; groupGrants: readonly string[] }>,
): Promise<Readonly<{ input: ReturnType<typeof SharedSavedSecretCreateInputV1Schema.parse>;
    resourceDataKey: Uint8Array | null; dispose(): void }>> {
    const { encryption } = await context.resolveAccountEncryption();
    context.assertCurrent();
    if (mode === 'e2ee' && !encryption) throw new Error('saved_secret_encryption_unavailable');
    const resourceDataKey = mode === 'e2ee' ? getRandomBytes(32) : null;
    try {
        const content = { v: 1 as const, name: input.displayName, kind: input.kind, value: input.value };
        const storedContent = resourceDataKey
            ? sealSavedSecretResourceStoredContentV1({ resourceId: input.resourceId, mode: 'e2ee', resourceDataKey, content, randomBytes: getRandomBytes })
            : sealSavedSecretResourceStoredContentV1({ resourceId: input.resourceId, mode: 'plain', content });
        const keyEnvelopes = encryption && resourceDataKey
            ? [sealOwnerSavedSecretResourceEnvelope(context.accountId, resourceDataKey, encryption.contentDataKey)] : [];
        const prepared = SharedSavedSecretCreateInputV1Schema.parse({ resourceId: input.resourceId, displayName: input.displayName,
            kind: input.kind, encryptionMode: mode, storedContent, accountGrants: [...input.accountGrants],
            teamGrants: [...input.teamGrants], groupGrants: [...input.groupGrants], ...(keyEnvelopes.length ? { keyEnvelopes } : {}) });
        context.assertCurrent();
        return { input: prepared, resourceDataKey, dispose: () => { resourceDataKey?.fill(0); } };
    } catch (error) { resourceDataKey?.fill(0); throw error; }
}

export type SavedSecretCatalogResourceCreationResult =
    | Readonly<{ ok: true; resourceRefs: ReadonlyMap<string, string>; resourceFingerprints: ReadonlyMap<string, string> }>
    | Readonly<{ ok: false; reason: 'changed' | 'unavailable' | 'failed' }>
    | Readonly<{ ok: false; reason: 'outcome_unknown'; verifyOutcome?: () => Promise<SavedSecretCatalogResourceCreationResult> }>;

/** Read back the immutable sent operation; an uncertain receipt never authorizes another write. */
function catalogCreationOutcomeVerifier(params: Readonly<{
    scope: ServerAccountScope;
    originalContext: ProfileAccountContext;
    input: ReturnType<typeof SharedSavedSecretPromoteInputV1Schema.parse>;
    success: Extract<SavedSecretCatalogResourceCreationResult, { ok: true }>;
}>): () => Promise<SavedSecretCatalogResourceCreationResult> {
    const credentialScopeKey = resolveAuthCredentialsScopeKey(params.originalContext.credentials);
    const mode = params.input.referenceCensus.accountMode;
    const creations = [params.input, ...(params.input.additionalSavedSecretResources ?? [])];
    const mutations = params.input.catalogMutations ?? {};
    const keys = Object.keys(mutations) as SavedSecretReferenceCatalogKey[];
    const unknown = (): SavedSecretCatalogResourceCreationResult => ({ ok: false, reason: 'outcome_unknown', verifyOutcome: verify });
    const verify = async (): Promise<SavedSecretCatalogResourceCreationResult> => {
        const { captureLazyActionAccountContext } = await import('@/sync/ops/actions/actionAccountContext');
        let context: ProfileAccountContext | undefined;
        try {
            if (!params.originalContext.accountLifetime.isCurrent()) return unknown();
            context = await captureLazyActionAccountContext(params.scope.serverId);
            if (context.accountId !== params.scope.accountId
                || resolveAuthCredentialsScopeKey(context.credentials) !== credentialScopeKey
                || await context.resolveAccountMode() !== mode) return unknown();
            const catalogs = await captureSavedSecretReferenceCatalogsInContext(context, mode, keys);
            if (!catalogs || keys.some(key => {
                const mutation = mutations[key];
                return !mutation || typeof mutation.expectedRevision !== 'number'
                    || catalogs.revisions[key] !== mutation.expectedRevision + 1
                    || !sameStrictJsonValue(catalogs.storedContents[key], mutation.content);
            })) return unknown();
            const material = await readSavedSecretCatalogInContext(context);
            if (!material.ok) return unknown();
            const resources: HealthySavedSecretResourceMaterialV1[] = [];
            for (const creation of creations) {
                const matching = material.resources.filter((row): row is HealthySavedSecretResourceMaterialV1 => isHealthySavedSecretResourceMaterialV1(row)
                    && row.resourceId === creation.resourceId);
                if (matching.length !== 1 || !isHealthySavedSecretResourceMaterialV1(matching[0]!)) return unknown();
                const resource = matching[0]!;
                const audience = resource.entry.audience;
                if (resource.entry.relationship !== 'owner'
                    || (resource.entry.owner?.accountId ?? resource.entry.ownerAccountId) !== context.accountId
                    || resource.entry.revision !== 1 || resource.entry.materialStatus !== 'ready' || !resource.entry.capabilities.use
                    || resource.encryptionMode !== creation.encryptionMode
                    || !sameStrictJsonValue(resource.storedContent, creation.storedContent)
                    || !audience || audience.accounts.length || audience.teams.length || audience.groups.length
                    || creation.accountGrants?.length || creation.teamGrants?.length || creation.groupGrants?.length) return unknown();
                const envelopes = creation.keyEnvelopes ?? [];
                if (creation.encryptionMode === 'plain') {
                    if (envelopes.length || resource.recipientEnvelope !== null) return unknown();
                } else {
                    const envelope = envelopes[0];
                    if (envelopes.length !== 1 || !envelope || envelope.recipientAccountId !== context.accountId
                        || !sameStrictJsonValue(resource.recipientEnvelope, {
                            encryptedDataKey: envelope.encryptedDataKey,
                            recipientContentPublicKeyFingerprint: envelope.recipientContentPublicKeyFingerprint,
                        })) return unknown();
                }
                resources.push(resource);
            }
            const encryption = resources.some(resource => resource.encryptionMode === 'e2ee')
                ? (await context.resolveAccountEncryption()).encryption : null;
            const currentContext = context;
            const opened = await materializeSavedSecretResources({ resources,
                decryptDataKeyEnvelope: encryptedDataKey => encryption
                    ? encryption.decryptEncryptionKey(encryptedDataKey, { serverId: currentContext.serverId, accountId: currentContext.accountId })
                    : Promise.resolve(null) });
            if (resources.some(resource => !opened.entries.some(entry => entry.ref === resource.entry.ref
                && entry.materialStatus === 'ready' && entry.capabilities.use))) return unknown();
            const currentMode = (await fetchAccountEncryptionMode(context.credentials, { request: context.request })).mode;
            if (encryption) {
                const currentStorage = await resolveAccountStorageContext(context.credentials, { encryption, request: context.request });
                if (currentStorage.mode !== mode) return unknown();
            }
            context.assertCurrent();
            if (!params.originalContext.accountLifetime.isCurrent() || currentMode !== mode) return unknown();
            return params.success;
        } catch { return unknown(); }
        finally { context?.dispose(); }
    };
    return verify;
}

export type SavedSecretFullReferenceResourceMutationCapture = Readonly<{
    rawSettings: Readonly<Record<string, unknown>>;
    settingsVersion: number;
    catalogs: SavedSecretReferenceCatalogsV1;
    catalogRevisions: SavedSecretCatalogRevisionsV1;
    resourceRefs: ReadonlyMap<string, string>;
    resourceFingerprints: ReadonlyMap<string, string>;
    context: ProfileAccountContext;
    accountMode: 'plain' | 'e2ee';
}>;
export type SavedSecretFullReferenceResourceMutationCandidate = Readonly<{
    settings: Readonly<Record<string, unknown>>;
    catalogs: SavedSecretReferenceCatalogsV1;
}>;

export type SavedSecretFullReferenceResourceCreationResult =
    | Readonly<{ ok: true; settingsVersion: number; resourceRefs: ReadonlyMap<string, string>; resourceFingerprints: ReadonlyMap<string, string> }>
    | Exclude<SavedSecretCatalogResourceCreationResult, Readonly<{ ok: true }>>;

type SavedSecretCatalogResourceCreationParams = Readonly<{
    scope: ServerAccountScope;
    resources: readonly SavedSecret[];
    referenceScope?: 'catalogs';
    catalogKeys: readonly SavedSecretReferenceCatalogKey[];
    mutateCatalogs: (capture: Readonly<{
        catalogs: SavedSecretReferenceCatalogFacets;
        catalogRevisions: Partial<SavedSecretCatalogRevisionsV1>;
        resourceRefs: ReadonlyMap<string, string>;
        resourceFingerprints: ReadonlyMap<string, string>;
        context: ProfileAccountContext;
        accountMode: 'plain' | 'e2ee';
    }>) => Readonly<{ catalogs: SavedSecretReferenceCatalogFacets }>
        | Readonly<{ ok: false; reason: 'changed' | 'unavailable' }>
        | Promise<Readonly<{ catalogs: SavedSecretReferenceCatalogFacets }>
            | Readonly<{ ok: false; reason: 'changed' | 'unavailable' }>>;
}> & SavedSecretApprovalHandlers<Extract<SavedSecretCatalogResourceCreationResult, { ok: true }>>;
export type SavedSecretFullReferenceResourceCreationParams = Readonly<{
    scope: ServerAccountScope;
    resources: readonly SavedSecret[];
    referenceScope: 'full';
    originalSource?: Readonly<{ rawSettings: Readonly<Record<string, unknown>>; settingsVersion: number }>;
    mutateCatalogs: (capture: SavedSecretFullReferenceResourceMutationCapture) => SavedSecretFullReferenceResourceMutationCandidate
        | Readonly<{ ok: false; reason: 'changed' | 'unavailable' }>
        | Promise<SavedSecretFullReferenceResourceMutationCandidate | Readonly<{ ok: false; reason: 'changed' | 'unavailable' }>>;
}> & SavedSecretApprovalHandlers<Extract<SavedSecretFullReferenceResourceCreationResult, { ok: true }>>;

/** New credentials and their existing destination bindings commit through one S2 transaction. */
export function createSavedSecretResourcesWithCatalogMutation(params: SavedSecretFullReferenceResourceCreationParams): Promise<SavedSecretFullReferenceResourceCreationResult>;
export function createSavedSecretResourcesWithCatalogMutation(params: SavedSecretCatalogResourceCreationParams): Promise<SavedSecretCatalogResourceCreationResult>;
export async function createSavedSecretResourcesWithCatalogMutation(
    params: SavedSecretFullReferenceResourceCreationParams | SavedSecretCatalogResourceCreationParams,
): Promise<SavedSecretFullReferenceResourceCreationResult | SavedSecretCatalogResourceCreationResult> {
    try {
        const { captureLazyActionAccountContext } = await import('@/sync/ops/actions/actionAccountContext');
        const context = await captureLazyActionAccountContext(params.scope.serverId);
        try {
            return params.referenceScope === 'full'
                ? await createSavedSecretResourcesWithCatalogMutationInContext(context, params)
                : await createSavedSecretResourcesWithCatalogMutationInContext(context, params);
        } finally { context.dispose(); }
    } catch (error) {
        if (isTeamActionApprovalPendingError(error)) throw error;
        return { ok: false, reason: 'failed' };
    }
}

/** Borrow the initiating Account lifetime; only the caller disposes this context. */
export function createSavedSecretResourcesWithCatalogMutationInContext(context: ProfileAccountContext, params: SavedSecretFullReferenceResourceCreationParams): Promise<SavedSecretFullReferenceResourceCreationResult>;
export function createSavedSecretResourcesWithCatalogMutationInContext(context: ProfileAccountContext, params: SavedSecretCatalogResourceCreationParams): Promise<SavedSecretCatalogResourceCreationResult>;
export async function createSavedSecretResourcesWithCatalogMutationInContext(
    context: ProfileAccountContext,
    params: SavedSecretFullReferenceResourceCreationParams | SavedSecretCatalogResourceCreationParams,
): Promise<SavedSecretFullReferenceResourceCreationResult | SavedSecretCatalogResourceCreationResult> {
    const prepared: Awaited<ReturnType<typeof prepareSavedSecretResourceCreateInContext>>[] = [];
    try {
        if (context.serverId !== params.scope.serverId || context.accountId !== params.scope.accountId) {
            return { ok: false, reason: 'changed' };
        }
        context.assertCurrent();
        if (params.referenceScope === 'full') {
            if (!params.resources.length || new Set(params.resources.map(resource => resource.id)).size !== params.resources.length) {
                return { ok: false, reason: 'unavailable' };
            }
            return await admitProfileAccount<SavedSecretFullReferenceResourceCreationResult>(context, async (_context, accountMode) => {
                const captured = await captureSavedSecretReferenceStateInContext(context, accountMode);
                if (!captured.ok) return captured;
                const { catalogs, profiles, baseline, referenceCensus } = captured;
                if (params.originalSource && (params.originalSource.settingsVersion !== baseline.source.version
                    || !sameStrictJsonValue(params.originalSource.rawSettings, baseline.source.raw))) {
                    return { ok: false, reason: 'changed' };
                }
                const catalogRevisions = referenceCensus.catalogs;
                const artifactsById = catalogs.artifactsById;
                if (!catalogRevisions || !artifactsById) return { ok: false, reason: 'unavailable' };
                const resourceRefs = new Map(params.resources.map(resource => [resource.id,
                    formatSavedSecretCatalogReferenceV1({ kind: 'shared_resource', id: resource.id })]));
                const resourceFingerprints = new Map([...resourceRefs].map(([id, ref]) => [id,
                    formatSavedSecretCatalogFingerprintV1({ ref, source: 'shared_resource', revision: 1 })!]));
                const candidate = await params.mutateCatalogs({ rawSettings: baseline.source.raw, settingsVersion: baseline.source.version,
                    catalogs, catalogRevisions, resourceRefs, resourceFingerprints, context, accountMode });
                context.assertCurrent();
                if ('ok' in candidate) return candidate;
                // These admitted facets are source proof, not callback-owned mutation destinations.
                if (candidate.catalogs.artifactsById !== artifactsById
                    || !sameStrictJsonValue(candidate.catalogs.profileControl, catalogs.profileControl)
                    || !sameStrictJsonValue(candidate.catalogs.remoteHostRecords, catalogs.remoteHostRecords)
                    || candidate.catalogs.profileRecords.length !== profiles.records.length
                    || candidate.catalogs.profileRecords.some(record => !profiles.records.some(row => row.record.id === record.id))) {
                    return { ok: false, reason: 'unavailable' };
                }
                let nextSettings = { ...candidate.settings };
                let nextCatalogs = candidate.catalogs;
                for (const resource of params.resources) {
                    const promoted = promotePersonalSavedSecretReference(nextSettings, { secretId: resource.id,
                        expectedUpdatedAt: resource.updatedAt, sharedSecretRef: resourceRefs.get(resource.id)! }, nextCatalogs);
                    const { settings, ...rewrittenCatalogs } = promoted;
                    nextSettings = { ...settings };
                    nextCatalogs = { ...nextCatalogs, ...rewrittenCatalogs };
                }
                if ([...resourceRefs.values()].some(ref => listAccountSettingsSavedSecretReferences(nextSettings, ref, nextCatalogs).length === 0)) {
                    return { ok: false, reason: 'unavailable' };
                }
                const pendingResourceIds = params.resources.map(resource => resource.id);
                const pendingRevisions = pendingResourceIds.map(resourceId => ({ resourceId, expectedRevision: 1 }));
                const nextRecords = new Map(nextCatalogs.profileRecords.map(record => [record.id, record]));
                const profileMutations = await prepareProfileRecordMutationsInContext(context, {
                    records: profiles.records.flatMap(row => {
                        const record = nextRecords.get(row.record.id)!;
                        return sameStrictJsonValue(record, row.record) ? [] : [{ record, revision: row.revision }];
                    }), expectedMode: accountMode, catalog: profiles, artifactsById, savedSecretRevisions: pendingRevisions,
                });
                const catalogMutations = await prepareSavedSecretReferenceCatalogMutationsInContext(context, {
                    catalogs: nextCatalogs, previousCatalogs: catalogs, revisions: catalogRevisions, accountMode,
                    sourceSettingsVersion: baseline.source.version, pendingResourceIds,
                });
                for (const resource of params.resources) {
                    const value = resource.encryptedValue.value;
                    if (typeof value !== 'string') return { ok: false, reason: 'unavailable' };
                    prepared.push(await prepareSavedSecretResourceCreateInContext(context, accountMode, {
                        resourceId: resource.id, displayName: resource.name, kind: resource.kind, value,
                        accountGrants: [], teamGrants: [], groupGrants: [],
                    }));
                }
                const { encryption } = await context.resolveAccountEncryption();
                const settingsKeys = await resolveSettingsSecretsKeySet({ credentials: context.credentials, scope: params.scope });
                context.assertCurrent();
                const success = { ok: true as const, resourceRefs, resourceFingerprints };
                const mutation = await syncSettings({ credentials: context.credentials, encryption,
                    settingsSecretsKey: settingsKeys?.writeKey ?? null, settingsSecretsReadKeys: settingsKeys?.readKeys ?? [],
                    settingsScope: params.scope, requestContext: { scope: params.scope, endpointUrl: context.endpointUrl, request: context.request },
                    pendingSettings: {}, clearPendingSettings: () => {}, oneShotServerSettingsMutation: {
                        expectedSettingsVersion: baseline.source.version, expectedProfileTransferRevision: profiles.controlRevision,
                        rebaseOnConflict: false, mutate: () => ({ settings: nextSettings, value: success }),
                        commitPrepared: async sealed => {
                            context.assertCurrent();
                            if (sealed.accountMode !== accountMode) return { status: 'rejected', error: new Error('saved_secret_account_mode_changed') };
                            const first = prepared[0]!;
                            const input = SharedSavedSecretPromoteInputV1Schema.parse({ ...first.input,
                                additionalSavedSecretResources: prepared.slice(1).map(resource => resource.input),
                                expectedSettingsVersion: sealed.expectedSettingsVersion, nextSettings: sealed.content,
                                referenceCensus, profileMutations, ...(Object.keys(catalogMutations).length ? { catalogMutations } : {}),
                            });
                            const outcome = await runTeamAction({ scope: params.scope, actionId: 'secrets.shared.promote', input,
                                parse: value => SharedSavedSecretPromoteOutputV1Schema.parse(value),
                                onApprovalSucceeded: async receipt => {
                                    if (receipt.resourceId !== first.input.resourceId) {
                                        params.onApprovalFailed?.('outcome_unknown');
                                        return;
                                    }
                                    await params.onApprovalSucceeded?.({ ...success, settingsVersion: receipt.settingsVersion });
                                },
                                ...(params.onApprovalFailed ? { onApprovalFailed: params.onApprovalFailed } : {}),
                            });
                            context.assertResultCurrent('write');
                            if (outcome.kind === 'succeeded') return outcome.value.resourceId === first.input.resourceId
                                ? { status: 'applied', settingsVersion: outcome.value.settingsVersion } : { status: 'outcomeUnknown' };
                            if (outcome.failure.kind === 'conflict') return { status: 'conflict' };
                            if (outcome.failure.kind === 'outcome_unknown') return { status: 'outcomeUnknown' };
                            return { status: 'rejected', error: new Error(`saved_secret_catalog_creation_${outcome.failure.kind}`) };
                        },
                    } });
                if (mutation?.status === 'applied') return { ...success, settingsVersion: mutation.settingsVersion };
                return { ok: false, reason: mutation?.status === 'conflict' ? 'changed' : 'outcome_unknown' };
            });
        }
        if (!params.resources.length || !params.catalogKeys.length
            || new Set(params.resources.map(resource => resource.id)).size !== params.resources.length) {
            return { ok: false, reason: 'unavailable' };
        }
        return await admitProfileAccount<SavedSecretCatalogResourceCreationResult>(context, async (_context, accountMode) => {
            const captured = await captureSavedSecretReferenceCatalogsInContext(context, accountMode, params.catalogKeys);
            if (!captured || params.catalogKeys.some(key => typeof captured.revisions[key] !== 'number'
                || captured.catalogs[key] == null)) return { ok: false, reason: 'unavailable' };
            const resourceRefs = new Map(params.resources.map(resource => [resource.id,
                formatSavedSecretCatalogReferenceV1({ kind: 'shared_resource', id: resource.id })]));
            const resourceFingerprints = new Map([...resourceRefs].map(([id, ref]) => [id,
                formatSavedSecretCatalogFingerprintV1({ ref, source: 'shared_resource', revision: 1 })!]));
            const candidate = await params.mutateCatalogs({ catalogs: captured.catalogs, catalogRevisions: captured.revisions,
                resourceRefs, resourceFingerprints, context, accountMode });
            context.assertCurrent();
            if ('ok' in candidate) return candidate;
            for (const resource of params.resources) {
                const value = resource.encryptedValue.value;
                if (typeof value !== 'string') return { ok: false, reason: 'unavailable' };
                prepared.push(await prepareSavedSecretResourceCreateInContext(context, accountMode, {
                    resourceId: resource.id, displayName: resource.name, kind: resource.kind, value,
                    accountGrants: [], teamGrants: [], groupGrants: [],
                }));
            }
            const catalogMutations = await prepareSavedSecretReferenceCatalogMutationsInContext(context, {
                catalogs: candidate.catalogs, previousCatalogs: captured.catalogs, revisions: captured.revisions, accountMode,
                pendingResourceIds: params.resources.map(resource => resource.id),
            });
            const changedKeys = Object.keys(catalogMutations) as SavedSecretReferenceCatalogKey[];
            const declaredReferences = new Set(Object.values(catalogMutations).flatMap(mutation => mutation?.referencedSavedSecretIds ?? []));
            if (!changedKeys.length || changedKeys.some(key => !params.catalogKeys.includes(key))
                || [...resourceRefs.values()].some(ref => !declaredReferences.has(ref))) {
                return { ok: false, reason: 'unavailable' };
            }
            const first = prepared[0]!;
            const input = SharedSavedSecretPromoteInputV1Schema.parse({ ...first.input,
                additionalSavedSecretResources: prepared.slice(1).map(resource => resource.input),
                nextSettings: null, profileMutations: [], catalogMutations,
                referenceCensus: { scope: 'catalogs', accountMode,
                    catalogs: Object.fromEntries(changedKeys.map(key => [key, captured.revisions[key]])) },
            });
            const success = { ok: true as const, resourceRefs, resourceFingerprints };
            const outcome = await runTeamAction({ scope: params.scope, actionId: 'secrets.shared.promote', input,
                parse: value => SharedSavedSecretPromoteOutputV1Schema.parse(value),
                onApprovalSucceeded: async () => { await params.onApprovalSucceeded?.(success); },
                ...(params.onApprovalFailed ? { onApprovalFailed: params.onApprovalFailed } : {}),
            });
            context.assertResultCurrent('write');
            // An unknown outcome is not permission to replay or claim success by id.
            if (outcome.kind !== 'succeeded' && outcome.failure.kind === 'outcome_unknown') {
                return { ok: false, reason: 'outcome_unknown', verifyOutcome: catalogCreationOutcomeVerifier({
                    scope: params.scope, originalContext: context, input, success,
                }) };
            }
            return outcome.kind === 'succeeded' ? success : { ok: false, reason: operationFailureReason(outcome.failure.kind) };
        });
    } catch (error) {
        if (isTeamActionApprovalPendingError(error)) throw error;
        return { ok: false, reason: 'failed' };
    } finally {
        for (const resource of prepared) resource.dispose();
    }
}

/** Creates a standalone resource using its captured Home's Account material. */
export async function createSavedSecretResource(params: Readonly<{
    scope: ServerAccountScope;
    name: string;
    kind: SavedSecret['kind'];
    value: string;
    accountGrants: readonly string[];
    teamGrants: readonly string[];
    groupGrants: readonly string[];
    onApprovalSucceeded?: (result: Extract<SavedSecretCreationResult, Readonly<{ ok: true }>>) => void | Promise<void>;
    onApprovalFailed?: (code: string) => void;
}>): Promise<SavedSecretCreationResult> {
    try {
        return await withProfileAccount<SavedSecretCreationResult>(params.scope, undefined, async (context, mode) => {
            const { encryption } = await context.resolveAccountEncryption();
            context.assertCurrent();
            if (mode === 'e2ee' && !encryption) return { ok: false as const, reason: 'unavailable' as const };
            const resourceId = randomUUID();
            const resourceRef = formatSavedSecretCatalogReferenceV1({ kind: 'shared_resource', id: resourceId });
            const prepared = await prepareSavedSecretResourceCreateInContext(context, mode, {
                resourceId, displayName: params.name, kind: params.kind, value: params.value,
                accountGrants: params.accountGrants, teamGrants: params.teamGrants, groupGrants: params.groupGrants,
            });
            const resourceDataKey = prepared.resourceDataKey;
            try {
                const finishApproved = async (value: { resourceId: string; revision: number }) => {
                    if (mode === 'e2ee') {
                        await repairApprovedSavedSecretResourceEnvelopesBestEffort({
                            scope: params.scope,
                            resourceId,
                            expectedRevision: value.revision,
                        }).catch(() => undefined);
                    }
                    const result = { ok: true as const, resourceRef, revision: value.revision };
                    await params.onApprovalSucceeded?.(result);
                };
                const outcome = await runTeamAction({
                    scope: params.scope,
                    actionId: 'secrets.shared.create',
                    input: prepared.input,
                    parse: (value) => SharedSavedSecretMutationOutputV1Schema.parse(value),
                    onApprovalSucceeded: finishApproved,
                    ...(params.onApprovalFailed ? { onApprovalFailed: params.onApprovalFailed } : {}),
                });
                context.assertResultCurrent('write');
                if (outcome.kind !== 'succeeded') {
                    if (outcome.failure.kind === 'outcome_unknown') {
                        const catalog = await readSavedSecretCatalogInContext(context);
                        context.assertCurrent();
                        const created = catalog.ok
                            ? catalog.resources.find((resource): resource is HealthySavedSecretResourceMaterialV1 => (
                                isHealthySavedSecretResourceMaterialV1(resource)
                                && resource.resourceId === resourceId
                                && resource.encryptionMode === mode
                                && resource.entry.relationship === 'owner'
                                && resource.entry.ownerAccountId === params.scope.accountId
                                && resource.entry.materialStatus === 'ready'
                            ))
                            : null;
                        if (created?.entry.revision !== null && created?.entry.revision !== undefined) {
                            if (resourceDataKey) {
                                await repairSavedSecretResourceEnvelopesBestEffort({
                                    scope: params.scope,
                                    resourceId,
                                    expectedRevision: created.entry.revision,
                                    resourceDataKey,
                                }).catch(() => undefined);
                            }
                            return { ok: true, resourceRef, revision: created.entry.revision };
                        }
                    }
                    return { ok: false, reason: operationFailureReason(outcome.failure.kind) };
                }
                if (resourceDataKey) {
                    await repairSavedSecretResourceEnvelopesBestEffort({
                        scope: params.scope,
                        resourceId,
                        expectedRevision: outcome.value.revision,
                        resourceDataKey,
                    }).catch(() => undefined);
                }
                return { ok: true, resourceRef, revision: outcome.value.revision };
            } finally {
                prepared.dispose();
            }
        });
    } catch (error) {
        // Approval-pending carries the exact result-bearing continuation and
        // must reach the mounted presenter unchanged. Ordinary preparation or
        // transport failures remain retryable from the preserved draft.
        if (isTeamActionApprovalPendingError(error)) throw error;
        return { ok: false, reason: 'failed' };
    }
}

/**
 * Promotes one personal value into the shared resource owner. The canonical
 * Settings one-shot owner prepares the complete envelope, while the Home's
 * promotion route commits that envelope and resource creation atomically.
 */
type SavedSecretPersonalPromotionParams = Readonly<{
    scope: ServerAccountScope;
    expectedSettingsVersion: number;
    secret: SavedSecret;
    accountGrants: readonly string[];
    teamGrants: readonly string[];
    groupGrants: readonly string[];
    onApprovalSucceeded?: (result: Readonly<{ ok: true; resourceRef: string }>) => void | Promise<void>;
    onApprovalFailed?: (code: string) => void;
}>;
type SavedSecretInferencePromotionParams = Omit<SavedSecretPersonalPromotionParams, 'secret'> & Readonly<{
    credential: SavedSecretLegacyInferenceCredentialV1;
}>;

export async function promotePersonalSavedSecretResource(params: SavedSecretPersonalPromotionParams): Promise<SavedSecretPromotionResult> {
    try {
        return await withProfileAccount(params.scope, undefined, async (context, mode) => {
            const result = await promoteSavedSecretSourceResourceInContext(context, mode, params);
            if (!result.ok) return result;
            // Cleanup failure cannot roll back the acknowledged destination.
            await normalizeTransferredSavedSecretHistoryInContext(context, params.scope, [{ savedSecretId: params.secret.id,
                resourceId: deriveSavedSecretImportResourceIdV1({ accountId: params.scope.accountId,
                    source: { kind: 'personal-saved-secret', secretId: params.secret.id } }), expectedRevision: 1 }], result.profileTransferRevision).catch(() => undefined);
            return { ok: true as const, resourceRef: result.resourceRef };
        });
    } catch (error) {
        if (isTeamActionApprovalPendingError(error)) throw error;
        return { ok: false, reason: 'unavailable' };
    }
}

/** The demand loader borrows this same sealed composite, without invalidating itself. */
async function promoteSavedSecretSourceResourceInContext(context: ProfileAccountContext, accountMode: 'plain' | 'e2ee',
    params: SavedSecretPersonalPromotionParams | SavedSecretInferencePromotionParams,
    expectedProfileTransferRevision?: number | 'absent',
): Promise<Exclude<SavedSecretPromotionResult, Readonly<{ ok: true }>> | Readonly<{
    ok: true; resourceRef: string; settingsVersion: number; profileTransferRevision: number | 'absent';
}>> {
    const resourceId = deriveSavedSecretImportResourceIdV1({ accountId: params.scope.accountId,
        source: 'secret' in params ? { kind: 'personal-saved-secret', secretId: params.secret.id } : params.credential.source });
    const resourceRef = formatSavedSecretCatalogReferenceV1({ kind: 'shared_resource', id: resourceId });
    // Written by the commit callback below; held in a box so the compiler
    // cannot narrow it back to its initial null at the zeroizing `finally`.
    const promotionDataKey: { value: Uint8Array | null } = { value: null };

    try {
        const captured = await captureSavedSecretReferenceStateInContext(context, accountMode, {
            expectedSettingsVersion: params.expectedSettingsVersion, expectedProfileTransferRevision,
        });
        if (!captured.ok) return captured;
        const { profiles, baseline, catalogs, referenceCensus } = captured;
        const { artifactsById } = catalogs;
        const before = await readSavedSecretCatalogInContext(context);
        if (!before.ok) return { ok: false, reason: 'unavailable' };
        if (before.resources.some(resource => isHealthySavedSecretResourceMaterialV1(resource) && resource.resourceId === resourceId)) {
            return { ok: false, reason: 'changed' };
        }
        context.assertCurrent();
        const value = 'secret' in params ? decryptSecretValueWithKeys(params.secret.encryptedValue,
            baseline.material ? deriveSettingsSecretsKeySet(baseline.material).readKeys : []) : params.credential.value;
        if (value === null) return { ok: false, reason: 'unavailable' };
        let promotedRecords: readonly ProfileRecordV1[] = profiles.records.map(({ record }) => record);
        let promotedCatalogs: SavedSecretReferenceCatalogFacets = catalogs;
        const { encryption: capturedEncryption } = await context.resolveAccountEncryption();
        const settingsSecretsKeys = await resolveSettingsSecretsKeySet({ credentials: context.credentials, scope: params.scope });
        context.assertCurrent();
        const mutation = await syncSettings({ credentials: context.credentials, encryption: capturedEncryption,
            settingsSecretsKey: settingsSecretsKeys?.writeKey ?? null, settingsSecretsReadKeys: settingsSecretsKeys?.readKeys ?? [],
            settingsScope: params.scope, requestContext: { scope: params.scope, endpointUrl: context.endpointUrl, request: context.request },
            pendingSettings: {}, clearPendingSettings: () => {}, oneShotServerSettingsMutation: {
            expectedSettingsVersion: params.expectedSettingsVersion,
            expectedProfileTransferRevision: profiles.controlRevision,
            rebaseOnConflict: false,
            mutate: (raw) => {
                context.assertCurrent();
                const promoted = 'secret' in params ? promotePersonalSavedSecretReference(raw, {
                    secretId: params.secret.id,
                    expectedUpdatedAt: params.secret.updatedAt,
                    sharedSecretRef: resourceRef,
                }, catalogs)
                    : promoteLegacyInferenceSavedSecretReferenceV1(raw, { source: params.credential.source, sharedSecretRef: resourceRef });
                promotedRecords = promoted.profileRecords ?? promotedRecords;
                promotedCatalogs = { ...catalogs, ...promoted };
                return { settings: { ...promoted.settings }, value: { resourceId, resourceRef } };
            },
            commitPrepared: async (prepared) => {
                context.assertCurrent();
                if (prepared.accountMode !== accountMode) {
                    return { status: 'rejected', error: new Error('saved_secret_account_mode_changed') };
                }
                const profileMutations = await prepareProfileRecordMutationsInContext(context, {
                    records: profiles.records.flatMap((row, index) => promotedRecords[index] === row.record
                        ? [] : [{ record: promotedRecords[index]!, revision: row.revision }]),
                    expectedMode: accountMode,
                    catalog: profiles,
                    artifactsById,
                    savedSecretRevisions: [{ resourceId, expectedRevision: 1 }],
                });
                const catalogMutations = await prepareSavedSecretReferenceCatalogMutationsInContext(context, {
                    catalogs: promotedCatalogs, previousCatalogs: catalogs, revisions: referenceCensus.catalogs ?? {},
                    accountMode, sourceSettingsVersion: prepared.expectedSettingsVersion, pendingResourceIds: [resourceId],
                });
                const { encryption } = await context.resolveAccountEncryption();
                if (prepared.accountMode === 'e2ee' && !encryption) {
                    return { status: 'rejected', error: new Error('saved_secret_encryption_unavailable') };
                }
                const preparedResourceDataKey = prepared.accountMode === 'e2ee'
                    ? getRandomBytes(32)
                    : null;
                promotionDataKey.value = preparedResourceDataKey;
                const storedContent = prepared.accountMode === 'plain'
                    ? sealSavedSecretResourceStoredContentV1({
                        resourceId,
                        mode: 'plain',
                        content: {
                            v: 1,
                            name: 'secret' in params ? params.secret.name : params.credential.displayName,
                            kind: 'secret' in params ? params.secret.kind : params.credential.kind,
                            value,
                        },
                    })
                    : preparedResourceDataKey
                        ? sealSavedSecretResourceStoredContentV1({
                            resourceId,
                            mode: 'e2ee',
                            resourceDataKey: preparedResourceDataKey,
                            content: {
                                v: 1,
                                name: 'secret' in params ? params.secret.name : params.credential.displayName,
                                kind: 'secret' in params ? params.secret.kind : params.credential.kind,
                                value,
                            },
                            randomBytes: getRandomBytes,
                        })
                        : null;
                if (!storedContent) {
                    return { status: 'rejected', error: new Error('saved_secret_encryption_unavailable') };
                }
                const keyEnvelopes = prepared.accountMode === 'e2ee' && encryption && preparedResourceDataKey
                    ? [sealOwnerSavedSecretResourceEnvelope(
                        params.scope.accountId,
                        preparedResourceDataKey,
                        encryption.contentDataKey,
                    )]
                    : [];
                const outcome = await runTeamAction({
                    scope: params.scope,
                    actionId: 'secrets.shared.promote',
                    input: {
                        resourceId,
                        displayName: 'secret' in params ? params.secret.name : params.credential.displayName,
                        kind: 'secret' in params ? params.secret.kind : params.credential.kind,
                        encryptionMode: prepared.accountMode,
                        storedContent,
                        accountGrants: [...params.accountGrants],
                        teamGrants: [...params.teamGrants],
                        groupGrants: [...params.groupGrants],
                        ...(keyEnvelopes.length > 0 ? { keyEnvelopes } : {}),
                        expectedSettingsVersion: prepared.expectedSettingsVersion,
                        nextSettings: prepared.content,
                        referenceCensus,
                        profileMutations,
                        ...('secret' in params ? { personalSecretPromotions: [{ personalSecretId: params.secret.id, resourceId }] } : {}),
                        ...(Object.keys(catalogMutations).length ? { catalogMutations } : {}),
                    },
                    parse: (value) => SharedSavedSecretPromoteOutputV1Schema.parse(value),
                    onApprovalSucceeded: async () => {
                        await repairApprovedSavedSecretResourceEnvelopesBestEffort({
                            scope: params.scope,
                            resourceId,
                            expectedRevision: 1,
                        }).catch(() => undefined);
                        await params.onApprovalSucceeded?.({ ok: true, resourceRef });
                    },
                    ...(params.onApprovalFailed ? { onApprovalFailed: params.onApprovalFailed } : {}),
                });
                context.assertResultCurrent('write');
                if (outcome.kind === 'succeeded') {
                    if (outcome.value.resourceId !== resourceId) return { status: 'outcomeUnknown' };
                    return { status: 'applied', settingsVersion: outcome.value.settingsVersion };
                }
                if (outcome.failure.kind === 'conflict') return { status: 'conflict' };
                if (outcome.failure.kind === 'outcome_unknown') return { status: 'outcomeUnknown' };
                return { status: 'rejected', error: new Error(`saved_secret_promotion_${outcome.failure.kind}`) };
            },
        } });
        if (mutation?.status === 'applied') {
            if (promotionDataKey.value) {
                await repairSavedSecretResourceEnvelopesBestEffort({
                    scope: params.scope,
                    resourceId,
                    expectedRevision: 1,
                    resourceDataKey: promotionDataKey.value,
                }).catch(() => undefined);
            }
            const after = await readProfileTransferSourceInContext(context);
            context.assertCurrent();
            if (after.mode !== accountMode || after.source.version !== mutation.settingsVersion
                || ('secret' in params ? readSavedSecretTransferSourceV1(after.source.raw).secrets.some(secret => secret.id === params.secret.id)
                    || listAccountSettingsSavedSecretReferences(after.source.raw, params.secret.id,
                        { ...catalogs, ...promotedCatalogs, profileRecords: promotedRecords }).length > 0
                    : readSavedSecretTransferSourceV1(after.source.raw).inferenceCredential !== undefined)) {
                return { ok: false, reason: 'outcome_unknown' };
            }
            return { ok: true, resourceRef, settingsVersion: mutation.settingsVersion, profileTransferRevision: profiles.controlRevision };
        }
        if (mutation?.status === 'conflict') return { ok: false, reason: 'changed' };

        // Resource presence does not prove the paired Settings/row source CAS.
        // Retain the draft and uncertainty; this path never replays a dispatch.
        return { ok: false, reason: 'outcome_unknown' };
    } catch (error) {
        if (isTeamActionApprovalPendingError(error)) throw error;
        return { ok: false, reason: 'failed' };
    } finally {
        promotionDataKey.value?.fill(0);
    }
}

async function normalizeTransferredSavedSecretHistoryInContext(context: ProfileAccountContext, scope: ServerAccountScope,
    transfers: readonly AccountSettingsHistorySavedSecretTransferV1[],
    expectedProfileTransferRevision?: number | 'absent',
    savedSecretRecovery?: AccountSettingsHistorySavedSecretRecoveryV1,
) {
    context.assertCurrent();
    const { encryption } = await context.resolveAccountEncryption();
    return normalizeAccountSettingsHistoryAfterTransfer({ credentials: context.credentials, encryption,
        expectedProfileTransferRevision,
        ...(savedSecretRecovery ? { savedSecretRecovery } : {}),
        settingsScope: scope, destinationAuthority: { activeTransferredRoots: [], savedSecretTransfers: transfers },
        requestContext: { request: context.request, isCurrent: () => {
            try { context.assertCurrent(); return true; } catch { return false; }
        } } });
}

/** The incumbent material-demand loader owns the one final catalog publication. */
export async function importLegacySavedSecretsInContext(context: ProfileAccountContext, mode: 'plain' | 'e2ee',
    scope: ServerAccountScope,
): Promise<SavedSecretLegacyImportResult> {
    const transfers: AccountSettingsHistorySavedSecretTransferV1[] = [];
    let pending: SavedSecretLegacyImportResult | null = null;
    let capturedControlRevision: number | 'absent' | undefined;
    let historyStarted = false;
    try {
        const initial = await readProfileTransferSourceInContext(context);
        if (initial.mode !== mode) return { status: 'pending', reason: 'source-unavailable' };
        const source = readSavedSecretTransferSourceV1(initial.source.raw);
        if (!source.complete) pending = { status: 'pending', reason: 'source-uncharacterized' };
        for (const secret of source.secrets) {
            context.assertCurrent();
            const before = await readProfileTransferSourceInContext(context);
            if (before.mode !== mode) return { status: 'pending', reason: 'source-unavailable' };
            const current = readSavedSecretTransferSourceV1(before.source.raw).secrets.find(candidate => candidate.id === secret.id);
            if (!current) continue;
            const result = await promoteSavedSecretSourceResourceInContext(context, mode, { scope,
                expectedSettingsVersion: before.source.version, secret: current, accountGrants: [], teamGrants: [], groupGrants: [] }, capturedControlRevision);
            if (!result.ok) {
                pending = { status: 'pending', reason: result.reason === 'changed' || result.reason === 'outcome_unknown'
                    ? result.reason : 'source-unavailable' };
                break;
            }
            capturedControlRevision ??= result.profileTransferRevision;
            transfers.push({ savedSecretId: current.id, resourceId: deriveSavedSecretImportResourceIdV1({ accountId: scope.accountId,
                source: { kind: 'personal-saved-secret', secretId: current.id } }), expectedRevision: 1 });
        }
        if (!pending || pending.reason === 'source-uncharacterized') {
            const before = await readProfileTransferSourceInContext(context);
            if (before.mode !== mode) return { status: 'pending', reason: 'source-unavailable' };
            const credential = readSavedSecretTransferSourceV1(before.source.raw).inferenceCredential;
            if (credential) {
                const result = await promoteSavedSecretSourceResourceInContext(context, mode, { scope,
                    expectedSettingsVersion: before.source.version, credential, accountGrants: [], teamGrants: [], groupGrants: [] }, capturedControlRevision);
                if (!result.ok) pending = { status: 'pending', reason: result.reason === 'changed' || result.reason === 'outcome_unknown'
                    ? result.reason : 'source-unavailable' };
                else {
                    capturedControlRevision ??= result.profileTransferRevision;
                    transfers.push({ source: credential.source, resourceId: deriveSavedSecretImportResourceIdV1({ accountId: scope.accountId,
                        source: credential.source }), expectedRevision: 1 });
                }
            }
        }
        const beforeHistory = await readProfileTransferSourceInContext(context);
        if (beforeHistory.mode !== mode) return { status: 'pending', reason: 'source-unavailable' };
        const catalog = await readSavedSecretCatalogInContext(context);
        if (!catalog.ok) return pending ?? { status: 'pending', reason: 'history-pending' };
        const { encryption } = await context.resolveAccountEncryption();
        const materialized = await materializeSavedSecretResources({ resources: catalog.resources,
            decryptDataKeyEnvelope: encryptedDataKey => encryption ? encryption.decryptEncryptionKey(encryptedDataKey, scope) : Promise.resolve(null) });
        context.assertCurrent();
        const usable = new Set(materialized.entries.filter(entry => entry.materialStatus === 'ready' && entry.capabilities.use).map(entry => entry.ref));
        const resources = catalog.resources.flatMap(resource => isHealthySavedSecretResourceMaterialV1(resource)
            && resource.entry.revision !== null && usable.has(resource.entry.ref)
            ? [{ resourceId: resource.resourceId, ownerAccountId: resource.entry.ownerAccountId ?? '',
                revision: resource.entry.revision, materialStatus: resource.entry.materialStatus }] : []);
        historyStarted = true;
        const cleanup = await normalizeTransferredSavedSecretHistoryInContext(context, scope, transfers, capturedControlRevision,
            { accountId: scope.accountId, source: beforeHistory.source, resources });
        if (cleanup.status !== 'complete') pending ??= { status: 'pending', reason: 'history-pending' };
        return pending ?? { status: 'complete' };
    } catch {
        // Previously acknowledged imports remain committed. Partial source or
        // history cleanup is independent of other valid resource material.
        return pending ?? { status: 'pending', reason: transfers.length || historyStarted ? 'history-pending' : 'source-unavailable' };
    }
}

/**
 * Rewrites an owned shared resource through the one update Action: its name,
 * its value, and — when the owner explicitly asks — the mode it is stored in.
 *
 * A conversion is the same write as a rotation: the content is opened in the
 * current mode and resealed in the requested one, so the resource keeps its id,
 * reference, recipients and revision line. Converting into E2EE seals a new
 * resource data key and carries the owner's own envelope, exactly as creation
 * does; the remaining recipients are then prepared by the existing census pass.
 * Converting into Plain discloses the value to the Home, which is why its
 * caller confirms the trust change before reaching this operation.
 */
export async function updateSavedSecretResource(params: Readonly<{
    scope: ServerAccountScope;
    resourceId: string;
    expectedRevision: number;
    nextName?: string;
    nextValue?: string;
    /** Explicit mode conversion; absent keeps the resource's current mode. */
    toMode?: 'plain' | 'e2ee';
    decryptDataKeyEnvelope: (encryptedDataKey: string) => Promise<Uint8Array | null>;
}> & SavedSecretApprovalHandlers<SavedSecretMutationOutput>): Promise<SavedSecretResourceOperationResult> {
    const { captureLazyActionAccountContext } = await import('@/sync/ops/actions/actionAccountContext');
    let context: ProfileAccountContext | undefined;
    try {
        context = await captureLazyActionAccountContext(params.scope.serverId);
        if (context.accountId !== params.scope.accountId) return { ok: false, reason: 'changed' };
        const accountMode = await context.resolveAccountMode();
        const catalog = await readSavedSecretCatalogInContext(context);
        context.assertCurrent();
        if (!catalog.ok) return { ok: false, reason: 'unavailable' };
        const resource = catalog.resources.find((candidate): candidate is HealthySavedSecretResourceMaterialV1 => (
            isHealthySavedSecretResourceMaterialV1(candidate)
            && candidate.resourceId === params.resourceId
        ));
        if (!resource || resource.entry.relationship !== 'owner' || resource.entry.materialStatus !== 'ready') {
            return { ok: false, reason: 'unavailable' };
        }
        if (resource.entry.revision !== params.expectedRevision) return { ok: false, reason: 'changed' };
        if (!resource.storedContent) return { ok: false, reason: 'unavailable' };

        let resourceDataKey: Uint8Array | null = null;
        let convertedResourceDataKey: Uint8Array | null = null;
        try {
            if (resource.encryptionMode === 'e2ee') {
                if (!resource.recipientEnvelope) return { ok: false, reason: 'unavailable' };
                resourceDataKey = await params.decryptDataKeyEnvelope(resource.recipientEnvelope.encryptedDataKey);
                if (!resourceDataKey) return { ok: false, reason: 'unavailable' };
            }
            const current = resource.encryptionMode === 'plain'
                ? openSavedSecretResourceStoredContentV1({
                    resourceId: resource.resourceId, mode: 'plain', storedContent: resource.storedContent,
                })
                : openSavedSecretResourceStoredContentV1({
                    resourceId: resource.resourceId, mode: 'e2ee', storedContent: resource.storedContent,
                    resourceDataKey: resourceDataKey!,
                });
            if (!current) return { ok: false, reason: 'unavailable' };
            const content = {
                ...current,
                ...(params.nextName === undefined ? {} : { name: params.nextName }),
                ...(params.nextValue === undefined ? {} : { value: params.nextValue }),
            };
            const nextMode = params.toMode ?? resource.encryptionMode;
            const encryption = nextMode === 'e2ee' && resource.encryptionMode === 'plain'
                ? (await context.resolveAccountEncryption()).encryption : null;
            context.assertCurrent();
            if (nextMode === 'e2ee' && resource.encryptionMode === 'plain') {
                // A Plain resource holds no data key, so the conversion seals one
                // and the owner's envelope travels with it.
                if (accountMode !== 'e2ee' || !encryption) return { ok: false, reason: 'unavailable' };
                convertedResourceDataKey = getRandomBytes(32);
            }
            const sealingDataKey = convertedResourceDataKey ?? resourceDataKey;
            const storedContent = nextMode === 'plain'
                ? sealSavedSecretResourceStoredContentV1({ resourceId: resource.resourceId, mode: 'plain', content })
                : sealSavedSecretResourceStoredContentV1({
                    resourceId: resource.resourceId,
                    mode: 'e2ee',
                    resourceDataKey: sealingDataKey!,
                    content,
                    randomBytes: getRandomBytes,
                });
            const keyEnvelopes = convertedResourceDataKey && encryption
                ? [sealOwnerSavedSecretResourceEnvelope(
                    params.scope.accountId,
                    convertedResourceDataKey,
                    encryption.contentDataKey,
                )]
                : [];
            // An approved-later conversion re-derives its data key from the
            // committed resource, since this call's copy is zeroed on return.
            const onApprovalSucceeded = convertedResourceDataKey && encryption
                ? async (value: SavedSecretMutationOutput) => {
                    await repairApprovedSavedSecretResourceEnvelopesBestEffort({
                        scope: params.scope,
                        resourceId: resource.resourceId,
                        expectedRevision: value.revision,
                    }).catch(() => undefined);
                    await params.onApprovalSucceeded?.(value);
                }
                : params.onApprovalSucceeded;
            const currentMode = (await fetchAccountEncryptionMode(context.credentials, { request: context.request })).mode;
            context.assertCurrent();
            if (currentMode !== accountMode) return { ok: false, reason: 'changed' };
            const outcome = await runTeamAction({
                scope: params.scope,
                actionId: 'secrets.shared.update',
                input: {
                    resourceId: resource.resourceId,
                    expectedRevision: params.expectedRevision,
                    displayName: content.name,
                    kind: content.kind,
                    storedContent,
                    ...(params.toMode ? { toMode: params.toMode } : {}),
                    ...(keyEnvelopes.length > 0 ? { keyEnvelopes } : {}),
                },
                parse: (value) => SharedSavedSecretMutationOutputV1Schema.parse(value),
                ...(onApprovalSucceeded ? { onApprovalSucceeded } : {}),
                ...(params.onApprovalFailed ? { onApprovalFailed: params.onApprovalFailed } : {}),
            });
            context.assertResultCurrent('write');
            if (outcome.kind !== 'succeeded') {
                return { ok: false, reason: operationFailureReason(outcome.failure.kind) };
            }
            if (convertedResourceDataKey) {
                await repairSavedSecretResourceEnvelopesBestEffort({
                    scope: params.scope,
                    resourceId: resource.resourceId,
                    expectedRevision: outcome.value.revision,
                    resourceDataKey: convertedResourceDataKey,
                }).catch(() => undefined);
            }
            return { ok: true };
        } catch (error) {
            if (isTeamActionApprovalPendingError(error)) throw error;
            return { ok: false, reason: 'failed' };
        } finally {
            resourceDataKey?.fill(0);
            convertedResourceDataKey?.fill(0);
        }
    } catch (error) {
        if (isTeamActionApprovalPendingError(error)) throw error;
        return { ok: false, reason: 'failed' };
    } finally {
        context?.dispose();
    }
}

export async function deleteSavedSecretResource(params: Readonly<{
    scope: ServerAccountScope;
    resourceId: string;
    expectedRevision: number;
    /** Owner's current Account Settings version; the reference census reads at it. */
    expectedSettingsVersion: number;
    confirmedByPresentUser?: true;
    managedResourceDispositions?: readonly ManagedResourceDispositionV1[];
}> & Omit<SavedSecretApprovalHandlers<SavedSecretDeleteOutput>, 'onApprovalFailed'> & Readonly<{
    /** The same owner-decoded result for immediate and Inbox-executed refusals. */
    onApprovalFailed?: (code: string, result: SavedSecretResourceDeleteFailure) => void;
}>): Promise<SavedSecretResourceDeleteResult> {
    const resourceRef = formatSavedSecretCatalogReferenceV1({ kind: 'shared_resource', id: params.resourceId });
    try {
        return await withProfileAccount<SavedSecretResourceDeleteResult>(params.scope, undefined, async (context, accountMode) => {
            const captured = await captureSavedSecretReferenceStateInContext(context, accountMode, {
                expectedSettingsVersion: params.expectedSettingsVersion,
            });
            if (!captured.ok) return captured;
            const { profiles, catalogs, referenceCensus } = captured;
            const { encryption } = await context.resolveAccountEncryption();
            const settingsSecretsKeys = await resolveSettingsSecretsKeySet({ credentials: context.credentials, scope: params.scope });
            context.assertCurrent();
            const census = await syncSettings({ credentials: context.credentials, encryption,
                settingsSecretsKey: settingsSecretsKeys?.writeKey ?? null, settingsSecretsReadKeys: settingsSecretsKeys?.readKeys ?? [],
                settingsScope: params.scope, requestContext: { scope: params.scope, endpointUrl: context.endpointUrl, request: context.request },
                pendingSettings: {}, clearPendingSettings: () => {}, oneShotServerSettingsMutation: {
                    expectedSettingsVersion: params.expectedSettingsVersion,
                    expectedProfileTransferRevision: profiles.controlRevision,
                    rebaseOnConflict: false,
                    mutate(raw) {
                        context.assertCurrent();
                        return { settings: { ...raw }, value: listAccountSettingsSavedSecretReferences(raw, resourceRef, catalogs) };
                    },
                } });
            if (census?.status !== 'applied') return { ok: false, reason: 'changed' };
            if (census.value.length > 0) return { ok: false, reason: 'in_use', references: census.value };
            context.assertCurrent();
            const outcome = await runTeamAction({ scope: params.scope, actionId: 'secrets.shared.delete',
                input: { resourceId: params.resourceId, expectedRevision: params.expectedRevision,
                    expectedSettingsVersion: params.expectedSettingsVersion,
                    referenceCensus,
                    ...(params.managedResourceDispositions ? { managedResourceDispositions: params.managedResourceDispositions } : {}),
                },
                parse: value => SharedSavedSecretDeleteOutputV1Schema.parse(value),
                ...(params.confirmedByPresentUser ? { approval: 'surface_confirmed' } : {}),
                ...(params.onApprovalSucceeded ? { onApprovalSucceeded: params.onApprovalSucceeded } : {}),
                ...(params.onApprovalFailed ? { onApprovalFailed: (code, failure) => params.onApprovalFailed?.(
                    code, savedSecretDeleteFailure(homeDomainFailureFromActionFailure(failure ?? { errorCode: code })),
                ) } : {}),
            });
            if (outcome.kind === 'succeeded') return { ok: true };
            const failure = savedSecretDeleteFailure(outcome.failure);
            if (failure.reason === 'managed_resources_review_required') context.assertCurrent();
            return failure;
        });
    } catch (error) {
        if (isTeamActionApprovalPendingError(error)) throw error;
        return { ok: false, reason: 'failed' };
    }
}

export async function setSavedSecretResourceGrants(params: Readonly<{
    scope: ServerAccountScope;
    resourceId: string;
    expectedRevision: number;
    encryptionMode: 'plain' | 'e2ee';
    accountGrants: readonly string[];
    teamGrants: readonly string[];
    groupGrants: readonly string[];
    decryptDataKeyEnvelope: (encryptedDataKey: string) => Promise<Uint8Array | null>;
}> & SavedSecretApprovalHandlers<SavedSecretMutationOutput>): Promise<SavedSecretResourceOperationResult> {
    let resourceDataKey: Uint8Array | null = null;
    try {
        if (params.encryptionMode === 'e2ee') {
            const catalog = await readSavedSecretCatalog(params.scope);
            if (!catalog.ok) return { ok: false, reason: 'unavailable' };
            const resource = catalog.resources.find((candidate): candidate is HealthySavedSecretResourceMaterialV1 => (
                isHealthySavedSecretResourceMaterialV1(candidate)
                && candidate.resourceId === params.resourceId
            ));
            if (!resource?.recipientEnvelope || resource.entry.revision !== params.expectedRevision) {
                return { ok: false, reason: resource ? 'changed' : 'unavailable' };
            }
            resourceDataKey = await params.decryptDataKeyEnvelope(resource.recipientEnvelope.encryptedDataKey);
            if (!resourceDataKey) return { ok: false, reason: 'unavailable' };

        }

        const finishApproved = async (value: SavedSecretMutationOutput) => {
            if (params.encryptionMode === 'e2ee') {
                await repairApprovedSavedSecretResourceEnvelopesBestEffort({
                    scope: params.scope,
                    resourceId: params.resourceId,
                    expectedRevision: value.revision,
                    decryptDataKeyEnvelope: params.decryptDataKeyEnvelope,
                }).catch(() => undefined);
            }
            await params.onApprovalSucceeded?.(value);
        };
        const outcome = await runTeamAction({
            scope: params.scope,
            actionId: 'secrets.shared.grants.set',
            input: {
                resourceId: params.resourceId,
                expectedRevision: params.expectedRevision,
                accountGrants: [...params.accountGrants],
                teamGrants: [...params.teamGrants],
                groupGrants: [...params.groupGrants],
            },
            parse: (value) => SharedSavedSecretMutationOutputV1Schema.parse(value),
            onApprovalSucceeded: finishApproved,
            ...(params.onApprovalFailed ? { onApprovalFailed: params.onApprovalFailed } : {}),
        });
        if (outcome.kind !== 'succeeded') {
            return { ok: false, reason: operationFailureReason(outcome.failure.kind) };
        }
        if (params.encryptionMode === 'e2ee' && resourceDataKey) {
            await repairSavedSecretResourceEnvelopesBestEffort({
                scope: params.scope,
                resourceId: params.resourceId,
                expectedRevision: outcome.value.revision,
                resourceDataKey,
            }).catch(() => undefined);
        }
        return { ok: true };
    } catch (error) {
        if (isTeamActionApprovalPendingError(error)) throw error;
        return { ok: false, reason: 'failed' };
    } finally {
        resourceDataKey?.fill(0);
    }
}
