import { createHash } from 'node:crypto';
import { homedir, userInfo } from 'node:os';
import { join, resolve } from 'node:path';

import type { ExecRuntimeServiceV1 } from '@happier-dev/plugin-sdk';

import type { ClaudeCodeNativeCredentialPayload } from './credentials.js';

export const CLAUDE_MACOS_SECURITY_SYSTEM_TOOL_ID = 'claude.macos.security';
const DEFAULT_CLAUDE_CODE_KEYCHAIN_SERVICE = 'Claude Code-credentials';

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

function buildKeychainPayloadInput(payload: ClaudeCodeNativeCredentialPayload): string {
    const serialized = JSON.stringify(payload);
    return `${serialized}\n${serialized}\n`;
}

function buildKeychainWriteError(status: number | null): Error {
    return new Error(`claude_code_keychain_write_failed:exit_${status ?? 'unknown'}`);
}

async function resolveSecurityLaunch(exec: ExecRuntimeServiceV1, purpose: string) {
    const grant = await exec.systemTools.resolve({
        toolId: CLAUDE_MACOS_SECURITY_SYSTEM_TOOL_ID,
        purpose,
        preferredCommand: 'security',
    });
    return grant.launch;
}

export async function writeClaudeCodeMacOsKeychainCredential(params: Readonly<{
    exec: ExecRuntimeServiceV1;
    claudeConfigDir: string;
    payload: ClaudeCodeNativeCredentialPayload;
    homeDir?: string | null | undefined;
    username?: string | null | undefined;
}>): Promise<void> {
    const serviceName = resolveClaudeCodeMacOsKeychainServiceName({
        claudeConfigDir: params.claudeConfigDir,
        homeDir: params.homeDir,
    });
    const username = String(params.username ?? userInfo().username).trim();
    let result: Awaited<ReturnType<ExecRuntimeServiceV1['run']>>;
    try {
        const launch = await resolveSecurityLaunch(
            params.exec,
            'write Claude Code OAuth credentials to the macOS keychain',
        );
        result = await params.exec.run({
            ...launch,
            args: [
                ...(launch.args ?? []),
                'add-generic-password',
                '-U',
                '-a',
                username,
                '-s',
                serviceName,
                '-w',
            ],
            stdin: buildKeychainPayloadInput(params.payload),
        });
    } catch {
        throw new Error('claude_code_keychain_write_failed:exec');
    }
    if (result.exitCode !== 0) {
        throw buildKeychainWriteError(result.exitCode);
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
    try {
        const launch = await resolveSecurityLaunch(
            params.exec,
            'read Claude Code OAuth credentials from the macOS keychain',
        );
        const result = await params.exec.run({
            ...launch,
            args: [...(launch.args ?? []), 'find-generic-password', '-s', serviceName, '-w'],
        });
        if (result.exitCode !== 0) return null;
        const parsed = JSON.parse(result.stdout.trim()) as unknown;
        return parsed && typeof parsed === 'object' ? (parsed as ClaudeCodeNativeCredentialPayload) : null;
    } catch {
        return null;
    }
}
