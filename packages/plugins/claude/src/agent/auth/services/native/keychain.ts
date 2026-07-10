import { createHash } from 'node:crypto';
import { homedir, userInfo } from 'node:os';
import { join, resolve } from 'node:path';

import type { ExecRuntimeServiceV1 } from '@happier-dev/plugin-sdk';

import {
    readClaudeCodeNativeCredentialPayload,
    type ClaudeCodeNativeCredentialPayload,
} from './credentials.js';

export const CLAUDE_MACOS_SECURITY_SYSTEM_TOOL_ID = 'claude.macos.security';
const DEFAULT_CLAUDE_CODE_KEYCHAIN_SERVICE = 'Claude Code-credentials';
const HAPPIER_MANAGED_CLAUDE_CODE_KEYCHAIN_SERVICE_PATTERN = /^Claude Code-credentials-[a-f0-9]{8}$/u;
const CLAUDE_MACOS_SECURITY_TIMEOUT_MS = 10_000;

function resolveDefaultClaudeConfigDir(homeDir: string): string {
    return resolve(join(homeDir, '.claude'));
}

export function resolveClaudeCodeMacOsKeychainServiceName(params: Readonly<{
    claudeConfigDir: string;
    homeDir?: string | null | undefined;
}>): string {
    const resolvedClaudeConfigDir = resolve(params.claudeConfigDir);
    const resolvedHomeDir = resolve(String(params.homeDir ?? homedir()));
    if (resolvedClaudeConfigDir === resolveDefaultClaudeConfigDir(resolvedHomeDir)) {
        return DEFAULT_CLAUDE_CODE_KEYCHAIN_SERVICE;
    }
    const suffix = createHash('sha256').update(resolvedClaudeConfigDir).digest('hex').slice(0, 8);
    return `${DEFAULT_CLAUDE_CODE_KEYCHAIN_SERVICE}-${suffix}`;
}

function buildKeychainDeleteError(status: number | null): Error {
    return new Error(`claude_code_keychain_delete_failed:exit_${status ?? 'unknown'}`);
}

export type ClaudeCodeMacOsKeychainSweepSkipReason =
    | 'global_service'
    | 'different_account'
    | 'not_happier_managed_service';

export type ClaudeCodeMacOsKeychainSweepEntry = Readonly<{
    account: string;
    service: string;
}>;

export type ClaudeCodeMacOsKeychainSweepSkippedEntry =
    ClaudeCodeMacOsKeychainSweepEntry & Readonly<{ reason: ClaudeCodeMacOsKeychainSweepSkipReason }>;

export type ClaudeCodeMacOsKeychainSweepResult = Readonly<{
    scanned: number;
    deleted: readonly ClaudeCodeMacOsKeychainSweepEntry[];
    skipped: readonly ClaudeCodeMacOsKeychainSweepSkippedEntry[];
}>;

async function resolveSecurityLaunch(exec: ExecRuntimeServiceV1, purpose: string) {
    const grant = await exec.systemTools.resolve({
        toolId: CLAUDE_MACOS_SECURITY_SYSTEM_TOOL_ID,
        purpose,
        preferredCommand: 'security',
    });
    return grant.launch;
}

function parseDumpedKeychainCredentialEntries(output: string): ClaudeCodeMacOsKeychainSweepEntry[] {
    const entries: ClaudeCodeMacOsKeychainSweepEntry[] = [];
    for (const block of output.split(/\n(?=keychain: )/u)) {
        const account = /"acct"<blob>="([^"]+)"/u.exec(block)?.[1]?.trim();
        const service = /"svce"<blob>="([^"]+)"/u.exec(block)?.[1]?.trim();
        if (!account || !service) continue;
        entries.push({ account, service });
    }
    return entries;
}

function classifyKeychainSweepEntry(params: Readonly<{
    entry: ClaudeCodeMacOsKeychainSweepEntry;
    username: string;
}>): ClaudeCodeMacOsKeychainSweepSkipReason | 'delete' {
    // The ONLY protected items are (a) OTHER accounts' items, (b) the user's GLOBAL
    // `Claude Code-credentials` login (the only Claude keychain item any `claude` process reads — a
    // managed home sets CLAUDE_CONFIG_DIR and reads ONLY its `.credentials.json` file, verified against
    // the shipped binary v2.1.205), and (c) non-Happier-managed services. Every remaining Happier-managed
    // SUFFIXED item for this account is obsolete: nothing writes it and nothing reads it, so it is deleted
    // regardless of whether its home is currently live (CLOSE-9 reversal).
    if (params.entry.account !== params.username) return 'different_account';
    if (params.entry.service === DEFAULT_CLAUDE_CODE_KEYCHAIN_SERVICE) return 'global_service';
    if (!HAPPIER_MANAGED_CLAUDE_CODE_KEYCHAIN_SERVICE_PATTERN.test(params.entry.service)) {
        return 'not_happier_managed_service';
    }
    return 'delete';
}

export async function sweepStaleClaudeCodeMacOsKeychainCredentials(params: Readonly<{
    exec: ExecRuntimeServiceV1;
    username?: string | null | undefined;
    homeDir?: string | null | undefined;
}>): Promise<ClaudeCodeMacOsKeychainSweepResult> {
    const username = String(params.username ?? userInfo().username).trim();
    const launch = await resolveSecurityLaunch(
        params.exec,
        'sweep stale Claude Code OAuth credentials from the macOS keychain',
    );
    const dump = await params.exec.run({
        ...launch,
        args: [...(launch.args ?? []), 'dump-keychain'],
    }, { timeoutMs: CLAUDE_MACOS_SECURITY_TIMEOUT_MS });
    if (dump.exitCode !== 0) {
        throw buildKeychainDeleteError(dump.exitCode);
    }

    const deleted: ClaudeCodeMacOsKeychainSweepEntry[] = [];
    const skipped: ClaudeCodeMacOsKeychainSweepSkippedEntry[] = [];
    const entries = parseDumpedKeychainCredentialEntries(dump.stdout);
    for (const entry of entries) {
        const classification = classifyKeychainSweepEntry({ entry, username });
        if (classification !== 'delete') {
            skipped.push({ ...entry, reason: classification });
            continue;
        }
        const result = await params.exec.run({
            ...launch,
            args: [
                ...(launch.args ?? []),
                'delete-generic-password',
                '-a',
                username,
                '-s',
                entry.service,
            ],
        }, { timeoutMs: CLAUDE_MACOS_SECURITY_TIMEOUT_MS });
        if (result.exitCode !== 0 && result.exitCode !== 44) {
            throw buildKeychainDeleteError(result.exitCode);
        }
        deleted.push(entry);
    }

    return {
        scanned: entries.length,
        deleted,
        skipped,
    };
}

export async function deleteClaudeCodeMacOsKeychainCredential(params: Readonly<{
    exec: ExecRuntimeServiceV1;
    claudeConfigDir: string;
    homeDir?: string | null | undefined;
    username?: string | null | undefined;
}>): Promise<void> {
    const serviceName = resolveClaudeCodeMacOsKeychainServiceName({
        claudeConfigDir: params.claudeConfigDir,
        homeDir: params.homeDir,
    });
    let result: Awaited<ReturnType<ExecRuntimeServiceV1['run']>>;
    try {
        const launch = await resolveSecurityLaunch(
            params.exec,
            'delete stale Claude Code OAuth credentials from the macOS keychain',
        );
        result = await params.exec.run({
            ...launch,
            args: [
                ...(launch.args ?? []),
                'delete-generic-password',
                '-a',
                String(params.username ?? userInfo().username).trim(),
                '-s',
                serviceName,
            ],
        }, { timeoutMs: CLAUDE_MACOS_SECURITY_TIMEOUT_MS });
    } catch {
        throw new Error('claude_code_keychain_delete_failed:exec');
    }
    if (result.exitCode !== 0 && result.exitCode !== 44) {
        throw buildKeychainDeleteError(result.exitCode);
    }
}

export async function readClaudeCodeMacOsKeychainCredential(params: Readonly<{
    exec: ExecRuntimeServiceV1;
    claudeConfigDir: string;
    homeDir?: string | null | undefined;
}>): Promise<ClaudeCodeNativeCredentialPayload | null> {
    const serviceName = resolveClaudeCodeMacOsKeychainServiceName({
        claudeConfigDir: params.claudeConfigDir,
        homeDir: params.homeDir,
    });
    // Read gate: only the GLOBAL `Claude Code-credentials` service is ever consulted. Happier no longer
    // writes derived per-config keychain items, and a managed home (CLAUDE_CONFIG_DIR set) reads ONLY its
    // `.credentials.json` file — never the keychain. A derived-service read could therefore only surface a
    // stale legacy Happier artifact and force a spurious credential_fingerprint_mismatch on the
    // authoritative file, so managed homes are file-only for reads too. The real `~/.claude` fallback is
    // preserved.
    if (serviceName !== DEFAULT_CLAUDE_CODE_KEYCHAIN_SERVICE) return null;
    try {
        const launch = await resolveSecurityLaunch(
            params.exec,
            'read Claude Code OAuth credentials from the macOS keychain',
        );
        const result = await params.exec.run({
            ...launch,
            args: [...(launch.args ?? []), 'find-generic-password', '-s', serviceName, '-w'],
        }, { timeoutMs: CLAUDE_MACOS_SECURITY_TIMEOUT_MS });
        if (result.exitCode !== 0) return null;
        return readClaudeCodeNativeCredentialPayload(JSON.parse(result.stdout.trim()) as unknown);
    } catch {
        return null;
    }
}
