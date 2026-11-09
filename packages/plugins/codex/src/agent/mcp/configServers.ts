import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse as parseToml } from 'smol-toml';
import { expandHomePath, resolveHomeDirFromEnvironment } from '@happier-dev/plugin-sdk/fs';

import type { DetectedMcpServerV1, DiscoveryWarning as McpDiscoveryWarningV1 } from '@happier-dev/plugin-sdk/mcp';

export type ReadCodexMcpConfigServersResult = Readonly<{
    servers: ReadonlyArray<DetectedMcpServerV1>;
    warnings: ReadonlyArray<McpDiscoveryWarningV1>;
}>;

export function resolveCodexHome(env: Readonly<Record<string, string | undefined>>): string {
    const codexHome = typeof env.CODEX_HOME === 'string' ? env.CODEX_HOME.trim() : '';
    const home = resolveHomeDirFromEnvironment(env);
    return codexHome ? expandHomePath(codexHome, home) : join(home, '.codex');
}

function readRecord(value: unknown): Readonly<Record<string, unknown>> | null {
    return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Readonly<Record<string, unknown>> : null;
}

function readCodexMcpConfig(env: Readonly<Record<string, string | undefined>>, path = join(resolveCodexHome(env), 'config.toml')): Readonly<{
    path: string;
    entries: Readonly<Record<string, unknown>>;
    warnings: ReadonlyArray<McpDiscoveryWarningV1>;
}> {
    if (!existsSync(path)) return { path, entries: {}, warnings: [] };
    let text: string;
    try {
        text = readFileSync(path, 'utf8');
    } catch {
        return { path, entries: {}, warnings: [{ provider: 'codex', code: 'read_failed', path }] };
    }
    try {
        return { path, entries: readRecord(parseToml(text).mcp_servers) ?? {}, warnings: [] };
    } catch {
        return { path, entries: {}, warnings: [{ provider: 'codex', code: 'parse_failed', path }] };
    }
}

export function readCodexMcpServerKeysFromConfigToml(env: Readonly<Record<string, string | undefined>>): string[] {
    return Object.keys(readCodexMcpConfig(env).entries).sort().map((name) => (
        /^[A-Za-z0-9_-]+$/u.test(name) ? name : JSON.stringify(name)
    ));
}

export async function readCodexMcpConfigServers(
    params: Readonly<{ env?: Readonly<Record<string, string | undefined>>; directory?: string | null }>,
): Promise<ReadCodexMcpConfigServersResult> {
    const env = params.env ?? process.env;
    const directory = params.directory?.trim() ? expandHomePath(params.directory, resolveHomeDirFromEnvironment(env)) : null;
    const candidates = [{ kind: 'user' as const, parsed: readCodexMcpConfig(env) },
        ...(directory ? [{ kind: 'project' as const, parsed: readCodexMcpConfig(env, join(directory, '.codex', 'config.toml')) }] : [])];
    const servers = new Map<string, DetectedMcpServerV1>();
    for (const { kind, parsed } of candidates) {
        for (const [name, value] of Object.entries(parsed.entries)) {
            const entry = readRecord(value);
            if (!entry) continue;
            const source = { kind, path: parsed.path };
            const enabled = typeof entry.enabled === 'boolean' ? entry.enabled : null;
            if (typeof entry.url === 'string' && entry.url.trim()) {
                servers.set(name, {
                    provider: 'codex', name, transport: 'http',
                    remote: { url: entry.url.trim(), headers: [...new Set([
                        ...Object.keys(readRecord(entry.http_headers) ?? {}),
                        ...Object.keys(readRecord(entry.env_http_headers) ?? {}),
                        ...(typeof entry.bearer_token_env_var === 'string' ? ['Authorization'] : []),
                    ])] },
                    envKeys: [], enabled, source,
                });
                continue;
            }
            if (typeof entry.command !== 'string' || !entry.command.trim()) continue;
            const args = Array.isArray(entry.args) ? entry.args.filter((arg): arg is string => typeof arg === 'string') : [];
            const forwardedEnvKeys = Array.isArray(entry.env_vars) ? entry.env_vars.flatMap(value => {
                const key = typeof value === 'string' ? value : readRecord(value)?.name;
                return typeof key === 'string' ? [key] : [];
            }) : [];
            servers.set(name, {
                provider: 'codex',
                name,
                transport: 'stdio',
                stdio: { command: entry.command, args },
                envKeys: [...new Set([...Object.keys(readRecord(entry.env) ?? {}), ...forwardedEnvKeys])],
                enabled,
                source,
            });
        }
    }
    return { servers: [...servers.values()], warnings: candidates.flatMap(candidate => candidate.parsed.warnings) };
}
