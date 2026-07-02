import { randomUUID } from 'node:crypto';
import { chmod, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import type { ConnectedServiceCredentialRecordV1 } from '@happier-dev/protocol';

import {
    computeClaudeCodeCredentialFingerprint,
    type ClaudeCodeNativeCredentialPayload,
} from './credentials.js';

export const CLAUDE_CODE_NATIVE_AUTH_PROVENANCE_FILE_NAME =
    '.happier-claude-connected-service-home.json';

export type ClaudeCodeNativeAuthProvenanceV1 = Readonly<{
    v: 1;
    serviceId: 'claude-subscription';
    credentialProfileId: string;
    credentialCreatedAt: number;
    credentialFingerprint?: string | undefined;
}>;

function readObject(value: unknown): Record<string, unknown> | null {
    return value && typeof value === 'object' && !Array.isArray(value)
        ? value as Record<string, unknown>
        : null;
}

function readNonEmptyString(value: unknown): string | null {
    return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

function readFiniteNumber(value: unknown): number | null {
    return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function readCredentialFingerprint(value: unknown): string | undefined {
    const text = readNonEmptyString(value);
    return text?.match(/^sha256:[a-f0-9]{64}$/u) ? text : undefined;
}

export function resolveClaudeCodeNativeAuthProvenancePath(claudeConfigDir: string): string {
    return join(claudeConfigDir, CLAUDE_CODE_NATIVE_AUTH_PROVENANCE_FILE_NAME);
}

export function buildClaudeCodeNativeAuthProvenance(params: Readonly<{
    record: ConnectedServiceCredentialRecordV1;
    payload: ClaudeCodeNativeCredentialPayload;
}>): ClaudeCodeNativeAuthProvenanceV1 {
    return {
        v: 1,
        serviceId: 'claude-subscription',
        credentialProfileId: params.record.profileId,
        credentialCreatedAt: params.record.createdAt,
        credentialFingerprint: computeClaudeCodeCredentialFingerprint(params.payload),
    };
}

export function parseClaudeCodeNativeAuthProvenance(value: unknown): ClaudeCodeNativeAuthProvenanceV1 | null {
    const root = readObject(value);
    if (!root || root.v !== 1 || root.serviceId !== 'claude-subscription') return null;
    const credentialProfileId = readNonEmptyString(root.credentialProfileId);
    const credentialCreatedAt = readFiniteNumber(root.credentialCreatedAt);
    if (!credentialProfileId || credentialCreatedAt === null) return null;
    const credentialFingerprint = readCredentialFingerprint(root.credentialFingerprint);
    return {
        v: 1,
        serviceId: 'claude-subscription',
        credentialProfileId,
        credentialCreatedAt,
        ...(credentialFingerprint ? { credentialFingerprint } : {}),
    };
}

export async function readClaudeCodeNativeAuthProvenance(
    claudeConfigDir: string,
): Promise<ClaudeCodeNativeAuthProvenanceV1 | null> {
    try {
        return parseClaudeCodeNativeAuthProvenance(
            JSON.parse(await readFile(resolveClaudeCodeNativeAuthProvenancePath(claudeConfigDir), 'utf8')),
        );
    } catch {
        return null;
    }
}

export async function writeClaudeCodeNativeAuthProvenance(params: Readonly<{
    claudeConfigDir: string;
    provenance: ClaudeCodeNativeAuthProvenanceV1;
}>): Promise<string> {
    await mkdir(params.claudeConfigDir, { recursive: true });
    const provenancePath = resolveClaudeCodeNativeAuthProvenancePath(params.claudeConfigDir);
    const tempPath = join(params.claudeConfigDir, `.native-auth-provenance.${randomUUID()}.tmp`);
    try {
        await writeFile(tempPath, `${JSON.stringify(params.provenance)}\n`, { mode: 0o600 });
        if (process.platform !== 'win32') {
            await chmod(tempPath, 0o600);
        }
        await rename(tempPath, provenancePath);
        if (process.platform !== 'win32') {
            await chmod(provenancePath, 0o600);
        }
        return provenancePath;
    } catch (error) {
        await rm(tempPath, { force: true }).catch(() => {});
        throw error;
    }
}
