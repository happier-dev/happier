import { readFile } from 'node:fs/promises';

import type { ExecRuntimeServiceV1 } from '@happier-dev/plugin-sdk';

import {
    computeClaudeCodeCredentialFingerprint,
    parseClaudeCodeCredentialFile,
    resolveClaudeCodeCredentialsFilePath,
} from './credentials.js';
import { readClaudeCodeMacOsKeychainCredential } from './keychain.js';
import { readClaudeCodeNativeAuthProvenance } from './provenance.js';
import { findMissingClaudeCodeCredentialScopes } from './scopes.js';

export type ClaudeCodeNativeAuthVerificationResult = Readonly<{
    status:
        | 'ok'
        | 'missing_credentials_file'
        | 'unsupported_shape'
        | 'missing_access_token'
        | 'missing_refresh_token'
        | 'missing_required_scope'
        | 'expired'
        | 'credential_fingerprint_mismatch';
    missingScopes: readonly string[];
    credentialPath: string;
}>;

export async function verifyClaudeCodeNativeAuth(params: Readonly<{
    claudeConfigDir: string;
    exec?: ExecRuntimeServiceV1 | null | undefined;
    /** Reference time for the expiry-vs-now usability gate; defaults to now. */
    now?: number;
    homeDir?: string | null | undefined;
}>): Promise<ClaudeCodeNativeAuthVerificationResult> {
    const credentialPath = resolveClaudeCodeCredentialsFilePath(params.claudeConfigDir);
    let raw: unknown;
    try {
        raw = JSON.parse(await readFile(credentialPath, 'utf8'));
    } catch {
        return { status: 'missing_credentials_file', missingScopes: [], credentialPath };
    }

    const parsed = parseClaudeCodeCredentialFile(raw);
    if (parsed.status !== 'ok') {
        return { status: 'unsupported_shape', missingScopes: [], credentialPath };
    }
    if (!parsed.hasAccessToken) {
        return { status: 'missing_access_token', missingScopes: [], credentialPath };
    }
    if (!parsed.hasRefreshToken) {
        return { status: 'missing_refresh_token', missingScopes: [], credentialPath };
    }
    const missingScopes = findMissingClaudeCodeCredentialScopes(parsed.scopes);
    if (missingScopes.length > 0) {
        return { status: 'missing_required_scope', missingScopes, credentialPath };
    }
    // Real usability gate: a well-formed-but-expired credential must not verify as healthy. A
    // finite expiry at or before now is unusable (the spawn would 401). A null/unknown expiry is
    // NOT treated as expired — we cannot prove staleness and the refresh coordinator owns unknown
    // expiry; coercing it to expired would false-reject otherwise-valid credentials.
    const now = typeof params.now === 'number' ? params.now : Date.now();
    if (typeof parsed.expiresAt === 'number' && parsed.expiresAt <= now) {
        return { status: 'expired', missingScopes: [], credentialPath };
    }
    const fileFingerprint = computeClaudeCodeCredentialFingerprint(raw);
    const provenance = await readClaudeCodeNativeAuthProvenance(params.claudeConfigDir);
    if (
        provenance
        && (
            provenance.credentialFingerprint === undefined
            || provenance.credentialFingerprint !== fileFingerprint
        )
    ) {
        return { status: 'credential_fingerprint_mismatch', missingScopes: [], credentialPath };
    }
    if (process.platform === 'darwin') {
        if (!params.exec) {
            return { status: 'missing_refresh_token', missingScopes: [], credentialPath };
        }
        const keychainPayload = await readClaudeCodeMacOsKeychainCredential({
            exec: params.exec,
            claudeConfigDir: params.claudeConfigDir,
            homeDir: params.homeDir,
        });
        const keychainParsed = parseClaudeCodeCredentialFile(keychainPayload);
        if (keychainParsed.status !== 'ok') {
            return { status: 'missing_refresh_token', missingScopes: [], credentialPath };
        }
        if (!keychainParsed.hasAccessToken) {
            return { status: 'missing_access_token', missingScopes: [], credentialPath };
        }
        if (!keychainParsed.hasRefreshToken) {
            return { status: 'missing_refresh_token', missingScopes: [], credentialPath };
        }
        const missingKeychainScopes = findMissingClaudeCodeCredentialScopes(keychainParsed.scopes);
        if (missingKeychainScopes.length > 0) {
            return { status: 'missing_required_scope', missingScopes: missingKeychainScopes, credentialPath };
        }
        if (computeClaudeCodeCredentialFingerprint(keychainPayload) !== fileFingerprint) {
            return { status: 'credential_fingerprint_mismatch', missingScopes: [], credentialPath };
        }
        if (typeof keychainParsed.expiresAt === 'number' && keychainParsed.expiresAt <= now) {
            return { status: 'expired', missingScopes: [], credentialPath };
        }
    }
    return { status: 'ok', missingScopes: [], credentialPath };
}
