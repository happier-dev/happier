import type { AuthCredentials } from '@/auth/storage/tokenStorage';
import { fetchAccountEncryptionCurrentness } from '@/sync/api/account/apiAccountEncryptionMode';
import { accountSettingsScopeKeySuffix, type AccountSettingsScope } from '@/sync/domains/settings/scope/accountSettingsScope';
import { readAccountEncryptionObservationBinding } from '@/sync/http/accountEncryptionObservationBinding';
import type { ServerFetch } from '@/sync/http/client';

type RetainedRawSettings = Readonly<{ version: number; raw: Readonly<Record<string, unknown>> }>;
type RetainedEntry = RetainedRawSettings & Readonly<{ headVerified: boolean }>;

/**
 * The last raw Account Settings document Sync admitted per Account (HTTP or socket). Parsed
 * Settings drop retired source roots, so legacy-catalog cutover decisions read
 * this document instead of fetching it again. Memory only: a missing entry
 * means unknown, and its consumers then read the source.
 */
const retained = new Map<string, RetainedEntry>();

export function retainAccountSettingsRawSnapshot(scope: AccountSettingsScope, version: number,
    raw: Readonly<Record<string, unknown>> | null): void {
    const key = accountSettingsScopeKeySuffix(scope);
    const previous = retained.get(key);
    if (previous && previous.version > version) return;
    if (raw === null) retained.delete(key);
    else retained.set(key, { version, raw, headVerified: true });
}

export function readRetainedAccountSettingsRawSnapshot(scope: AccountSettingsScope): RetainedRawSettings | undefined {
    return retained.get(accountSettingsScopeKeySuffix(scope));
}

export function readRetainedAccountSettingsRaw(scope: AccountSettingsScope): Readonly<Record<string, unknown>> | undefined {
    return retained.get(accountSettingsScopeKeySuffix(scope))?.raw;
}

/**
 * The one decider for "the current raw Account Settings document" outside the Sync loop. Sync
 * admits every Settings write as a whole document (HTTP baseline or the socket's `settingsV2`
 * copy), so while this request's Account socket observation is live and has had no gap since the
 * last confirmation, the admitted version is the head and a catalog wake reuses it instead of
 * fetching the whole blob again. Otherwise the server head is checked; any other head reads the
 * baseline and admits it here.
 * Writes derived from the document stay CAS-bound to its version.
 */
export async function readCurrentAccountSettingsRawSnapshot(scope: AccountSettingsScope, ports: Readonly<{
    credentials: AuthCredentials;
    request: ServerFetch;
    signal?: AbortSignal;
    readBaseline(): Promise<RetainedRawSettings>;
}>): Promise<RetainedRawSettings> {
    const admitted = retained.get(accountSettingsScopeKeySuffix(scope));
    if (admitted && admitted.headVerified && readAccountEncryptionObservationBinding(ports.request, ports.credentials)) return admitted;
    if (admitted && (await fetchAccountEncryptionCurrentness(ports.credentials, { request: ports.request, signal: ports.signal }))
        .settingsVersion === admitted.version) {
        confirmAccountSettingsHead(scope, admitted.version);
        return admitted;
    }
    const baseline = await ports.readBaseline();
    retainAccountSettingsRawSnapshot(scope, baseline.version, baseline.raw);
    return baseline;
}

/** A socket gap can have missed a pushed write: the next read of each document checks the head once. */
export function markAccountSettingsHeadUnverified(): void {
    for (const [key, entry] of retained) retained.set(key, { ...entry, headVerified: false });
}

/** A fresh head read matched this version, so the document is current again. */
export function confirmAccountSettingsHead(scope: AccountSettingsScope, version: number): void {
    const key = accountSettingsScopeKeySuffix(scope);
    const entry = retained.get(key);
    if (entry?.version === version && !entry.headVerified) retained.set(key, { ...entry, headVerified: true });
}

export function resetAccountSettingsRawSnapshotsForTests(): void { retained.clear(); }
