import { appendFile, mkdir, mkdtemp, rm, unlink, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
    createCodexAppServerProcessEnv,
    writeFakeCodexAppServerThreadListScript,
} from '@/backends/codex/appServer/testkit/fakeCodexAppServer';

import { createCodexRolloutSessionStore } from './createCodexRolloutSessionStore';

const tempDirs = new Set<string>();

function rememberTempDir(path: string): string {
    tempDirs.add(path);
    return path;
}

function sessionMetaLine(payload: Record<string, unknown>): string {
    return `${JSON.stringify({ type: 'session_meta', payload })}\n`;
}

function responseItemLine(params: { timestamp: string; payload: Record<string, unknown> }): string {
    return `${JSON.stringify({ type: 'response_item', timestamp: params.timestamp, payload: params.payload })}\n`;
}

afterEach(async () => {
    for (const dir of tempDirs) {
        await rm(dir, { recursive: true, force: true });
    }
    tempDirs.clear();
});

describe('createCodexRolloutSessionStore', () => {
    it('reads older transcript pages and caches the resolved working directory metadata', async () => {
        const root = rememberTempDir(await mkdtemp(join(tmpdir(), 'happier-codex-rollout-store-')));
        const codexHome = join(root, 'codex-home');
        const sessionsDir = join(codexHome, 'sessions');
        await mkdir(sessionsDir, { recursive: true });

        const sessionId = '77777777-7777-7777-7777-777777777777';
        const filePath = join(sessionsDir, `rollout-2026-01-02T00-00-00-${sessionId}.jsonl`);
        await writeFile(
            filePath,
            sessionMetaLine({ id: sessionId, timestamp: '2026-01-02T00:00:00.000Z', cwd: '/repo/store' })
            + responseItemLine({
                timestamp: '2026-01-02T00:00:01.000Z',
                payload: { type: 'message', role: 'assistant', content: [{ type: 'text', text: 'hello' }] },
            }),
            'utf8',
        );

        const store = createCodexRolloutSessionStore({
            key: {
                providerId: 'codex',
                source: { kind: 'codexHome', home: 'user' },
                remoteSessionId: sessionId,
            },
            activeServerDir: join(root, 'servers', 'cloud'),
            env: { CODEX_HOME: codexHome } as NodeJS.ProcessEnv,
        });

        const page = await store.pageOlder({ direction: 'older', maxBytes: 1024 * 1024, maxItems: 10 });
        expect(page.items).toHaveLength(1);
        expect(page.tailCursor).toBeTruthy();
        expect(store.getTailCursor()).toBe(page.tailCursor);

        const cwd = await store.getWorkingDirectory();
        expect(cwd).toBe('/repo/store');

        await unlink(filePath);
        await expect(store.getWorkingDirectory()).resolves.toBe('/repo/store');
    });

    it('falls back to app-server metadata for working directory when rollout files are missing', async () => {
        const root = rememberTempDir(await mkdtemp(join(tmpdir(), 'happier-codex-rollout-store-app-server-')));
        const codexHome = join(root, 'codex-home');
        await mkdir(codexHome, { recursive: true });

        const sessionId = 'remote_store_preview';
        const fakeAppServer = await writeFakeCodexAppServerThreadListScript({
            dir: root,
            initializeName: 'fake',
            nonArchivedThreads: [{
                id: sessionId,
                name: 'Store app server preview',
                updatedAt: 1736000100,
                cwd: '/repo/from-app-server',
            }],
        });

        const store = createCodexRolloutSessionStore({
            key: {
                providerId: 'codex',
                source: { kind: 'codexHome', home: 'user' },
                remoteSessionId: sessionId,
            },
            activeServerDir: join(root, 'servers', 'cloud'),
            env: createCodexAppServerProcessEnv(fakeAppServer, { CODEX_HOME: codexHome }),
        });

        await expect(store.getWorkingDirectory()).resolves.toBe('/repo/from-app-server');
    });

    it('subscribes to appended rollout items via the merged read-after path', async () => {
        const root = rememberTempDir(await mkdtemp(join(tmpdir(), 'happier-codex-rollout-subscribe-')));
        const codexHome = join(root, 'codex-home');
        const sessionsDir = join(codexHome, 'sessions');
        await mkdir(sessionsDir, { recursive: true });

        const sessionId = '88888888-8888-8888-8888-888888888888';
        const filePath = join(sessionsDir, `rollout-2026-01-02T00-00-00-${sessionId}.jsonl`);
        await writeFile(
            filePath,
            sessionMetaLine({ id: sessionId, timestamp: '2026-01-02T00:00:00.000Z', cwd: '/repo/subscribed' })
            + responseItemLine({
                timestamp: '2026-01-02T00:00:01.000Z',
                payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'initial hello' }] },
            }),
            'utf8',
        );

        const store = createCodexRolloutSessionStore({
            key: {
                providerId: 'codex',
                source: { kind: 'codexHome', home: 'user' },
                remoteSessionId: sessionId,
            },
            activeServerDir: join(root, 'servers', 'cloud'),
            env: { CODEX_HOME: codexHome } as NodeJS.ProcessEnv,
        });

        const initialPage = await store.pageOlder({ direction: 'older', maxBytes: 1024 * 1024, maxItems: 10 });
        expect(initialPage.tailCursor).toBeTruthy();

        const events: Array<{ items: readonly unknown[]; nextCursor: string | null; truncated: boolean }> = [];
        const unsubscribe = store.subscribe((event) => {
            events.push(event);
        });

        await appendFile(
            filePath,
            responseItemLine({
                timestamp: '2026-01-02T00:00:02.000Z',
                payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'subscribed hello' }] },
            }),
            'utf8',
        );

        const deadline = Date.now() + 5_000;
        while (events.length === 0 && Date.now() < deadline) {
            await new Promise((resolve) => setTimeout(resolve, 25));
        }

        unsubscribe();

        expect(events).toHaveLength(1);
        expect(events[0]?.items).toHaveLength(1);
        expect(JSON.stringify(events[0]?.items[0] ?? null)).toContain('subscribed hello');
        expect(events[0]?.nextCursor).toBeTruthy();
        expect(events[0]?.truncated).toBe(false);
    });

    it('starts first live subscription from the current tail instead of replaying existing history', async () => {
        const root = rememberTempDir(await mkdtemp(join(tmpdir(), 'happier-codex-rollout-subscribe-tail-only-')));
        const codexHome = join(root, 'codex-home');
        const sessionsDir = join(codexHome, 'sessions');
        await mkdir(sessionsDir, { recursive: true });

        const sessionId = 'tail-only-subscribe-session';
        const filePath = join(sessionsDir, `rollout-2026-01-02T00-00-00-${sessionId}.jsonl`);
        await writeFile(
            filePath,
            sessionMetaLine({ id: sessionId, timestamp: '2026-01-02T00:00:00.000Z', cwd: '/repo/live-tail-only' })
            + responseItemLine({
                timestamp: '2026-01-02T00:00:01.000Z',
                payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'existing history item' }] },
            }),
            'utf8',
        );

        const store = createCodexRolloutSessionStore({
            key: {
                providerId: 'codex',
                source: { kind: 'codexHome', home: 'user' },
                remoteSessionId: sessionId,
            },
            activeServerDir: join(root, 'servers', 'cloud'),
            env: { CODEX_HOME: codexHome } as NodeJS.ProcessEnv,
        });

        const events: Array<{ items: readonly unknown[]; nextCursor: string | null; truncated: boolean }> = [];
        const unsubscribe = store.subscribe((event) => {
            events.push(event);
        });

        await new Promise((resolve) => setTimeout(resolve, 300));
        expect(events).toHaveLength(0);

        await appendFile(
            filePath,
            responseItemLine({
                timestamp: '2026-01-02T00:00:02.000Z',
                payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'live tail item' }] },
            }),
            'utf8',
        );

        const deadline = Date.now() + 5_000;
        while (events.length === 0 && Date.now() < deadline) {
            await new Promise((resolve) => setTimeout(resolve, 25));
        }

        unsubscribe();

        expect(events).toHaveLength(1);
        expect(events[0]?.items).toHaveLength(1);
        expect(JSON.stringify(events[0]?.items[0] ?? null)).toContain('live tail item');
        expect(JSON.stringify(events[0]?.items[0] ?? null)).not.toContain('existing history item');
        expect(events[0]?.nextCursor).toBeTruthy();
        expect(events[0]?.truncated).toBe(false);
    });

    it('delivers a full appended live backlog without dropping items', async () => {
        const root = rememberTempDir(await mkdtemp(join(tmpdir(), 'happier-codex-rollout-subscribe-truncated-drain-')));
        const codexHome = join(root, 'codex-home');
        const sessionsDir = join(codexHome, 'sessions');
        await mkdir(sessionsDir, { recursive: true });

        const sessionId = 'truncated-live-drain-session';
        const filePath = join(sessionsDir, `rollout-2026-01-02T00-00-00-${sessionId}.jsonl`);
        await writeFile(
            filePath,
            sessionMetaLine({ id: sessionId, timestamp: '2026-01-02T00:00:00.000Z', cwd: '/repo/live-drain' }),
            'utf8',
        );

        const store = createCodexRolloutSessionStore({
            key: {
                providerId: 'codex',
                source: { kind: 'codexHome', home: 'user' },
                remoteSessionId: sessionId,
            },
            activeServerDir: join(root, 'servers', 'cloud'),
            env: { CODEX_HOME: codexHome } as NodeJS.ProcessEnv,
        });

        const events: Array<{ items: readonly unknown[]; nextCursor: string | null; truncated: boolean }> = [];
        const unsubscribe = store.subscribe((event) => {
            events.push(event);
        });

        await new Promise((resolve) => setTimeout(resolve, 300));
        expect(events).toHaveLength(0);

        const appendedLines = Array.from({ length: 101 }, (_, index) =>
            responseItemLine({
                timestamp: `2026-01-02T00:00:${String(index).padStart(2, '0')}.000Z`,
                payload: {
                    type: 'message',
                    role: 'assistant',
                    content: [{ type: 'output_text', text: `live backlog item ${index + 1}` }],
                },
            }),
        ).join('');
        await appendFile(filePath, appendedLines, 'utf8');

        const deadline = Date.now() + 5_000;
        while (events.flatMap((event) => event.items).length < 101 && Date.now() < deadline) {
            await new Promise((resolve) => setTimeout(resolve, 25));
        }

        unsubscribe();

        const totalItems = events.flatMap((event) => event.items);
        expect(events.length).toBeGreaterThanOrEqual(1);
        expect(totalItems).toHaveLength(101);
        expect(events.at(-1)?.truncated).toBe(false);
        expect(JSON.stringify(totalItems)).toContain('live backlog item 1');
        expect(JSON.stringify(totalItems)).toContain('live backlog item 101');
    });

    it('uses one authoritative connected-service home for paging, metadata, and live follow', async () => {
        const root = rememberTempDir(await mkdtemp(join(tmpdir(), 'happier-codex-rollout-store-multi-home-')));
        const activeServerDir = join(root, 'servers', 'cloud');
        const homesRoot = join(activeServerDir, 'daemon', 'connected-services', 'homes', 'svc_1');
        const olderHome = join(homesRoot, 'profile-a', 'codex', 'codex-home');
        const newerHome = join(homesRoot, 'profile-b', 'codex', 'codex-home');
        const olderSessionsDir = join(olderHome, 'sessions');
        const newerSessionsDir = join(newerHome, 'sessions');
        await mkdir(olderSessionsDir, { recursive: true });
        await mkdir(newerSessionsDir, { recursive: true });

        const sessionId = 'multi-home-authoritative-session';
        const olderFilePath = join(olderSessionsDir, `rollout-2026-01-01T00-00-00-${sessionId}.jsonl`);
        const newerFilePath = join(newerSessionsDir, `rollout-2026-01-02T00-00-00-${sessionId}.jsonl`);
        await writeFile(
            olderFilePath,
            sessionMetaLine({ id: sessionId, timestamp: '2026-01-01T00:00:00.000Z', cwd: '/repo/older-home' })
            + responseItemLine({
                timestamp: '2026-01-01T00:00:01.000Z',
                payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Older home title' }] },
            }),
            'utf8',
        );
        await writeFile(
            newerFilePath,
            sessionMetaLine({ id: sessionId, timestamp: '2026-01-02T00:00:00.000Z', cwd: '/repo/newer-home' })
            + responseItemLine({
                timestamp: '2026-01-02T00:00:01.000Z',
                payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Newer home title' }] },
            })
            + responseItemLine({
                timestamp: '2026-01-02T00:00:02.000Z',
                payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'newer home initial message' }] },
            }),
            'utf8',
        );
        await utimes(olderFilePath, new Date('2026-01-01T00:00:02.000Z'), new Date('2026-01-01T00:00:02.000Z'));
        await utimes(newerFilePath, new Date('2026-01-02T00:00:02.000Z'), new Date('2026-01-02T00:00:02.000Z'));

        const store = createCodexRolloutSessionStore({
            key: {
                providerId: 'codex',
                source: { kind: 'codexHome', home: 'connectedService', connectedServiceId: 'svc_1' },
                remoteSessionId: sessionId,
            },
            activeServerDir,
            env: {} as NodeJS.ProcessEnv,
        });

        const page = await store.pageOlder({ direction: 'older', maxBytes: 1024 * 1024, maxItems: 10 });
        expect(JSON.stringify(page.items)).toContain('newer home initial message');

        await expect(store.getTitle()).resolves.toBe('Newer home title');
        await expect(store.getWorkingDirectory()).resolves.toBe('/repo/newer-home');

        const events: Array<{ items: readonly unknown[]; nextCursor: string | null; truncated: boolean }> = [];
        const unsubscribe = store.subscribe((event) => {
            events.push(event);
        });

        await appendFile(
            newerFilePath,
            responseItemLine({
                timestamp: '2026-01-02T00:00:03.000Z',
                payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'newer home live follow message' }] },
            }),
            'utf8',
        );

        const deadline = Date.now() + 5_000;
        while (events.length === 0 && Date.now() < deadline) {
            await new Promise((resolve) => setTimeout(resolve, 25));
        }

        unsubscribe();

        expect(events).toHaveLength(1);
        expect(JSON.stringify(events[0]?.items ?? [])).toContain('newer home live follow message');
    });

    it('follows already-known sidechain rollouts when live follow starts after paging history', async () => {
        const root = rememberTempDir(await mkdtemp(join(tmpdir(), 'happier-codex-rollout-known-sidechain-follow-')));
        const codexHome = join(root, 'codex-home');
        const sessionsDir = join(codexHome, 'sessions');
        await mkdir(sessionsDir, { recursive: true });

        const sessionId = '31313131-3131-3131-3131-313131313131';
        const childThreadId = '41414141-4141-4141-4141-414141414141';
        const parentFilePath = join(sessionsDir, `rollout-2026-01-02T00-00-00-${sessionId}.jsonl`);
        const childFilePath = join(sessionsDir, `rollout-2026-01-02T00-00-01-${childThreadId}.jsonl`);
        await writeFile(
            parentFilePath,
            sessionMetaLine({ id: sessionId, timestamp: '2026-01-02T00:00:00.000Z', cwd: '/repo/known-sidechain' })
            + `${JSON.stringify({
                type: 'event_msg',
                timestamp: '2026-01-02T00:00:01.000Z',
                payload: {
                    type: 'collab_agent_spawn_end',
                    sender_thread_id: sessionId,
                    new_thread_id: childThreadId,
                    new_agent_nickname: 'Lovelace',
                    new_agent_role: 'explorer',
                    prompt: 'inspect the repo',
                },
            })}\n`,
            'utf8',
        );
        await writeFile(
            childFilePath,
            responseItemLine({
                timestamp: '2026-01-02T00:00:02.000Z',
                payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'known child history' }] },
            }),
            'utf8',
        );

        const store = createCodexRolloutSessionStore({
            key: {
                providerId: 'codex',
                source: { kind: 'codexHome', home: 'user' },
                remoteSessionId: sessionId,
            },
            activeServerDir: join(root, 'servers', 'cloud'),
            env: { CODEX_HOME: codexHome } as NodeJS.ProcessEnv,
        });

        const initialPage = await store.pageOlder({ direction: 'older', maxBytes: 1024 * 1024, maxItems: 20 });
        expect(JSON.stringify(initialPage.items)).toContain('known child history');
        expect(initialPage.tailCursor).toBeTruthy();

        const events: Array<{ items: readonly unknown[]; nextCursor: string | null; truncated: boolean }> = [];
        const unsubscribe = store.subscribe((event) => {
            events.push(event);
        });

        await new Promise((resolve) => setTimeout(resolve, 300));
        expect(events).toHaveLength(0);

        await appendFile(
            childFilePath,
            responseItemLine({
                timestamp: '2026-01-02T00:00:03.000Z',
                payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'known child live follow' }] },
            }),
            'utf8',
        );

        const deadline = Date.now() + 5_000;
        while (events.length === 0 && Date.now() < deadline) {
            await new Promise((resolve) => setTimeout(resolve, 25));
        }

        unsubscribe();

        expect(events).toHaveLength(1);
        expect(JSON.stringify(events[0]?.items ?? [])).toContain('known child live follow');
    });

    it('refreshes cached metadata when a rollout appears after app-server fallback warmed the store', async () => {
        const root = rememberTempDir(await mkdtemp(join(tmpdir(), 'happier-codex-rollout-store-refresh-')));
        const codexHome = join(root, 'codex-home');
        const sessionsDir = join(codexHome, 'sessions');
        await mkdir(sessionsDir, { recursive: true });

        const sessionId = 'app-server-then-rollout-store';
        const fakeAppServer = await writeFakeCodexAppServerThreadListScript({
            dir: root,
            initializeName: 'fake',
            nonArchivedThreads: [{
                id: sessionId,
                name: 'App server warm title',
                updatedAt: 1736000100,
                cwd: '/repo/from-app-server',
            }],
        });

        const env = createCodexAppServerProcessEnv(fakeAppServer, { CODEX_HOME: codexHome });
        const store = createCodexRolloutSessionStore({
            key: {
                providerId: 'codex',
                source: { kind: 'codexHome', home: 'user' },
                remoteSessionId: sessionId,
            },
            activeServerDir: join(root, 'servers', 'cloud'),
            env,
        });

        await expect(store.getTitle()).resolves.toBeNull();
        await expect(store.getWorkingDirectory()).resolves.toBe('/repo/from-app-server');
        await expect(store.getActivity()).resolves.toEqual({ lastActivityAtMs: 1_736_000_100_000 });

        const rolloutFilePath = join(sessionsDir, `rollout-2026-01-03T00-00-00-${sessionId}.jsonl`);
        await writeFile(
            rolloutFilePath,
            sessionMetaLine({ id: sessionId, timestamp: '2026-01-03T00:00:00.000Z', cwd: '/repo/from-rollout' })
            + responseItemLine({
                timestamp: '2026-01-03T00:00:01.000Z',
                payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Rollout authoritative title' }] },
            }),
            'utf8',
        );
        await utimes(rolloutFilePath, new Date('2026-01-03T00:00:02.000Z'), new Date('2026-01-03T00:00:02.000Z'));

        const page = await store.pageOlder({ direction: 'older', maxBytes: 1024 * 1024, maxItems: 10 });
        expect(JSON.stringify(page.items)).toContain('Rollout authoritative title');

        await expect(store.getTitle()).resolves.toBe('Rollout authoritative title');
        await expect(store.getWorkingDirectory()).resolves.toBe('/repo/from-rollout');
        await expect(store.getActivity()).resolves.toEqual({ lastActivityAtMs: Date.parse('2026-01-03T00:00:02.000Z') });
    });

    it('replays transcript pages from a flat CODEX_HOME sessions rollout whose filename omits the session id', async () => {
        const root = rememberTempDir(await mkdtemp(join(tmpdir(), 'happier-codex-rollout-flat-store-')));
        const codexHome = join(root, 'codex-home');
        const sessionsDir = join(codexHome, 'sessions');
        await mkdir(sessionsDir, { recursive: true });

        const sessionId = 'flat-session-meta-store';
        const filePath = join(sessionsDir, 'rollout-test.jsonl');
        await writeFile(
            filePath,
            sessionMetaLine({ id: sessionId, timestamp: '2026-01-02T00:00:00.000Z', cwd: '/repo/flat-store' })
            + responseItemLine({
                timestamp: '2026-01-02T00:00:01.000Z',
                payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'hello from flat store' }] },
            }),
            'utf8',
        );

        const store = createCodexRolloutSessionStore({
            key: {
                providerId: 'codex',
                source: {
                    kind: 'codexHome',
                    home: 'user',
                    homePath: codexHome,
                },
                remoteSessionId: sessionId,
            },
            activeServerDir: join(root, 'servers', 'cloud'),
            env: { CODEX_HOME: codexHome } as NodeJS.ProcessEnv,
        });

        const page = await store.pageOlder({ direction: 'older', maxBytes: 1024 * 1024, maxItems: 10 });

        expect(page.items).toHaveLength(1);
        expect(JSON.stringify(page.items[0] ?? null)).toContain('hello from flat store');
        expect(page.tailCursor).toBeTruthy();
    });

    it('replays transcript pages from a flat CODEX_HOME sessions rollout for UUID-shaped session ids', async () => {
        const root = rememberTempDir(await mkdtemp(join(tmpdir(), 'happier-codex-rollout-flat-uuid-store-')));
        const codexHome = join(root, 'codex-home');
        const sessionsDir = join(codexHome, 'sessions');
        await mkdir(sessionsDir, { recursive: true });

        const sessionId = '123e4567-e89b-12d3-a456-426614174000';
        const filePath = join(sessionsDir, 'rollout-test.jsonl');
        await writeFile(
            filePath,
            sessionMetaLine({ id: sessionId, timestamp: '2026-01-02T00:00:00.000Z', cwd: '/repo/flat-uuid-store' })
            + responseItemLine({
                timestamp: '2026-01-02T00:00:01.000Z',
                payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'hello from flat uuid store' }] },
            }),
            'utf8',
        );

        const store = createCodexRolloutSessionStore({
            key: {
                providerId: 'codex',
                source: {
                    kind: 'codexHome',
                    home: 'user',
                    homePath: codexHome,
                },
                remoteSessionId: sessionId,
            },
            activeServerDir: join(root, 'servers', 'cloud'),
            env: { CODEX_HOME: codexHome } as NodeJS.ProcessEnv,
        });

        const page = await store.pageOlder({ direction: 'older', maxBytes: 1024 * 1024, maxItems: 10 });

        expect(page.items).toHaveLength(1);
        expect(JSON.stringify(page.items[0] ?? null)).toContain('hello from flat uuid store');
        expect(page.tailCursor).toBeTruthy();
    });

    it('delivers a flat-rollout assistant item whose response_item line omits the top-level timestamp', async () => {
        const root = rememberTempDir(await mkdtemp(join(tmpdir(), 'happier-codex-rollout-flat-no-timestamp-')));
        const codexHome = join(root, 'codex-home');
        const sessionsDir = join(codexHome, 'sessions');
        await mkdir(sessionsDir, { recursive: true });

        const sessionId = 'flat-session-meta-no-timestamp';
        const filePath = join(sessionsDir, 'rollout-test.jsonl');
        await writeFile(
            filePath,
            sessionMetaLine({ id: sessionId, timestamp: '2026-01-02T00:00:00.000Z', cwd: '/repo/flat-no-timestamp' }),
            'utf8',
        );

        const store = createCodexRolloutSessionStore({
            key: {
                providerId: 'codex',
                source: {
                    kind: 'codexHome',
                    home: 'user',
                    homePath: codexHome,
                },
                remoteSessionId: sessionId,
            },
            activeServerDir: join(root, 'servers', 'cloud'),
            env: { CODEX_HOME: codexHome } as NodeJS.ProcessEnv,
        });

        const initialPage = await store.pageOlder({ direction: 'older', maxBytes: 1024 * 1024, maxItems: 10 });
        expect(initialPage.items).toHaveLength(0);

        const events: Array<{ items: readonly unknown[]; nextCursor: string | null; truncated: boolean }> = [];
        const unsubscribe = store.subscribe((event) => {
            events.push(event);
        });

        await appendFile(
            filePath,
            `${JSON.stringify({
                type: 'response_item',
                payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'flat append without timestamp' }] },
            })}\n`,
            'utf8',
        );

        const deadline = Date.now() + 5_000;
        while (events.length === 0 && Date.now() < deadline) {
            await new Promise((resolve) => setTimeout(resolve, 25));
        }

        unsubscribe();

        expect(events).toHaveLength(1);
        expect(events[0]?.items).toHaveLength(1);
        expect(JSON.stringify(events[0]?.items[0] ?? null)).toContain('flat append without timestamp');
        expect(events[0]?.nextCursor).toBeTruthy();
        expect(events[0]?.truncated).toBe(false);
    });

    it('delivers a flat-rollout assistant item appended after the last paged snapshot but before subscribe startup finishes', async () => {
        const root = rememberTempDir(await mkdtemp(join(tmpdir(), 'happier-codex-rollout-flat-pre-subscribe-')));
        const codexHome = join(root, 'codex-home');
        const sessionsDir = join(codexHome, 'sessions');
        await mkdir(sessionsDir, { recursive: true });

        const sessionId = 'flat-session-meta-pre-subscribe';
        const filePath = join(sessionsDir, 'rollout-test.jsonl');
        await writeFile(
            filePath,
            sessionMetaLine({ id: sessionId, timestamp: '2026-01-02T00:00:00.000Z', cwd: '/repo/flat-pre-subscribe' }),
            'utf8',
        );

        const store = createCodexRolloutSessionStore({
            key: {
                providerId: 'codex',
                source: {
                    kind: 'codexHome',
                    home: 'user',
                    homePath: codexHome,
                },
                remoteSessionId: sessionId,
            },
            activeServerDir: join(root, 'servers', 'cloud'),
            env: { CODEX_HOME: codexHome } as NodeJS.ProcessEnv,
        });

        const initialPage = await store.pageOlder({ direction: 'older', maxBytes: 1024 * 1024, maxItems: 10 });
        expect(initialPage.items).toHaveLength(0);

        await appendFile(
            filePath,
            `${JSON.stringify({
                type: 'response_item',
                payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'flat append before subscribe startup' }] },
            })}\n`,
            'utf8',
        );

        const events: Array<{ items: readonly unknown[]; nextCursor: string | null; truncated: boolean }> = [];
        const unsubscribe = store.subscribe((event) => {
            events.push(event);
        });

        const deadline = Date.now() + 5_000;
        while (events.length === 0 && Date.now() < deadline) {
            await new Promise((resolve) => setTimeout(resolve, 25));
        }

        unsubscribe();

        expect(events).toHaveLength(1);
        expect(events[0]?.items).toHaveLength(1);
        expect(JSON.stringify(events[0]?.items[0] ?? null)).toContain('flat append before subscribe startup');
        expect(events[0]?.nextCursor).toBeTruthy();
        expect(events[0]?.truncated).toBe(false);
    });

    it('delivers the first appended flat-rollout transcript item even when it lands during subscription startup', async () => {
        const root = rememberTempDir(await mkdtemp(join(tmpdir(), 'happier-codex-rollout-flat-subscribe-race-')));
        const codexHome = join(root, 'codex-home');
        const sessionsDir = join(codexHome, 'sessions');
        await mkdir(sessionsDir, { recursive: true });

        const sessionId = 'flat-session-meta-subscribe-race';
        const filePath = join(sessionsDir, 'rollout-test.jsonl');
        await writeFile(
            filePath,
            sessionMetaLine({ id: sessionId, timestamp: '2026-01-02T00:00:00.000Z', cwd: '/repo/flat-race' }),
            'utf8',
        );

        const store = createCodexRolloutSessionStore({
            key: {
                providerId: 'codex',
                source: {
                    kind: 'codexHome',
                    home: 'user',
                    homePath: codexHome,
                },
                remoteSessionId: sessionId,
            },
            activeServerDir: join(root, 'servers', 'cloud'),
            env: { CODEX_HOME: codexHome } as NodeJS.ProcessEnv,
        });

        const initialPage = await store.pageOlder({ direction: 'older', maxBytes: 1024 * 1024, maxItems: 10 });
        expect(initialPage.items).toHaveLength(0);

        const events: Array<{ items: readonly unknown[]; nextCursor: string | null; truncated: boolean }> = [];
        const unsubscribe = store.subscribe((event) => {
            events.push(event);
        });

        await appendFile(
            filePath,
            responseItemLine({
                timestamp: '2026-01-02T00:00:02.000Z',
                payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'first flat append' }] },
            }),
            'utf8',
        );

        const deadline = Date.now() + 5_000;
        while (events.length === 0 && Date.now() < deadline) {
            await new Promise((resolve) => setTimeout(resolve, 25));
        }

        unsubscribe();

        expect(events).toHaveLength(1);
        expect(events[0]?.items).toHaveLength(1);
        expect(JSON.stringify(events[0]?.items[0] ?? null)).toContain('first flat append');
        expect(events[0]?.nextCursor).toBeTruthy();
        expect(events[0]?.truncated).toBe(false);
    });

    it('keeps following appended rollout items while the lifecycle is hot_attached even without listeners', async () => {
        const root = rememberTempDir(await mkdtemp(join(tmpdir(), 'happier-codex-rollout-hot-attached-')));
        const codexHome = join(root, 'codex-home');
        const sessionsDir = join(codexHome, 'sessions');
        await mkdir(sessionsDir, { recursive: true });

        const sessionId = '99999999-9999-9999-9999-999999999999';
        const filePath = join(sessionsDir, `rollout-2026-01-02T00-00-00-${sessionId}.jsonl`);
        await writeFile(
            filePath,
            sessionMetaLine({ id: sessionId, timestamp: '2026-01-02T00:00:00.000Z', cwd: '/repo/hot' })
            + responseItemLine({
                timestamp: '2026-01-02T00:00:01.000Z',
                payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'initial hello' }] },
            }),
            'utf8',
        );

        const store = createCodexRolloutSessionStore({
            key: {
                providerId: 'codex',
                source: { kind: 'codexHome', home: 'user' },
                remoteSessionId: sessionId,
            },
            activeServerDir: join(root, 'servers', 'cloud'),
            env: { CODEX_HOME: codexHome } as NodeJS.ProcessEnv,
        });

        const initial = await store.pageOlder({ direction: 'older', maxBytes: 1024 * 1024, maxItems: 10 });
        expect(initial.tailCursor).toBeTruthy();

        await store.setLifecycleState('hot_attached');

        await appendFile(
            filePath,
            responseItemLine({
                timestamp: '2026-01-02T00:00:02.000Z',
                payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'lifecycle hello' }] },
            }),
            'utf8',
        );

        const initialTailCursor = store.getTailCursor();
        const deadline = Date.now() + 5_000;
        while (store.getTailCursor() === initialTailCursor && Date.now() < deadline) {
            await new Promise((resolve) => setTimeout(resolve, 25));
        }

        expect(store.getTailCursor()).not.toBe(initialTailCursor);
    });

    it('does not keep following appended rollout items after the last listener unsubscribes during startup', async () => {
        const root = rememberTempDir(await mkdtemp(join(tmpdir(), 'happier-codex-rollout-unsubscribe-startup-')));
        const codexHome = join(root, 'codex-home');
        const sessionsDir = join(codexHome, 'sessions');
        await mkdir(sessionsDir, { recursive: true });

        const sessionId = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
        const filePath = join(sessionsDir, `rollout-2026-01-02T00-00-00-${sessionId}.jsonl`);
        await writeFile(
            filePath,
            sessionMetaLine({ id: sessionId, timestamp: '2026-01-02T00:00:00.000Z', cwd: '/repo/detached' })
            + responseItemLine({
                timestamp: '2026-01-02T00:00:01.000Z',
                payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'initial detached hello' }] },
            }),
            'utf8',
        );

        const store = createCodexRolloutSessionStore({
            key: {
                providerId: 'codex',
                source: { kind: 'codexHome', home: 'user' },
                remoteSessionId: sessionId,
            },
            activeServerDir: join(root, 'servers', 'cloud'),
            env: { CODEX_HOME: codexHome } as NodeJS.ProcessEnv,
        });

        const initialPage = await store.pageOlder({ direction: 'older', maxBytes: 1024 * 1024, maxItems: 10 });
        expect(initialPage.tailCursor).toBeTruthy();

        const unsubscribe = store.subscribe(() => {
            throw new Error('detached Codex store should not emit after immediate unsubscribe');
        });
        unsubscribe();

        await new Promise((resolve) => setTimeout(resolve, 100));

        const initialTailCursor = store.getTailCursor();
        await appendFile(
            filePath,
            responseItemLine({
                timestamp: '2026-01-02T00:00:02.000Z',
                payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'detached append' }] },
            }),
            'utf8',
        );

        await new Promise((resolve) => setTimeout(resolve, 400));

        expect(store.getTailCursor()).toBe(initialTailCursor);
    });
});
