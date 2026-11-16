import { PluginError } from '@happier-dev/plugin-sdk';
import type { ExecService } from '@happier-dev/plugin-sdk/exec';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { canonicalizePathSync, expandHomePath, resolveHomeDirFromEnvironment } from '@happier-dev/plugin-sdk/fs';
import type { DetectedMcpServerV1, DiscoveryWarning as McpDiscoveryWarningV1 } from '@happier-dev/plugin-sdk/mcp';
import { CLAUDE_CONFIG_DIR_ENV_KEYS, resolveClaudeConfigDirOverride } from '../environment.js';

const CLAUDE_MCP_CONFIG_ENV_KEYS = ['HOME', 'USERPROFILE', ...CLAUDE_CONFIG_DIR_ENV_KEYS] as const;

export type ReadClaudeMcpConfigServersResult = Readonly<{
    servers: ReadonlyArray<DetectedMcpServerV1>;
    warnings: ReadonlyArray<McpDiscoveryWarningV1>;
}>;

function record(value: unknown): Readonly<Record<string, unknown>> {
    return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Readonly<Record<string, unknown>> : {};
}

function stringArray(value: unknown): string[] {
    return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === 'string') : [];
}

export async function readClaudeMcpConfigServers(params: Readonly<{
    directory: string | null;
    env?: NodeJS.ProcessEnv;
    exec?: Pick<ExecService, 'readEnvironment'>;
}>): Promise<ReadClaudeMcpConfigServersResult> {
    if (params.env === undefined && params.exec && !params.exec.readEnvironment) {
        throw new PluginError({ code: 'plugin_service_unavailable', message: 'Inherited invocation environment is unavailable.' });
    }
    const env = params.env ?? params.exec?.readEnvironment?.(CLAUDE_MCP_CONFIG_ENV_KEYS) ?? process.env;
    const home = resolveHomeDirFromEnvironment(env);
    const override = resolveClaudeConfigDirOverride(env);
    const userPath = join(override ? expandHomePath(override, home) : home, '.claude.json');
    const warnings: McpDiscoveryWarningV1[] = [];
    function read(path: string): Readonly<Record<string, unknown>> {
        let text: string;
        try { text = readFileSync(path, 'utf8'); }
        catch (error) {
            if (record(error).code !== 'ENOENT') warnings.push({ provider: 'claude', code: 'read_failed', path });
            return {};
        }
        try { return record(JSON.parse(text)); }
        catch { warnings.push({ provider: 'claude', code: 'parse_failed', path }); return {}; }
    }
    const user = read(userPath);
    const directory = params.directory ? canonicalizePathSync(expandHomePath(params.directory, home)) : null;
    const local = directory ? Object.entries(record(user.projects)).find(([path]) => canonicalizePathSync(path) === directory)?.[1] : null;
    const disabled = new Set(stringArray(record(local).disabledMcpServers));
    const candidates = [
        { kind: 'user' as const, path: userPath, servers: record(user.mcpServers) },
        ...(directory ? [{ kind: 'project' as const, path: join(directory, '.mcp.json'), servers: record(read(join(directory, '.mcp.json')).mcpServers) },
            { kind: 'project' as const, path: userPath, servers: record(record(local).mcpServers) }] : []),
    ];
    const servers = new Map<string, DetectedMcpServerV1>();
    for (const candidate of candidates) {
        for (const [name, config] of Object.entries(candidate.servers)) {
            const entry = record(config);
            const source = { kind: candidate.kind, path: candidate.path };
            const enabled = disabled.has(name) ? false : null;
            const envKeys = Object.keys(record(entry.env));
            if ((entry.type === undefined || entry.type === 'stdio') && typeof entry.command === 'string' && entry.command.trim()) {
                servers.set(name, { provider: 'claude', name, transport: 'stdio', stdio: { command: entry.command.trim(), args: stringArray(entry.args) }, envKeys, enabled, source });
            } else if ((entry.type === 'http' || entry.type === 'streamable-http' || entry.type === 'sse') && typeof entry.url === 'string' && entry.url.trim()) {
                servers.set(name, { provider: 'claude', name, transport: entry.type === 'sse' ? 'sse' : 'http', remote: { url: entry.url.trim(), headers: Object.keys(record(entry.headers)) }, envKeys, enabled, source });
            } else {
                warnings.push({ provider: 'claude', code: 'unsupported', path: candidate.path });
            }
        }
    }
    return { servers: [...servers.values()], warnings };
}
