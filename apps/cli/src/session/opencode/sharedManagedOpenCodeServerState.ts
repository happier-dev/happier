import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import { configuration } from '@/configuration';

export type SharedManagedOpenCodeServerState = Readonly<{
    baseUrl: string;
    pid: number;
    startedAtMs: number;
    status?: 'starting' | 'ready' | 'failed';
}>;

function resolveStatePathFromEnv(): string {
    const raw = typeof process.env.HAPPIER_OPENCODE_SERVER_STATE_PATH === 'string'
        ? process.env.HAPPIER_OPENCODE_SERVER_STATE_PATH.trim()
        : '';
    if (raw) return raw;
    return join(configuration.happyHomeDir, 'opencode', 'managed-server.json');
}

function normalizeState(raw: unknown): SharedManagedOpenCodeServerState | null {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
    const rec = raw as Record<string, unknown>;
    const baseUrl = typeof rec.baseUrl === 'string' ? rec.baseUrl.trim() : '';
    const pidRaw = typeof rec.pid === 'number' ? rec.pid : Number(rec.pid);
    const startedAtMsRaw = typeof rec.startedAtMs === 'number' ? rec.startedAtMs : Number(rec.startedAtMs);
    const statusRaw = typeof rec.status === 'string' ? rec.status.trim() : '';
    if (!baseUrl) return null;
    if (!Number.isFinite(pidRaw) || pidRaw <= 0) return null;
    if (!Number.isFinite(startedAtMsRaw) || startedAtMsRaw <= 0) return null;

    return {
        baseUrl,
        pid: Math.floor(pidRaw),
        startedAtMs: Math.floor(startedAtMsRaw),
        ...(statusRaw === 'starting' || statusRaw === 'ready' || statusRaw === 'failed' ? { status: statusRaw } : {}),
    };
}

export async function readSharedManagedOpenCodeServerStateBestEffort(): Promise<SharedManagedOpenCodeServerState | null> {
    const statePath = resolveStatePathFromEnv();
    try {
        // Ensure the path looks like a file path (not a directory) to avoid accidental large directory reads.
        if (dirname(statePath) === statePath) return null;
        const raw = await readFile(statePath, 'utf8');
        return normalizeState(JSON.parse(raw));
    } catch {
        return null;
    }
}
