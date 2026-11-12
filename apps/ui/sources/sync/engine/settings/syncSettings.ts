import { isHomeCredentialCurrent } from '@/sync/runtime/orchestration/homeAccountChange';
import type { AccountRemoteAlertPolicyV1 } from '@happier-dev/protocol/account/settings/accountRemoteAlertPolicy';
import { tracking } from '@/track';
import { ThemeProfileLibraryStoredSchema } from '@/theme/profiles/themeProfilePersistence';
import { captureLegacyThemeProfileMigration } from './themeProfileMigration';
import { runAccountSettingsMutation } from './accountSettingsMutationOrder';
import { applySettings, settingsParse, type Settings } from '@/sync/domains/settings/settings';
import {
    normalizeVoiceSettingsLocalDelta,
    normalizeVoiceSettingsServerDelta,
} from '@/sync/domains/settings/voiceSettingsPersistence';
import { summarizeSettings, summarizeSettingsDelta, dbgSettings, isSettingsSyncDebugEnabled } from '@/sync/domains/settings/debugSettings';
import {
    stripDerivedAccountSettingsProjections,
    stripLocalOnlyAccountSettings,
    stripReadOnlyAccountSettingsDelta,
} from '@/sync/domains/settings/localOnlyAccountSettings';
import {
    MIGRATED_SESSION_ORGANIZATION_ACCOUNT_SETTING_KEYS,
    stripMigratedSessionOrganizationSettings,
} from '@/sync/domains/settings/parse/accountSettingsLegacyCleanup';
import {
    areAccountSettingsScopesEqual,
    accountSettingsScopeKeySuffix,
    type AccountSettingsScope,
} from '@/sync/domains/settings/scope/accountSettingsScope';
import {
    getActiveServerHomeCarrier,
    getActiveServerSnapshot,
} from '@/sync/domains/server/serverRuntime';
import {
    getServerProfileById,
    getServerProfileLegacyServerIds,
    resolveServerProfileScopeId,
} from '@/sync/domains/server/serverProfiles';
import { storage } from '@/sync/domains/state/storageStore';
import { loadPendingSettings } from '@/sync/domains/state/persistence';
import { getPersistenceStorage } from '@/sync/domains/state/persistenceStorage';
import { getStorage as getSessionOrganizationStorage } from '@/sync/domains/state/storageStore';
import {
    loadAccountSettings,
    loadPendingAccountSettings,
} from '@/sync/domains/state/accountSettingsPersistence';
import { areAccountSettingsJsonValuesEqual } from '@/sync/domains/settings/accountSettingsStructuralEquality';
import type { AuthCredentials } from '@/auth/storage/tokenStorage';
import type { Encryption } from '@/sync/encryption/encryption';
import {
    sealSecretsDeep,
} from '@/sync/encryption/secretSettings';
import {
    normalizeAccountSettingsForLocalStorage,
    normalizeAccountSettingsForServerStorage,
    openAccountSettingsStoredContent,
    AccountSettingsStoredContentUnavailableError,
} from '@/sync/domains/settings/accountSettingsNormalization';
import { createServerFetchAtEndpoint, type ServerFetch } from '@/sync/http/client';
import { readAccountSettingsWriteMaterial } from './accountSettingsWriteMaterial';
import { getRandomBytes } from '@/platform/cryptoRandom';
import { applyAccountSettingMutationV1, type AccountSettingMutationV1 } from '@happier-dev/protocol/account/settings/accountSettingMutationV1';
import { AccountSettingsV2UpdateResponseSchema } from '@happier-dev/protocol/account/settings/accountSettingsApiV2';
import { LEGACY_AUTHORING_MEMORY_SETTINGS_KEYS } from '@happier-dev/protocol/account/settings/legacyAuthoringMemorySettingsV1';
import { sealAccountScopedBlobCiphertext } from '@happier-dev/protocol/crypto/accountScopedCipher';
import type { AccountSettingsStoredContentEnvelope } from '@happier-dev/protocol/account/settings/accountSettingsStoredContentEnvelope';
import {
    readAccountSettingsBaseline,
    readRemoteAlertPolicyStatusHeader,
    type AccountSettingsBaselineContent,
} from './accountSettingsBaseline';
import { applyCrashReportsOptOut } from '@/utils/system/sentry';
import { emitAccountSettingChangedEvents } from '@/track/settingsAnalytics/emitSettingChangedEvent';
import type { SettingsAnalyticsSource } from '@/track/settingsAnalytics/types';
import {
    isServerIssuedIdentityId,
    migrateAccountSettingsServerIdentityKeys,
} from '@/sync/domains/settings/serverIdentityKeyMigration';
import { fetchSessionOrganizationSnapshot } from '@/sync/api/session/sessionOrganizationApi';
import {
    buildLegacySessionOrganizationImportPlan,
    stripImportedLegacySessionOrganizationSettingsForServer,
} from '@/sync/domains/session/organization/legacyImportPlan';
import { importLegacySessionOrganization as importLegacySessionOrganizationOp } from '@/sync/ops/sessionOrganization/importLegacySessionOrganization';
import {
    mergePendingSettingsIntoRawBaseline,
    removeCommittedPendingSettings,
} from './writeback/accountSettingsRawDeltaMerge';
import { areAccountSettingsRawObjectsEqual } from './writeback/accountSettingsRawEquality';
import { confirmAccountSettingsHead, readRetainedAccountSettingsRawSnapshot, retainAccountSettingsRawSnapshot } from './accountSettingsRawSnapshot';
import { createRemoteAlertPolicyWriteback } from './writeback/remoteAlertPolicyWriteback';
import { assertUiAccountEncryptionModeAllowed } from '@/sync/domains/settings/clientEncryptionRequirement';
import { getProviderCatalogSnapshot } from '@/sync/store/settings/providerCatalogSnapshot';
import { composeProviderSettingsV1 } from '@happier-dev/protocol/providers/connections/connectionRowsV1';

function readAdmittedVoiceProviderSettings(scope: AccountSettingsScope | null | undefined) {
    const snapshot = getProviderCatalogSnapshot(scope);
    return snapshot?.status === 'ready' && !snapshot.stale && snapshot.data
        ? composeProviderSettingsV1(snapshot.data, {}) : null;
}

function legacySessionOrganizationImportMarkerKey(scope: AccountSettingsScope): string {
    return `session-organization:legacy-import:v1:${accountSettingsScopeKeySuffix(scope)}`;
}

function hasCompletedLegacySessionOrganizationImport(scope: AccountSettingsScope): boolean {
    return getPersistenceStorage().getString(legacySessionOrganizationImportMarkerKey(scope)) === '1';
}

function markLegacySessionOrganizationImportComplete(scope: AccountSettingsScope): void {
    getPersistenceStorage().set(legacySessionOrganizationImportMarkerKey(scope), '1');
}

function pickMigratedSessionOrganizationSettings(settings: Record<string, unknown>): Record<string, unknown> {
    const picked: Record<string, unknown> = {};
    for (const key of MIGRATED_SESSION_ORGANIZATION_ACCOUNT_SETTING_KEYS) {
        if (Object.prototype.hasOwnProperty.call(settings, key)) {
            picked[key] = settings[key];
        }
    }
    return picked;
}

export type OneShotAccountSettingsMutationResult<T> =
    | Readonly<{
        status: 'applied';
        settingsVersion: number;
        value: T;
        /** Requested owner projection of the exact raw document transition. */
        captured?: unknown;
    }>
    | Readonly<{
        status: 'conflict';
        currentSettingsVersion: number;
    }>
    | Readonly<{
        status: 'invalid';
        reason: 'invalidPreparedMutation';
    }>
    | Readonly<{
        /** The one-shot write may have reached storage without its durable result. */
        status: 'outcomeUnknown';
        lastKnownSettingsVersion: number;
        /** Present only when this owner completed its one safe canonical readback. */
        safeSnapshotVersion?: number;
    }>;

export type OneShotAccountSettingsPreparedCommitResult =
    | Readonly<{ status: 'applied'; settingsVersion: number }>
    | Readonly<{ status: 'conflict' }>
    | Readonly<{ status: 'outcomeUnknown' }>
    | Readonly<{ status: 'rejected'; error: Error }>;

export type AccountSettingsMutationCapture = Readonly<{
    before: Readonly<Record<string, unknown>>;
    applied: Readonly<Record<string, unknown>>;
    beforeVersion: number;
}>;

export function requireOneShotAccountSettingsMutationApplied(
    result: Exclude<OneShotAccountSettingsMutationResult<unknown>, Readonly<{ status: 'applied' }>>,
): never;
export function requireOneShotAccountSettingsMutationApplied<T>(
    result: OneShotAccountSettingsMutationResult<T>,
): Extract<OneShotAccountSettingsMutationResult<T>, Readonly<{ status: 'applied' }>>;
export function requireOneShotAccountSettingsMutationApplied<T>(
    result: OneShotAccountSettingsMutationResult<T>,
): Extract<OneShotAccountSettingsMutationResult<T>, Readonly<{ status: 'applied' }>> {
    if (result.status === 'applied') return result;
    throw Object.assign(
        new Error(`Account Settings mutation did not settle: ${result.status}`),
        {
            code: result.status === 'conflict'
                ? 'account_settings_mutation_conflict'
                : result.status === 'invalid'
                    ? 'account_settings_mutation_invalid'
                    : 'account_settings_mutation_outcome_unknown',
            result,
        },
    );
}

function isPlainSettingsRecord(value: unknown): value is Record<string, unknown> {
    if (value === null || typeof value !== 'object') return false;
    const prototype = Object.getPrototypeOf(value);
    return prototype === Object.prototype || prototype === null;
}

export type SyncSettingsParams<TOneShotMutationValue = never> = {
    signal?: AbortSignal;
    credentials: AuthCredentials;
    encryption: Encryption | null;
    settingsScope?: AccountSettingsScope | null;
    pendingSettings: Partial<Settings>;
    /** Latest intents for this captured scope, including those awaiting the quiet disk flush. */
    getPendingSettings?: () => Partial<Settings>;
    clearPendingSettings: (nextPendingSettings: Partial<Settings>) => void;
    settingsSecretsKey?: Uint8Array | null;
    settingsSecretsReadKeys?: ReadonlyArray<Uint8Array | null | undefined>;
    /**
     * A caller-captured request for the same explicit Account Settings scope.
     * History restore uses this to keep its snapshot read and one-shot CAS on
     * one endpoint/credential capture across every await.
     */
    requestContext?: Readonly<{
        scope: AccountSettingsScope;
        endpointUrl: string;
        request: ServerFetch;
        /** Already opened on this captured transport; fresh identity is verified before sealing. */
        admittedBaseline?: Readonly<{
            accountMode: 'plain' | 'e2ee';
            value: AccountSettingsBaselineContent;
        }>;
    }>;
    /** Immutable set/reset operations reapplied to each fetched CAS winner. */
    accountSettingsMutation?: AccountSettingMutationV1;
    /**
     * One explicit semantic mutation against one Account Settings version.
     * By default the callback is never replayed after a version conflict;
     * pure field-level intents may opt into the bounded CAS rebase below.
     */
    oneShotServerSettingsMutation?: Readonly<{
        /** A rebasing intent may arrive before the local version has hydrated. */
        expectedSettingsVersion: number | null;
        expectedProfileTransferRevision?: number | 'absent';
        /** Replay a deterministic field-level intent against the latest CAS winner. */
        rebaseOnConflict?: boolean;
        /** Runs before issuance, after canonical normalization, at each CAS candidate. */
        capture?: (transition: AccountSettingsMutationCapture) => unknown;
        mutate: (
            raw: Readonly<Record<string, unknown>>,
        ) => Readonly<{
            settings: Record<string, unknown>;
            value: TOneShotMutationValue;
        }> | Promise<Readonly<{
            settings: Record<string, unknown>;
            value: TOneShotMutationValue;
        }>>;
        /**
         * Lets another Home transaction commit the canonical prepared Settings
         * envelope. Promotion uses this seam so resource creation and every
         * Settings reference rewrite share one server transaction.
         */
        commitPrepared?: (input: Readonly<{
            content: AccountSettingsStoredContentEnvelope;
            expectedSettingsVersion: number;
            accountMode: 'plain' | 'e2ee';
            remoteAlertPolicy?: AccountRemoteAlertPolicyV1 | null;
        }>) => Promise<OneShotAccountSettingsPreparedCommitResult>;
    }>;
};

/** Destination-first authoring-memory import may retire only its exact source key. */
export async function retireLegacyAuthoringMemoryKey(params: Readonly<{
    credentials: AuthCredentials;
    encryption: Encryption | null;
    accountMode: 'plain' | 'e2ee';
    settingsScope: AccountSettingsScope;
    requestContext: NonNullable<SyncSettingsParams['requestContext']>;
    key: typeof LEGACY_AUTHORING_MEMORY_SETTINGS_KEYS[number];
    expectedSettingsVersion: number;
}>): Promise<Exclude<OneShotAccountSettingsMutationResult<void>, Readonly<{ status: 'invalid' }>>> {
    if (!LEGACY_AUTHORING_MEMORY_SETTINGS_KEYS.includes(params.key)) {
        throw new Error('Invalid authoring-memory retirement key');
    }
    if (!areAccountSettingsScopesEqual(params.settingsScope, params.requestContext.scope)) {
        throw new Error('Account settings request scope does not match the settings scope');
    }
    if (!Number.isInteger(params.expectedSettingsVersion) || params.expectedSettingsVersion < 0) {
        throw new Error('Authoring-memory retirement requires a valid expected version');
    }
    const request = (path: string, init?: RequestInit) => params.requestContext.request(path, init, { includeAuth: false });
    const readBaseline = async () => {
        const baseline = await readAccountSettingsBaseline({
            request, credentials: params.credentials, encryption: params.encryption, accountMode: params.accountMode,
        });
        // A conflict is authoritative evidence that the socket-observed head
        // was stale. The import's next read must use this admitted document.
        retainAccountSettingsRawSnapshot(params.settingsScope, baseline.version, baseline.raw ?? {});
        return baseline;
    };
    const baseline = await readBaseline();
    if (baseline.version !== params.expectedSettingsVersion) {
        return { status: 'conflict', currentSettingsVersion: baseline.version };
    }
    if (!Object.prototype.hasOwnProperty.call(baseline.raw ?? {}, params.key)) {
        return { status: 'applied', settingsVersion: baseline.version, value: undefined };
    }
    // No generic Settings normalization is allowed here: opaque siblings,
    // including SecretString carriers, are outside this retirement's authority.
    const raw = { ...baseline.raw };
    delete raw[params.key];
    if (baseline.api !== 'v2') throw new Error('Authoring-memory retirement requires Account Settings v2');
    const writeMaterial = await readAccountSettingsWriteMaterial({ credentials: params.credentials,
        encryption: params.encryption, request, expectedMode: params.accountMode });
    writeMaterial.assertCurrent();
    let content: AccountSettingsStoredContentEnvelope;
    if (params.accountMode === 'plain') {
        content = { t: 'plain', v: raw };
    } else {
        if (!writeMaterial.material) throw new AccountSettingsStoredContentUnavailableError(
            'account_settings_encryption_material_unavailable', 'Account settings encryption material is unavailable');
        content = { t: 'encrypted', c: sealAccountScopedBlobCiphertext({
            kind: 'account_settings',
            material: writeMaterial.material,
            payload: raw,
            randomBytes: getRandomBytes,
        }) };
    }
    const recoverUnknownOutcome = async (): Promise<Exclude<OneShotAccountSettingsMutationResult<void>, Readonly<{ status: 'invalid' }>>> => {
        try {
            const readback = await readBaseline();
            return { status: 'outcomeUnknown', lastKnownSettingsVersion: readback.version, safeSnapshotVersion: readback.version };
        } catch {
            return { status: 'outcomeUnknown', lastKnownSettingsVersion: baseline.version };
        }
    };
    let response: Response;
    let acknowledgement: unknown;
    try {
        response = await request('/v2/account/settings', {
            method: 'POST',
            headers: { Authorization: `Bearer ${params.credentials.token}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({ content, expectedVersion: baseline.version }),
        });
        acknowledgement = await response.json();
    } catch {
        return recoverUnknownOutcome();
    }
    const parsed = AccountSettingsV2UpdateResponseSchema.safeParse(acknowledgement);
    if (!parsed.success) return recoverUnknownOutcome();
    if (parsed.data.success) {
        if (!response.ok) return recoverUnknownOutcome();
        retainAccountSettingsRawSnapshot(params.settingsScope, parsed.data.version, raw);
        return { status: 'applied', settingsVersion: parsed.data.version, value: undefined };
    }
    if (parsed.data.error === 'version-mismatch') {
        const opened = openAccountSettingsStoredContent({ content: parsed.data.currentContent,
            encryption: params.encryption, expectedMode: params.accountMode });
        retainAccountSettingsRawSnapshot(params.settingsScope, parsed.data.currentVersion, opened.raw ?? {});
        return { status: 'conflict', currentSettingsVersion: parsed.data.currentVersion };
    }
    throw new Error(`Authoring-memory retirement rejected: ${parsed.data.error}`);
}

export function syncSettings<TOneShotMutationValue>(
    params: SyncSettingsParams<TOneShotMutationValue> & Required<Pick<SyncSettingsParams<TOneShotMutationValue>, 'oneShotServerSettingsMutation'>>,
): Promise<OneShotAccountSettingsMutationResult<TOneShotMutationValue>>;
export function syncSettings<TOneShotMutationValue = never>(
    params: SyncSettingsParams<TOneShotMutationValue>,
): Promise<OneShotAccountSettingsMutationResult<TOneShotMutationValue> | void>;
export async function syncSettings<TOneShotMutationValue = never>(
    params: SyncSettingsParams<TOneShotMutationValue>,
): Promise<OneShotAccountSettingsMutationResult<TOneShotMutationValue> | void> {
    // Admitted Actions already hold this order. Ordinary writeback joins it so
    // migration cleanup cannot overtake a newer edit's durable pending handoff.
    if (params.settingsScope && !params.accountSettingsMutation && !params.oneShotServerSettingsMutation) {
        return runAccountSettingsMutation(params.settingsScope,
            () => syncSettingsUnlocked(params),
            params.signal ?? new AbortController().signal);
    }
    return syncSettingsUnlocked(params);
}

async function syncSettingsUnlocked<TOneShotMutationValue>(params: SyncSettingsParams<TOneShotMutationValue>): Promise<OneShotAccountSettingsMutationResult<TOneShotMutationValue> | void> {
    const { credentials, encryption, pendingSettings, clearPendingSettings } = params;
    const settingsScope = params.settingsScope ?? null;
    const settingsSecretsKey = params.settingsSecretsKey ?? null;
    const settingsSecretsReadKeys = params.settingsSecretsReadKeys ?? (settingsSecretsKey ? [settingsSecretsKey] : []);
    const requestContext = params.requestContext;
    if (requestContext && !areAccountSettingsScopesEqual(settingsScope, requestContext.scope)) {
        throw new Error('Account settings request scope does not match the settings scope');
    }
    const legacyServerIdsForSettingsKeys = settingsScope
        ? getServerProfileLegacyServerIds(settingsScope.serverId)
        : [];

    const activeServerSnapshot = requestContext ? null : getActiveServerSnapshot();
    const scopedProfile = settingsScope ? getServerProfileById(settingsScope.serverId) : null;
    const scopedProfileMatches = Boolean(
        settingsScope
        && scopedProfile
        && resolveServerProfileScopeId(scopedProfile) === settingsScope.serverId,
    );
    const activeSnapshotMatches = settingsScope && activeServerSnapshot
        ? activeServerSnapshot.serverId === settingsScope.serverId
        : true;
    const settingsEndpointUrl = String(
        requestContext?.endpointUrl
        ?? (scopedProfileMatches
            ? scopedProfile?.canonicalServerUrl ?? scopedProfile?.serverUrl
            : activeSnapshotMatches
                ? activeServerSnapshot?.serverUrl
                : ''),
    ).trim();
    if (!settingsEndpointUrl) {
        throw new Error('Account settings endpoint is unavailable for the captured scope');
    }
    // Runtime-origin and browser-Iroh carrier publication are active-Home
    // capabilities today. Never borrow them for another captured scope: a
    // non-active scope uses its canonical URL when reachable, otherwise its
    // pending delta remains scoped and retries when that Home becomes active.
    const activeHomeCarrier = !requestContext && activeSnapshotMatches ? getActiveServerHomeCarrier() : null;
    const capturedRequest = requestContext?.request ?? createServerFetchAtEndpoint({
        endpointUrl: settingsEndpointUrl,
        ...(activeSnapshotMatches && activeServerSnapshot?.runtimeOrigin
            ? { runtimeOrigin: activeServerSnapshot.runtimeOrigin }
            : {}),
        ...(activeHomeCarrier ? { homeCarrier: activeHomeCarrier } : {}),
        credentials,
        serverId: settingsScope?.serverId ?? activeServerSnapshot?.serverId ?? '',
        signal: params.signal,
    });
    let oneShotWriteIssued = false;
    const request = (path: string, init?: RequestInit): Promise<Response> => {
        if (params.signal?.aborted) throw new Error('Account Settings request was cancelled before issuance');
        if (init?.method === 'POST' && (path === '/v1/account/settings' || path === '/v2/account/settings')) {
            oneShotWriteIssued = true;
        }
        return capturedRequest(path, init, { includeAuth: false });
    };
    const remoteAlertPolicyWriteback = createRemoteAlertPolicyWriteback({ credentials, request });
    const maxRetries = 3;
    let retryCount = 0;
    let lastVersionMismatch: { expectedVersion: number; currentVersion: number; pendingKeys: string[] } | null = null;
    const pendingAccountSettings = stripReadOnlyAccountSettingsDelta(stripLocalOnlyAccountSettings(pendingSettings)) as Record<string, unknown>;
    const pendingLegacySessionOrganizationSettings = pickMigratedSessionOrganizationSettings(pendingAccountSettings);
    const pendingServerSettings = stripMigratedSessionOrganizationSettings(pendingAccountSettings) as Partial<Settings>;
    let legacySessionOrganizationImportCompletedThisRun = false;

    if (params.accountSettingsMutation && params.oneShotServerSettingsMutation) {
        throw new Error('Account settings mutation cannot be both replaying and one-shot');
    }
    if (params.oneShotServerSettingsMutation) {
        if (Object.keys(pendingServerSettings).length > 0) {
            throw new Error('One-shot Account Settings mutation requires pending settings to be flushed first');
        }
        const expected = params.oneShotServerSettingsMutation.expectedSettingsVersion;
        if (expected === null
            ? params.oneShotServerSettingsMutation.rebaseOnConflict !== true
            : !Number.isInteger(expected) || expected < 0) {
            throw new Error('One-shot Account Settings mutation requires a valid expected version');
        }
        if (params.oneShotServerSettingsMutation.rebaseOnConflict === true
            && params.oneShotServerSettingsMutation.commitPrepared) {
            throw new Error('Prepared Account Settings mutations cannot be rebased after conflict');
        }
    }

    // Explicit semantic mutations retain their exact requested transition.
    const themeProfileMigration = settingsScope && !params.accountSettingsMutation && !params.oneShotServerSettingsMutation
        ? captureLegacyThemeProfileMigration(settingsScope) : null;

    const admittedBaseline = requestContext?.admittedBaseline;
    // The admitted path initializes material at the fresh pre-seal boundary below.
    let writeMaterial!: Awaited<ReturnType<typeof readAccountSettingsWriteMaterial>>;
    const accountMode = admittedBaseline ? admittedBaseline.accountMode
        : (writeMaterial = await readAccountSettingsWriteMaterial({ credentials, encryption, request })).identity.mode;
    const accountIdentity = admittedBaseline ? undefined : writeMaterial.identity;
    const refreshWriteMaterial = async () => {
        writeMaterial = await readAccountSettingsWriteMaterial({ credentials, encryption, request,
            ...(admittedBaseline ? { expectedMode: accountMode } : { expectedIdentity: accountIdentity }) });
    };

    function isSettingsScopeActive(): boolean {
        if (!settingsScope) return true;
        return areAccountSettingsScopesEqual(storage.getState().settingsScope, settingsScope);
    }

    function loadSettingsForCapturedScope(): { settings: Settings; version: number | null } {
        if (!settingsScope || isSettingsScopeActive()) {
            const currentState = storage.getState();
            return {
                settings: currentState.settings,
                version: currentState.settingsVersion,
            };
        }
        const loaded = loadAccountSettings(settingsScope);
        return {
            settings: settingsParse(loaded.settings),
            version: loaded.version,
        };
    }

    function loadPendingSettingsForCapturedScope(): Partial<Settings> {
        if (params.getPendingSettings) return params.getPendingSettings();
        // Pre-auth/bootstrap calls may not have a captured account scope yet. Authenticated
        // sync paths always pass a scope and therefore use scoped pending settings.
        return settingsScope ? loadPendingAccountSettings(settingsScope) : loadPendingSettings();
    }

    function applySettingsForCapturedScope(nextSettings: Settings, nextVersion: number,
        remoteAlertPolicyStatus?: AccountSettingsBaselineContent['remoteAlertPolicyStatus']): void {
        if (settingsScope) {
            storage.getState().applySettingsForScope(settingsScope, nextSettings, nextVersion, remoteAlertPolicyStatus);
            return;
        }
        storage.getState().applySettings(nextSettings, nextVersion, remoteAlertPolicyStatus);
    }

    function applyActiveSettingsSideEffects(): void {
        if (!isSettingsScopeActive()) return;
        // The store may reject an older acknowledgement or publish a newer
        // update synchronously. Privacy effects follow its accepted projection,
        // never the incoming document that merely attempted to replace it.
        const nextSettings = storage.getState().settings;
        if (tracking) {
            nextSettings.analyticsOptOut ? tracking.optOut() : tracking.optIn();
        }
        applyCrashReportsOptOut(nextSettings.crashReportsOptOut);
    }

    type AccountSettingsServerBaseline = AccountSettingsBaselineContent & {
        serverIdentityKeysChanged: boolean;
    };

    const expectedProfileTransferRevision = params.oneShotServerSettingsMutation?.expectedProfileTransferRevision;
    async function updateSettingsV2(params: { content: unknown; expectedVersion: number; before: Readonly<Record<string, unknown>> | null; raw: Readonly<Record<string, unknown>> }): Promise<unknown> {
        const remotePolicy = await remoteAlertPolicyWriteback.prepare(params.before, params.raw, initialBaseline.remoteAlertPolicyWriteSupported);
        const response = await request('/v2/account/settings', {
            method: 'POST',
            body: JSON.stringify({
                content: params.content,
                expectedVersion: params.expectedVersion,
                ...(expectedProfileTransferRevision === undefined ? {} : { expectedProfileTransferRevision }),
                ...remotePolicy,
            }),
            headers: {
                'Authorization': `Bearer ${credentials.token}`,
                'Content-Type': 'application/json',
            },
        });

        const data: unknown = await response.json().catch(() => null);
        const parsed = AccountSettingsV2UpdateResponseSchema.safeParse(data);
        if (response.ok && parsed.success) return { ...parsed.data, remoteAlertPolicyStatus: readRemoteAlertPolicyStatusHeader(response.headers) };
        if (response.status === 404) {
            throw Object.assign(new Error('settings_v2_not_supported'), { code: 'settings_v2_not_supported' });
        }
        if (parsed.success) return parsed.data;
        throw new Error(`Failed to update settings (v2): ${response.status}`);
    }

    async function updateSettingsV1(params: { settings: string | null; expectedVersion: number }): Promise<any> {
        const response = await request('/v1/account/settings', {
            method: 'POST',
            body: JSON.stringify({
                settings: params.settings,
                expectedVersion: params.expectedVersion,
            }),
            headers: {
                'Authorization': `Bearer ${credentials.token}`,
                'Content-Type': 'application/json',
            },
        });

        const data: any = await response.json().catch(() => null);
        if (!data || typeof data !== 'object') {
            throw new Error(`Failed to update settings (v1): ${response.status}`);
        }

        if (response.ok && data.success === true && typeof data.version === 'number') {
            return { ...data, remoteAlertPolicyStatus: readRemoteAlertPolicyStatusHeader(response.headers) };
        }
        if (response.ok && data.success === false && data.error === 'version-mismatch' && typeof data.currentVersion === 'number') {
            return data;
        }
        throw new Error(`Failed to update settings (v1): ${response.status}`);
    }

    function migrateRawServerIdentityKeys(raw: Record<string, unknown> | null): {
        raw: Record<string, unknown> | null;
        changed: boolean;
    } {
        if (!raw || !settingsScope) return { raw, changed: false };
        const migrated = migrateAccountSettingsServerIdentityKeys({
            settings: raw,
            currentServerId: settingsScope.serverId,
            legacyServerIds: legacyServerIdsForSettingsKeys,
            rewriteUnknownServerIds: isServerIssuedIdentityId(settingsScope.serverId),
        });
        return { raw: migrated.settings, changed: migrated.changed };
    }

    function mergePendingLegacySessionOrganizationSettings(
        raw: Record<string, unknown> | null,
    ): Record<string, unknown> | null {
        if (Object.keys(pendingLegacySessionOrganizationSettings).length === 0) return raw;
        const merged = {
            ...(raw ?? {}),
            ...pendingLegacySessionOrganizationSettings,
        };
        return migrateRawServerIdentityKeys(merged).raw;
    }

    async function fetchAccountSettingsBaseline(admitted?: NonNullable<SyncSettingsParams['requestContext']>['admittedBaseline']): Promise<AccountSettingsServerBaseline> {
        // The wire read and envelope opening live in the shared baseline seam;
        // this wrapper adds only the captured-scope identity-key migration and
        // its local normalization side effect.
        const fetched = admitted?.value ?? await readAccountSettingsBaseline({
            request,
            credentials,
            encryption,
            accountMode,
        });
        const migrated = migrateRawServerIdentityKeys(fetched.raw);
        if (accountMode === 'plain') {
            assertUiAccountEncryptionModeAllowed({
                mode: 'plain',
                syncedSettings: migrated.raw ?? {},
                localSettings: loadSettingsForCapturedScope().settings,
            });
        }
        return { ...fetched, raw: migrated.raw, serverIdentityKeysChanged: migrated.changed };
    }

    async function baselineFromVersionMismatch(data: any): Promise<AccountSettingsServerBaseline> {
        const currentContent = (data.currentContent ??
            (typeof data.currentSettings === 'string' || data.currentSettings === null
                ? (data.currentSettings ? { t: 'encrypted', c: data.currentSettings } : null)
                : null)) as AccountSettingsStoredContentEnvelope | null;
        const opened = openAccountSettingsStoredContent({
            content: currentContent,
            encryption,
            expectedMode: accountMode,
        });
        const migrated = migrateRawServerIdentityKeys(opened.raw);
        if (opened.mode === 'plain') {
            assertUiAccountEncryptionModeAllowed({
                mode: 'plain',
                syncedSettings: migrated.raw ?? {},
                localSettings: loadSettingsForCapturedScope().settings,
            });
        }
        return {
            api: data.currentContent !== undefined ? 'v2' : 'v1',
            content: currentContent,
            version: data.currentVersion,
            raw: migrated.raw,
            format: opened.format,
            serverIdentityKeysChanged: migrated.changed,
        };
    }

    function normalizeSettingsForLocalStorage(params: {
        raw: Record<string, unknown> | null;
        mode: 'plain' | 'e2ee';
    }): Settings {
        const localSettings = loadSettingsForCapturedScope().settings;
        return normalizeAccountSettingsForLocalStorage({
            raw: params.raw,
            mode: params.mode,
            settingsSecretsKey,
            settingsSecretsReadKeys,
            localSettings,
            normalizeServerRaw: stripMigratedSessionOrganizationSettingsForImportedScope,
        });
    }

    function normalizeSettingsForServerStorageResult(params: {
        raw: Settings | Record<string, unknown>;
        mode: 'plain' | 'e2ee';
        current?: Readonly<Record<string, unknown>>;
    }): { value: Record<string, unknown>; changed: boolean } {
        writeMaterial.assertCurrent();
        const strippedLocalOnly = stripLocalOnlyAccountSettings(params.raw) as Record<string, unknown>;
        const stripped = stripMigratedSessionOrganizationSettingsForImportedScope(strippedLocalOnly);
        const migratedOrganizationStripped = !areAccountSettingsRawObjectsEqual(
            strippedLocalOnly,
            stripped,
        );
        // Enforce Voice persistence compatibility at the final write boundary.
        // This also covers crash-recovered pending deltas created by an older
        // build and every CAS conflict retry baseline.
        const providerSettings = readAdmittedVoiceProviderSettings(settingsScope);
        const voiceNormalized = normalizeVoiceSettingsServerDelta(stripped, params.current, providerSettings);
        const voiceChanged = !areAccountSettingsRawObjectsEqual(
            stripped,
            voiceNormalized as Record<string, unknown>,
        );
        const normalized = normalizeAccountSettingsForServerStorage({
            raw: strippedLocalOnly,
            mode: params.mode,
            settingsSecretsKey,
            settingsSecretsReadKeys,
            normalizeServerRaw: (raw) =>
                normalizeVoiceSettingsServerDelta(
                    stripMigratedSessionOrganizationSettingsForImportedScope(raw),
                    params.current,
                    providerSettings,
                ) as Record<string, unknown>,
        });
        return {
            value: normalized.value,
            changed: migratedOrganizationStripped || voiceChanged || normalized.secretsChanged,
        };
    }

    function createSettingsContentForWrite(raw: Record<string, unknown>): {
        content: AccountSettingsStoredContentEnvelope;
        v1Settings: string | null;
    } {
        writeMaterial.assertCurrent();
        if (accountMode === 'plain') {
            assertUiAccountEncryptionModeAllowed({
                mode: 'plain',
                syncedSettings: raw,
                localSettings: loadSettingsForCapturedScope().settings,
            });
            return { content: { t: 'plain', v: raw }, v1Settings: null };
        }
        if (!writeMaterial.material) throw new AccountSettingsStoredContentUnavailableError(
            'account_settings_encryption_material_unavailable', 'Account settings encryption material is unavailable');
        const ciphertext = sealAccountScopedBlobCiphertext({
            kind: 'account_settings',
            material: writeMaterial.material,
            payload: raw,
            randomBytes: getRandomBytes,
        });
        return { content: { t: 'encrypted', c: ciphertext }, v1Settings: ciphertext };
    }

    function applyRawSettingsProjection(params: {
        raw: Record<string, unknown> | null;
        version: number;
        remainingPendingSettings?: Partial<Settings>;
        remoteAlertPolicyStatus?: AccountSettingsBaselineContent['remoteAlertPolicyStatus'];
    }): Settings {
        if (settingsScope) retainAccountSettingsRawSnapshot(settingsScope, params.version, params.raw);
        const parsedSettings = params.raw
            ? normalizeSettingsForLocalStorage({ raw: params.raw, mode: accountMode })
            : normalizeAccountSettingsForLocalStorage({
                raw: null,
                mode: accountMode,
                settingsSecretsKey,
                settingsSecretsReadKeys,
                localSettings: loadSettingsForCapturedScope().settings,
            });
        const remainingServerPending = stripMigratedSessionOrganizationSettings(
            stripLocalOnlyAccountSettings(params.remainingPendingSettings ?? {}) as Record<string, unknown>,
        ) as Partial<Settings>;
        const mergedWithPending = Object.keys(remainingServerPending).length > 0
            ? applySettings(parsedSettings, remainingServerPending)
            : parsedSettings;
        const nextSettings = mergedWithPending;
        applySettingsForCapturedScope(nextSettings, params.version, params.remoteAlertPolicyStatus);
        applyActiveSettingsSideEffects();
        return nextSettings;
    }

    async function recoverOneShotOutcomeUnknown(
        lastKnownSettingsVersion: number,
    ): Promise<OneShotAccountSettingsMutationResult<TOneShotMutationValue>> {
        try {
            // The POST may have committed even though its acknowledgement was
            // lost. Re-enter the existing canonical reader once; never replay
            // the one-shot callback against a later baseline.
            const readback = await fetchAccountSettingsBaseline();
            applyRawSettingsProjection({
                raw: readback.raw,
                version: readback.version,
                remoteAlertPolicyStatus: readback.remoteAlertPolicyStatus,
                remainingPendingSettings: {},
            });
            return Object.freeze({
                status: 'outcomeUnknown' as const,
                lastKnownSettingsVersion: readback.version,
                safeSnapshotVersion: readback.version,
            });
        } catch {
            return Object.freeze({
                status: 'outcomeUnknown' as const,
                lastKnownSettingsVersion,
            });
        }
    }

    function clearCommittedPendingSettings(
        submittedPendingSettings: Partial<Settings>,
        options?: { preserveMigratedSessionOrganizationSettings?: boolean },
    ): Partial<Settings> {
        const currentPendingSettings = loadPendingSettingsForCapturedScope();
        const mergedCurrentPendingSettings = {
            ...pendingSettings,
            ...currentPendingSettings,
        } as Partial<Settings>;
        const nextRawPendingSettings = removeCommittedPendingSettings(mergedCurrentPendingSettings, submittedPendingSettings) as Record<string, unknown>;
        const nextPendingSettings = options?.preserveMigratedSessionOrganizationSettings
            ? nextRawPendingSettings as Partial<Settings>
            : stripMigratedSessionOrganizationSettings(nextRawPendingSettings) as Partial<Settings>;
        clearPendingSettings(nextPendingSettings);
        return nextPendingSettings;
    }

    function shouldStripMigratedSessionOrganizationSettings(): boolean {
        return settingsScope
            ? legacySessionOrganizationImportCompletedThisRun || hasCompletedLegacySessionOrganizationImport(settingsScope)
            : false;
    }

    function stripMigratedSessionOrganizationSettingsForImportedScope<TSettings extends Record<string, unknown>>(settings: TSettings): TSettings {
        if (!settingsScope || !shouldStripMigratedSessionOrganizationSettings()) return settings;
        return stripImportedLegacySessionOrganizationSettingsForServer({
            serverId: settingsScope.serverId,
            rawSettings: settings,
        });
    }

    async function maybeImportLegacySessionOrganization(rawSettings: Record<string, unknown> | null): Promise<boolean> {
        if (!settingsScope || !rawSettings) return false;
        if (hasCompletedLegacySessionOrganizationImport(settingsScope)) {
            legacySessionOrganizationImportCompletedThisRun = true;
            return true;
        }

        try {
            const initialPlan = buildLegacySessionOrganizationImportPlan({
                serverId: settingsScope.serverId,
                rawSettings,
            });
            if (!initialPlan.hasLegacyOrganizationSettings) return false;
            if (!initialPlan.hasImportableLegacyOrganization) {
                markLegacySessionOrganizationImportComplete(settingsScope);
                legacySessionOrganizationImportCompletedThisRun = true;
                return true;
            }

            const snapshotRequest = {
                includeFolders: true,
                includeTags: true,
                includeLabels: true,
                includeAllFolderAssignments: true,
                includeAllTagAssignments: true,
            } as const;
            const existing = await fetchSessionOrganizationSnapshot({
                credentials,
                requestAtEndpoint: request,
                request: snapshotRequest,
            });
            const plan = buildLegacySessionOrganizationImportPlan({
                serverId: settingsScope.serverId,
                rawSettings,
                existingSnapshot: existing.snapshot,
            });
            if (plan.hasImportableLegacyOrganization) {
                await importLegacySessionOrganizationOp({
                    credentials,
                    serverId: settingsScope.serverId,
                    requestAtEndpoint: request,
                    accountMode,
                    request: plan.request,
                });
            } else if (isHomeCredentialCurrent(settingsScope.serverId, credentials)) {
                getSessionOrganizationStorage().getState().applySessionOrganizationSnapshot(
                    settingsScope.serverId,
                    existing.snapshot,
                    snapshotRequest,
                );
            }
            markLegacySessionOrganizationImportComplete(settingsScope);
            legacySessionOrganizationImportCompletedThisRun = true;
            return true;
        } catch (error) {
            dbgSettings('syncSettings: legacy session organization import skipped', {
                endpoint: settingsEndpointUrl,
                error: error instanceof Error ? error.message : String(error),
            });
            return false;
        }
    }

    // A refresh with nothing to write only exists to catch up. When the Home's head is the version
    // Sync already admitted and applied, the document is known: no whole-blob read, no republication.
    // The remote-alert status is a pure function of the policy binding and Settings version, every
    // change of which moves the head, so a known status cannot be stale here. An unknown one (an older
    // Home omits it) keeps the consumer's exact-version re-read below.
    if (settingsScope && isSettingsScopeActive() && !admittedBaseline && Object.keys(pendingServerSettings).length === 0
        && !themeProfileMigration && !params.accountSettingsMutation && !params.oneShotServerSettingsMutation
        && storage.getState().settingsRemoteAlertPolicyStatus != null) {
        const admitted = readRetainedAccountSettingsRawSnapshot(settingsScope);
        if (admitted && admitted.version === loadSettingsForCapturedScope().version
            && writeMaterial.settingsVersion === admitted.version) {
            confirmAccountSettingsHead(settingsScope, admitted.version);
            await maybeImportLegacySessionOrganization({ ...admitted.raw });
            return;
        }
    }

    const initialBaseline = await fetchAccountSettingsBaseline(requestContext?.admittedBaseline);
    let prefetchedFinalBaseline: AccountSettingsServerBaseline | null = initialBaseline;

    // Apply pending settings
    if (Object.keys(pendingServerSettings).length > 0
        || themeProfileMigration
        || params.accountSettingsMutation
        || params.oneShotServerSettingsMutation) {
        dbgSettings('syncSettings: pending detected; will POST', {
            endpoint: settingsEndpointUrl,
            pendingKeys: Object.keys(pendingServerSettings).sort(),
            pendingSummary: summarizeSettingsDelta(pendingServerSettings as Partial<Settings>),
            base: summarizeSettings(storage.getState().settings, { version: storage.getState().settingsVersion }),
        });

        let baseline = initialBaseline;
        prefetchedFinalBaseline = null;
        let pendingLegacySessionOrganizationImported = params.oneShotServerSettingsMutation ? false
            : await maybeImportLegacySessionOrganization(mergePendingLegacySessionOrganizationSettings(baseline.raw));
        while (retryCount < maxRetries) {
            const version = baseline.version;
            if (params.oneShotServerSettingsMutation
                && version !== params.oneShotServerSettingsMutation.expectedSettingsVersion
                && params.oneShotServerSettingsMutation.rebaseOnConflict !== true) {
                applyRawSettingsProjection({
                    raw: baseline.raw,
                    version,
                    remoteAlertPolicyStatus: baseline.remoteAlertPolicyStatus,
                    remainingPendingSettings: {},
                });
                return Object.freeze({
                    status: 'conflict',
                    currentSettingsVersion: version,
                });
            }
            const oneShotMutation = params.oneShotServerSettingsMutation
                ? await params.oneShotServerSettingsMutation.mutate(baseline.raw ?? {})
                : null;
            if (params.oneShotServerSettingsMutation
                && (!isPlainSettingsRecord(oneShotMutation)
                    || !Object.hasOwn(oneShotMutation, 'settings')
                    || !isPlainSettingsRecord(oneShotMutation.settings))) {
                return Object.freeze({ status: 'invalid', reason: 'invalidPreparedMutation' });
            }
            // Preparation may await a key change. Re-admit before importing legacy
            // organization data, normalizing secrets or sealing this attempt.
            await refreshWriteMaterial();
            if (params.oneShotServerSettingsMutation) {
                pendingLegacySessionOrganizationImported = await maybeImportLegacySessionOrganization(
                    mergePendingLegacySessionOrganizationSettings(baseline.raw),
                ) || pendingLegacySessionOrganizationImported;
            }
            const immutableMutation = params.accountSettingsMutation
                ? applyAccountSettingMutationV1(
                    baseline.raw ?? {},
                    params.accountSettingsMutation,
                )
                : null;
            if (immutableMutation?.status === 'invalid') {
                throw Object.assign(
                    new Error(`Invalid Account Settings mutation: ${immutableMutation.reason}`),
                    {
                        code: 'account_settings_mutation_invalid',
                        reason: immutableMutation.reason,
                    },
                );
            }
            const mutationBaseline = oneShotMutation
                ? oneShotMutation.settings
                : immutableMutation?.raw ?? baseline.raw;
            const migratedThemes = themeProfileMigration?.resolve(
                ThemeProfileLibraryStoredSchema.parse(baseline.raw?.themeProfiles ?? []), pendingServerSettings.themeProfiles,
            ) ?? null;
            const pendingWithMigration: Partial<Settings> = migratedThemes
                ? { ...pendingServerSettings, themeProfiles: [...migratedThemes.profiles] } : pendingServerSettings;
            const merged = mergePendingSettingsIntoRawBaseline({
                rawBaseline: mutationBaseline,
                pendingSettings: pendingWithMigration,
                normalizeForPersistedStorage: (raw) => normalizeSettingsForServerStorageResult({ raw, mode: accountMode, current: baseline.raw ?? {} }),
            });
            const normalizedUnmutatedBaseline = normalizeSettingsForServerStorageResult({
                raw: baseline.raw ?? {},
                mode: accountMode,
                current: baseline.raw ?? {},
            }).value;
            if (migratedThemes) themeProfileMigration?.stage(migratedThemes);
            const captured = params.oneShotServerSettingsMutation?.capture?.({
                before: baseline.raw ?? {}, applied: merged.outgoingRaw, beforeVersion: version,
            });
            const serverMutationChanged = !areAccountSettingsRawObjectsEqual(
                normalizedUnmutatedBaseline,
                merged.comparisonRaw,
            );
            if (!params.oneShotServerSettingsMutation?.commitPrepared
                && !baseline.serverIdentityKeysChanged
                && !serverMutationChanged
                && !merged.comparisonChanged
                && areAccountSettingsRawObjectsEqual(merged.comparisonRaw, merged.outgoingRaw)) {
                const remainingPendingSettings = clearCommittedPendingSettings(pendingWithMigration, {
                    preserveMigratedSessionOrganizationSettings: Object.keys(pendingLegacySessionOrganizationSettings).length > 0
                        && !pendingLegacySessionOrganizationImported,
                });
                dbgSettings('syncSettings: pending merge produced no server change; skipped POST', {
                    endpoint: settingsEndpointUrl,
                    serverVersion: version,
                    pendingKeys: Object.keys(pendingServerSettings).sort(),
                });
                applyRawSettingsProjection({
                    raw: baseline.raw,
                    version,
                    remoteAlertPolicyStatus: baseline.remoteAlertPolicyStatus,
                    remainingPendingSettings,
                });
                if (migratedThemes) {
                    themeProfileMigration?.acknowledge(migratedThemes);
                    themeProfileMigration?.finish(migratedThemes);
                }
                return oneShotMutation
                    ? Object.freeze({
                        status: 'applied',
                        settingsVersion: version,
                        value: oneShotMutation.value,
                        ...(captured === undefined ? {} : { captured }),
                    })
                    : undefined;
            }

            const { content, v1Settings } = createSettingsContentForWrite(merged.outgoingRaw);
            dbgSettings('syncSettings: POST attempt', {
                endpoint: settingsEndpointUrl,
                attempt: retryCount + 1,
                expectedVersion: version,
                merged: summarizeSettings(merged.outgoingRaw as any, { version }),
            });

            let data: any;
            let preparedCommitResult: OneShotAccountSettingsPreparedCommitResult | null = null;
            try {
                // From this point the one-shot external mutation may have
                // reached storage. Missing or malformed acknowledgement is
                // reconciled once, never retried as another mutation.
                if (params.oneShotServerSettingsMutation?.commitPrepared) {
                    preparedCommitResult = await params.oneShotServerSettingsMutation.commitPrepared({
                        content,
                        expectedSettingsVersion: version,
                        accountMode,
                        ...await remoteAlertPolicyWriteback.prepare(baseline.raw, merged.outgoingRaw, initialBaseline.remoteAlertPolicyWriteSupported),
                    });
                    data = preparedCommitResult.status === 'applied'
                        ? { success: true, version: preparedCommitResult.settingsVersion }
                        : null;
                } else {
                    data = baseline.api === 'v2'
                        ? await updateSettingsV2({ content, expectedVersion: version, before: baseline.raw, raw: merged.outgoingRaw })
                        : await updateSettingsV1({ settings: v1Settings, expectedVersion: version });
                }
            } catch (error) {
                if (params.oneShotServerSettingsMutation) {
                    if (!oneShotWriteIssued) throw error;
                    return await recoverOneShotOutcomeUnknown(version);
                }
                throw error;
            }

            if (preparedCommitResult?.status === 'outcomeUnknown') {
                return await recoverOneShotOutcomeUnknown(version);
            }
            if (preparedCommitResult?.status === 'rejected') {
                throw preparedCommitResult.error;
            }
            if (preparedCommitResult?.status === 'conflict') {
                const current = await fetchAccountSettingsBaseline();
                applyRawSettingsProjection({ raw: current.raw, version: current.version,
                    remoteAlertPolicyStatus: current.remoteAlertPolicyStatus, remainingPendingSettings: {} });
                return Object.freeze({
                    status: 'conflict' as const,
                    currentSettingsVersion: current.version,
                });
            }

            if (data.success) {
                const remainingPendingSettings = clearCommittedPendingSettings(pendingWithMigration, {
                    preserveMigratedSessionOrganizationSettings: Object.keys(pendingLegacySessionOrganizationSettings).length > 0
                        && !pendingLegacySessionOrganizationImported,
                });
                dbgSettings('syncSettings: POST success; pending cleared', {
                    endpoint: settingsEndpointUrl,
                    expectedVersion: version,
                    responseVersion: data.version,
                });
                applyRawSettingsProjection({
                    raw: merged.outgoingRaw,
                    version: data.version,
                    remoteAlertPolicyStatus: data.remoteAlertPolicyStatus,
                    remainingPendingSettings,
                });
                if (migratedThemes) {
                    themeProfileMigration?.acknowledge(migratedThemes);
                    themeProfileMigration?.finish(migratedThemes);
                }
                return oneShotMutation
                    ? Object.freeze({
                        status: 'applied',
                        settingsVersion: data.version,
                        value: oneShotMutation.value,
                        ...(captured === undefined ? {} : { captured }),
                    })
                    : undefined;
            }

            if (data.error === 'profile-transfer-mismatch' && params.oneShotServerSettingsMutation) {
                // A transfer changed authority without changing the source Settings
                // version. Never replay the old opened control or its root claims.
                const current = await fetchAccountSettingsBaseline();
                applyRawSettingsProjection({ raw: current.raw, version: current.version,
                    remoteAlertPolicyStatus: current.remoteAlertPolicyStatus, remainingPendingSettings: {} });
                return Object.freeze({ status: 'conflict', currentSettingsVersion: current.version });
            }

            if (data.error === 'version-mismatch') {
                lastVersionMismatch = {
                    expectedVersion: version,
                    currentVersion: data.currentVersion,
                    pendingKeys: Object.keys(pendingServerSettings).sort(),
                };
                baseline = await baselineFromVersionMismatch(data);
                if (!params.oneShotServerSettingsMutation) {
                    pendingLegacySessionOrganizationImported = await maybeImportLegacySessionOrganization(
                        mergePendingLegacySessionOrganizationSettings(baseline.raw),
                    ) || pendingLegacySessionOrganizationImported;
                }
                if (params.oneShotServerSettingsMutation?.rebaseOnConflict === true) {
                    dbgSettings('syncSettings: one-shot version-mismatch rebase', {
                        endpoint: settingsEndpointUrl,
                        expectedVersion: version,
                        currentVersion: data.currentVersion,
                        pendingKeys: Object.keys(pendingServerSettings).sort(),
                    });
                    retryCount++;
                    continue;
                }
                if (params.oneShotServerSettingsMutation) {
                    applyRawSettingsProjection({
                        raw: baseline.raw,
                        version: baseline.version,
                        remoteAlertPolicyStatus: baseline.remoteAlertPolicyStatus,
                        remainingPendingSettings: {},
                    });
                    return Object.freeze({
                        status: 'conflict',
                        currentSettingsVersion: baseline.version,
                    });
                }
                dbgSettings('syncSettings: version-mismatch merge', {
                    endpoint: settingsEndpointUrl,
                    expectedVersion: version,
                    currentVersion: data.currentVersion,
                    pendingKeys: Object.keys(pendingServerSettings).sort(),
                    serverRawKeys: Object.keys(baseline.raw ?? {}).sort(),
                });
                retryCount++;
                continue;
            }

            throw new Error(`Failed to sync settings: ${data.error}`);
        }
    } else if (Object.keys(pendingSettings).length > 0) {
        // Pending keys can include UI-local server-selection fields, which are intentionally local-only.
        // Drop them from pending storage to avoid unnecessary sync attempts.
        if (Object.keys(pendingLegacySessionOrganizationSettings).length > 0) {
            if (settingsScope) {
                const baseline = initialBaseline;
                prefetchedFinalBaseline = baseline;
                const imported = await maybeImportLegacySessionOrganization(
                    mergePendingLegacySessionOrganizationSettings(baseline.raw),
                );
                if (imported) {
                    clearCommittedPendingSettings(pendingSettings);
                } else {
                    dbgSettings('syncSettings: kept pending legacy session organization settings after failed import', {
                        endpoint: settingsEndpointUrl,
                        pendingKeys: Object.keys(pendingSettings).sort(),
                    });
                }
            } else {
                dbgSettings('syncSettings: kept pending legacy session organization settings without account scope', {
                    endpoint: settingsEndpointUrl,
                    pendingKeys: Object.keys(pendingSettings).sort(),
                });
            }
        } else {
            clearCommittedPendingSettings(pendingSettings);
            dbgSettings('syncSettings: cleared local-only pending settings keys', {
                endpoint: settingsEndpointUrl,
                pendingKeys: Object.keys(pendingSettings).sort(),
            });
        }
    }

    // If exhausted retries, throw to trigger outer backoff delay
    if (retryCount >= maxRetries) {
        const mismatchHint = lastVersionMismatch
            ? ` (expected=${lastVersionMismatch.expectedVersion}, current=${lastVersionMismatch.currentVersion}, pendingKeys=${lastVersionMismatch.pendingKeys.join(',')})`
            : '';
        throw new Error(`Settings sync failed after ${maxRetries} retries due to version conflicts${mismatchHint}`);
    }

    const fetched = prefetchedFinalBaseline ?? await fetchAccountSettingsBaseline();
    const decryptedSettings = fetched.raw;
    await maybeImportLegacySessionOrganization(decryptedSettings);

    // Merge any locally-pending settings deltas before applying server settings.
    //
    // Why:
    // - Local writes apply immediately but do not bump `settingsVersion`.
    // - A concurrent sync tick can fetch/apply a newer server version (e.g. migrations/other clients)
    //   and accidentally clobber recent local edits before the pending POST flush runs.
    // - Read the captured scope's latest intents from Sync, including those awaiting the quiet
    //   disk flush. Other callers fall back to the persisted pending settings for that scope.
    const pendingLatest = loadPendingSettingsForCapturedScope();
    const nextSettings = applyRawSettingsProjection({
        raw: decryptedSettings,
        version: fetched.version,
        remoteAlertPolicyStatus: fetched.remoteAlertPolicyStatus,
        remainingPendingSettings: pendingLatest,
    });

    dbgSettings('syncSettings: GET applied', {
        endpoint: settingsEndpointUrl,
        serverVersion: fetched.version,
        parsed: summarizeSettings(nextSettings, { version: fetched.version }),
    });

    // Reading may project retained formats locally. Persist normalization only with
    // the next deliberate mutation above; a GET must not rewrite another writer's document.
}

export function applySettingsLocalDelta(params: {
    expectedSettingsScope: AccountSettingsScope | null;
    delta: Partial<Settings>;
    settingsSecretsKey: Uint8Array | null;
    getPendingSettings: () => Partial<Settings>;
    setPendingSettings: (next: Partial<Settings>) => void;
    schedulePendingSettingsFlush: () => void;
    source?: SettingsAnalyticsSource;
}): void {
    const { settingsSecretsKey, getPendingSettings, setPendingSettings, schedulePendingSettingsFlush } = params;
    let { delta } = params;

    const currentScope = storage.getState().settingsScope;
    const isExpectedScopeActive = (currentScope === null && params.expectedSettingsScope === null)
        || areAccountSettingsScopesEqual(currentScope, params.expectedSettingsScope);
    if (!isExpectedScopeActive) {
        dbgSettings('applySettings skipped (account settings scope changed)', {
            expectedSettingsScope: params.expectedSettingsScope,
            currentSettingsScope: currentScope,
        });
        return;
    }

    // Generic writes cannot name runtime-derived keys in TypeScript, and this
    // boundary also drops stale/untyped deltas before local or pending writes.
    delta = stripDerivedAccountSettingsProjections(delta);

    const currentState = storage.getState();
    const hasServerBackedDelta = Object.keys(stripLocalOnlyAccountSettings(delta)).length > 0;
    if (hasServerBackedDelta
        && (currentState.settingsScope === null || currentState.settingsVersion === null)) {
        dbgSettings('applySettings skipped (account settings not hydrated)', {
            delta: summarizeSettingsDelta(delta),
        });
        return;
    }

    // Seal secret settings fields before any persistence.
    const currentSettings = currentState.settings;
    delta = sealSecretsDeep(delta, settingsSecretsKey);

    const hasRealChangeAgainstCurrent = (candidate: Partial<Settings>): boolean => {
        const entries = Object.entries(candidate) as Array<[keyof Settings, unknown]>;
        return entries.some(([key, next]) => {
            const prev = currentSettings[key];
            if (Object.is(prev, next)) return false;

            const prevIsObj = prev !== null && typeof prev === 'object';
            const nextIsObj = next !== null && typeof next === 'object';
            if (prevIsObj || nextIsObj) {
                return !areAccountSettingsJsonValuesEqual(prev, next);
            }
            return true;
        });
    };

    // Preserve the no-op contract before compatibility projection. A rebuilt
    // equal voice object must not become a write merely because an older local
    // snapshot has not yet acquired the canonical diagnostics root field.
    if (!hasRealChangeAgainstCurrent(delta)) {
        dbgSettings('applySettings skipped (no-op delta)', {
            delta: summarizeSettingsDelta(delta),
            base: summarizeSettings(currentSettings, { version: storage.getState().settingsVersion }),
        });
        return;
    }

    delta = normalizeVoiceSettingsLocalDelta(delta, currentSettings) as Partial<Settings>;

    // Avoid no-op writes. Settings writes cause:
    // - local persistence writes
    // - pending delta persistence
    // - a server POST (eventually)
    //
    // So we must not write when nothing actually changed.
    const hasRealChange = hasRealChangeAgainstCurrent(delta);
    if (!hasRealChange) {
        dbgSettings('applySettings skipped (no-op delta)', {
            delta: summarizeSettingsDelta(delta),
            base: summarizeSettings(currentSettings, { version: storage.getState().settingsVersion }),
        });
        return;
    }

    if (isSettingsSyncDebugEnabled()) {
        const stack = (() => {
            try {
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                const s = (new Error('settings-sync trace') as any)?.stack;
                return typeof s === 'string' ? s.split('\n').slice(0, 10).join('\n') : null;
            } catch {
                return null;
            }
        })();
        const st = storage.getState();
        dbgSettings('applySettings called', {
            delta: summarizeSettingsDelta(delta),
            base: summarizeSettings(st.settings, { version: st.settingsVersion }),
            stack,
        });
    }

    const nextSettings = applySettings(currentSettings, delta);
    const deltaForServer = stripLocalOnlyAccountSettings(
        normalizeVoiceSettingsServerDelta(delta, currentSettings, readAdmittedVoiceProviderSettings(currentScope)) as Partial<Settings>,
    );
    emitAccountSettingChangedEvents({
        previousSettings: currentSettings,
        nextSettings,
        source: params.source,
    });
    storage.getState().applySettingsLocal(delta);

    if (Object.keys(deltaForServer).length === 0) {
        dbgSettings('applySettings: local-only delta (no pending sync)', {
            delta: summarizeSettingsDelta(delta),
        });
        return;
    }

    // Save pending settings
    const nextPending = { ...getPendingSettings(), ...deltaForServer };
    setPendingSettings(nextPending);
    dbgSettings('applySettings: pendingSettings updated', {
        pendingKeys: Object.keys(nextPending).sort(),
    });

    // Sync PostHog opt-out state if it was changed
    if (tracking && 'analyticsOptOut' in delta) {
        nextSettings.analyticsOptOut ? tracking.optOut() : tracking.optIn();
    }
    if ('crashReportsOptOut' in delta) {
        applyCrashReportsOptOut(nextSettings.crashReportsOptOut);
    }

    schedulePendingSettingsFlush();
}
