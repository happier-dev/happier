import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { getCodexDirectSessionActivity } from './getCodexDirectSessionActivity';

const tempDirs = new Set<string>();

function rememberTempDir(path: string): string {
    tempDirs.add(path);
    return path;
}

function sessionMetaLine(payload: Record<string, unknown>): string {
    return `${JSON.stringify({ type: 'session_meta', payload })}\n`;
}

afterEach(async () => {
    for (const dir of tempDirs) {
        await rm(dir, { recursive: true, force: true });
    }
    tempDirs.clear();
});

describe('getCodexDirectSessionActivity', () => {
    it('reuses the cached activity marker after the rollout file becomes unavailable', async () => {
        const root = rememberTempDir(await mkdtemp(join(tmpdir(), 'happier-codex-activity-')));
        const codexHome = join(root, 'codex-home');
        const sessionsDir = join(codexHome, 'sessions');
        await mkdir(sessionsDir, { recursive: true });

        const sessionId = '99999999-9999-9999-9999-999999999999';
        const filePath = join(sessionsDir, `rollout-2026-01-02T00-00-00-${sessionId}.jsonl`);
        await writeFile(
            filePath,
            sessionMetaLine({ id: sessionId, timestamp: '2026-01-02T00:00:00.000Z', cwd: '/repo/for-activity' }),
            'utf8',
        );

        const first = await getCodexDirectSessionActivity({
            source: { kind: 'codexHome', home: 'user' },
            activeServerDir: join(root, 'servers', 'cloud'),
            remoteSessionId: sessionId,
            env: { CODEX_HOME: codexHome } as NodeJS.ProcessEnv,
        });

        await rm(filePath);

        const second = await getCodexDirectSessionActivity({
            source: { kind: 'codexHome', home: 'user' },
            activeServerDir: join(root, 'servers', 'cloud'),
            remoteSessionId: sessionId,
            env: { CODEX_HOME: codexHome } as NodeJS.ProcessEnv,
        });

        expect(first.lastActivityAtMs).toBeTypeOf('number');
        expect(second.lastActivityAtMs).toBe(first.lastActivityAtMs);
    });
});
