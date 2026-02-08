import { describe, expect, it } from 'vitest';
import { mkdtemp, writeFile, utimes, mkdir, rm, truncate } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { discoverCodexRolloutFileOnce, scoreCodexRolloutCandidate } from '../rolloutDiscovery';

function sessionMetaLine(payload: Record<string, unknown>): string {
    return JSON.stringify({
        timestamp: new Date().toISOString(),
        type: 'session_meta',
        payload,
    });
}

describe('codex local-control rollout discovery', () => {
    it('scores candidates higher when payload.timestamp is close to startedAt', () => {
        const startedAtMs = Date.parse('2026-02-04T12:00:00.000Z');
        const near = { timestamp: '2026-02-04T12:00:02.000Z', cwd: '/x' };
        const far = { timestamp: '2026-02-04T11:40:00.000Z', cwd: '/x' };

        const nearScore = scoreCodexRolloutCandidate({
            sessionMeta: near as any,
            startedAtMs,
            cwd: '/x',
        });
        const farScore = scoreCodexRolloutCandidate({
            sessionMeta: far as any,
            startedAtMs,
            cwd: '/x',
        });

        expect(nearScore).toBeGreaterThan(farScore);
    });

    it('uses resumeId fast-path by filename fragment and prefers newest mtime', async () => {
        const root = await mkdtemp(join(tmpdir(), 'codex-sessions-'));
        try {
            const dir = join(root, '2026', '02', '04');
            await mkdir(dir, { recursive: true });

            const resumeId = '019c17f4-cb9c-7512-b441-80d453fb5a53';
            const older = join(dir, `rollout-2026-02-04T00-00-00-${resumeId}.jsonl`);
            const newer = join(dir, `rollout-2026-02-04T00-00-01-${resumeId}.jsonl`);

            await writeFile(older, `${sessionMetaLine({ id: resumeId, timestamp: '2026-02-04T12:00:00.000Z' })}\n`);
            await writeFile(newer, `${sessionMetaLine({ id: resumeId, timestamp: '2026-02-04T12:00:00.000Z' })}\n`);

            const t1 = new Date('2026-02-04T12:00:00.000Z');
            const t2 = new Date('2026-02-04T12:00:10.000Z');
            await utimes(older, t1, t1);
            await utimes(newer, t2, t2);

            const discovered = await discoverCodexRolloutFileOnce({
                sessionsRootDir: root,
                startedAtMs: Date.parse('2026-02-04T12:00:05.000Z'),
                cwd: '/Users/leeroy/Documents/Development/happier/dev',
                resumeId,
                scanLimit: 50,
            });

            expect(discovered?.filePath).toBe(newer);
        } finally {
            await rm(root, { recursive: true, force: true });
        }
    });

    it('can read session_meta from a huge sparse rollout file without loading the entire file', async () => {
        const root = await mkdtemp(join(tmpdir(), 'codex-sessions-huge-'));
        try {
            const dir = join(root, '2026', '02', '04');
            await mkdir(dir, { recursive: true });

            const filePath = join(dir, 'rollout-2026-02-04T00-00-00-huge.jsonl');
            await writeFile(filePath, `${sessionMetaLine({ id: 'huge', timestamp: '2026-02-04T12:00:00.000Z' })}\n`);
            await truncate(filePath, 2_500_000_000);

            const discovered = await discoverCodexRolloutFileOnce({
                sessionsRootDir: root,
                startedAtMs: Date.parse('2026-02-04T12:00:05.000Z'),
                cwd: '/Users/leeroy/Documents/Development/happier/dev',
                scanLimit: 10,
            });

            expect(discovered?.filePath).toBe(filePath);
            expect(discovered?.sessionMeta.id).toBe('huge');
        } finally {
            await rm(root, { recursive: true, force: true });
        }
    });
});
