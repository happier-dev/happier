import { stat } from 'node:fs/promises';

import type { DirectSessionsSource } from '@happier-dev/protocol';

import { resolveClaudeJsonlSessionFile } from './resolveClaudeJsonlSessionFile';

export async function readClaudeJsonlSessionActivity(params: Readonly<{
    source: DirectSessionsSource;
    remoteSessionId: string;
    env?: NodeJS.ProcessEnv;
}>): Promise<Readonly<{ lastActivityAtMs: number | null }>> {
    const resolved = await resolveClaudeJsonlSessionFile({
        source: params.source,
        remoteSessionId: params.remoteSessionId,
        env: params.env,
    });
    if (!resolved) return { lastActivityAtMs: null };

    try {
        const entry = await stat(resolved.filePath);
        const mtimeMs = Number.isFinite(entry.mtimeMs) ? Math.trunc(entry.mtimeMs) : null;
        return { lastActivityAtMs: mtimeMs != null && mtimeMs >= 0 ? mtimeMs : null };
    } catch {
        return { lastActivityAtMs: null };
    }
}
