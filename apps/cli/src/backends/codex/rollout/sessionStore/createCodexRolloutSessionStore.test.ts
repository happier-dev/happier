import { appendFile, mkdir, mkdtemp, rm, unlink, writeFile } from 'node:fs/promises';
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
});
