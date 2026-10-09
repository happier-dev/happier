import {
    assertProfileRecordContentForModeV1, ProfileRecordContentV1Schema, parseStoredProfileRecordContentV1,
    ProfileRowMutationV1Schema, type ProfileRecordContentV1, type ProfileRowMutationV1, type ProfileRowV1,
    type ProfileRowsListResponseV1,
    ProfileProviderConversionMutationV1Schema, type ProfileProviderConversionMutationV1, type ProfileProviderConversionResponseV1,
    assertProfileRecordSecretMaterialPromotedV1, ProfileSecretPromotionRequiredError,
    hasChangedReadonlyProfileDefinitionV1,
    type ProfileRecordV1,
} from '@happier-dev/protocol/profiles/profileRecordV1';
import { isLegacyProfileSourcePreservingCloneV1, readEffectiveProfileSecretBindingsV1, removeProfilePreferenceReferencesV1, resolveProfileCatalogAuthorityV1 } from '@happier-dev/protocol/profiles/read';
import { prepareBuiltinProfileAttachmentV1 } from '@happier-dev/protocol/profiles/profileOperations';
import type { ArtifactSharingResourceV1 } from '@happier-dev/protocol/artifacts/artifactSharingV1';
import type { ProfileTransferControlV1 } from '@happier-dev/protocol/profiles/profileTransferV1';
import { isDeepStrictEqual } from 'node:util';
import type { Tx } from '@/storage/inTx';
import { inTx } from '@/storage/inTx';
import { markAccountChanged } from '@/app/changes/markAccountChanged';
import { acquireAccountEncryptionTransitionFenceInTx } from '@/app/encryption/accountEncryptionTransition';
import { openPlainAccountSettingsDbValue, PlainAccountSettingsStorageUnavailableError } from '@/app/encryption/accountSettingsStorage';
import { writeAccountSettingsInTx } from '@/app/accountSettings/writeAccountSettingsInTx';
import type { TeamOperationAuthenticationContext } from '@/app/teams/actorContext';
import { PROFILE_ACCOUNT_KV_PREFIX, PROFILE_REFERENCE_GUARD_ACCOUNT_KV_KEY, buildProfilePhysicalKey, parseProfilePhysicalKey } from '@/app/kv/accountScopedKv';
import {
    readReservedAccountScopedKvRowInTx, listReservedAccountScopedKvRowsInTx,
    mutateReservedAccountScopedKvRowInTx, mutateReservedAccountScopedKvRowsInTx,
    type ReservedAccountScopedKvRowDomain, type ReservedAccountScopedKvRowFailure,
} from '@/app/kv/reservedAccountScopedKvRow';
import { readProfileTransferControlInTx, profileTransferControlReadResponseV1 } from './profileTransferControl';
import { readArtifactForCallerInTx, projectPlainArtifactSharingResourceV1 } from '@/app/artifacts/artifactAccessService';
import { mutateProviderConnectionsRowInTx } from '@/app/account/providers/connectionRows';

export const profileRecordDomain: ReservedAccountScopedKvRowDomain<ProfileRecordContentV1> = {
    label: 'Profile record',
    parseStoredEnvelope: parseStoredProfileRecordContentV1,
    parseCandidateEnvelope(value) { const parsed = ProfileRecordContentV1Schema.safeParse(value); return parsed.success ? parsed.data : null; },
    assertEnvelopeForMode: assertProfileRecordContentForModeV1,
};

/** A reference guard has no payload in either Account mode. Only its tombstone revision exists. */
const profileReferenceGuardDomain: ReservedAccountScopedKvRowDomain<ProfileRecordContentV1> = {
    label: 'Profile reference guard', parseStoredEnvelope: () => null, parseCandidateEnvelope: () => null,
    assertEnvelopeForMode: () => { throw new Error('Profile reference guard cannot contain a payload'); },
};

export async function readProfileReferenceGuardInTx(tx: Tx, input: Readonly<{ accountId: string }>): Promise<
    Readonly<{ status: 'ready'; revision: number | 'absent' }> | ReservedAccountScopedKvRowFailure
> {
    const result = await readReservedAccountScopedKvRowInTx(tx, { accountId: input.accountId,
        physicalKey: PROFILE_REFERENCE_GUARD_ACCOUNT_KV_KEY, domain: profileReferenceGuardDomain });
    if (result.status === 'absent') return { status: 'ready', revision: 'absent' };
    if (result.status === 'deleted') return { status: 'ready', revision: result.revision };
    return result.status === 'present' ? { status: 'invalid-stored-content' } : result;
}

async function markProfileReferenceGuardChangedInTx(tx: Tx, input: Readonly<{ accountId: string; revision: number }>): Promise<number> {
    return markAccountChanged(tx, { accountId: input.accountId, kind: 'account', entityId: PROFILE_REFERENCE_GUARD_ACCOUNT_KV_KEY,
        hint: { profiles: true, referenceGuardRevision: input.revision } });
}

export async function advanceProfileReferenceGuardInTx(tx: Tx, input: Readonly<{ accountId: string; expectedRevision: number | 'absent' }>) {
    return mutateReservedAccountScopedKvRowInTx(tx, { accountId: input.accountId, physicalKey: PROFILE_REFERENCE_GUARD_ACCOUNT_KV_KEY,
        expectedRevision: input.expectedRevision, envelope: null, domain: profileReferenceGuardDomain,
        markChanged: ({ tx, revision }) => markProfileReferenceGuardChangedInTx(tx, { accountId: input.accountId, revision }) });
}

export async function markProfileRowChangedInTx(tx: Tx, input: Readonly<{ accountId: string; id: string; revision: number }>): Promise<number> {
    return markAccountChanged(tx, { accountId: input.accountId, kind: 'account', entityId: buildProfilePhysicalKey(input.id),
        hint: { profiles: true, id: input.id, revision: input.revision } });
}

export async function readProfileRowInTx(tx: Tx, input: Readonly<{ accountId: string; id: string }>) {
    const result = await readReservedAccountScopedKvRowInTx(tx, { accountId: input.accountId,
        physicalKey: buildProfilePhysicalKey(input.id), domain: profileRecordDomain });
    if (result.status === 'present') {
        if (result.envelope.t === 'plain' && result.envelope.v.id !== input.id) return { status: 'invalid-stored-content' as const };
        return { status: 'present' as const, revision: result.revision, content: result.envelope };
    }
    return result;
}

export async function listProfileRowsInTx(tx: Tx, input: Readonly<{ accountId: string; cursor?: string; limit?: number }>): Promise<ProfileRowsListResponseV1> {
    const result = await listReservedAccountScopedKvRowsInTx(tx, { ...input, physicalPrefix: PROFILE_ACCOUNT_KV_PREFIX,
        domain: profileRecordDomain, diagnostics: true });
    if (result.status !== 'listed') return result;
    const guard = await readProfileReferenceGuardInTx(tx, input);
    if (guard.status !== 'ready') return guard;
    const control = await readProfileTransferControlInTx(tx, input);
    if (control.status !== 'present' && control.status !== 'absent' && control.status !== 'deleted') return control;
    const rows: ProfileRowV1[] = [];
    const diagnostics: Array<{ id: string; revision: number; reason: 'invalid-stored-content' }> = [];
    for (const row of result.rows) {
        const id = parseProfilePhysicalKey(row.physicalKey);
        if (id === null) return { status: 'invalid-stored-content' };
        if (row.envelope?.t === 'plain' && row.envelope.v.id !== id) {
            diagnostics.push({ id, revision: row.revision, reason: 'invalid-stored-content' });
        } else rows.push({ id, revision: row.revision, content: row.envelope });
    }
    for (const row of result.diagnostics) {
        const id = parseProfilePhysicalKey(row.physicalKey);
        if (id === null) return { status: 'invalid-stored-content' };
        diagnostics.push({ id, revision: row.revision, reason: row.reason });
    }
    return { status: 'listed', rows, nextCursor: result.nextCursor, complete: result.complete && diagnostics.length === 0,
        diagnostics, referenceGuardRevision: guard.revision, transferControl: profileTransferControlReadResponseV1(control) };
}

/** Caller holds its Account transition fence; this census performs no domain writes. */
export async function validateProfileReferenceCensusInTx(tx: Tx, input: Readonly<{
    accountId: string; referenceGuardRevision: number | 'absent'; rows: readonly Readonly<{ id: string; revision: number }>[];
    expectedAccountMode?: 'plain' | 'e2ee';
}>): Promise<Readonly<{ status: 'ready'; rows: readonly ProfileRowV1[] }> | Readonly<{ status: 'reference-conflict' }> | ReservedAccountScopedKvRowFailure> {
    if (input.expectedAccountMode !== undefined) {
        const account = await tx.account.findUnique({ where: { id: input.accountId }, select: { encryptionMode: true } });
        if (!account) return { status: 'account-not-found' };
        if (account.encryptionMode !== input.expectedAccountMode) return { status: 'account-mode-mismatch' };
    }
    const guard = await readProfileReferenceGuardInTx(tx, input);
    if (guard.status !== 'ready') return guard;
    if (guard.revision !== input.referenceGuardRevision) return { status: 'reference-conflict' };
    const listed = await listReservedAccountScopedKvRowsInTx(tx, { accountId: input.accountId,
        physicalPrefix: PROFILE_ACCOUNT_KV_PREFIX, domain: profileRecordDomain });
    if (listed.status !== 'listed') return listed;
    const captured = new Map(input.rows.map(row => [row.id, row.revision]));
    if (captured.size !== input.rows.length || listed.rows.length !== captured.size) return { status: 'reference-conflict' };
    const rows: ProfileRowV1[] = [];
    for (const row of listed.rows) {
        const id = parseProfilePhysicalKey(row.physicalKey);
        if (id === null || (row.envelope?.t === 'plain' && row.envelope.v.id !== id)) return { status: 'invalid-stored-content' };
        if (captured.get(id) !== row.revision) return { status: 'reference-conflict' };
        rows.push({ id, revision: row.revision, content: row.envelope });
    }
    return { status: 'ready', rows };
}

export type ProfileRowsMutationResult = Readonly<{ status: 'updated'; rows: readonly ProfileRowV1[]; referenceGuardRevision: number; cursor: number }>
    | Readonly<{ status: 'conflict'; revision: number }> | Readonly<{ status: 'settings-conflict'; revision: number }>
    | Readonly<{ status: 'invalid-reference'; reason?: string }> | ReservedAccountScopedKvRowFailure;

export class ProfileRowTransactionAbort extends Error {
    constructor(readonly result: Exclude<ProfileRowsMutationResult, { status: 'updated' }>) { super(result.status); this.name = 'ProfileRowTransactionAbort'; }
}

function plainProfileDestinationAuthority(accountId: string, settings: string | null, control: ProfileTransferControlV1 | null): boolean {
    const opened = openPlainAccountSettingsDbValue({ accountId, dbValue: settings });
    return resolveProfileCatalogAuthorityV1({ rawSettings: opened?.t === 'plain' ? opened.v : {}, control }) === 'destination';
}

type ProfileRowsMutationInput = Readonly<{
    accountId: string; mutations: readonly ProfileRowMutationV1[]; expectedReferenceGuardRevision?: number | 'absent';
    authentication?: TeamOperationAuthenticationContext;
}>;

/** The named Provider owner reaches this same transaction only after its complete captured proof is admitted. */
async function applyProfileRowsInTx(tx: Tx, input: ProfileRowsMutationInput,
    operationOwner: 'ordinary' | 'provider-conversion',
): Promise<ProfileRowsMutationResult> {
    const mutations = input.mutations.map(mutation => ProfileRowMutationV1Schema.parse(mutation));
    if (mutations.length === 0 || new Set(mutations.map(mutation => mutation.id)).size !== mutations.length) return { status: 'invalid-stored-content' };
    const fence = await acquireAccountEncryptionTransitionFenceInTx(tx, input.accountId);
    if (fence.status === 'account_not_found') return { status: 'account-not-found' };
    if (fence.status === 'account_inconsistent') return { status: 'account-inconsistent', reason: fence.reason };
    if (mutations.some(mutation => mutation.operation !== 'import') && fence.account.currentness.encryptionMode === 'plain') {
        const control = await readProfileTransferControlInTx(tx, input);
        if (control.status !== 'present' && control.status !== 'absent' && control.status !== 'deleted') return control;
        try {
            if (!plainProfileDestinationAuthority(input.accountId, fence.account.settings,
                control.status === 'present' && control.envelope.t === 'plain' ? control.envelope.v : null)) return { status: 'invalid-stored-content' };
        } catch (error) {
            if (error instanceof PlainAccountSettingsStorageUnavailableError) return { status: 'invalid-stored-content' };
            throw error;
        }
    }
    const guard = await readProfileReferenceGuardInTx(tx, input);
    if (guard.status !== 'ready') return guard;
    if (input.expectedReferenceGuardRevision !== undefined && guard.revision !== input.expectedReferenceGuardRevision) {
        return { status: 'conflict', revision: guard.revision === 'absent' ? -1 : guard.revision };
    }
    const secrets = mutations.some(mutation => mutation.referencedSavedSecretIds.length > 0)
        ? await (await import('@/app/account/savedSecrets/savedSecretResourceService')).listSavedSecretResourcesForAccountInTx(tx, input.accountId, input.authentication) : [];
    let nextPlainSettings = fence.account.currentness.encryptionMode === 'plain'
        ? openPlainAccountSettingsDbValue({ accountId: input.accountId, dbValue: fence.account.settings }) : null;
    let settingsCleanup: ProfileRowMutationV1['settingsCleanup'];
    for (const mutation of mutations) {
        let previousDefinition: ProfileRecordV1['definition'] | undefined;
        let previousReadonlyRecord: ProfileRecordV1 | undefined;
        if (mutation.operation === 'clone-legacy') {
            const capture = mutation.legacyCloneSource;
            if (!capture) return { status: 'invalid-reference' };
            const source = await readProfileRowInTx(tx, { accountId: input.accountId, id: capture.id });
            if (source.status === 'absent' || source.status === 'deleted') return {
                status: 'conflict', revision: source.status === 'deleted' ? source.revision : -1 };
            if (source.status !== 'present') return source;
            if (source.revision !== capture.revision) return { status: 'conflict', revision: source.revision };
            const sourceArtifactId = source.content.t === 'plain'
                ? (source.content.v.definition.kind === 'artifact' ? source.content.v.definition.artifactId : undefined)
                : capture.artifactRevision?.artifactId;
            if (source.content.t === 'plain' && Boolean(sourceArtifactId) !== Boolean(capture.artifactRevision)) return { status: 'invalid-reference' };
            const sourceArtifacts = new Map<string, ArtifactSharingResourceV1>();
            if (sourceArtifactId) {
                const artifactCapture = capture.artifactRevision;
                if (!artifactCapture || artifactCapture.artifactId !== sourceArtifactId) return { status: 'invalid-reference' };
                const artifact = await readArtifactForCallerInTx(tx, { actorAccountId: input.accountId, artifactId: sourceArtifactId });
                if (!artifact.ok || artifact.artifact.headerVersion !== artifactCapture.headerVersion
                    || artifact.artifact.bodyVersion !== artifactCapture.bodyVersion) return { status: 'invalid-reference' };
                if (source.content.t === 'plain') {
                    const resource = projectPlainArtifactSharingResourceV1(artifact.artifact);
                    if (!resource) return { status: 'invalid-reference' };
                    sourceArtifacts.set(sourceArtifactId, resource);
                }
            }
            if (mutation.content?.t === 'plain' && (source.content.t !== 'plain'
                || !isLegacyProfileSourcePreservingCloneV1({ source: source.content.v,
                    record: mutation.content.v, artifactsById: sourceArtifacts }))) return { status: 'invalid-reference' };
        }
        if (mutation.operation === 'attach-builtin') {
            if (!mutation.settingsCleanup) return { status: 'invalid-reference' };
            if (mutation.content?.t === 'plain') {
                const prepared = prepareBuiltinProfileAttachmentV1(mutation.content.v,
                    nextPlainSettings?.t === 'plain' ? nextPlainSettings.v : {});
                if (prepared.record.enabled !== mutation.content.v.enabled) return { status: 'invalid-stored-content' };
                nextPlainSettings = { t: 'plain', v: prepared.nextSettings };
            }
        }
        if (mutation.content?.t === 'plain') {
            try { assertProfileRecordSecretMaterialPromotedV1(mutation.content.v); }
            catch (error) {
                if (error instanceof ProfileSecretPromotionRequiredError) return { status: 'invalid-reference', reason: error.code };
                throw error;
            }
        }
        if (mutation.operation === 'import' || mutation.operation === 'update') {
            const current = await readProfileRowInTx(tx, { accountId: input.accountId, id: mutation.id });
            if (current.status === 'deleted') return { status: 'conflict', revision: current.revision };
            if (current.status === 'absent' && mutation.operation === 'update') return { status: 'conflict', revision: -1 };
            if (current.status !== 'present' && current.status !== 'absent') return current;
            if (operationOwner === 'ordinary' && mutation.operation === 'update' && current.status === 'present' && current.content.t === 'plain'
                && mutation.content?.t === 'plain') previousReadonlyRecord = current.content.v;
        }
        if (mutation.operation === 'remove') {
            const current = await readProfileRowInTx(tx, { accountId: input.accountId, id: mutation.id });
            if (current.status !== 'present' && current.status !== 'absent' && current.status !== 'deleted') return current;
            if (current.status === 'present' && current.content.t === 'plain') previousDefinition = current.content.v.definition;
        }
        if (mutation.content?.t === 'encrypted' && mutation.artifactRevision === undefined) return { status: 'invalid-reference' };
        const artifactId = mutation.content?.t === 'plain'
            ? (mutation.content.v.definition.kind === 'artifact' ? mutation.content.v.definition.artifactId : null)
            : mutation.artifactRevision?.artifactId;
        const artifactsById = new Map<string, ArtifactSharingResourceV1>();
        if (artifactId) {
            const capture = mutation.artifactRevision;
            if (!capture) return { status: 'invalid-reference' };
            const current = await readArtifactForCallerInTx(tx, { actorAccountId: input.accountId, artifactId });
            if (!current.ok || current.artifact.headerVersion !== capture.headerVersion
                || current.artifact.bodyVersion !== capture.bodyVersion) return { status: 'invalid-reference' };
            if (mutation.content?.t === 'plain') {
                const resource = projectPlainArtifactSharingResourceV1(current.artifact);
                if (!resource) return { status: 'invalid-reference' };
                artifactsById.set(artifactId, resource);
            }
        }
        const bindings = mutation.content?.t === 'plain'
            ? readEffectiveProfileSecretBindingsV1(mutation.content.v, { artifactsById }) : undefined;
        if (bindings === null) return { status: 'invalid-reference' };
        if (previousReadonlyRecord && mutation.content?.t === 'plain'
            && hasChangedReadonlyProfileDefinitionV1(previousReadonlyRecord, mutation.content.v,
                artifactId ? artifactsById.get(artifactId) : undefined)) {
            return { status: 'invalid-reference', reason: 'profile-read-only' };
        }
        const references = bindings === undefined ? mutation.referencedSavedSecretIds : [...new Set(Object.values(bindings))];
        if (mutation.content?.t === 'plain' && !isDeepStrictEqual([...references].sort(), [...new Set(mutation.referencedSavedSecretIds)].sort())) return { status: 'invalid-reference' };
        if (!(await import('@/app/account/savedSecrets/savedSecretResourceService')).validateSavedSecretResourceReferenceCapturesV1(secrets, {
            references, savedSecretRevisions: mutation.savedSecretRevisions ?? [], allowPersonal: mutation.operation === 'import',
        })) return { status: 'invalid-reference' };
        if (mutation.operation === 'remove' && nextPlainSettings?.t === 'plain') {
            const next = removeProfilePreferenceReferencesV1(nextPlainSettings.v, mutation.id, previousDefinition);
            if (!isDeepStrictEqual(next, nextPlainSettings.v) && !mutation.settingsCleanup) return { status: 'invalid-stored-content' };
            nextPlainSettings = { t: 'plain', v: next };
        }
        if (mutation.settingsCleanup) {
            if (settingsCleanup !== undefined) return { status: 'invalid-stored-content' };
            settingsCleanup = mutation.settingsCleanup;
        }
    }
    if (settingsCleanup !== undefined && nextPlainSettings?.t === 'plain' && !isDeepStrictEqual(nextPlainSettings, settingsCleanup.nextSettings)) return { status: 'invalid-stored-content' };
    let settingsChanged = false;
    if (settingsCleanup) {
        const settings = await writeAccountSettingsInTx({ tx, accountId: input.accountId,
            expectedVersion: settingsCleanup.expectedSettingsVersion, next: { kind: 'v2', content: settingsCleanup.nextSettings } });
        if (settings.status === 'version_mismatch') return { status: 'settings-conflict', revision: settings.currentVersion };
        if (settings.status !== 'success') return { status: 'invalid-stored-content' };
        settingsChanged = true;
    }
    const guardKey = PROFILE_REFERENCE_GUARD_ACCOUNT_KV_KEY;
    const result = await mutateReservedAccountScopedKvRowsInTx(tx, { accountId: input.accountId,
        mutations: [...mutations.map(mutation => ({ physicalKey: buildProfilePhysicalKey(mutation.id), expectedRevision: mutation.expectedRevision,
            envelope: mutation.content, domain: profileRecordDomain })),
            { physicalKey: guardKey, expectedRevision: guard.revision, envelope: null, domain: profileReferenceGuardDomain }],
        markChanged: ({ tx, physicalKey, revision }) => physicalKey === guardKey
            ? markProfileReferenceGuardChangedInTx(tx, { accountId: input.accountId, revision })
            : markProfileRowChangedInTx(tx, { accountId: input.accountId, id: parseProfilePhysicalKey(physicalKey)!, revision }),
    });
    if (result.status !== 'updated') {
        const refusal = result.status === 'conflict' ? { status: 'conflict' as const, revision: result.revision } : result;
        if (settingsChanged) throw new ProfileRowTransactionAbort(refusal);
        return refusal;
    }
    const guardRow = result.rows.find(row => row.physicalKey === guardKey)!;
    return { status: 'updated', referenceGuardRevision: guardRow.revision, cursor: guardRow.cursor,
        rows: mutations.map(mutation => ({ id: mutation.id, revision: result.rows.find(row => row.physicalKey === buildProfilePhysicalKey(mutation.id))!.revision, content: mutation.content })) };
}

/** Ordinary edits and S2 attachment changes preserve captured readonly definitions. */
export async function mutateProfileRowsInTx(tx: Tx, input: ProfileRowsMutationInput): Promise<ProfileRowsMutationResult> {
    return applyProfileRowsInTx(tx, input, 'ordinary');
}

export async function mutateProfileRows(input: Parameters<typeof mutateProfileRowsInTx>[1]): Promise<ProfileRowsMutationResult> {
    try { return await inTx(tx => mutateProfileRowsInTx(tx, input)); }
    catch (error) { if (error instanceof ProfileRowTransactionAbort) return error.result; throw error; }
}

class ProfileProviderConversionTransactionAbort extends Error {
    constructor(readonly result: ProfileProviderConversionResponseV1) { super(result.status); }
}

/** The incumbent translation commits its Provider catalog, Settings and captured Profile batch together. */
export async function convertProfileProvidersInTx(tx: Tx, input: Readonly<{
    accountId: string; mutation: ProfileProviderConversionMutationV1; authentication?: TeamOperationAuthenticationContext;
}>): Promise<ProfileProviderConversionResponseV1> {
    const mutation = ProfileProviderConversionMutationV1Schema.parse(input.mutation);
    const fence = await acquireAccountEncryptionTransitionFenceInTx(tx, input.accountId);
    if (fence.status === 'account_not_found') return { status: 'account-not-found' };
    if (fence.status === 'account_inconsistent') return { status: 'account-inconsistent', reason: fence.reason };
    if (fence.account.currentness.encryptionMode !== mutation.expectedAccountMode) return { status: 'account-mode-mismatch' };
    const control = await readProfileTransferControlInTx(tx, input);
    if (control.status !== 'present' && control.status !== 'absent' && control.status !== 'deleted') return control;
    const revision = control.status === 'absent' ? 'absent' : control.revision;
    if (revision !== mutation.expectedProfileTransferRevision) return { status: 'conflict', revision: revision === 'absent' ? -1 : revision };
    if (mutation.expectedAccountMode === 'plain' && mutation.mutations.length > 0) {
        try {
            if (!plainProfileDestinationAuthority(input.accountId, fence.account.settings,
                control.status === 'present' && control.envelope.t === 'plain' ? control.envelope.v : null)) return { status: 'invalid-stored-content' };
        } catch (error) {
            if (error instanceof PlainAccountSettingsStorageUnavailableError) return { status: 'invalid-stored-content' };
            throw error;
        }
    }
    const census = await validateProfileReferenceCensusInTx(tx, { accountId: input.accountId,
        expectedAccountMode: mutation.expectedAccountMode, referenceGuardRevision: mutation.expectedReferenceGuardRevision,
        rows: mutation.profileCensus });
    if (census.status !== 'ready') return census;
    const provider = await mutateProviderConnectionsRowInTx(tx, { accountId: input.accountId,
        authentication: input.authentication, ...mutation.providerMutation });
    if (provider.status === 'conflict') return { status: 'provider-conflict', revision: provider.revision };
    if (provider.status !== 'updated') return provider;
    const settings = await writeAccountSettingsInTx({ tx, accountId: input.accountId,
        expectedVersion: mutation.expectedSettingsVersion, expectedProfileTransferRevision: mutation.expectedProfileTransferRevision,
        next: { kind: 'v2', content: mutation.nextSettings } });
    if (settings.status === 'version_mismatch') throw new ProfileProviderConversionTransactionAbort({ status: 'settings-conflict', revision: settings.currentVersion });
    if (settings.status === 'profile_transfer_mismatch') throw new ProfileProviderConversionTransactionAbort({ status: 'reference-conflict' });
    if (settings.status !== 'success') throw new ProfileProviderConversionTransactionAbort({ status: 'invalid-stored-content' });
    if (mutation.mutations.length === 0) return { status: 'updated', settingsVersion: settings.version, providerRevision: provider.revision,
        rows: [], referenceGuardRevision: mutation.expectedReferenceGuardRevision };
    const rows = await applyProfileRowsInTx(tx, { accountId: input.accountId, mutations: mutation.mutations,
        expectedReferenceGuardRevision: mutation.expectedReferenceGuardRevision, authentication: input.authentication }, 'provider-conversion');
    if (rows.status !== 'updated') throw new ProfileProviderConversionTransactionAbort(rows);
    return { status: 'updated', settingsVersion: settings.version, providerRevision: provider.revision,
        rows: [...rows.rows], referenceGuardRevision: rows.referenceGuardRevision };
}

export async function convertProfileProviders(input: Parameters<typeof convertProfileProvidersInTx>[1]): Promise<ProfileProviderConversionResponseV1> {
    try { return await inTx(tx => convertProfileProvidersInTx(tx, input)); }
    catch (error) { if (error instanceof ProfileProviderConversionTransactionAbort) return error.result; throw error; }
}
