import { createHash, randomUUID } from 'node:crypto';
import { chmod, mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import type {
    OauthCredentialRecord,
    TokenCredentialRecord,
} from '@happier-dev/plugin-sdk/connected-accounts';

import {
    classifyClaudeCodeCredentialHealth,
    type ClaudeCodeCredentialHealth,
} from './health.js';
import {
    CLAUDE_CODE_SETUP_TOKEN_SCOPES,
    parseClaudeCodeCredentialScopes,
} from './scopes.js';

export type ClaudeCodeNativeCredentialPayload = Readonly<{
    claudeAiOauth: Readonly<{
        accessToken: string;
        refreshToken?: string;
        // Optional: a null/unknown expiry is OMITTED rather than coerced to 0. Writing `0` produced
        // an immediately-expired credential (a latent fail-open 401 path); omitting it reads as
        // "unknown" (the refresh coordinator handles unknown expiry) instead of "expired at epoch".
        expiresAt?: number;
        scopes: readonly string[];
        subscriptionType?: string;
        rateLimitTier?: string;
    }>;
}>;

export type ClaudeCodeCredentialPayloadBuildResult =
    | Readonly<{ status: 'ok'; payload: ClaudeCodeNativeCredentialPayload }>
    | Readonly<{ status: 'diagnostic'; health: ClaudeCodeCredentialHealth }>;

export type ClaudeCodeCredentialFileParseResult =
    | Readonly<{
        status: 'ok';
        hasAccessToken: boolean;
        hasRefreshToken: boolean;
        expiresAt: number | null;
        scopes: readonly string[];
    }>
    | Readonly<{
        status: 'unsupported_shape';
        hasAccessToken: false;
        hasRefreshToken: false;
        expiresAt: null;
        scopes: readonly string[];
    }>;

function readObject(value: unknown): Record<string, unknown> | null {
    return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
        ? value as Record<string, unknown>
        : null;
}

function readString(value: unknown): string | null {
    return typeof value === 'string' && value.trim().length > 0 ? value : null;
}

function readOptionalString(value: unknown): string | undefined {
    return readString(value) ?? undefined;
}

function readNumber(value: unknown): number | null {
    return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function readStringArray(value: unknown): readonly string[] {
    if (!Array.isArray(value)) return [];
    return value.filter((item): item is string => typeof item === 'string' && item.trim().length > 0);
}

export function resolveClaudeCodeCredentialsFilePath(claudeConfigDir: string): string {
    return join(claudeConfigDir, '.credentials.json');
}

function canonicalizeJsonValue(value: unknown): unknown {
    if (Array.isArray(value)) {
        return value.map(canonicalizeJsonValue);
    }
    if (value && typeof value === 'object') {
        return Object.fromEntries(
            Object.entries(value as Record<string, unknown>)
                .sort(([left], [right]) => left.localeCompare(right))
                .map(([key, nested]) => [key, canonicalizeJsonValue(nested)]),
        );
    }
    return value;
}

export function computeClaudeCodeCredentialFingerprint(payload: unknown): string {
    const canonical = JSON.stringify(canonicalizeJsonValue(payload));
    return `sha256:${createHash('sha256').update(canonical).digest('hex')}`;
}

export function computeClaudeCodeCredentialAccountProofFingerprint(payload: unknown): string | null {
    const root = readObject(payload);
    const credential = readObject(root?.claudeAiOauth);
    const accessToken = readString(credential?.accessToken);
    const refreshToken = readString(credential?.refreshToken);
    if (!accessToken) return null;

    return computeClaudeCodeCredentialFingerprint({
        claudeAiOauth: {
            accessToken,
            ...(refreshToken ? { refreshToken } : {}),
            scopes: parseClaudeCodeCredentialScopes(
                Array.isArray(credential?.scopes)
                    ? credential.scopes.filter((scope): scope is string => typeof scope === 'string')
                    : typeof credential?.scopes === 'string'
                        ? credential.scopes
                        : null,
            ),
            ...(readOptionalString(credential?.subscriptionType)
                ? { subscriptionType: readOptionalString(credential?.subscriptionType) }
                : {}),
            ...(readOptionalString(credential?.rateLimitTier)
                ? { rateLimitTier: readOptionalString(credential?.rateLimitTier) }
                : {}),
        },
    });
}

export function parseClaudeCodeCredentialFile(value: unknown): ClaudeCodeCredentialFileParseResult {
    const root = readObject(value);
    const credential = readObject(root?.claudeAiOauth);
    if (!credential) {
        return {
            status: 'unsupported_shape',
            hasAccessToken: false,
            hasRefreshToken: false,
            expiresAt: null,
            scopes: [],
        };
    }

    return {
        status: 'ok',
        hasAccessToken: Boolean(readString(credential.accessToken)),
        hasRefreshToken: Boolean(readString(credential.refreshToken)),
        expiresAt: readNumber(credential.expiresAt),
        scopes: parseClaudeCodeCredentialScopes(
            Array.isArray(credential.scopes)
                ? credential.scopes.filter((scope): scope is string => typeof scope === 'string')
                : typeof credential.scopes === 'string'
                    ? credential.scopes
                    : null,
        ),
    };
}

export function readClaudeCodeNativeCredentialPayload(
    value: unknown,
): ClaudeCodeNativeCredentialPayload | null {
    const root = readObject(value);
    const credential = readObject(root?.claudeAiOauth);
    const accessToken = readString(credential?.accessToken);
    const refreshToken = readString(credential?.refreshToken);
    if (!credential || !accessToken) return null;
    const expiresAt = readNumber(credential.expiresAt);
    const subscriptionType = readOptionalString(credential.subscriptionType);
    const rateLimitTier = readOptionalString(credential.rateLimitTier);
    return {
        claudeAiOauth: {
            accessToken,
            ...(refreshToken ? { refreshToken } : {}),
            ...(expiresAt !== null ? { expiresAt } : {}),
            scopes: parseClaudeCodeCredentialScopes(
                readStringArray(credential.scopes).length > 0
                    ? readStringArray(credential.scopes)
                    : typeof credential.scopes === 'string'
                        ? credential.scopes
                        : null,
            ),
            ...(subscriptionType ? { subscriptionType } : {}),
            ...(rateLimitTier ? { rateLimitTier } : {}),
        },
    };
}

export function buildClaudeCodeCredentialPayload(
    record: OauthCredentialRecord | TokenCredentialRecord,
): ClaudeCodeCredentialPayloadBuildResult {
    const health = classifyClaudeCodeCredentialHealth(record);
    if (health.status !== 'ok') {
        return { status: 'diagnostic', health };
    }
    if (record.kind === 'token') {
        return {
            status: 'ok',
            payload: {
                claudeAiOauth: {
                    accessToken: record.token.token,
                    scopes: [...CLAUDE_CODE_SETUP_TOKEN_SCOPES],
                },
            },
        };
    }
    if (record.kind !== 'oauth') return { status: 'diagnostic', health };

    const raw = readObject(record.oauth.raw);
    const providerCredential = readObject(raw?.claudeAiOauth) ?? readObject(raw?.['claude.ai_oauth']);
    const subscriptionType = readOptionalString(providerCredential?.subscriptionType);
    const rateLimitTier = readOptionalString(providerCredential?.rateLimitTier);

    return {
        status: 'ok',
        payload: {
            claudeAiOauth: {
                accessToken: record.oauth.accessToken,
                // Omit a null/unknown expiry instead of coercing to 0 (immediately-expired).
                ...(typeof record.expiresAt === 'number' ? { expiresAt: record.expiresAt } : {}),
                scopes: parseClaudeCodeCredentialScopes(record.oauth.scope),
                ...(subscriptionType ? { subscriptionType } : {}),
                ...(rateLimitTier ? { rateLimitTier } : {}),
            },
        },
    };
}

async function readCredentialFileFingerprint(credentialPath: string): Promise<string | null> {
    try {
        return computeClaudeCodeCredentialFingerprint(
            JSON.parse(await readFile(credentialPath, 'utf8')) as unknown,
        );
    } catch {
        return null;
    }
}

async function repairClaudeCodeCredentialsFileMode(credentialPath: string): Promise<void> {
    if (process.platform === 'win32') return;
    try {
        const stats = await stat(credentialPath);
        if ((stats.mode & 0o777) === 0o600) return;
        await chmod(credentialPath, 0o600);
    } catch {
        // The file may have vanished under a concurrent writer; the next materialization repairs it.
    }
}

export async function writeClaudeCodeCredentialsFile(params: Readonly<{
    claudeConfigDir: string;
    payload: ClaudeCodeNativeCredentialPayload;
}>): Promise<string> {
    await mkdir(params.claudeConfigDir, { recursive: true });
    const credentialPath = resolveClaudeCodeCredentialsFilePath(params.claudeConfigDir);
    // Idempotence guard at the actual write owner. The materializer already short-circuits via
    // provenance, but that high-level check can miss (missing/mismatched provenance with identical
    // content); this low-level guard makes idempotence unavoidable. A running Claude process may be
    // mid-read of `.credentials.json`; a redundant truncate+rename to a fresh inode risks tearing
    // that read for no benefit. Still repair perms cheaply (stat-first) so an externally-relaxed
    // 0644/0664 file never lingers world/group-readable on the skip path.
    const currentFingerprint = await readCredentialFileFingerprint(credentialPath);
    if (
        currentFingerprint !== null
        && currentFingerprint === computeClaudeCodeCredentialFingerprint(params.payload)
    ) {
        await repairClaudeCodeCredentialsFileMode(credentialPath);
        return credentialPath;
    }
    const tempPath = join(params.claudeConfigDir, `.credentials.${randomUUID()}.tmp`);
    try {
        await writeFile(tempPath, `${JSON.stringify(params.payload)}\n`, { mode: 0o600 });
        if (process.platform !== 'win32') {
            await chmod(tempPath, 0o600);
        }
        await rename(tempPath, credentialPath);
        if (process.platform !== 'win32') {
            await chmod(credentialPath, 0o600);
        }
        return credentialPath;
    } catch (error) {
        await rm(tempPath, { force: true }).catch(() => {});
        throw error;
    }
}
