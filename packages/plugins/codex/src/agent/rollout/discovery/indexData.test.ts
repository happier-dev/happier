import { describe, expect, it, vi } from 'vitest';
import { mkdtemp, writeFile, utimes, mkdir, rm, truncate } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { discoverCodexRolloutFileOnce, scoreCodexRolloutCandidate } from './indexData.js';

const rolloutDiscoveryStatPaths = vi.hoisted(() => [] as string[]);

vi.mock('node:fs/promises', async (importOriginal) => {
    const actual = await importOriginal<typeof import('node:fs/promises')>();
    return {
        ...actual,
        stat: async (path: Parameters<typeof actual.stat>[0]) => {
            rolloutDiscoveryStatPaths.push(String(path));
            return await actual.stat(path);
        },
    };
});

function sessionMetaLine(payload: Record<string, unknown>): string {
    return JSON.stringify({
        timestamp: new Date().toISOString(),
        type: 'session_meta',
        payload,
    });
}

describe('codex terminal-mode rollout discovery', () => {
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

    it('applies scanLimit before statting rollout history', async () => {
        const root = await mkdtemp(join(tmpdir(), 'codex-sessions-bounded-scan-'));
        try {
            const dir = join(root, '2026', '02', '04');
            await mkdir(dir, { recursive: true });
            const startedAtMs = Date.parse('2026-02-04T12:00:05.000Z');

            for (let index = 0; index < 100; index += 1) {
                const seconds = String(index % 60).padStart(2, '0');
                const suffix = String(index).padStart(3, '0');
                await writeFile(
                    join(dir, `rollout-2026-02-04T11-59-${seconds}-stale-${suffix}.jsonl`),
                    `${sessionMetaLine({
                        id: `stale-${suffix}`,
                        timestamp: '2026-02-04T11:59:00.000Z',
                        cwd: '/x',
                    })}\n`,
                );
            }
            const fresh = join(dir, 'rollout-2026-02-04T12-00-06-fresh.jsonl');
            await writeFile(
                fresh,
                `${sessionMetaLine({
                    id: 'fresh',
                    timestamp: '2026-02-04T12:00:06.000Z',
                    cwd: '/x',
                })}\n`,
            );

            rolloutDiscoveryStatPaths.length = 0;
            const discovered = await discoverCodexRolloutFileOnce({
                sessionsRootDir: root,
                startedAtMs,
                cwd: '/x',
                scanLimit: 5,
            });

            expect(discovered?.filePath).toBe(fresh);
            expect(rolloutDiscoveryStatPaths.length).toBeLessThanOrEqual(5);
        } finally {
            await rm(root, { recursive: true, force: true });
        }
    });

    it('ignores a stale rollout whose mtime is fresh because another long-running Codex session keeps appending to it', async () => {
        const root = await mkdtemp(join(tmpdir(), 'codex-sessions-stale-active-'));
        try {
            const dir = join(root, '2026', '02', '04');
            await mkdir(dir, { recursive: true });

            const startedAtMs = Date.parse('2026-02-04T12:00:05.000Z');

            // A real unrelated Codex session started two days earlier that is still actively writing.
            const staleButActive = join(dir, 'rollout-2026-02-02T10-00-00-stale-active.jsonl');
            await writeFile(
                staleButActive,
                `${sessionMetaLine({ id: 'stale-active', timestamp: '2026-02-02T10:00:00.000Z', cwd: '/somewhere/else' })}\n` +
                    `${JSON.stringify({ type: 'event_msg', payload: { type: 'user_message', message: 'ghost message from old session' } })}\n`,
            );
            // Simulate the other Codex continuing to append right through our launcher's startedAtMs window.
            const activeMtime = new Date('2026-02-04T12:00:05.500Z');
            await utimes(staleButActive, activeMtime, activeMtime);

            // Our brand-new rollout has not been created yet at the moment of discovery.
            const discovered = await discoverCodexRolloutFileOnce({
                sessionsRootDir: root,
                startedAtMs,
                cwd: '/x',
                scanLimit: 50,
            });

            // Before the fix, this returned the stale rollout (mtime-fresh branch), which caused its
            // historical user messages to be mirrored into the freshly-created Happy session.
            expect(discovered).toBeNull();
        } finally {
            await rm(root, { recursive: true, force: true });
        }
    });

    it('waits for the matching root TUI rollout when a fresh unrelated rollout appears first', async () => {
        const root = await mkdtemp(join(tmpdir(), 'codex-sessions-concurrent-'));
        try {
            const dir = join(root, '2026', '02', '04');
            await mkdir(dir, { recursive: true });

            const startedAtMs = Date.parse('2026-02-04T12:00:05.000Z');
            const unrelated = join(dir, 'rollout-2026-02-04T12-00-05-unrelated.jsonl');
            await writeFile(
                unrelated,
                `${sessionMetaLine({
                    id: 'unrelated',
                    timestamp: '2026-02-04T12:00:05.000Z',
                    cwd: '/workspace/dev',
                    originator: 'happier_cli',
                    source: {
                        subagent: {
                            thread_spawn: {
                                parent_thread_id: 'parent',
                                depth: 1,
                            },
                        },
                    },
                })}\n`,
            );

            const beforeOwnRollout = await discoverCodexRolloutFileOnce({
                sessionsRootDir: root,
                startedAtMs,
                cwd: '/workspace/remote-dev',
                scanLimit: 50,
            });
            expect(beforeOwnRollout).toBeNull();

            const own = join(dir, 'rollout-2026-02-04T12-00-06-own.jsonl');
            await writeFile(
                own,
                `${sessionMetaLine({
                    id: 'own',
                    timestamp: '2026-02-04T12:00:06.000Z',
                    cwd: '/workspace/remote-dev/',
                    originator: 'codex-tui',
                    source: 'cli',
                })}\n`,
            );

            const discovered = await discoverCodexRolloutFileOnce({
                sessionsRootDir: root,
                startedAtMs,
                cwd: '/workspace/remote-dev',
                scanLimit: 50,
            });

            expect(discovered?.filePath).toBe(own);
            expect(discovered?.sessionMeta.id).toBe('own');
        } finally {
            await rm(root, { recursive: true, force: true });
        }
    });

    it('rejects a fresh Codex subagent rollout even when it shares the requested cwd', async () => {
        const root = await mkdtemp(join(tmpdir(), 'codex-sessions-subagent-'));
        try {
            const dir = join(root, '2026', '02', '04');
            await mkdir(dir, { recursive: true });

            const filePath = join(dir, 'rollout-2026-02-04T12-00-05-subagent.jsonl');
            await writeFile(
                filePath,
                `${sessionMetaLine({
                    id: 'subagent',
                    timestamp: '2026-02-04T12:00:05.000Z',
                    cwd: '/workspace/remote-dev',
                    originator: 'happier_cli',
                    source: {
                        subagent: {
                            thread_spawn: {
                                parent_thread_id: 'parent',
                                depth: 1,
                            },
                        },
                    },
                })}\n`,
            );

            const discovered = await discoverCodexRolloutFileOnce({
                sessionsRootDir: root,
                startedAtMs: Date.parse('2026-02-04T12:00:05.000Z'),
                cwd: '/workspace/remote-dev',
                scanLimit: 50,
            });

            expect(discovered).toBeNull();
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
            // Ensure the file does not look "active" for the newly-started session.
            const staleMtime = new Date('2026-02-04T11:59:30.000Z');
            await utimes(filePath, staleMtime, staleMtime);

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
            await writeFile(
                filePath,
                `${sessionMetaLine({
                    id: 'huge',
                    timestamp: '2026-02-04T12:00:00.000Z',
                    cwd: '/Users/leeroy/Documents/Development/happier/dev',
                })}\n`,
            );
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

    it('does not claim a fresh rollout from filename and mtime before session_meta establishes ownership', async () => {
        const root = await mkdtemp(join(tmpdir(), 'codex-sessions-no-meta-'));
        try {
            const dir = join(root, '2026', '02', '04');
            await mkdir(dir, { recursive: true });

            const resumeId = '019c17f4-cb9c-7512-b441-80d453fb5a53';
            const filePath = join(dir, `rollout-2026-02-04T00-00-00-${resumeId}.jsonl`);
            await writeFile(filePath, `${JSON.stringify({ type: 'noop', payload: {} })}\n`);

            const startedAtMs = Date.parse('2026-02-04T12:00:05.000Z');
            const mtime = new Date('2026-02-04T12:00:06.000Z');
            await utimes(filePath, mtime, mtime);

            const discovered = await discoverCodexRolloutFileOnce({
                sessionsRootDir: root,
                startedAtMs,
                cwd: '/x',
                scanLimit: 50,
            });

            expect(discovered).toBeNull();
        } finally {
            await rm(root, { recursive: true, force: true });
        }
    });

    it('preserves cwd in the resume-id fast path when session_meta is missing', async () => {
        const root = await mkdtemp(join(tmpdir(), 'codex-sessions-fast-no-meta-'));
        try {
            const dir = join(root, '2026', '02', '04');
            await mkdir(dir, { recursive: true });

            const resumeId = '019c17f4-cb9c-7512-b441-80d453fb5a53';
            const filePath = join(dir, `rollout-2026-02-04T00-00-00-${resumeId}.jsonl`);
            await writeFile(filePath, `${JSON.stringify({ type: 'noop', payload: {} })}\n`);

            const mtime = new Date('2026-02-04T12:00:06.000Z');
            await utimes(filePath, mtime, mtime);

            const discovered = await discoverCodexRolloutFileOnce({
                sessionsRootDir: root,
                startedAtMs: Date.parse('2026-02-04T12:00:05.000Z'),
                cwd: '/x',
                resumeId,
                scanLimit: 50,
            });

            expect(discovered?.filePath).toBe(filePath);
            expect(discovered?.sessionMeta.id).toBe(resumeId);
            expect(discovered?.sessionMeta.cwd).toBe('/x');
        } finally {
            await rm(root, { recursive: true, force: true });
        }
    });
});
