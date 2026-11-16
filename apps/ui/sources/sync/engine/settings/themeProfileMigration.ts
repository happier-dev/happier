import { deriveAccountScopedArtifactIdV1, type ArtifactIdScopeV1 } from '@happier-dev/protocol/artifacts/idScope';
import { computeCanonicalDomainSeparatedHexDigest } from '@happier-dev/protocol/crypto/canonicalDigest';
import { createCanonicalJsonSigningInput } from '@happier-dev/protocol/crypto/canonicalJson';
import { parseThemeProfileDocument, mergeThemeProfileDocumentEdit, type ThemeProfileDocument, type ThemeProfileLibrary, type ThemeReference } from '@happier-dev/protocol/account/settings/themeProfiles';
import { sameStrictJsonValue } from '@happier-dev/protocol/json/strictJsonValue';
import { readThemeProfileLegacyAccountScope, writeThemeProfileLegacyAccountScope } from '@/sync/domains/state/themeProfileMigrationUiState';
import { DEFAULT_THEME_PROFILES_LOCAL_STATE } from '@/theme/profiles/themeProfilePersistence';
import type { ThemeProfileV1 } from '@/theme/profiles/themeProfileTypes';
import { canUseLegacyThemeProfiles } from '@/sync/domains/settings/themeProfiles';
import { areAccountSettingsScopesEqual, type AccountSettingsScope } from '@/sync/domains/settings/scope/accountSettingsScope';
import { loadLocalSettings, loadLocalSettingsSnapshot } from '@/sync/domains/state/settingsPersistence';
import { storage } from '@/sync/domains/state/storageStore';
import { loadPendingThemeProfileMigrationInput, retirePendingThemeProfileMigrationInput } from '@/sync/domains/state/pendingAccountSettingsPersistence';
import { projectThemeProfileMigration } from '@/theme/profiles/themeProfileMigrationEdits';
import { isBuiltInThemeProfilePresetId } from '@/theme/profiles/builtInThemeProfiles';
import { inferThemeProfileAssetAppearance } from '@/theme/profiles/themeProfileAssetAppearance';
import { throwIfAborted } from '@/utils/runtime/abortSignals';

export type WithThemeProfileLibrary = <T>(operation: (library: ThemeProfileLibrary) => Promise<T>,
    options?: Readonly<{ signal?: AbortSignal; expectedScope?: AccountSettingsScope; artifactIdScopes?: ReadonlyMap<string, ArtifactIdScopeV1> }>) => Promise<T>;

const record = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
function readDocuments(value: unknown): readonly ThemeProfileDocument[] {
    if (value === undefined) return [];
    if (!Array.isArray(value)) throw new Error('Invalid released theme library');
    const documents = new Map<string, ThemeProfileDocument>();
    for (const raw of value) {
        const parsed = parseThemeProfileDocument(raw);
        if (!parsed.ok) throw new Error('Invalid released theme profile');
        if (!documents.has(parsed.document.profile.id)) documents.set(parsed.document.profile.id, parsed.document);
    }
    return [...documents.values()];
}

/**
 * Released ids need not be UUIDs. Canonical definition identity coalesces equal
 * Account/local sources on devices upgrading at different times, while different
 * same-id definitions remain separate. The UUID token uses the existing scope API.
 */
export function deriveReleasedThemeProfileIdentity(accountId: string, document: ThemeProfileDocument): Readonly<{ artifactId: string; idScope: ArtifactIdScopeV1 }> {
    const digest = computeCanonicalDomainSeparatedHexDigest('happier.theme-profile.released-source.v1', [
        document.profile.id, createCanonicalJsonSigningInput(document.raw),
    ]);
    const sourceId = `${digest.slice(0, 8)}-${digest.slice(8, 12)}-8${digest.slice(13, 16)}-8${digest.slice(17, 20)}-${digest.slice(20, 32)}`;
    return { artifactId: deriveAccountScopedArtifactIdV1(accountId, sourceId), idScope: { v: 1, sourceId } };
}

function applyReleasedEdit(document: ThemeProfileDocument, originalId: string, projected: ThemeProfileV1, retainedPresentation?: ThemeProfileDocument): ThemeProfileDocument {
    const normalized = { ...document.profile, assetAppearance: document.profile.assetAppearance ?? inferThemeProfileAssetAppearance(document.profile) };
    const edits = Object.fromEntries(Object.entries(projected).filter(([key, value]) => key !== 'id'
        && key !== 'schemaVersion' && !sameStrictJsonValue(value, normalized[key as keyof ThemeProfileV1])));
    return mergeThemeProfileDocumentEdit(document, { ...edits, id: originalId }, { retainedPresentation });
}

export function hasReleasedThemeProfileMigrationInput(scope: AccountSettingsScope, raw: Readonly<Record<string, unknown>> | null): boolean {
    if (raw && Object.hasOwn(raw, 'themeProfiles')) return true;
    if (areAccountSettingsScopesEqual(storage.getState().settingsScope, scope)
        && canUseLegacyThemeProfiles(readThemeProfileLegacyAccountScope(), scope)
        && storage.getState().localSettings.themeProfiles.profiles.length > 0) return true;
    const pending = loadPendingThemeProfileMigrationInput(scope);
    return pending.profiles !== undefined || pending.intent !== null;
}

/** One-shot transfer: released inputs remain retry sources until destination acknowledgement. */
export async function migrateReleasedThemeProfiles(input: Readonly<{
    scope: AccountSettingsScope;
    profiles: unknown;
    signal?: AbortSignal;
    withThemeProfileLibrary: WithThemeProfileLibrary;
}>): Promise<Readonly<{ complete(): void }>> {
    const { scope } = input;
    const snapshot = loadLocalSettingsSnapshot();
    const initial = snapshot.settings;
    const legacyAllowed = areAccountSettingsScopesEqual(storage.getState().settingsScope, scope)
        && canUseLegacyThemeProfiles(readThemeProfileLegacyAccountScope(), scope);
    const legacy = legacyAllowed ? initial.themeProfiles : DEFAULT_THEME_PROFILES_LOCAL_STATE;
    const localRaw = record(snapshot.storedValue) && record(snapshot.storedValue.themeProfiles) ? snapshot.storedValue.themeProfiles.profiles : undefined;
    const accountDocuments = readDocuments(input.profiles);
    const localDocuments = legacyAllowed ? readDocuments(localRaw) : [];
    const pending = loadPendingThemeProfileMigrationInput(scope);
    const pendingDocuments = readDocuments(pending.profiles);
    if (legacy.profiles.length > 0 && !readThemeProfileLegacyAccountScope()) writeThemeProfileLegacyAccountScope(scope);
    // After destination ACK, Account/local sources may already be retired while
    // removing the released pending envelope failed. Its full checkpoint is the
    // remaining retry input; replaying legacy edits would need the cleared backup.
    const pendingCheckpointOnly = pending.profiles !== undefined && input.profiles === undefined && localDocuments.length === 0;
    const pendingReplacement = (!pending.intent && pending.profiles !== undefined) || pendingCheckpointOnly;
    const projected = projectThemeProfileMigration((pendingReplacement ? pendingDocuments : accountDocuments).map(doc => doc.profile), legacy,
        pendingCheckpointOnly ? null : pending.intent, pending.profiles === undefined ? undefined : pendingDocuments.map(doc => doc.profile));
    const accountById = new Map(accountDocuments.map(doc => [doc.profile.id, doc]));
    const localById = new Map(localDocuments.map(doc => [doc.profile.id, doc]));
    const pendingById = new Map(pendingDocuments.map(doc => [doc.profile.id, doc]));
    const checkpointFor = (id: string, localId?: string) => {
        if (!pending.intent) return pendingById.get(id);
        const mapped = pending.intent.attemptedLegacyProfileIds?.[localId ?? id] ?? pending.intent.legacyProfileIds[localId ?? id];
        return localId ? pendingById.get(mapped ?? '') ?? pendingById.get(id) : pendingById.get(id) ?? pendingById.get(mapped ?? '');
    };
    const originalLocalIds = new Map([...projected.legacyProfileIds].map(([originalId, id]) => [id, originalId]));
    const identities = new Map<string, ReturnType<typeof deriveReleasedThemeProfileIdentity>>();
    const legacyIdentities = new Map<string, ReturnType<typeof deriveReleasedThemeProfileIdentity>>();
    const documents = new Map<string, ThemeProfileDocument>();
    const addDocument = (source: ThemeProfileDocument, profile: ThemeProfileV1, checkpoint?: ThemeProfileDocument) => {
        const document = applyReleasedEdit(source, source.profile.id, profile, checkpoint);
        // Released pending checkpoints already carry the attempted definition's
        // identity. Keep that retry source stable after its local backup clears.
        const identity = deriveReleasedThemeProfileIdentity(scope.accountId, checkpoint ?? document);
        documents.set(identity.artifactId, mergeThemeProfileDocumentEdit(document, { id: identity.artifactId }));
        return identity;
    };
    for (const profile of projected.profiles) {
        const localId = originalLocalIds.get(profile.id);
        const source = accountById.get(profile.id) ?? (localId ? localById.get(localId) : undefined)
            ?? pendingById.get(profile.id) ?? checkpointFor(profile.id, localId);
        if (!source) throw new Error('Released theme source is unavailable');
        identities.set(profile.id, addDocument(source, profile, checkpointFor(profile.id, localId)));
    }
    const projectedById = new Map(projected.profiles.map(profile => [profile.id, profile]));
    for (const source of localDocuments) {
        const projectedId = projected.legacyProfileIds.get(source.profile.id);
        const profile = projectedId ? projectedById.get(projectedId) : undefined;
        if (!profile) continue;
        const represented = pending.intent?.acknowledged || pending.intent?.replaceLibrary;
        const identity = represented ? identities.get(profile.id) : addDocument(source, profile, checkpointFor(profile.id, source.profile.id));
        if (identity) legacyIdentities.set(source.profile.id, identity);
    }
    if (documents.size) await input.withThemeProfileLibrary(async library => {
        const existing = new Set((await library.list()).filter(entry => entry.reference.kind === 'artifact').map(entry => entry.id));
        for (const document of documents.values()) {
            // A create may commit before its response is lost. Header presence is
            // enough to avoid overwriting a later deliberate edit on retry.
            if (!existing.has(document.profile.id)) await library.save({ document });
        }
    }, { signal: input.signal, expectedScope: scope, artifactIdScopes: new Map([...identities.values(), ...legacyIdentities.values()].map(identity => [identity.artifactId, identity.idScope])) });
    const artifactReference = (id: string | null): ThemeReference | null => {
        if (!id) return null;
        if (isBuiltInThemeProfilePresetId(id)) return { kind: 'built-in', presetId: id };
        const identity = identities.get(id);
        return identity ? { kind: 'artifact', id: identity.artifactId } : null;
    };
    // Device selection settles first. Failed local persistence leaves the Account
    // ids available for retry, before its source can be retired by the Settings CAS.
    throwIfAborted(input.signal);
    const latest = loadLocalSettings();
    const sameLegacySource = legacyAllowed && canUseLegacyThemeProfiles(readThemeProfileLegacyAccountScope(), scope)
        && sameStrictJsonValue(latest.themeProfiles, initial.themeProfiles);
    const isCurrent = areAccountSettingsScopesEqual(storage.getState().settingsScope, scope);
    if (isCurrent) {
        const resolve = (mode: 'light' | 'dark') => {
            const selection = latest.themeProfileSelection?.[mode];
            if (selection && typeof selection === 'object' && 'kind' in selection) return selection;
            if (selection && typeof selection === 'object') {
                const identity = legacyIdentities.get(selection.legacyProfileId);
                return identity ? { kind: 'artifact' as const, id: identity.artifactId } : selection;
            }
            if (latest.themeProfileSelection) return artifactReference(selection ?? null) ?? selection ?? null;
            const legacyId = initial.themeProfiles.activeProfileIds[mode];
            const identity = legacyIdentities.get(legacyId ?? '');
            return identity ? { kind: 'artifact' as const, id: identity.artifactId } : artifactReference(legacyId);
        };
        const resolved = { light: resolve('light'), dark: resolve('dark') };
        const selection = latest.themeProfileSelection === null && resolved.light === null && resolved.dark === null ? null : resolved;
        const delta = {
            ...(sameLegacySource && legacy.profiles.length ? { themeProfiles: DEFAULT_THEME_PROFILES_LOCAL_STATE } : {}),
            ...(!sameStrictJsonValue(selection, latest.themeProfileSelection) ? { themeProfileSelection: selection } : {}),
        };
        if (Object.keys(delta).length) storage.getState().applyLocalSettings(delta);
    }
    if (isCurrent && sameLegacySource) writeThemeProfileLegacyAccountScope(null);
    return { complete: () => retirePendingThemeProfileMigrationInput(scope, pending) };
}
