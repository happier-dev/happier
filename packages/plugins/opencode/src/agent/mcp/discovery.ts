import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import {
    normalizeDetectedMcpServerV1,
    type DaemonMcpServersDetectWarningV1,
    type DetectedMcpServerV1,
} from '@happier-dev/plugin-sdk/mcp';

export type ReadOpenCodeMcpConfigServersResult = Readonly<{
    servers: ReadonlyArray<DetectedMcpServerV1>;
    warnings: ReadonlyArray<DaemonMcpServersDetectWarningV1>;
}>;

type OpenCodeMcpServersFile = Readonly<{
    mcpServers?: Readonly<Record<string, unknown>>;
    mcp_servers?: Readonly<Record<string, unknown>>;
}>;

function resolveOpenCodeConfigJsonPath(env: NodeJS.ProcessEnv): string {
    const xdgConfigHome = typeof env.XDG_CONFIG_HOME === 'string' ? env.XDG_CONFIG_HOME.trim() : '';
    if (xdgConfigHome) return join(xdgConfigHome, 'opencode', 'opencode.json');
    const home = typeof env.HOME === 'string' && env.HOME.trim() ? env.HOME.trim() : homedir();
    return join(home, '.config', 'opencode', 'opencode.json');
}

function parseStringArray(raw: unknown): string[] {
    if (!Array.isArray(raw)) return [];
    const out: string[] = [];
    for (const entry of raw) {
        if (typeof entry !== 'string') continue;
        out.push(entry);
    }
    return out;
}

function parseRecordKeys(raw: unknown): string[] {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return [];
    return Object.keys(raw as Record<string, unknown>);
}

function normalizeDetectedServer(params: Readonly<{
    name: string;
    config: unknown;
    source: DetectedMcpServerV1['source'];
}>): DetectedMcpServerV1 | null {
    const cfg = params.config;
    if (!cfg || typeof cfg !== 'object' || Array.isArray(cfg)) return null;
    const obj = cfg as Record<string, unknown>;

    const enabled = typeof obj.enabled === 'boolean' ? obj.enabled : null;
    const command = typeof obj.command === 'string' && obj.command.trim()
        ? obj.command.trim()
        : null;
    const args = parseStringArray(obj.args);
    const envKeys = parseRecordKeys(obj.env);

    if (command) {
        return normalizeDetectedMcpServerV1({
            provider: 'opencode',
            name: params.name,
            transport: 'stdio',
            stdio: { command, args },
            envKeys,
            enabled,
            source: params.source,
        });
    }

    const urlRaw = typeof obj.url === 'string'
        ? obj.url
        : typeof obj.endpoint === 'string'
            ? obj.endpoint
            : null;
    const url = urlRaw && urlRaw.trim() ? urlRaw.trim() : null;
    if (!url) return null;

    const transport = obj.transport === 'sse' || obj.type === 'sse' ? 'sse' : 'http';
    return normalizeDetectedMcpServerV1({
        provider: 'opencode',
        name: params.name,
        transport,
        remote: {
            url,
            headers: parseRecordKeys(obj.headers),
        },
        envKeys,
        enabled,
        source: params.source,
    });
}

export async function readOpenCodeMcpConfigServers(
    params: Readonly<{ directory?: string | null; env?: NodeJS.ProcessEnv }>,
): Promise<ReadOpenCodeMcpConfigServersResult> {
    const env = params.env ?? process.env;
    const candidates: Array<Readonly<{ kind: 'user' | 'project'; path: string }>> = [
        { kind: 'user', path: resolveOpenCodeConfigJsonPath(env) },
    ];
    if (typeof params.directory === 'string' && params.directory.trim()) {
        candidates.push({
            kind: 'project',
            path: join(params.directory.trim(), '.opencode', 'opencode.json'),
        });
    }

    const servers: DetectedMcpServerV1[] = [];
    const warnings: DaemonMcpServersDetectWarningV1[] = [];

    for (const candidate of candidates) {
        if (!existsSync(candidate.path)) continue;

        let parsed: OpenCodeMcpServersFile;
        try {
            const text = readFileSync(candidate.path, 'utf8');
            parsed = JSON.parse(text) as OpenCodeMcpServersFile;
        } catch {
            warnings.push({ provider: 'opencode', code: 'parse_failed', path: candidate.path });
            continue;
        }

        const mcpServers = parsed?.mcpServers ?? parsed?.mcp_servers;
        if (!mcpServers || typeof mcpServers !== 'object') continue;

        for (const [name, raw] of Object.entries(mcpServers)) {
            const trimmed = name.trim();
            if (!trimmed) continue;
            const detected = normalizeDetectedServer({
                name: trimmed,
                config: raw,
                source: { kind: candidate.kind, path: candidate.path },
            });
            if (detected) servers.push(detected);
        }
    }

    return { servers, warnings };
}
