import { PluginError } from '@happier-dev/plugin-sdk';
import type { ExecService } from '@happier-dev/plugin-sdk/exec';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import JSON5 from 'json5';
import { expandHomePath, resolveHomeDirFromEnvironment } from '@happier-dev/plugin-sdk/fs';
import type { DetectedMcpServerV1, DiscoveryWarning as McpDiscoveryWarningV1 } from '@happier-dev/plugin-sdk/mcp';

const OPENCODE_MCP_CONFIG_ENV_KEYS = ['HOME', 'USERPROFILE', 'XDG_CONFIG_HOME', 'OPENCODE_CONFIG', 'OPENCODE_CONFIG_DIR'] as const;

export type ReadOpenCodeMcpConfigServersResult = Readonly<{
    servers: ReadonlyArray<DetectedMcpServerV1>;
    warnings: ReadonlyArray<McpDiscoveryWarningV1>;
}>;

function record(value: unknown): Readonly<Record<string, unknown>> {
    return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Readonly<Record<string, unknown>> : {};
}

export async function readOpenCodeMcpConfigServers(
    params: Readonly<{
        directory?: string | null;
        env?: NodeJS.ProcessEnv;
        exec?: Pick<ExecService, 'readEnvironment'>;
    }>,
): Promise<ReadOpenCodeMcpConfigServersResult> {
    if (params.env === undefined && params.exec && !params.exec.readEnvironment) {
        throw new PluginError({ code: 'plugin_service_unavailable', message: 'Inherited invocation environment is unavailable.' });
    }
    const env = params.env ?? params.exec?.readEnvironment?.(OPENCODE_MCP_CONFIG_ENV_KEYS) ?? process.env;
    const home = resolveHomeDirFromEnvironment(env);
    const configRoot = env.XDG_CONFIG_HOME?.trim() ? expandHomePath(env.XDG_CONFIG_HOME, home) : join(home, '.config');
    const candidates: Array<DetectedMcpServerV1['source']> = [];
    function addDirectory(root: string, kind: 'user' | 'project') {
        candidates.push({ kind, path: join(root, 'opencode.json') }, { kind, path: join(root, 'opencode.jsonc') });
    }
    addDirectory(join(configRoot, 'opencode'), 'user');
    if (env.OPENCODE_CONFIG?.trim()) candidates.push({ kind: 'user', path: expandHomePath(env.OPENCODE_CONFIG, home) });
    if (params.directory?.trim()) {
        const directory = expandHomePath(params.directory, home);
        addDirectory(directory, 'project');
        addDirectory(join(directory, '.opencode'), 'project');
    }
    if (env.OPENCODE_CONFIG_DIR?.trim()) addDirectory(expandHomePath(env.OPENCODE_CONFIG_DIR, home), 'user');

    const entries = new Map<string, { config: Readonly<Record<string, unknown>>; source: DetectedMcpServerV1['source'] }>();
    const warnings: McpDiscoveryWarningV1[] = [];
    for (const source of candidates) {
        let text: string;
        try { text = readFileSync(source.path, 'utf8'); }
        catch (error) {
            if (record(error).code !== 'ENOENT') warnings.push({ provider: 'opencode', code: 'read_failed', path: source.path });
            continue;
        }
        let parsed: unknown;
        try { parsed = source.path.endsWith('.jsonc') ? JSON5.parse(text) : JSON.parse(text); }
        catch { warnings.push({ provider: 'opencode', code: 'parse_failed', path: source.path }); continue; }
        for (const [name, raw] of Object.entries(record(record(parsed).mcp))) {
            entries.set(name, { config: { ...entries.get(name)?.config, ...record(raw) }, source });
        }
    }

    const servers: DetectedMcpServerV1[] = [];
    for (const [name, { config, source }] of entries) {
        const enabled = typeof config.enabled === 'boolean' ? config.enabled : null;
        if (config.type === 'local' && Array.isArray(config.command) && config.command.length > 0
            && config.command.every((value): value is string => typeof value === 'string') && config.command[0].trim()) {
            servers.push({ provider: 'opencode', name, transport: 'stdio',
                stdio: { command: config.command[0], args: config.command.slice(1) },
                envKeys: Object.keys(record(config.environment)), enabled, source });
        } else if (config.type === 'remote' && typeof config.url === 'string' && config.url.trim()) {
            servers.push({ provider: 'opencode', name, transport: 'http',
                remote: { url: config.url.trim(), headers: Object.keys(record(config.headers)) },
                envKeys: [], enabled, source });
        } else {
            warnings.push({ provider: 'opencode', code: 'unsupported', path: source.path });
        }
    }
    return { servers, warnings };
}
