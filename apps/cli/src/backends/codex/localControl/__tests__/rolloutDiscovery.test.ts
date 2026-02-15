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

    it('prefers the most recent rollout file when multiple matches share the same resumeId', async () => {
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

    it('prefers rollout whose session_meta timestamp is after startedAt even if another file has newer mtime', async () => {
        const root = await mkdtemp(join(tmpdir(), 'codex-sessions-stale-'));
        try {
            const dir = join(root, '2026', '02', '04');
            await mkdir(dir, { recursive: true });

            const startedAtMs = Date.parse('2026-02-04T12:00:05.000Z');

            const stale = join(dir, 'rollout-2026-02-04T12-00-00-stale.jsonl');
            const fresh = join(dir, 'rollout-2026-02-04T12-00-06-fresh.jsonl');

            await writeFile(
                stale,
                `${sessionMetaLine({ id: 'stale', timestamp: '2026-02-04T12:00:00.000Z', cwd: '/x' })}\n`,
            );
            await writeFile(
                fresh,
                `${sessionMetaLine({ id: 'fresh', timestamp: '2026-02-04T12:00:06.000Z', cwd: '/x' })}\n`,
            );

            // Simulate an unrelated active Codex session continuously writing to an older rollout file.
            await utimes(stale, new Date('2026-02-04T12:05:00.000Z'), new Date('2026-02-04T12:05:00.000Z'));
            await utimes(fresh, new Date('2026-02-04T12:00:06.500Z'), new Date('2026-02-04T12:00:06.500Z'));

            const discovered = await discoverCodexRolloutFileOnce({
                sessionsRootDir: root,
                startedAtMs,
                cwd: '/x',
                scanLimit: 50,
            });

            expect(discovered?.filePath).toBe(fresh);
            expect(discovered?.sessionMeta.id).toBe('fresh');
        } finally {
            await rm(root, { recursive: true, force: true });
        }
    });

    it('returns null when only stale rollouts exist for a newly-started session', async () => {
        const root = await mkdtemp(join(tmpdir(), 'codex-sessions-only-stale-'));
        try {
            const dir = join(root, '2026', '02', '04');
            await mkdir(dir, { recursive: true });

            const filePath = join(dir, 'rollout-2026-02-04T11-59-00-stale-only.jsonl');
            await writeFile(
                filePath,
                `${sessionMetaLine({ id: 'stale-only', timestamp: '2026-02-04T11:59:00.000Z', cwd: '/x' })}\n`,
            );

            const discovered = await discoverCodexRolloutFileOnce({
                sessionsRootDir: root,
                startedAtMs: Date.parse('2026-02-04T12:00:05.000Z'),
                cwd: '/x',
                scanLimit: 50,
            });

            expect(discovered).toBeNull();
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
                startedAtMs: Date.parse('2026-02-04T11:59:59.000Z'),
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
