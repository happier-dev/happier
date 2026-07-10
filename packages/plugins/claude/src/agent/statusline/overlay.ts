import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { HAPPIER_CLAUDE_CONFIG_DIR_ENV } from '@happier-dev/plugin-sdk/experimental/envConstants';

/**
 * Statusline forwarder `statusLine` overlay for the Claude unified terminal launch.
 *
 * The unified launch merges `statusLine: { type: 'command', command: <forwarder> }` into the
 * single `--settings` overlay. The forwarder wrapper POSTs Claude's statusline payload to the
 * session hook server and exec-chains the user's ORIGINAL statusline command, resolved here from
 * the EFFECTIVE settings of the spawned config root (`HAPPIER_CLAUDE_CONFIG_DIR` /
 * `CLAUDE_CONFIG_DIR` — the same env keys the connected-services homes materialize) and carried
 * base64-encoded so quoting survives the settings JSON → shell round trip.
 *
 * Hardening (carry-over from the remote-dev S7 review): the hook secret NEVER rides the
 * command/argv — the forwarder reads it from the session hook server's 0600 secret file
 * (`--secret-file`), the same mechanism the session/permission hook forwarders use.
 */

export type ClaudeStatuslineOriginalCommand = Readonly<{
    command: string;
    padding?: number | undefined;
}>;

function readEnvString(env: Readonly<Record<string, string | undefined>>, key: string): string | null {
    const value = env[key];
    return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

function resolveClaudeConfigRoot(env: Readonly<Record<string, string | undefined>>): string {
    return readEnvString(env, HAPPIER_CLAUDE_CONFIG_DIR_ENV)
        ?? readEnvString(env, 'CLAUDE_CONFIG_DIR')
        ?? join(readEnvString(env, 'HOME') ?? homedir(), '.claude');
}

export function resolveClaudeStatuslineOriginalCommand(params: Readonly<{
    env: Readonly<Record<string, string | undefined>>;
}>): ClaudeStatuslineOriginalCommand | null {
    try {
        const configRoot = resolveClaudeConfigRoot(params.env);
        const parsed = JSON.parse(readFileSync(join(configRoot, 'settings.json'), 'utf8')) as unknown;
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
        const statusLine = (parsed as Record<string, unknown>).statusLine;
        if (!statusLine || typeof statusLine !== 'object' || Array.isArray(statusLine)) return null;
        const record = statusLine as Record<string, unknown>;
        if (record.type !== 'command') return null;
        const command = typeof record.command === 'string' ? record.command.trim() : '';
        if (!command) return null;
        const padding = typeof record.padding === 'number' && Number.isFinite(record.padding)
            ? record.padding
            : undefined;
        return { command, ...(padding !== undefined ? { padding } : {}) };
    } catch {
        // Missing/unreadable settings: behave as if no statusline is configured (fail-open).
        return null;
    }
}

export type ClaudeStatuslineOverlaySettings = Readonly<{
    type: 'command';
    command: string;
    padding?: number | undefined;
}>;

export function buildClaudeStatuslineOverlaySettings(params: Readonly<{
    nodeExecutable: string;
    forwarderScriptPath: string;
    port: number;
    secretFilePath: string | null;
    original: ClaudeStatuslineOriginalCommand | null;
}>): ClaudeStatuslineOverlaySettings {
    const parts = [
        JSON.stringify(params.nodeExecutable),
        JSON.stringify(params.forwarderScriptPath),
        String(params.port),
    ];
    if (params.secretFilePath) {
        parts.push('--secret-file', JSON.stringify(params.secretFilePath));
    }
    if (params.original) {
        parts.push('--original-b64', Buffer.from(params.original.command, 'utf8').toString('base64'));
    }
    return {
        type: 'command',
        command: parts.join(' '),
        ...(params.original?.padding !== undefined ? { padding: params.original.padding } : {}),
    };
}
