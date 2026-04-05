import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { getCodexDirectSessionWorkingDirectory } from './getCodexDirectSessionWorkingDirectory';

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

describe('getCodexDirectSessionWorkingDirectory', () => {
    it('returns the working directory through the Codex rollout session store path', async () => {
        const root = rememberTempDir(await mkdtemp(join(tmpdir(), 'happier-codex-working-directory-')));
        const codexHome = join(root, 'codex-home');
        const sessionsDir = join(codexHome, 'sessions');
        await mkdir(sessionsDir, { recursive: true });

        const sessionId = '88888888-8888-8888-8888-888888888888';
        await writeFile(
            join(sessionsDir, `rollout-2026-01-02T00-00-00-${sessionId}.jsonl`),
            sessionMetaLine({ id: sessionId, timestamp: '2026-01-02T00:00:00.000Z', cwd: '/repo/from-store-path' }),
            'utf8',
        );

        await expect(getCodexDirectSessionWorkingDirectory({
            source: { kind: 'codexHome', home: 'user' },
            activeServerDir: join(root, 'servers', 'cloud'),
            remoteSessionId: sessionId,
            env: { CODEX_HOME: codexHome } as NodeJS.ProcessEnv,
        })).resolves.toBe('/repo/from-store-path');
    });
});
