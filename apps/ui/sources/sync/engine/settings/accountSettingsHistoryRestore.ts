import { AccountSettingsV2HistoryDetailResponseSchema, AccountSettingsV2HistoryMutationRequestSchema, AccountSettingsV2HistoryMutationResponseSchema } from '@happier-dev/protocol/account/settings/accountSettingsApiV2';
import { applyAccountSettingsHistoryRestoreV1, type AccountSettingsHistoryDestinationAuthorityV1, type AccountSettingsHistoryRestoreInvalidReasonV1 } from '@happier-dev/protocol/account/settings/accountSettingsHistoryRestoreV1';
import { captureAccountSettingsHistoryDestinationAuthorityV1, normalizeAccountSettingsHistoryClientV1,
    areAccountSettingsHistoryRecoveryInputsEqualV1,
    type AccountSettingsHistoryClientPortsV1, type AccountSettingsHistoryCleanupResultV1,
    type AccountSettingsHistoryNormalizationCheckpointV1,
    type AccountSettingsHistorySavedSecretRecoveryV1 } from '@happier-dev/protocol/account/settings/accountSettingsHistoryClientV1';
import { PROFILE_TRANSFER_ROUTE_V1, ProfileTransferRowReadResponseV1Schema } from '@happier-dev/protocol/profiles/profileTransferV1';
import { sealAccountScopedBlobCiphertext } from '@happier-dev/protocol/crypto/accountScopedCipher';
import type { AccountEncryptionCurrentnessResponse } from '@happier-dev/protocol/account/encryptionMode';
import { SettingsDeclarationOperationInputV1Schema } from '@happier-dev/protocol/actions/settingsDeclarationActionFamily';
import { sameStrictJsonValue } from '@happier-dev/protocol/json/strictJsonValue';
import tweetnacl from 'tweetnacl';
import { z } from 'zod/mini';

import { areCredentialsEqual, type AuthCredentials } from '@/auth/storage/tokenStorage';
import type { Encryption } from '@/sync/encryption/encryption';
import { accountSettingsScopeKeySuffix, areAccountSettingsScopesEqual, type AccountSettingsScope } from '@/sync/domains/settings/scope/accountSettingsScope';
import { captureAccountSettingsRequest } from '@/sync/api/account/accountSettingsRequest';
import type { ServerFetch } from '@/sync/http/client';
import { fetchAccountEncryptionCurrentness } from '@/sync/api/account/apiAccountEncryptionMode';
import { resolveAccountScopedCryptoMaterialFromCredentials } from '@/sync/domains/connectedServices/resolveAccountScopedCryptoMaterialFromCredentials';
import { getRandomBytes } from '@/platform/cryptoRandom';
import {
    openAccountSettingsStoredContent,
    type OpenedAccountSettingsStoredContent,
} from '@/sync/domains/settings/accountSettingsNormalization';

import { getPersistenceStorage } from '@/sync/domains/state/persistenceStorage';
import { syncSettings } from './syncSettings';

/**
 * Client-side classification-aware Account Settings history restore (SET-07).
 *
 * This adapter owns exactly the realm facts the pure Protocol merge cannot:
 * fetching the recorded historical envelope, opening it in its RECORDED mode
 * (a snapshot stored before an encryption-mode transition still opens), and
 * submitting the merged document through the ordinary one-shot whole-document
 * CAS — which reseals to the CURRENT Account mode and applies the ordinary
 * local projection. There is no second restore writer: the retired
 * server-side exact-content restore keeps failing closed with
 * `account_settings_restore_client_update_required`.
 *
 * Restore is one-shot and never replayed: the merged document is computed once
 * against the freshest server baseline inside `syncSettings`' CAS callback, so
 * a version move is a typed conflict rather than a rewritten history.
 */

const SettingsVersionSchema = z.number().check(z.int(), z.nonnegative());
export const AccountSettingsHistoryRestoreResultSchema = z.discriminatedUnion('status', [
    z.strictObject({ status: z.literal('applied'), settingsVersion: SettingsVersionSchema }),
    z.strictObject({ status: z.literal('unchanged'), settingsVersion: SettingsVersionSchema }),
    z.strictObject({ status: z.literal('conflict'), currentSettingsVersion: SettingsVersionSchema }),
    z.strictObject({ status: z.literal('outcomeUnknown'), lastKnownSettingsVersion: SettingsVersionSchema }),
]);
export type AccountSettingsHistoryRestoreResult = Readonly<z.infer<typeof AccountSettingsHistoryRestoreResultSchema>>;

/** The historical snapshot exists but cannot serve a valid restore. */
export class AccountSettingsHistoryRestoreUnavailableError extends Error {
    readonly status: number;

    constructor(status: number, message: string) {
        super(message);
        this.name = 'AccountSettingsHistoryRestoreUnavailableError';
        this.status = status;
    }
}

/**
 * The merged document refused a current classification/bound, so nothing was
 * written. Restore never substitutes a default or rewinds a legacy root.
 */
export class AccountSettingsHistoryRestoreInvalidError extends Error {
    readonly reason: AccountSettingsHistoryRestoreInvalidReasonV1;

    constructor(reason: AccountSettingsHistoryRestoreInvalidReasonV1) {
        super(`Account Settings history restore refused the merged document (${reason})`);
        this.name = 'AccountSettingsHistoryRestoreInvalidError';
        this.reason = reason;
    }
}

function throwStaleRestoreScope(): never {
    throw new AccountSettingsHistoryRestoreUnavailableError(
        0,
        'Account Settings scope changed while restoring history',
    );
}

async function fetchHistorySnapshot(
    request: ServerFetch,
    version: number,
    isCurrent: () => boolean,
) {
    if (!isCurrent()) throwStaleRestoreScope();
    const response = await request(`/v2/account/settings/history/${version}`, {
        headers: {
            'Content-Type': 'application/json',
        },
    });
    if (!isCurrent()) throwStaleRestoreScope();
    if (!response.ok) {
        throw new AccountSettingsHistoryRestoreUnavailableError(
            response.status,
            `Failed to fetch account settings history snapshot (${response.status})`,
        );
    }
    const data: unknown = await response.json();
    if (!isCurrent()) throwStaleRestoreScope();
    const parsed = AccountSettingsV2HistoryDetailResponseSchema.safeParse(data);
    if (!parsed.success) {
        throw new AccountSettingsHistoryRestoreUnavailableError(
            response.status,
            'Account settings history snapshot response is invalid',
        );
    }
    return parsed.data;
}

function createHistoryCapturePorts(params: Readonly<{
    request: ServerFetch; isCurrent: () => boolean; credentials: AuthCredentials;
}>): Pick<AccountSettingsHistoryClientPortsV1, 'request' | 'readCurrentness' | 'isCurrent' | 'resolveTransferMaterial' | 'unavailable'> {
    return {
        request: async (path, input) => {
            const response = await params.request(path, { method: input.method, headers: { 'Content-Type': 'application/json' },
                ...(input.body === undefined ? {} : { body: JSON.stringify(input.body) }) }, input.method === 'POST' ? { retry: 'none' } : undefined);
            return { status: response.status, data: await response.json().catch(() => null) };
        },
        readCurrentness: () => fetchAccountEncryptionCurrentness(params.credentials, { request: params.request }),
        isCurrent: params.isCurrent,
        resolveTransferMaterial: mode => mode === 'plain' ? null : resolveAccountScopedCryptoMaterialFromCredentials(params.credentials),
        unavailable: (status, message) => { throw new AccountSettingsHistoryRestoreUnavailableError(status, message); },
    };
}

function captureDestinationAuthority(params: Readonly<{
    request: ServerFetch; isCurrent: () => boolean; credentials: AuthCredentials;
    currentness?: AccountEncryptionCurrentnessResponse;
    destinationAuthority?: AccountSettingsHistoryDestinationAuthorityV1;
}>) {
    return captureAccountSettingsHistoryDestinationAuthorityV1({ ports: createHistoryCapturePorts(params),
        currentness: params.currentness, destinationAuthority: params.destinationAuthority });
}

export type AccountSettingsHistoryCleanupResult = AccountSettingsHistoryCleanupResultV1;

// Catalogs share live Account-wide maintenance. Completed evidence below can skip
// history scans only after Protocol freshly recaptures currentness and destination rows.
const pendingHistoryNormalizations = new Set<Readonly<{
    params: Parameters<typeof normalizeAccountSettingsHistoryAfterTransfer>[0];
    isCurrent: () => boolean;
    result: Promise<AccountSettingsHistoryCleanupResult>;
}>>();

// One checkpoint per Account, scoped to the same credentials and cipher. Protocol
// re-reads head/transfer/destinations and compares proofs before using it.
const completedHistoryNormalizations = new Map<string, Readonly<{
    params: Parameters<typeof normalizeAccountSettingsHistoryAfterTransfer>[0];
    isCurrent: () => boolean;
    checkpoint: AccountSettingsHistoryNormalizationCheckpointV1;
}>>();

function sameHistoryNormalizationAccount(a: Parameters<typeof normalizeAccountSettingsHistoryAfterTransfer>[0],
    b: Parameters<typeof normalizeAccountSettingsHistoryAfterTransfer>[0]): boolean {
    return areAccountSettingsScopesEqual(a.settingsScope, b.settingsScope)
        && areCredentialsEqual(a.credentials, b.credentials)
        && (a.encryption === b.encryption || (a.encryption !== null && b.encryption !== null
            && tweetnacl.verify(a.encryption.getContentPrivateKey(), b.encryption.getContentPrivateKey())));
}

function sameHistoryNormalizationContext(a: Parameters<typeof normalizeAccountSettingsHistoryAfterTransfer>[0],
    b: Parameters<typeof normalizeAccountSettingsHistoryAfterTransfer>[0]): boolean {
    return sameHistoryNormalizationAccount(a, b)
        && a.expectedProfileTransferRevision === b.expectedProfileTransferRevision
        && areAccountSettingsHistoryRecoveryInputsEqualV1(a.savedSecretRecovery, b.savedSecretRecovery)
        && sameStrictJsonValue(a.destinationAuthority.savedSecretTransfers, b.destinationAuthority.savedSecretTransfers)
        && sameStrictJsonValue(a.destinationAuthority.legacyRoleArtifactTransfers, b.destinationAuthority.legacyRoleArtifactTransfers);
}

function pendingAccountPass(params: Parameters<typeof normalizeAccountSettingsHistoryAfterTransfer>[0]) {
    return [...pendingHistoryNormalizations].find(entry => entry.isCurrent() && sameHistoryNormalizationAccount(entry.params, params));
}

// A history row is immutable except for normalize/purge, which only remove transferred content,
// so "read and found clean under these verdict inputs" stays true for that version on later app
// starts. Device-local reuse of that verdict spares re-reading every retained row per launch; new
// rows and changed verdict inputs (key fingerprints, transferred roots) are still read.
const VERIFIED_HISTORY_ROWS_STORAGE_PREFIX = 'account-settings-history-verified-v1:';
const VerifiedHistoryRowsSchema = z.record(z.string(), z.array(z.number().check(z.int(), z.nonnegative())));

function readVerifiedHistoryRows(scopeKey: string): Map<string, Set<number>> {
    try {
        const raw = getPersistenceStorage().getString(VERIFIED_HISTORY_ROWS_STORAGE_PREFIX + scopeKey);
        const parsed = raw === undefined ? null : VerifiedHistoryRowsSchema.safeParse(JSON.parse(raw));
        return new Map(parsed?.success ? Object.entries(parsed.data).map(([verdict, rows]) => [verdict, new Set(rows)]) : []);
    } catch (error) {
        console.warn('[settings-history] Verified history rows could not be read; rows will be re-verified.', error);
        return new Map();
    }
}

function writeVerifiedHistoryRows(scopeKey: string, verified: Map<string, Set<number>> | undefined): void {
    const entries = [...(verified ?? [])].filter(([, rows]) => rows.size > 0);
    try {
        const storage = getPersistenceStorage();
        if (entries.length === 0) storage.delete(VERIFIED_HISTORY_ROWS_STORAGE_PREFIX + scopeKey);
        else storage.set(VERIFIED_HISTORY_ROWS_STORAGE_PREFIX + scopeKey,
            JSON.stringify(Object.fromEntries(entries.map(([verdict, rows]) => [verdict, [...rows]]))));
    } catch (error) {
        console.warn('[settings-history] Verified history rows could not be saved; the next launch re-verifies them.', error);
    }
}

/** Private transport for the incumbent approved, exact-version purge intent. */
export async function purgeAccountSettingsHistoryVersions(params: Readonly<{
    credentials: AuthCredentials; settingsScope: AccountSettingsScope; versions: readonly number[]; signal?: AbortSignal;
    requestContext?: Readonly<{ request: ServerFetch; isCurrent(): boolean; dispose?(): void }>;
}>): Promise<AccountSettingsHistoryCleanupResult> {
    const admitted = SettingsDeclarationOperationInputV1Schema.parse({ kind: 'account_settings_history_purge', versions: params.versions });
    if (admitted.kind !== 'account_settings_history_purge') throw new Error('Invalid history purge intent');
    const captured = params.requestContext ?? await captureAccountSettingsRequest(params);
    if (!captured) throwStaleRestoreScope();
    const pending = new Set<number>();
    try {
        const currentness = await fetchAccountEncryptionCurrentness(params.credentials, { request: captured.request, signal: params.signal });
        if (currentness.settingsVersion === undefined) throw new AccountSettingsHistoryRestoreUnavailableError(0, 'Settings currentness unavailable');
        const controlResponse = await captured.request(PROFILE_TRANSFER_ROUTE_V1, { method: 'GET', signal: params.signal });
        if (!captured.isCurrent()) throwStaleRestoreScope();
        if (!controlResponse.ok) throw new AccountSettingsHistoryRestoreUnavailableError(controlResponse.status, 'Profile transfer currentness unavailable');
        const control = ProfileTransferRowReadResponseV1Schema.parse(await controlResponse.json());
        if (control.status !== 'absent' && control.status !== 'deleted' && control.status !== 'present') {
            throw new AccountSettingsHistoryRestoreUnavailableError(0, 'Profile transfer currentness unavailable');
        }
        const mutation = AccountSettingsV2HistoryMutationRequestSchema.parse({ expectedSettingsVersion: currentness.settingsVersion,
            expectedProfileTransferRevision: control.status === 'absent' ? 'absent' : control.revision,
            expectedEncryptionCurrentness: { mode: currentness.mode, signingKeyFingerprint: currentness.signingKeyFingerprint,
                contentKeyFingerprint: currentness.contentKeyFingerprint }, operation: { kind: 'purge' } });
        for (const version of new Set(admitted.versions)) {
            try {
                if (!captured.isCurrent() || params.signal?.aborted) { pending.add(version); continue; }
                const response = await captured.request(`/v2/account/settings/history/${version}/mutate`, {
                    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(mutation), signal: params.signal,
                }, { retry: 'none' });
                const result = AccountSettingsV2HistoryMutationResponseSchema.safeParse(await response.json());
                if (!response.ok || !result.success || (result.data.status !== 'applied' && result.data.status !== 'not_found')) pending.add(version);
            } catch { pending.add(version); }
        }
        return pending.size ? { status: 'cleanup-pending', versions: [...pending] } : { status: 'complete' };
    } finally { captured.dispose?.(); }
}

/** One pass after source cleanup, including the previous document it just retained. */
export async function normalizeAccountSettingsHistoryAfterTransfer(params: Readonly<{
    credentials: AuthCredentials; encryption: Encryption | null; settingsScope: AccountSettingsScope;
    destinationAuthority: AccountSettingsHistoryDestinationAuthorityV1;
    expectedProfileTransferRevision?: number | 'absent';
    savedSecretRecovery?: AccountSettingsHistorySavedSecretRecoveryV1;
    /** An incumbent transfer/Action lifetime; never recapture a different Home. */
    requestContext?: Readonly<{ request: ServerFetch; isCurrent(): boolean; dispose?(): void }>;
}>): Promise<AccountSettingsHistoryCleanupResult> {
    const captured = params.requestContext ?? await captureAccountSettingsRequest(params);
    if (!captured) throwStaleRestoreScope();
    try {
        if (!captured.isCurrent()) throwStaleRestoreScope();
        for (const [key, entry] of completedHistoryNormalizations) {
            if (!entry.isCurrent()) completedHistoryNormalizations.delete(key);
        }
        const incumbent = [...pendingHistoryNormalizations].find(entry => entry.isCurrent()
            && sameHistoryNormalizationContext(entry.params, params));
        if (incumbent) {
            const result = await incumbent.result;
            if (!captured.isCurrent()) throwStaleRestoreScope();
            return result;
        }
        // Catalog triggers differ only in proofs Protocol recaptures, so one Account
        // runs one pass at a time and the next trigger starts from its checkpoint.
        for (let running = pendingAccountPass(params); running; running = pendingAccountPass(params)) {
            await running.result.catch(() => undefined);
            if (!captured.isCurrent()) throwStaleRestoreScope();
        }
        const key = accountSettingsScopeKeySuffix(params.settingsScope);
        const previous = completedHistoryNormalizations.get(key);
        const checkpoint: AccountSettingsHistoryNormalizationCheckpointV1 = previous
            && sameHistoryNormalizationAccount(previous.params, params) ? { ...previous.checkpoint }
            : { verifiedUnchanged: readVerifiedHistoryRows(key) };
        const result = normalizeAccountSettingsHistoryClientV1({ destinationAuthority: params.destinationAuthority, checkpoint,
            ...(params.savedSecretRecovery ? { savedSecretRecovery: params.savedSecretRecovery } : {}),
            ...(params.expectedProfileTransferRevision === undefined ? {} : { expectedProfileTransferRevision: params.expectedProfileTransferRevision }), ports: {
            ...createHistoryCapturePorts({ ...params, ...captured }),
            openSnapshot: content => openAccountSettingsStoredContent({ content, encryption: params.encryption }).raw,
            resealSnapshot: (raw, recorded) => recorded.t === 'plain' ? { t: 'plain', v: raw }
                : { t: 'encrypted', c: sealAccountScopedBlobCiphertext({ kind: 'account_settings',
                    material: { type: 'dataKey', machineKey: params.encryption!.getContentPrivateKey() },
                    payload: raw, randomBytes: getRandomBytes }) },
        } });
        const entry = { params, isCurrent: captured.isCurrent, result };
        pendingHistoryNormalizations.add(entry);
        try {
            const completed = await result;
            if (!captured.isCurrent()) throwStaleRestoreScope();
            // Verified-unchanged rows are evidence too: a later head move re-reads only new rows.
            if (checkpoint.completed || checkpoint.settledPending || checkpoint.verifiedUnchanged?.size) {
                completedHistoryNormalizations.set(key, { params, isCurrent: captured.isCurrent, checkpoint });
            }
            writeVerifiedHistoryRows(key, checkpoint.verifiedUnchanged);
            return completed;
        } finally { pendingHistoryNormalizations.delete(entry); }
    } finally { captured.dispose?.(); }
}

export type RestoreAccountSettingsFromHistorySnapshotParams = Readonly<{
    credentials: AuthCredentials;
    encryption: Encryption | null;
    /** The historical snapshot version to restore. */
    historyVersion: number;
    /**
     * The current Account Settings version the caller restored from. One-shot:
     * a moved version returns `conflict` with the current version.
     */
    expectedSettingsVersion: number;
    /** Captured destination evidence; source presence is never authority. */
    destinationAuthority?: AccountSettingsHistoryDestinationAuthorityV1;
    /** The rendered Account Settings scope that owns this restore gesture. */
    settingsScope: AccountSettingsScope;
    settingsSecretsKey?: Uint8Array | null;
    settingsSecretsReadKeys?: ReadonlyArray<Uint8Array | null | undefined>;
    signal?: AbortSignal;
}>;

export async function restoreAccountSettingsFromHistorySnapshot(
    params: RestoreAccountSettingsFromHistorySnapshotParams,
): Promise<AccountSettingsHistoryRestoreResult> {
    const captured = await captureAccountSettingsRequest(params);
    if (!captured) return throwStaleRestoreScope();
    const { request, isCurrent } = captured;

    try {
        const detail = await fetchHistorySnapshot(request, params.historyVersion, isCurrent);
        const destination = await captureDestinationAuthority({ ...params, request, isCurrent });
        // Open in the RECORDED mode — no expected mode is asserted — so a snapshot
        // recorded before an Account encryption-mode transition still opens. The
        // ordinary writer below reseals the merged document to the CURRENT mode.
        let opened: OpenedAccountSettingsStoredContent;
        try {
            opened = openAccountSettingsStoredContent({ content: detail.content, encryption: params.encryption });
        } catch (error) {
            throw new AccountSettingsHistoryRestoreUnavailableError(0,
                error instanceof Error ? error.message : 'Historical snapshot cannot be opened');
        }
        const historicalRaw = opened.raw ?? {};
        if (!isCurrent()) throwStaleRestoreScope();

        const result = await syncSettings({
            credentials: params.credentials,
            encryption: params.encryption,
            settingsScope: params.settingsScope,
            requestContext: captured,
            settingsSecretsKey: params.settingsSecretsKey ?? null,
            settingsSecretsReadKeys: params.settingsSecretsReadKeys,
            // Restore never carries pending deltas: unflushed pending settings make
            // the one-shot path fail closed instead of mixing into history restore.
            pendingSettings: {},
            clearPendingSettings: () => {},
            oneShotServerSettingsMutation: {
                expectedSettingsVersion: params.expectedSettingsVersion,
                expectedProfileTransferRevision: destination.expectedProfileTransferRevision,
                mutate: (latestRaw) => {
                    if (!isCurrent()) throwStaleRestoreScope();
                    const application = applyAccountSettingsHistoryRestoreV1(latestRaw, historicalRaw, destination.authority);
                    if (application.status === 'invalid') {
                        throw new AccountSettingsHistoryRestoreInvalidError(application.reason);
                    }
                    return {
                        settings: application.raw as Record<string, unknown>,
                        value: {
                            restoredFromHistoryVersion: detail.version,
                            mergeStatus: application.status,
                        } as const,
                    };
                },
            },
        });
        // The one-shot mutation path always settles with a typed result.
        if (!result) {
            throw new AccountSettingsHistoryRestoreUnavailableError(0, 'Restore produced no result');
        }

        if (result.status === 'conflict') {
            return Object.freeze({
                status: 'conflict',
                currentSettingsVersion: result.currentSettingsVersion,
            });
        }
        if (result.status === 'outcomeUnknown') {
            return Object.freeze({
                status: 'outcomeUnknown',
                lastKnownSettingsVersion: result.lastKnownSettingsVersion,
            });
        }
        if (result.status === 'invalid') {
            throw new AccountSettingsHistoryRestoreInvalidError('invalidValue');
        }
        // The pure classification merge owns unchanged/applied. The one-shot
        // writer skips the POST for `unchanged`, so it never creates a history
        // entry merely because a server happened to reuse or alter version rules.
        const unchanged = result.value.mergeStatus === 'unchanged';
        return Object.freeze({
            status: unchanged ? 'unchanged' : 'applied',
            settingsVersion: result.settingsVersion,
        });
    } catch (error) {
        if (!isCurrent()) return throwStaleRestoreScope();
        throw error;
    } finally {
        captured.dispose();
    }
}
