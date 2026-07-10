import { chmod, lstat, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

import type { ConnectedServiceCredentialRecordV1 } from '@happier-dev/plugin-sdk/experimental/cloud/auth';
import type { ExecRuntimeServiceV1 } from '@happier-dev/plugin-sdk';

import {
    buildClaudeCodeCredentialPayload,
    resolveClaudeCodeCredentialsFilePath,
    writeClaudeCodeCredentialsFile,
} from './credentials.js';
import type { ClaudeCodeCredentialHealth } from './health.js';
import {
    deleteClaudeCodeMacOsKeychainCredential,
    sweepStaleClaudeCodeMacOsKeychainCredentials,
} from './keychain.js';
import {
    buildClaudeCodeNativeAuthProvenance,
    readClaudeCodeNativeAuthProvenance,
    resolveClaudeCodeNativeAuthProvenancePath,
    writeClaudeCodeNativeAuthProvenance,
} from './provenance.js';

export type ClaudeNativeAuthMaterializationDiagnostic = Readonly<{
    code: string;
    providerId: 'claude';
    severity: 'blocking';
    serviceId: 'claude-subscription';
    reason: string;
    entryName?: string;
    credentialRefreshFailure?: Readonly<{
        category:
            | 'invalid_grant'
            | 'invalid_client'
            | 'provider_401'
            | 'provider_403'
            | 'network_error'
            | 'malformed_response'
            | 'missing_access_token'
            | 'missing_refresh_token'
            | 'unknown';
        providerStatus?: number;
        providerErrorCode?: string;
    }>;
}>;

export type ClaudeCodeNativeAuthMaterializationResult =
    | Readonly<{
        status: 'materialized';
        env: Record<string, string>;
        diagnostics: readonly ClaudeNativeAuthMaterializationDiagnostic[];
        credentialPath: string;
    }>
    | Readonly<{
        status: 'diagnostic';
        env: Record<string, string>;
        diagnostics: readonly ClaudeNativeAuthMaterializationDiagnostic[];
    }>;

function diagnosticCodeForHealth(health: ClaudeCodeCredentialHealth): string {
    switch (health.status) {
        case 'missing_required_scope':
            return 'claude_subscription_missing_claude_code_scope';
        case 'unsupported_credential_kind':
            return 'claude_subscription_setup_token_not_supported_for_unified';
        case 'missing_access_token':
        case 'missing_refresh_token':
        case 'unsupported_service':
        case 'ok':
            return 'claude_subscription_native_auth_materialization_failed';
    }
}

function credentialRefreshFailureForHealth(
    health: ClaudeCodeCredentialHealth,
): ClaudeNativeAuthMaterializationDiagnostic['credentialRefreshFailure'] {
    switch (health.status) {
        case 'missing_required_scope':
            return {
                category: 'provider_403',
                providerStatus: 403,
                providerErrorCode: 'claude_subscription_missing_claude_code_scope',
            };
        case 'unsupported_credential_kind':
            return {
                category: 'missing_refresh_token',
                providerErrorCode: 'claude_subscription_setup_token_not_supported_for_unified',
            };
        case 'missing_access_token':
            return {
                category: 'missing_access_token',
                providerErrorCode: 'claude_subscription_native_auth_materialization_failed',
            };
        case 'missing_refresh_token':
            return {
                category: 'missing_refresh_token',
                providerErrorCode: 'claude_subscription_native_auth_materialization_failed',
            };
        case 'unsupported_service':
        case 'ok':
            return undefined;
    }
}

function diagnosticForHealth(
    health: ClaudeCodeCredentialHealth,
): ClaudeNativeAuthMaterializationDiagnostic {
    const credentialRefreshFailure = credentialRefreshFailureForHealth(health);
    return {
        code: diagnosticCodeForHealth(health),
        providerId: 'claude',
        severity: 'blocking',
        serviceId: 'claude-subscription',
        reason: health.status,
        ...(credentialRefreshFailure ? { credentialRefreshFailure } : {}),
        ...(health.missingScopes.length > 0 ? { entryName: health.missingScopes.join(' ') } : {}),
    };
}

function diagnosticForCredentialFileWriteFailure(): ClaudeNativeAuthMaterializationDiagnostic {
    return {
        code: 'claude_subscription_native_auth_materialization_failed',
        providerId: 'claude',
        severity: 'blocking',
        serviceId: 'claude-subscription',
        reason: 'credential_file_write_failed',
    };
}

function diagnosticForKeychainWriteFailure(): ClaudeNativeAuthMaterializationDiagnostic {
    return {
        code: 'claude_subscription_native_auth_keychain_write_failed',
        providerId: 'claude',
        severity: 'blocking',
        serviceId: 'claude-subscription',
        reason: 'keychain_write_failed',
    };
}

export function buildClaudeCodeNativeAuthDiagnostic(
    health: ClaudeCodeCredentialHealth,
): ClaudeNativeAuthMaterializationDiagnostic {
    return diagnosticForHealth(health);
}

export function diagnoseClaudeCodeNativeAuthMaterialization(params: Readonly<{
    record: ConnectedServiceCredentialRecordV1;
}>): readonly ClaudeNativeAuthMaterializationDiagnostic[] {
    const built = buildClaudeCodeCredentialPayload(params.record);
    return built.status === 'ok' ? [] : [diagnosticForHealth(built.health)];
}

type FileRollbackSnapshot = Readonly<{
    path: string;
    existed: boolean;
    contents?: Buffer | undefined;
    mode?: number | undefined;
}>;

const pendingLazyKeychainSweepKeys = new Set<string>();

/** AT-4: reset the module-level lazy-sweep dedupe between tests (darwin-only path; order-determinism). */
export function resetPendingLazyKeychainSweepKeysForTests(): void {
    pendingLazyKeychainSweepKeys.clear();
}

function lazySweepKey(params: Readonly<{
    homeDir?: string | null | undefined;
    username?: string | null | undefined;
}>): string {
    return JSON.stringify({
        homeDir: params.homeDir ?? null,
        username: params.username ?? null,
    });
}

function scheduleLazyStaleKeychainSweep(params: Readonly<{
    exec: ExecRuntimeServiceV1;
    username?: string | null | undefined;
    homeDir?: string | null | undefined;
}>): void {
    // CLOSE-9 reversal: the sweep purges EVERY Happier-managed suffixed item for the account (nothing
    // reads them under proven file-only), so it no longer needs a live-home allow-set. Run it once per
    // (homeDir, username), deferred + deduped, on the materialization hot path (startup-reconciled).
    const key = lazySweepKey({
        homeDir: params.homeDir,
        username: params.username,
    });
    if (pendingLazyKeychainSweepKeys.has(key)) return;
    pendingLazyKeychainSweepKeys.add(key);
    const timer = setTimeout(() => {
        void sweepStaleClaudeCodeMacOsKeychainCredentials({
            exec: params.exec,
            username: params.username,
            homeDir: params.homeDir,
        }).catch(() => undefined).finally(() => {
            pendingLazyKeychainSweepKeys.delete(key);
        });
    }, 0);
    timer.unref?.();
}

async function credentialFileExists(claudeConfigDir: string): Promise<boolean> {
    try {
        await lstat(resolveClaudeCodeCredentialsFilePath(claudeConfigDir));
        return true;
    } catch {
        return false;
    }
}

async function snapshotFileForRollback(path: string): Promise<FileRollbackSnapshot> {
    try {
        const [contents, stats] = await Promise.all([readFile(path), lstat(path)]);
        return { path, existed: true, contents, mode: stats.mode & 0o777 };
    } catch {
        return { path, existed: false };
    }
}

async function restoreFileSnapshot(snapshot: FileRollbackSnapshot): Promise<void> {
    if (!snapshot.existed) {
        await rm(snapshot.path, { force: true }).catch(() => {});
        return;
    }
    await mkdir(dirname(snapshot.path), { recursive: true });
    await writeFile(snapshot.path, snapshot.contents ?? Buffer.alloc(0), { mode: snapshot.mode ?? 0o600 });
    if (process.platform !== 'win32') {
        await chmod(snapshot.path, snapshot.mode ?? 0o600).catch(() => {});
    }
}

async function restoreFileSnapshots(snapshots: readonly FileRollbackSnapshot[]): Promise<void> {
    await Promise.all(snapshots.map((snapshot) => restoreFileSnapshot(snapshot)));
}

export async function materializeClaudeCodeNativeAuth(params: Readonly<{
    exec?: ExecRuntimeServiceV1 | null | undefined;
    record: ConnectedServiceCredentialRecordV1;
    claudeConfigDir: string;
    homeDir?: string | null | undefined;
    username?: string | null | undefined;
}>): Promise<ClaudeCodeNativeAuthMaterializationResult> {
    const built = buildClaudeCodeCredentialPayload(params.record);
    if (built.status !== 'ok') {
        return {
            status: 'diagnostic',
            env: { CLAUDE_CONFIG_DIR: params.claudeConfigDir },
            diagnostics: [diagnosticForHealth(built.health)],
        };
    }
    const nextProvenance = buildClaudeCodeNativeAuthProvenance({
        record: params.record,
        payload: built.payload,
    });
    const existingProvenance = await readClaudeCodeNativeAuthProvenance(params.claudeConfigDir);
    if (
        existingProvenance?.credentialProfileId === nextProvenance.credentialProfileId
        && existingProvenance.credentialCreatedAt === nextProvenance.credentialCreatedAt
        && existingProvenance.credentialFingerprint === nextProvenance.credentialFingerprint
        && await credentialFileExists(params.claudeConfigDir)
    ) {
        return {
            status: 'materialized',
            env: { CLAUDE_CONFIG_DIR: params.claudeConfigDir },
            diagnostics: [],
            credentialPath: resolveClaudeCodeCredentialsFilePath(params.claudeConfigDir),
        };
    }
    let credentialPath: string;
    const rollbackSnapshots = await Promise.all([
        snapshotFileForRollback(resolveClaudeCodeCredentialsFilePath(params.claudeConfigDir)),
        snapshotFileForRollback(resolveClaudeCodeNativeAuthProvenancePath(params.claudeConfigDir)),
    ]);
    try {
        credentialPath = await writeClaudeCodeCredentialsFile({
            claudeConfigDir: params.claudeConfigDir,
            payload: built.payload,
        });
        await writeClaudeCodeNativeAuthProvenance({
            claudeConfigDir: params.claudeConfigDir,
            provenance: nextProvenance,
        });
    } catch {
        await restoreFileSnapshots(rollbackSnapshots);
        return {
            status: 'diagnostic',
            env: { CLAUDE_CONFIG_DIR: params.claudeConfigDir },
            diagnostics: [diagnosticForCredentialFileWriteFailure()],
        };
    }
    if (process.platform === 'darwin') {
        if (!params.exec) {
            await restoreFileSnapshots(rollbackSnapshots);
            return {
                status: 'diagnostic',
                env: { CLAUDE_CONFIG_DIR: params.claudeConfigDir },
                diagnostics: [diagnosticForKeychainWriteFailure()],
            };
        }
        try {
            scheduleLazyStaleKeychainSweep({
                exec: params.exec,
                username: params.username,
                homeDir: params.homeDir,
            });
            await deleteClaudeCodeMacOsKeychainCredential({
                exec: params.exec,
                claudeConfigDir: params.claudeConfigDir,
                homeDir: params.homeDir,
                username: params.username,
            });
        } catch {
            await restoreFileSnapshots(rollbackSnapshots);
            return {
                status: 'diagnostic',
                env: { CLAUDE_CONFIG_DIR: params.claudeConfigDir },
                diagnostics: [diagnosticForKeychainWriteFailure()],
            };
        }
    }
    return {
        status: 'materialized',
        env: { CLAUDE_CONFIG_DIR: params.claudeConfigDir },
        diagnostics: [],
        credentialPath,
    };
}
