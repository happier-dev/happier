import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import type { DaemonMcpServersDetectWarningV1, DetectedMcpServerV1 } from '@happier-dev/protocol';

export type DetectOpenCodeMcpServersResult = Readonly<{
    servers: ReadonlyArray<DetectedMcpServerV1>;
    warnings: ReadonlyArray<DaemonMcpServersDetectWarningV1>;
}>;

type OpenCodeMcpServersFile = Readonly<{
    mcpServers?: Readonly<Record<string, Readonly<{ command?: unknown; args?: unknown; env?: unknown }>>>;
}>;

function resolveOpenCodeConfigJsonPath(env: NodeJS.ProcessEnv): string {
    const xdgConfigHome = typeof env.XDG_CONFIG_HOME === 'string' ? env.XDG_CONFIG_HOME.trim() : '';
    if (xdgConfigHome) return join(xdgConfigHome, 'opencode', 'opencode.json');
    return join(homedir(), '.config', 'opencode', 'opencode.json');
}

function parseStringArray(raw: unknown): string[] | null {
    if (!Array.isArray(raw)) return null;
    const out: string[] = [];
    for (const entry of raw) {
        if (typeof entry !== 'string') return null;
        out.push(entry);
    }
    return out;
}

export async function detectOpenCodeMcpServers(
    params: Readonly<{ env?: NodeJS.ProcessEnv }>,
): Promise<DetectOpenCodeMcpServersResult> {
    const env = params.env ?? process.env;
    const path = resolveOpenCodeConfigJsonPath(env);
    if (!existsSync(path)) return { servers: [], warnings: [] };

    let parsed: OpenCodeMcpServersFile;
    try {
        const text = readFileSync(path, 'utf8');
        parsed = JSON.parse(text) as OpenCodeMcpServersFile;
    } catch {
        return { servers: [], warnings: [{ provider: 'opencode', code: 'parse_failed', path }] };
    }

    const servers: DetectedMcpServerV1[] = [];
    const warnings: DaemonMcpServersDetectWarningV1[] = [];

    const mcpServers = parsed?.mcpServers;
    if (!mcpServers || typeof mcpServers !== 'object') return { servers, warnings };

    for (const [name, raw] of Object.entries(mcpServers)) {
        const trimmed = name.trim();
        if (!trimmed) continue;

        const command = raw && typeof raw.command === 'string' ? raw.command.trim() : '';
        if (!command) continue;

        const args = parseStringArray(raw.args) ?? [];
        const envKeys =
            raw.env && typeof raw.env === 'object' && !Array.isArray(raw.env)
                ? Object.keys(raw.env as Record<string, unknown>)
                : [];

        servers.push({
            provider: 'opencode',
            name: trimmed,
            transport: 'stdio',
            stdio: { command, args },
            envKeys,
            enabled: null,
            source: { kind: 'user', path },
        });
    }

    return { servers, warnings };
}
