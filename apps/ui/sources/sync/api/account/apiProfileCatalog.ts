import {
    PROFILE_ROWS_ROUTE_V1, PROFILE_RECORDS_ROUTE_V1, PROFILE_REFERENCE_GUARD_ROUTE_V1, ProfileReferenceGuardReadResponseV1Schema, ProfileRowsListResponseV1Schema,
    ProfileRowMutationResponseV1Schema, ProfileRowMutationV1Schema, sealProfileRecordContentV1, ProfileSecretPromotionRequiredError,
    parseProfileRecordForMutationV1,
    type ProfileRecordV1, type ProfileRowMutationV1,
} from '@happier-dev/protocol/profiles/profileRecordV1';
import { loadProfileCatalogV1, type ProfileCatalogSnapshotV1 } from '@happier-dev/protocol/profiles/profileCatalogV1';
import type { AccountScopedCryptoMaterial } from '@happier-dev/protocol/crypto/accountScopedCipher';
import type { ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';
import { resolveAccountScopedCryptoMaterialFromCredentials } from '@/sync/domains/connectedServices/resolveAccountScopedCryptoMaterialFromCredentials';
import { resolveAccountStorageContext } from '@/sync/encryption/accountStorageContext';
import { getRandomBytes } from '@/platform/cryptoRandom';
import { classifyHttpMutationRequestFailure } from '@/sync/http/mutationRequestOutcome';
import { isLegacyProfileSourcePreservingCloneV1, loadAiLaunchProfileArtifacts, removeProfilePreferenceReferencesV1, readLegacyProfileRecordsV1,
    readAiLaunchProfileRecords, resolveProfileCatalogAuthorityV1, readEffectiveProfileSecretBindingsV1,
    type AiLaunchProfile, type AiLaunchProfileReadDiagnostic, type LegacyProfileRecordPreparationV1 } from '@happier-dev/protocol/profiles/read';
import { prepareBuiltinProfileAttachmentV1 } from '@happier-dev/protocol/profiles/profileOperations';
import { transferLegacyProfilesV1, cleanupTransferredProfileSourcesV1,
    type LegacyProfileTransferResultV1, type ProfileTransferSourceCleanupResultV1 } from '@happier-dev/protocol/profiles/transferLegacyProfilesV1';
import { normalizeAccountSettingsHistoryAfterTransfer } from '@/sync/engine/settings/accountSettingsHistoryRestore';
import type { ArtifactSharingResourceV1 } from '@happier-dev/protocol/artifacts/artifactSharingV1';
import { readAccountSettingsBaseline } from '@/sync/engine/settings/accountSettingsBaseline';
import { sealAccountScopedBlobCiphertext } from '@happier-dev/protocol/crypto/accountScopedCipher';
import { parseSavedSecretCatalogReferenceV1 } from '@happier-dev/protocol/account/settings/savedSecretCatalogV1';
import { readSavedSecretCatalogInContext } from './apiSavedSecretCatalog';
import { getSyncSingleton } from '@/sync/runtime/getSyncSingleton';
import { getStorage } from '@/sync/domains/state/storageStore';
import { areAccountSettingsScopesEqual } from '@/sync/domains/settings/scope/accountSettingsScope';
import { PROFILE_TRANSFER_ROUTE_V1, ProfileTransferRowReadResponseV1Schema, ProfileTransferMutationV1Schema,
    ProfileTransferMutationResponseV1Schema, assertProfileTransferContentForModeV1,
    type ProfileTransferMutationV1, type ProfileTransferMutationResponseV1 } from '@happier-dev/protocol/profiles/profileTransferV1';

export type ProfileRowMutationResponseV1 = ReturnType<typeof ProfileRowMutationResponseV1Schema.parse>;

export class ProfileRowOperationError extends Error {
    constructor(readonly code: string, readonly cause?: unknown) {
        super(code);
        this.name = 'ProfileRowOperationError';
    }
}

export type ProfileAccountContext = Awaited<ReturnType<typeof import('@/sync/ops/actions/actionAccountContext').captureLazyActionAccountContext>>;

async function admitProfileAccount<T>(context: ProfileAccountContext,
    operation: (context: ProfileAccountContext, mode: 'plain' | 'e2ee', material: AccountScopedCryptoMaterial | null) => Promise<T>): Promise<T> {
    const { encryption } = await context.resolveAccountEncryption();
    const storage = await resolveAccountStorageContext(context.credentials, { encryption, request: context.request });
    context.assertCurrent();
    const material = storage.mode === 'plain' ? null : resolveAccountScopedCryptoMaterialFromCredentials(context.credentials);
    return operation(context, storage.mode, material);
}

/** The incumbent Action context captures Home, Account, credential and key lifetime once. */
export async function withProfileAccount<T>(scope: ServerAccountScope, signal: AbortSignal | undefined,
    operation: (context: ProfileAccountContext, mode: 'plain' | 'e2ee', material: AccountScopedCryptoMaterial | null) => Promise<T>): Promise<T> {
    const { captureLazyActionAccountContext } = await import('@/sync/ops/actions/actionAccountContext');
    const context = await captureLazyActionAccountContext(scope.serverId, signal);
    try {
        if (context.accountId !== scope.accountId) throw new ProfileRowOperationError('scope-retired');
        return await admitProfileAccount(context, operation);
    } finally {
        context.dispose();
    }
}

async function readResponse(context: ProfileAccountContext, path: string, signal?: AbortSignal): Promise<unknown> {
    const response = await context.request(path, { method: 'GET', signal }, { retry: 'none' });
    context.assertCurrent();
    if (response.status === 401) throw new ProfileRowOperationError('unauthorized');
    if (response.status === 403) throw new ProfileRowOperationError('forbidden');
    if (response.status === 404) throw new ProfileRowOperationError('unsupported');
    if (response.status >= 500 || response.status === 408 || response.status === 429) throw new ProfileRowOperationError('unreachable');
    const value: unknown = await response.json();
    context.assertCurrent();
    return value;
}

/** Full opened inventory; partial data can be displayed but cannot authorize a write or conversion. */
async function readCapturedProfileCatalog(context: ProfileAccountContext, mode: 'plain' | 'e2ee', material: AccountScopedCryptoMaterial | null,
    signal?: AbortSignal, readSource?: () => Promise<unknown>): Promise<ProfileCatalogSnapshotV1> {
    const catalog = await loadProfileCatalogV1({ mode, material, signal,
        ...(readSource ? { readSource } : {}),
        readPage: async cursor => ProfileRowsListResponseV1Schema.parse(await readResponse(context,
            `${PROFILE_ROWS_ROUTE_V1}${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ''}`, signal)),
        readReferenceGuard: async () => ProfileReferenceGuardReadResponseV1Schema.parse(await readResponse(context,
            PROFILE_REFERENCE_GUARD_ROUTE_V1, signal)),
        readTransfer: async () => ProfileTransferRowReadResponseV1Schema.parse(await readResponse(context,
            PROFILE_TRANSFER_ROUTE_V1, signal)),
    });
    const { encryption } = await context.resolveAccountEncryption();
    const current = await resolveAccountStorageContext(context.credentials, { encryption, request: context.request });
    context.assertCurrent();
    return current.mode === mode ? catalog : { status: 'unavailable', reason: 'account-mode-mismatch' };
}
function catalogFailure(error: unknown, signal?: AbortSignal): ProfileCatalogSnapshotV1 {
    if (signal?.aborted) return { status: 'unavailable', reason: 'cancelled' };
    if (error instanceof ProfileRowOperationError && (error.code === 'unauthorized' || error.code === 'forbidden'
        || error.code === 'unsupported' || error.code === 'scope-retired')) return { status: 'unavailable', reason: error.code };
    if (error instanceof Error) {
        // The incumbent capture uses these code strings as messages for setup refusals.
        const code = 'code' in error ? error.code : error.message;
        if (code === 'action_account_scope_changed' || code === 'action_home_not_found') return { status: 'unavailable', reason: 'scope-retired' };
        if (code === 'action_home_signed_out') return { status: 'unavailable', reason: 'unauthorized' };
        if (code === 'account_storage_currentness_unavailable') return { status: 'unavailable', reason: 'encryption-material-unavailable' };
    }
    if (error instanceof Error && error.name === 'ZodError') return { status: 'unavailable', reason: 'invalid-stored-content' };
    return { status: 'unavailable', reason: 'unreachable' };
}
export async function readProfileCatalog(scope: ServerAccountScope, signal?: AbortSignal): Promise<ProfileCatalogSnapshotV1> {
    try {
        return await withProfileAccount(scope, signal, async (context, mode, material) => {
            const catalog = await readCapturedProfileCatalog(context, mode, material, signal);
            context.assertCurrent();
            return catalog;
        });
    } catch (error) {
        return catalogFailure(error, signal);
    }
}

export type ProfileCatalogProjection = Readonly<{
    catalog: ProfileCatalogSnapshotV1;
    artifactsById: ReadonlyMap<string, ArtifactSharingResourceV1>;
    source: 'destination' | 'legacy' | null;
    legacyProfiles?: readonly AiLaunchProfile[];
    legacyDiagnostics?: readonly (AiLaunchProfileReadDiagnostic | LegacyProfileRecordPreparationV1['diagnostics'][number])[];
    transfer?: LegacyProfileTransferResultV1;
    cleanup?: ProfileTransferSourceCleanupResultV1;
}>;
/** UI projection loads granted Artifacts at the very same captured Home, never the focused store. */
type ProfileReadPublication = Readonly<{
    onReady?: (projection: ProfileCatalogProjection, isAccountCurrent: () => boolean) => void;
    hasPendingCleanup?: () => boolean;
}>;
export async function readProfileCatalogProjection(scope: ServerAccountScope, signal?: AbortSignal,
    publication?: ProfileReadPublication): Promise<ProfileCatalogProjection> {
    try {
        return await withProfileAccount(scope, signal, (context, mode, material) => readCapturedProfileCatalogProjection(context, mode, material, signal, publication));
    } catch (error) { return { catalog: catalogFailure(error, signal), artifactsById: new Map(), source: null }; }
}
async function readCapturedProfileCatalogProjection(context: ProfileAccountContext, mode: 'plain' | 'e2ee', material: AccountScopedCryptoMaterial | null,
    signal?: AbortSignal, publication?: ProfileReadPublication): Promise<ProfileCatalogProjection> {
    const capturedSource: { baseline: Awaited<ReturnType<typeof readProfileTransferSourceInContext>> | null } = { baseline: null };
    let catalog = await readCapturedProfileCatalog(context, mode, material, signal, async () => {
        capturedSource.baseline = await readProfileTransferSourceInContext(context);
        return capturedSource.baseline.source.raw;
    });
    if (catalog.status !== 'ready' && catalog.status !== 'partial') return { catalog, artifactsById: new Map(), source: null };
    // An opened active control is destination authority even when stale source roots remain.
    // Every other case needs the genuine baseline; row presence never decides the source.
    if (!catalog.source) return { catalog: { status: 'unavailable', reason: 'invalid-stored-content' }, artifactsById: new Map(), source: null };
    const baseline = capturedSource.baseline;
    let source = catalog.source;
    const references = [...catalog.records.map(row => row.record),
        ...(source === 'legacy' && Array.isArray(baseline?.source.raw.profiles) ? baseline.source.raw.profiles : [])];
    const artifactsById = await loadAiLaunchProfileArtifacts(references, context.workflowArtifacts, signal);
    context.assertCurrent();
    let transfer: LegacyProfileTransferResultV1 | undefined;
    let cleanup: ProfileTransferSourceCleanupResultV1 | undefined;
    if (source === 'legacy' && baseline && catalog.status === 'ready') {
        transfer = await transferLegacyProfilesV1({ source: baseline.source, catalog, artifactsById,
            // UI has no admitted Machine Provider descriptor lease. The canonical transfer
            // owner refuses historical environment classification, not display/repair.
            providerContributions: null, homeServerId: context.serverId, mode, material, assertCurrent: context.assertCurrent, signal, randomBytes: getRandomBytes,
            readSavedSecretRevisions: async refs => {
                const metadata = await readSavedSecretCatalogInContext(context, signal);
                context.assertCurrent();
                if (!metadata.ok) return { status: 'unavailable' };
                const resourcesByRef = new Map<string, Readonly<{ resourceId: string; revision: number }>>();
                for (const ref of refs) {
                    const parsed = parseSavedSecretCatalogReferenceV1(ref);
                    const resource = parsed?.kind === 'shared_resource' ? metadata.resources.find(row => 'resourceId' in row && row.resourceId === parsed.id) : undefined;
                    if (!resource || !('resourceId' in resource) || resource.entry.materialStatus !== 'ready'
                        || !resource.entry.capabilities.use || resource.entry.revision === null) return { status: 'partial' };
                    resourcesByRef.set(ref, { resourceId: resource.resourceId, revision: resource.entry.revision });
                }
                return { status: 'ready', resourcesByRef };
            },
            readArtifactRevisions: async ids => {
                const resourcesByRef = new Map<string, Readonly<{ headerVersion: number; bodyVersion: number }>>();
                for (const id of ids) {
                    // Definition bodies were already authorized at this exact composite version.
                    const artifact = artifactsById.get(id) ?? await context.workflowArtifacts.read(id, { signal });
                    context.assertCurrent();
                    if (!artifact?.revision) return { status: 'partial' };
                    resourcesByRef.set(id, artifact.revision);
                }
                return { status: 'ready', resourcesByRef };
            },
            mutateTransfer: mutation => mutateProfileTransferInContext(context, mutation, signal),
            reloadCatalog: () => readCapturedProfileCatalog(context, mode, material, signal),
        });
        context.assertCurrent();
        if (transfer.status === 'active') {
            catalog = await readCapturedProfileCatalog(context, mode, material, signal);
            if (catalog.status !== 'ready' || catalog.control?.record.phase !== 'active'
                || catalog.control.revision !== transfer.revision) return { catalog: { status: 'unavailable', reason: 'reference-conflict' }, artifactsById: new Map(), source: null };
            source = resolveProfileCatalogAuthorityV1({ rawSettings: undefined, control: catalog.control.record });
        }
    }
    const project = async (): Promise<ProfileCatalogProjection> => {
        const { encryption } = await context.resolveAccountEncryption();
        const current = await resolveAccountStorageContext(context.credentials, { encryption, request: context.request });
        context.assertCurrent();
        if (current.mode !== mode) return { catalog: { status: 'unavailable', reason: 'account-mode-mismatch' }, artifactsById: new Map(), source: null };
        if (catalog.status !== 'ready' && catalog.status !== 'partial') return { catalog, artifactsById: new Map(), source: null };
        const openedLegacy = source === 'legacy' && baseline ? readLegacyProfileRecordsV1(baseline.source.raw, { artifactsById }) : null;
        const legacy = openedLegacy ? readAiLaunchProfileRecords(openedLegacy.records, { artifactsById, includeShared: true }) : null;
        return { catalog: { ...catalog, source }, artifactsById, source,
            ...(legacy && openedLegacy ? { legacyProfiles: legacy.entries.flatMap(entry => entry.kind === 'opaque' ? [] : [entry.profile]),
                legacyDiagnostics: [...openedLegacy.diagnostics, ...legacy.diagnostics] } : {}),
            ...(transfer ? { transfer } : {}), ...(cleanup ? { cleanup } : {}) };
    };
    // Resume pending source/history cleanup on later demand too. Destination edits
    // do not undo historical activation; the shared owner never rewrites those rows.
    if ((catalog.status === 'ready' || catalog.status === 'partial') && catalog.control?.record.phase === 'active') {
        if (publication?.onReady) publication.onReady(await project(), context.accountLifetime.isCurrent);
        if (!publication?.hasPendingCleanup?.()) cleanup = await cleanupTransferredProfileSourcesV1({ control: catalog.control, assertCurrent: context.assertCurrent, signal,
            reloadCatalog: () => readCapturedProfileCatalog(context, mode, material, signal),
            readSource: async () => (await readProfileTransferSourceInContext(context)).source,
            replaceSource: input => context.mutateRawSettings(() => ({ ...input.raw }), {
                expectedSettingsVersion: input.expectedVersion, expectedProfileTransferRevision: input.expectedProfileTransferRevision,
                rebaseOnConflict: false, observeOutcome: true,
            }),
            normalizeHistory: async input => {
                const { encryption } = await context.resolveAccountEncryption();
                return normalizeAccountSettingsHistoryAfterTransfer({ credentials: context.credentials, encryption,
                    settingsScope: { serverId: context.serverId, accountId: context.accountId },
                    destinationAuthority: { activeTransferredRoots: input.activeTransferredRoots },
                    expectedProfileTransferRevision: input.expectedProfileTransferRevision,
                    requestContext: { request: context.request, isCurrent: () => context.accountLifetime.isCurrent() } });
            },
        });
    }
    return project();
}

async function mutateWithContext(context: ProfileAccountContext, mutation: ProfileRowMutationV1, signal?: AbortSignal): Promise<ProfileRowMutationResponseV1> {
    const input = ProfileRowMutationV1Schema.parse(mutation);
    const result = await requestProfileMutation(context, PROFILE_RECORDS_ROUTE_V1, input,
        value => { const parsed = ProfileRowMutationResponseV1Schema.safeParse(value); return parsed.success ? parsed.data : null; }, signal);
    if (result.status === 'updated' && input.settingsCleanup && context.accountLifetime.isCurrent()
        && areAccountSettingsScopesEqual(getStorage().getState().settingsScope, context.accountLifetime.scope)) {
        try {
            await getSyncSingleton().refreshAccountSettingsFromServer(input.settingsCleanup.expectedSettingsVersion + 1,
                context.accountLifetime.scope);
        } catch {
            // A source reload failure cannot retract the durable transaction ACK.
        }
    }
    return result;
}
async function requestProfileMutation<T>(context: ProfileAccountContext, path: string, input: unknown,
    parse: (value: unknown) => T | null, signal?: AbortSignal): Promise<T> {
    context.assertCurrent();
    let response: Response;
    try {
        response = await context.request(path, {
            method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(input), signal,
        }, { retry: 'none' });
    } catch (error) {
        const outcome = classifyHttpMutationRequestFailure({ error, issued: true, signal });
        throw new ProfileRowOperationError(outcome === 'not_dispatched' ? 'unreachable' : outcome, error);
    }
    const parsed = parse(await response.json().catch(() => null));
    if (parsed === null) throw new ProfileRowOperationError(response.ok ? 'outcome_unknown' : `profile_row_http_${response.status}`);
    return parsed;
}

/** Transfer orchestration owns the proof; this owner admits and dispatches the actual Account carrier. */
export function mutateProfileTransferInContext(context: ProfileAccountContext, mutation: ProfileTransferMutationV1,
    signal?: AbortSignal): Promise<ProfileTransferMutationResponseV1> {
    return admitProfileAccount(context, (captured, mode) => {
        const input = ProfileTransferMutationV1Schema.parse(mutation);
        assertProfileTransferContentForModeV1(input.content, mode);
        return requestProfileMutation(captured, PROFILE_TRANSFER_ROUTE_V1, input,
            value => { const parsed = ProfileTransferMutationResponseV1Schema.safeParse(value); return parsed.success ? parsed.data : null; }, signal);
    });
}

/** Genuine predecessor read and mode/key admission share the caller's existing Account capture. */
export function readProfileTransferSourceInContext(context: ProfileAccountContext): Promise<Readonly<{
    source: Readonly<{ raw: Readonly<Record<string, unknown>>; version: number }>;
    mode: 'plain' | 'e2ee'; material: AccountScopedCryptoMaterial | null;
}>> {
    return admitProfileAccount(context, async (captured, mode, material) => {
        const { encryption } = await captured.resolveAccountEncryption();
        const baseline = await readAccountSettingsBaseline({ credentials: captured.credentials, encryption, accountMode: mode,
            request: (path, init) => captured.request(path, init, { retry: 'none' }) });
        captured.assertCurrent();
        return { source: { raw: baseline.raw ?? {}, version: baseline.version }, mode, material };
    });
}

/** For composite resource operations whose canonical owner already sealed its row change. */
export async function mutateProfileRow(scope: ServerAccountScope, mutation: ProfileRowMutationV1, signal?: AbortSignal): Promise<ProfileRowMutationResponseV1> {
    return withProfileAccount(scope, signal, context => mutateWithContext(context, mutation, signal));
}

/** Actions reuse their admitted context; this never acquires a second Home or credential capture. */
export async function readProfileCatalogInContext(context: ProfileAccountContext, signal?: AbortSignal,
    options?: Readonly<{ readSourceBaseline: true }>): Promise<ProfileCatalogSnapshotV1> {
    try { return await admitProfileAccount(context, (captured, mode, material) => readCapturedProfileCatalog(captured, mode, material, signal,
        options?.readSourceBaseline ? async () => (await readProfileTransferSourceInContext(captured)).source.raw : undefined)); }
    catch (error) { return catalogFailure(error, signal); }
}
export async function readProfileCatalogProjectionInContext(context: ProfileAccountContext, signal?: AbortSignal): Promise<ProfileCatalogProjection> {
    try { return await admitProfileAccount(context, (captured, mode, material) => readCapturedProfileCatalogProjection(captured, mode, material, signal)); }
    catch (error) { return { catalog: catalogFailure(error, signal), artifactsById: new Map(), source: null }; }
}
export function mutateProfileRowInContext(context: ProfileAccountContext, mutation: ProfileRowMutationV1, signal?: AbortSignal): Promise<ProfileRowMutationResponseV1> {
    return admitProfileAccount(context, captured => mutateWithContext(captured, mutation, signal));
}

type ProfileWriteInput = Readonly<{ record: ProfileRecordV1; expectedRevision: number | 'absent'; operation: Exclude<ProfileRowMutationV1['operation'], 'remove' | 'import'>;
    savedSecretRevisions?: ProfileRowMutationV1['savedSecretRevisions']; legacyCloneSource?: ProfileRowMutationV1['legacyCloneSource']; }>;
type ProfileSealInput = Omit<ProfileWriteInput, 'operation'> & Readonly<{
    operation: Exclude<ProfileRowMutationV1['operation'], 'remove'>;
    settingsCleanup?: ProfileRowMutationV1['settingsCleanup'];
}>;
function sealProfileSettingsCleanup(mode: 'plain' | 'e2ee', material: AccountScopedCryptoMaterial | null,
    version: number, raw: Readonly<Record<string, unknown>>): NonNullable<ProfileRowMutationV1['settingsCleanup']> {
    if (mode === 'plain') return { expectedSettingsVersion: version, nextSettings: { t: 'plain', v: raw } };
    if (!material) throw new ProfileRowOperationError('encryption-material-unavailable');
    return { expectedSettingsVersion: version, nextSettings: { t: 'encrypted', c: sealAccountScopedBlobCiphertext({
        kind: 'account_settings', material, payload: raw, randomBytes: getRandomBytes,
    }) } };
}
function readProfileMutationReferences(record: ProfileRecordV1, artifactsById: ReadonlyMap<string, ArtifactSharingResourceV1>) {
    const bindings = readEffectiveProfileSecretBindingsV1(record, { artifactsById });
    if (!bindings) throw new ProfileRowOperationError('invalid-reference');
    const referencedSavedSecretIds = [...new Set(Object.values(bindings))];
    if (record.definition.kind !== 'artifact') return { referencedSavedSecretIds, artifactRevision: null };
    const artifactId = record.definition.artifactId;
    const resource = artifactsById.get(artifactId);
    if (!resource?.revision) throw new ProfileRowOperationError('invalid-reference');
    return { referencedSavedSecretIds, artifactRevision: { artifactId,
        headerVersion: resource.revision.headerVersion, bodyVersion: resource.revision.bodyVersion } };
}
type ProfileMutationReferences = ReturnType<typeof readProfileMutationReferences>;
async function writeCapturedProfileRecord(context: ProfileAccountContext, mode: 'plain' | 'e2ee', material: AccountScopedCryptoMaterial | null,
    input: ProfileWriteInput, signal?: AbortSignal): Promise<ProfileRowMutationResponseV1> {
    let record = input.record;
    let settingsCleanup: ProfileRowMutationV1['settingsCleanup'];
    if (input.operation === 'clone-legacy') {
        const capture = input.legacyCloneSource;
        if (!capture) throw new ProfileRowOperationError('invalid-reference');
        const catalog = await readCapturedProfileCatalog(context, mode, material, signal);
        context.assertCurrent();
        if (catalog.status !== 'ready' || catalog.source !== 'destination') throw new ProfileRowOperationError('invalid-reference');
        const source = catalog.records.find(row => row.record.id === capture.id);
        if (!source || source.revision !== capture.revision) throw new ProfileRowOperationError('reference-conflict');
        const artifactsById = await loadAiLaunchProfileArtifacts([source.record], {
            read: (id, options) => context.workflowArtifacts.read(id, options),
        }, signal);
        context.assertCurrent();
        const artifact = source.record.definition.kind === 'artifact' ? artifactsById.get(source.record.definition.artifactId) : undefined;
        if (source.record.definition.kind === 'artifact' ? (!capture.artifactRevision || !artifact?.revision
            || capture.artifactRevision.artifactId !== artifact.artifactId || capture.artifactRevision.headerVersion !== artifact.revision.headerVersion
            || capture.artifactRevision.bodyVersion !== artifact.revision.bodyVersion) : capture.artifactRevision !== undefined)
            throw new ProfileRowOperationError('reference-conflict');
        if (!isLegacyProfileSourcePreservingCloneV1({ source: source.record, record, artifactsById }))
            throw new ProfileRowOperationError('invalid-reference');
    }
    if (input.operation === 'attach-builtin') {
        const { encryption } = await context.resolveAccountEncryption();
        const baseline = await readAccountSettingsBaseline({ credentials: context.credentials, encryption, accountMode: mode,
            request: (path, init) => context.request(path, { ...init, signal }, { retry: 'none' }) });
        context.assertCurrent();
        const prepared = prepareBuiltinProfileAttachmentV1(record, baseline.raw ?? {});
        record = prepared.record;
        settingsCleanup = sealProfileSettingsCleanup(mode, material, baseline.version, prepared.nextSettings);
    }
    const artifactsById = record.definition.kind === 'artifact'
        ? await loadAiLaunchProfileArtifacts([record], { read: (id, options) => context.workflowArtifacts.read(id, options) }, signal)
        : new Map<string, ArtifactSharingResourceV1>();
    context.assertCurrent();
    const references = readProfileMutationReferences(record, artifactsById);
    const savedSecretRevisions = await resolveProfileSecretRevisions(context, [references], input.savedSecretRevisions, false, false, signal);
    return mutateWithContext(context, sealProfileMutation(mode, material, { ...input, record, settingsCleanup, savedSecretRevisions }, references), signal);
}
/** The resource catalog owns reference decoding, usability and current revision admission. */
async function resolveProfileSecretRevisions(context: ProfileAccountContext, references: readonly ProfileMutationReferences[],
    capturedRevisions: ProfileRowMutationV1['savedSecretRevisions'], allowCreatedResource: boolean, allowPersonalStaging: boolean,
    signal?: AbortSignal): Promise<NonNullable<ProfileRowMutationV1['savedSecretRevisions']>> {
    const ids = new Set<string>();
    for (const reference of references) for (const ref of reference.referencedSavedSecretIds) {
        const parsed = parseSavedSecretCatalogReferenceV1(ref);
        if (!parsed || (parsed.kind === 'personal' && !allowPersonalStaging)) throw new ProfileRowOperationError('invalid-reference');
        if (parsed.kind === 'shared_resource') ids.add(parsed.id);
    }
    if (ids.size === 0) return [];
    const catalog = await readSavedSecretCatalogInContext(context, signal);
    context.assertCurrent();
    if (!catalog.ok) throw new ProfileRowOperationError('invalid-reference', catalog.failure);
    const resources = new Map(catalog.resources.flatMap(resource => 'resourceId' in resource ? [[resource.resourceId, resource] as const] : []));
    const overrides = new Map(capturedRevisions?.map(proof => [proof.resourceId, proof.expectedRevision]));
    return [...ids].map(resourceId => {
        const resource = resources.get(resourceId);
        const selected = overrides.get(resourceId);
        if (!resource && allowCreatedResource && selected === 1) return { resourceId, expectedRevision: selected };
        if (!resource || resource.entry.materialStatus !== 'ready' || !resource.entry.capabilities.use
            || resource.entry.revision === null) throw new ProfileRowOperationError('invalid-reference');
        if (selected !== undefined && selected !== resource.entry.revision) throw new ProfileRowOperationError('reference-conflict');
        return { resourceId, expectedRevision: resource.entry.revision };
    });
}
function sealProfileMutation(mode: 'plain' | 'e2ee', material: AccountScopedCryptoMaterial | null, input: ProfileSealInput,
    references: ProfileMutationReferences): ProfileRowMutationV1 {
    const record = parseProfileRecordForMutationV1({ operation: input.operation, record: input.record });
    let content: ReturnType<typeof sealProfileRecordContentV1>;
    try { content = sealProfileRecordContentV1({ mode, material, record, randomBytes: getRandomBytes }); }
    catch (error) {
        if (error instanceof ProfileSecretPromotionRequiredError) throw new ProfileRowOperationError(error.code, error);
        throw error;
    }
    return ProfileRowMutationV1Schema.parse({
        id: record.id, operation: input.operation, expectedRevision: input.expectedRevision,
        content,
        ...references,
        ...(input.savedSecretRevisions ? { savedSecretRevisions: input.savedSecretRevisions } : {}),
        ...(input.legacyCloneSource ? { legacyCloneSource: input.legacyCloneSource } : {}),
        ...(input.settingsCleanup ? { settingsCleanup: input.settingsCleanup } : {}),
    });
}
/** Resource owners seal their composite row changes through this same captured crypto boundary. */
export function prepareProfileRecordMutationsInContext(context: ProfileAccountContext, input: Readonly<{
    catalog: Extract<ProfileCatalogSnapshotV1, { status: 'ready' }>;
    artifactsById: ReadonlyMap<string, ArtifactSharingResourceV1>;
    records: readonly Readonly<{ record: ProfileRecordV1; revision: number }>[];
    expectedMode: 'plain' | 'e2ee';
    savedSecretRevisions?: ProfileRowMutationV1['savedSecretRevisions'];
}>): Promise<readonly ProfileRowMutationV1[]> {
    return admitProfileAccount(context, async (captured, mode, material) => {
        if (mode !== input.expectedMode) throw new ProfileRowOperationError('account-mode-mismatch');
        const catalog = input.catalog;
        if (catalog.status !== 'ready' || !catalog.source || (input.records.length > 0 && catalog.referenceGuardRevision === 'absent')
            || (catalog.control && catalog.control.revision !== catalog.controlRevision)
            || (catalog.control?.record.phase === 'active'
                ? catalog.authority !== 'active' || catalog.source !== 'destination'
                : catalog.authority !== 'inactive')
            || (catalog.control?.record.phase === 'prepared' && catalog.source !== 'legacy')) {
            throw new ProfileRowOperationError('invalid-reference');
        }
        const rows = new Map(catalog.records.map(row => [row.record.id, row]));
        for (const { record, revision } of input.records) {
            if (rows.get(record.id)?.revision !== revision) throw new ProfileRowOperationError('reference-conflict');
        }
        const operation = catalog.source === 'legacy' ? 'import' : 'update';
        const rowsWithReferences = input.records.map(row => ({ row, references: readProfileMutationReferences(row.record, input.artifactsById) }));
        const revisions = await resolveProfileSecretRevisions(captured, rowsWithReferences.map(({ references }) => references), input.savedSecretRevisions,
            true, operation === 'import');
        captured.assertCurrent();
        return rowsWithReferences.map(({ row: { record, revision }, references }) => sealProfileMutation(mode, material,
            { record, expectedRevision: revision, operation, savedSecretRevisions: revisions }, references));
    });
}
export function writeProfileRecordInContext(context: ProfileAccountContext, input: ProfileWriteInput, signal?: AbortSignal): Promise<ProfileRowMutationResponseV1> {
    return admitProfileAccount(context, (captured, mode, material) => writeCapturedProfileRecord(captured, mode, material, input, signal));
}

export async function writeProfileRecord(scope: ServerAccountScope, input: ProfileWriteInput, signal?: AbortSignal): Promise<ProfileRowMutationResponseV1> {
    return withProfileAccount(scope, signal, (context, mode, material) => writeCapturedProfileRecord(context, mode, material, input, signal));
}

type ProfileDeleteInput = Readonly<{
    id: string; expectedRevision: number; previousDefinition: ProfileRecordV1['definition'];
    settingsCleanup?: ProfileRowMutationV1['settingsCleanup'];
}>;
async function deleteCapturedProfileRecord(context: ProfileAccountContext, mode: 'plain' | 'e2ee', material: AccountScopedCryptoMaterial | null,
    input: ProfileDeleteInput, signal?: AbortSignal): Promise<ProfileRowMutationResponseV1> {
        let settingsCleanup = input.settingsCleanup;
        if (!settingsCleanup) {
            const { encryption } = await context.resolveAccountEncryption();
            const baseline = await readAccountSettingsBaseline({ credentials: context.credentials, encryption, accountMode: mode,
                request: (path, init) => context.request(path, init, { retry: 'none' }) });
            context.assertCurrent();
            const raw = removeProfilePreferenceReferencesV1(baseline.raw ?? {}, input.id, input.previousDefinition);
            if (JSON.stringify(raw) !== JSON.stringify(baseline.raw ?? {})) {
                settingsCleanup = sealProfileSettingsCleanup(mode, material, baseline.version, raw);
            }
        }
        return mutateWithContext(context, {
            id: input.id, operation: 'remove', expectedRevision: input.expectedRevision, content: null,
            referencedSavedSecretIds: [], ...(settingsCleanup ? { settingsCleanup } : {}),
        }, signal);
}
export function deleteProfileRecordInContext(context: ProfileAccountContext, input: ProfileDeleteInput, signal?: AbortSignal): Promise<ProfileRowMutationResponseV1> {
    return admitProfileAccount(context, (captured, mode, material) => deleteCapturedProfileRecord(captured, mode, material, input, signal));
}
export function deleteProfileRecord(scope: ServerAccountScope, input: ProfileDeleteInput, signal?: AbortSignal): Promise<ProfileRowMutationResponseV1> {
    return withProfileAccount(scope, signal, (context, mode, material) => deleteCapturedProfileRecord(context, mode, material, input, signal));
}
