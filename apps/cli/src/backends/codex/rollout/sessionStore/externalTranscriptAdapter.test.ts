import { mkdir, mkdtemp, rm, writeFile, utimes } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { createCodexExternalSessionTranscriptStoreAdapter } from './externalTranscriptAdapter';

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

describe('Codex external-session transcript store adapter', () => {
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

        const adapter = createCodexExternalSessionTranscriptStoreAdapter({
            activeServerDir: join(root, 'servers', 'cloud'),
            env: { CODEX_HOME: codexHome } as NodeJS.ProcessEnv,
        });

        await expect(adapter.withStore({
            providerId: 'codex',
            source: { kind: 'codexHome', home: 'user' },
            providerSessionId: sessionId,
        }, async (store) => await store.getWorkingDirectory())).resolves.toBe('/repo/from-store-path');
    });

    it('resolves the authoritative connected-service home when multiple homes contain the same session', async () => {
        const root = rememberTempDir(await mkdtemp(join(tmpdir(), 'happier-codex-transcript-adapter-home-')));
        const activeServerDir = join(root, 'servers', 'cloud');
        const homesRoot = join(activeServerDir, 'daemon', 'connected-services', 'homes', 'svc_1');
        const olderHome = join(homesRoot, 'profile-a', 'codex', 'codex-home');
        const newerHome = join(homesRoot, 'profile-b', 'codex', 'codex-home');
        const olderSessionsDir = join(olderHome, 'sessions');
        const newerSessionsDir = join(newerHome, 'sessions');
        await mkdir(olderSessionsDir, { recursive: true });
        await mkdir(newerSessionsDir, { recursive: true });

        const remoteSessionId = 'takeover-authoritative-home-session';
        const olderRollout = join(olderSessionsDir, `rollout-2026-01-01T00-00-00-${remoteSessionId}.jsonl`);
        const newerRollout = join(newerSessionsDir, `rollout-2026-01-02T00-00-00-${remoteSessionId}.jsonl`);

        await writeFile(
            olderRollout,
            sessionMetaLine({ id: remoteSessionId, timestamp: '2026-01-01T00:00:00.000Z', cwd: '/repo/older-home' }),
            'utf8',
        );
        await writeFile(
            newerRollout,
            sessionMetaLine({ id: remoteSessionId, timestamp: '2026-01-02T00:00:00.000Z', cwd: '/repo/newer-home' }),
            'utf8',
        );
        await utimes(olderRollout, new Date('2026-01-01T00:00:01.000Z'), new Date('2026-01-01T00:00:01.000Z'));
        await utimes(newerRollout, new Date('2026-01-02T00:00:01.000Z'), new Date('2026-01-02T00:00:01.000Z'));

        const adapter = createCodexExternalSessionTranscriptStoreAdapter({
            activeServerDir,
            env: {} as NodeJS.ProcessEnv,
        });

        await expect(adapter.getProviderHome?.({
            providerId: 'codex',
            source: { kind: 'codexHome', home: 'connectedService', connectedServiceId: 'svc_1' },
            providerSessionId: remoteSessionId,
        })).resolves.toBe(newerHome);
        await expect(adapter.withStore({
            providerId: 'codex',
            source: { kind: 'codexHome', home: 'connectedService', connectedServiceId: 'svc_1' },
            providerSessionId: remoteSessionId,
        }, async (store) => await store.getWorkingDirectory())).resolves.toBe('/repo/newer-home');
    });
});
