import { appendFile, mkdtemp, readFile, realpath, rm, symlink, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { createPluginDisposableRegistry } from '@/plugins/runtime/lifecycle/disposables';

import { createPluginTranscriptFileFollowService } from './fileFollow';
import { createTranscriptFileFollowPathGrantRegistry } from './fileFollowGrants';

async function createTempRoot(prefix: string): Promise<string> {
    return await mkdtemp(join(tmpdir(), prefix));
}

async function waitForTimerTick(ms: number): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, ms));
}

describe('createPluginTranscriptFileFollowService', () => {
    it('fails closed for ungranted transcript paths', async () => {
        const root = await createTempRoot('happier-plugin-file-follow-denied-');
        const filePath = join(root, 'session.jsonl');
        await writeFile(filePath, '{"ok":true}\n', 'utf8');
        const service = createPluginTranscriptFileFollowService();

        try {
            await expect(service.follow({
                path: filePath,
                startAt: 'beginning',
                onLine: () => undefined,
            })).rejects.toMatchObject({ code: 'PLUGIN_TRANSCRIPTS_FILE_FOLLOW_PATH_DENIED' });
        } finally {
            await rm(root, { recursive: true, force: true });
        }
    });

    it('denies symlink escapes from granted transcript roots', async () => {
        const root = await createTempRoot('happier-plugin-file-follow-root-');
        const outsideRoot = await createTempRoot('happier-plugin-file-follow-outside-');
        const outsidePath = join(outsideRoot, 'outside.jsonl');
        const linkedPath = join(root, 'linked.jsonl');
        await writeFile(outsidePath, '{"outside":true}\n', 'utf8');
        await symlink(outsidePath, linkedPath);
        const service = createPluginTranscriptFileFollowService({ allowedPathRoots: [root] });

        try {
            await expect(service.follow({
                path: linkedPath,
                startAt: 'beginning',
                onLine: () => undefined,
            })).rejects.toMatchObject({ code: 'PLUGIN_TRANSCRIPTS_FILE_FOLLOW_PATH_DENIED' });
        } finally {
            await rm(root, { recursive: true, force: true });
            await rm(outsideRoot, { recursive: true, force: true });
        }
    });

    it('follows an exact dynamically granted transcript path', async () => {
        const root = await createTempRoot('happier-plugin-file-follow-dynamic-');
        const filePath = join(root, 'session.jsonl');
        await writeFile(filePath, '{"granted":true}\n', 'utf8');
        const registry = createTranscriptFileFollowPathGrantRegistry();
        await registry.grant({
            pluginId: 'acme.transcript',
            runtimeId: 'runtime-1',
            sessionId: 'session-1',
            path: filePath,
            reason: 'testFixture',
            evidence: { kind: 'testOnly' },
        });
        const received: string[] = [];
        const service = createPluginTranscriptFileFollowService({
            pluginId: 'acme.transcript',
            runtimeId: 'runtime-1',
            readSessionId: () => 'session-1',
            fileFollowPathGrants: registry,
            watchFile: () => () => undefined,
            policy: {
                activeBurstPollIntervalMs: 60_000,
                activeFallbackPollIntervalMs: 60_000,
                idleFallbackPollIntervalMs: 60_000,
            },
        });

        try {
            const handle = await service.follow({
                path: filePath,
                startAt: 'beginning',
                onLine: (line) => {
                    received.push(line.line);
                },
            });
            await handle.close();

            expect(received).toEqual(['{"granted":true}']);
        } finally {
            await rm(root, { recursive: true, force: true });
        }
    });

    it('rejects dynamic grants for sibling traversal and symlink escapes', async () => {
        const root = await createTempRoot('happier-plugin-file-follow-dynamic-boundary-');
        const outsideRoot = await createTempRoot('happier-plugin-file-follow-dynamic-outside-');
        const grantedPath = join(root, 'session.jsonl');
        const siblingPath = join(root, 'sibling.jsonl');
        const traversalPath = join(root, 'nested', '..', 'sibling.jsonl');
        const outsidePath = join(outsideRoot, 'outside.jsonl');
        const linkedPath = join(root, 'linked.jsonl');
        await writeFile(grantedPath, '{"granted":true}\n', 'utf8');
        await writeFile(siblingPath, '{"sibling":true}\n', 'utf8');
        await writeFile(outsidePath, '{"outside":true}\n', 'utf8');
        await symlink(outsidePath, linkedPath);
        const registry = createTranscriptFileFollowPathGrantRegistry();
        await registry.grant({
            pluginId: 'acme.transcript',
            runtimeId: 'runtime-1',
            sessionId: 'session-1',
            path: grantedPath,
            reason: 'testFixture',
            evidence: { kind: 'testOnly' },
        });
        const service = createPluginTranscriptFileFollowService({
            pluginId: 'acme.transcript',
            runtimeId: 'runtime-1',
            readSessionId: () => 'session-1',
            fileFollowPathGrants: registry,
        });

        try {
            await expect(service.follow({
                path: siblingPath,
                startAt: 'beginning',
                onLine: () => undefined,
            })).rejects.toMatchObject({ code: 'PLUGIN_TRANSCRIPTS_FILE_FOLLOW_PATH_DENIED' });
            await expect(service.follow({
                path: traversalPath,
                startAt: 'beginning',
                onLine: () => undefined,
            })).rejects.toMatchObject({ code: 'PLUGIN_TRANSCRIPTS_FILE_FOLLOW_PATH_DENIED' });
            await expect(service.follow({
                path: linkedPath,
                startAt: 'beginning',
                onLine: () => undefined,
            })).rejects.toMatchObject({ code: 'PLUGIN_TRANSCRIPTS_FILE_FOLLOW_PATH_DENIED' });
        } finally {
            await rm(root, { recursive: true, force: true });
            await rm(outsideRoot, { recursive: true, force: true });
        }
    });

    it('scopes dynamic grants by plugin runtime session and revocation', async () => {
        const root = await createTempRoot('happier-plugin-file-follow-dynamic-scope-');
        const filePath = join(root, 'session.jsonl');
        await writeFile(filePath, '{"scoped":true}\n', 'utf8');
        const registry = createTranscriptFileFollowPathGrantRegistry();
        const grant = await registry.grant({
            pluginId: 'acme.transcript',
            runtimeId: 'runtime-1',
            sessionId: 'session-1',
            path: filePath,
            reason: 'testFixture',
            evidence: { kind: 'testOnly' },
        });
        const createService = (pluginId: string, runtimeId: string, sessionId: string) => createPluginTranscriptFileFollowService({
            pluginId,
            runtimeId,
            readSessionId: () => sessionId,
            fileFollowPathGrants: registry,
            watchFile: () => () => undefined,
            policy: {
                activeBurstPollIntervalMs: 60_000,
                activeFallbackPollIntervalMs: 60_000,
                idleFallbackPollIntervalMs: 60_000,
            },
        });

        try {
            await expect(createService('other.plugin', 'runtime-1', 'session-1').follow({
                path: filePath,
                startAt: 'beginning',
                onLine: () => undefined,
            })).rejects.toMatchObject({ code: 'PLUGIN_TRANSCRIPTS_FILE_FOLLOW_PATH_DENIED' });
            await expect(createService('acme.transcript', 'runtime-2', 'session-1').follow({
                path: filePath,
                startAt: 'beginning',
                onLine: () => undefined,
            })).rejects.toMatchObject({ code: 'PLUGIN_TRANSCRIPTS_FILE_FOLLOW_PATH_DENIED' });
            await expect(createService('acme.transcript', 'runtime-1', 'session-2').follow({
                path: filePath,
                startAt: 'beginning',
                onLine: () => undefined,
            })).rejects.toMatchObject({ code: 'PLUGIN_TRANSCRIPTS_FILE_FOLLOW_PATH_DENIED' });

            const handle = await createService('acme.transcript', 'runtime-1', 'session-1').follow({
                path: filePath,
                startAt: 'beginning',
                onLine: () => undefined,
            });
            await handle.close();
            await grant.revoke();

            await expect(createService('acme.transcript', 'runtime-1', 'session-1').follow({
                path: filePath,
                startAt: 'beginning',
                onLine: () => undefined,
            })).rejects.toMatchObject({ code: 'PLUGIN_TRANSCRIPTS_FILE_FOLLOW_PATH_DENIED' });

            await registry.grant({
                pluginId: 'acme.transcript',
                runtimeId: 'runtime-1',
                sessionId: 'session-1',
                path: filePath,
                reason: 'testFixture',
                evidence: { kind: 'testOnly' },
            });
            await registry.revokeScope({ pluginId: 'acme.transcript', runtimeId: 'runtime-1' });
            await expect(createService('acme.transcript', 'runtime-1', 'session-1').follow({
                path: filePath,
                startAt: 'beginning',
                onLine: () => undefined,
            })).rejects.toMatchObject({ code: 'PLUGIN_TRANSCRIPTS_FILE_FOLLOW_PATH_DENIED' });
        } finally {
            await rm(root, { recursive: true, force: true });
        }
    });

    it('denies expired dynamic grants fail closed', async () => {
        const root = await createTempRoot('happier-plugin-file-follow-dynamic-expired-');
        const filePath = join(root, 'session.jsonl');
        await writeFile(filePath, '{"expired":true}\n', 'utf8');
        const registry = createTranscriptFileFollowPathGrantRegistry();
        await registry.grant({
            pluginId: 'acme.transcript',
            runtimeId: 'runtime-1',
            sessionId: 'session-1',
            path: filePath,
            reason: 'testFixture',
            evidence: { kind: 'testOnly' },
            expiresAtMs: Date.now() - 1,
        });
        const service = createPluginTranscriptFileFollowService({
            pluginId: 'acme.transcript',
            runtimeId: 'runtime-1',
            readSessionId: () => 'session-1',
            fileFollowPathGrants: registry,
        });

        try {
            await expect(service.follow({
                path: filePath,
                startAt: 'beginning',
                onLine: () => undefined,
            })).rejects.toMatchObject({ code: 'PLUGIN_TRANSCRIPTS_FILE_FOLLOW_PATH_DENIED' });
        } finally {
            await rm(root, { recursive: true, force: true });
        }
    });

    it('continues following the authorized real path after a granted symlink is swapped', async () => {
        const root = await createTempRoot('happier-plugin-file-follow-dynamic-symlink-');
        const outsideRoot = await createTempRoot('happier-plugin-file-follow-dynamic-symlink-outside-');
        const grantedPath = join(root, 'session.jsonl');
        const outsidePath = join(outsideRoot, 'outside.jsonl');
        const linkedPath = join(root, 'current.jsonl');
        await writeFile(grantedPath, '{"safe":1}\n', 'utf8');
        await writeFile(outsidePath, '{"outside":1}\n', 'utf8');
        await symlink(grantedPath, linkedPath);
        const registry = createTranscriptFileFollowPathGrantRegistry();
        await registry.grant({
            pluginId: 'acme.transcript',
            runtimeId: 'runtime-1',
            sessionId: 'session-1',
            path: linkedPath,
            reason: 'testFixture',
            evidence: { kind: 'testOnly' },
        });
        const received: string[] = [];
        const service = createPluginTranscriptFileFollowService({
            pluginId: 'acme.transcript',
            runtimeId: 'runtime-1',
            readSessionId: () => 'session-1',
            fileFollowPathGrants: registry,
            watchFile: () => () => undefined,
            policy: {
                activeBurstPollIntervalMs: 60_000,
                activeFallbackPollIntervalMs: 60_000,
                idleFallbackPollIntervalMs: 60_000,
            },
        });

        try {
            const handle = await service.follow({
                path: linkedPath,
                startAt: 'end',
                onLine: (line) => {
                    received.push(`${line.sourcePath}:${line.line}`);
                },
            });
            await unlink(linkedPath);
            await symlink(outsidePath, linkedPath);
            await appendFile(outsidePath, '{"outside":2}\n', 'utf8');
            await handle.drainNow();
            await appendFile(grantedPath, '{"safe":2}\n', 'utf8');
            await handle.drainNow();
            await handle.close();

            expect(received).toEqual([`${await realpath(grantedPath)}:{"safe":2}`]);
        } finally {
            await rm(root, { recursive: true, force: true });
            await rm(outsideRoot, { recursive: true, force: true });
        }
    });

    it('stops delivering lines when an active dynamic grant expires', async () => {
        const root = await createTempRoot('happier-plugin-file-follow-dynamic-expiry-close-');
        const filePath = join(root, 'session.jsonl');
        await writeFile(filePath, '', 'utf8');
        const registry = createTranscriptFileFollowPathGrantRegistry();
        await registry.grant({
            pluginId: 'acme.transcript',
            runtimeId: 'runtime-1',
            sessionId: 'session-1',
            path: filePath,
            reason: 'testFixture',
            evidence: { kind: 'testOnly' },
            expiresAtMs: Date.now() + 30,
        });
        const received: string[] = [];
        const service = createPluginTranscriptFileFollowService({
            pluginId: 'acme.transcript',
            runtimeId: 'runtime-1',
            readSessionId: () => 'session-1',
            fileFollowPathGrants: registry,
            watchFile: () => () => undefined,
            policy: {
                activeBurstPollIntervalMs: 60_000,
                activeFallbackPollIntervalMs: 60_000,
                idleFallbackPollIntervalMs: 60_000,
            },
        });

        try {
            const handle = await service.follow({
                path: filePath,
                startAt: 'end',
                onLine: (line) => {
                    received.push(line.line);
                },
            });
            await waitForTimerTick(80);
            await appendFile(filePath, '{"afterExpiry":true}\n', 'utf8');
            await handle.drainNow();
            await handle.close();

            expect(received).toEqual([]);
        } finally {
            await rm(root, { recursive: true, force: true });
        }
    });

    it('delivers complete raw lines from granted paths without parsing provider rows', async () => {
        const root = await createTempRoot('happier-plugin-file-follow-lines-');
        const filePath = join(root, 'session.jsonl');
        await writeFile(filePath, '{"one":1}\nnot-json\npartial', 'utf8');
        const received: Array<Readonly<{ line: string; sourcePath: string; sequence: number }>> = [];
        const service = createPluginTranscriptFileFollowService({
            allowedPathRoots: [root],
            watchFile: () => () => undefined,
            policy: {
                activeBurstPollIntervalMs: 60_000,
                activeFallbackPollIntervalMs: 60_000,
                idleFallbackPollIntervalMs: 60_000,
            },
        });

        try {
            const handle = await service.follow({
                path: filePath,
                startAt: 'beginning',
                onLine: (line) => {
                    received.push(line);
                },
            });
            await handle.close();

            const sourcePath = await realpath(filePath);
            expect(received).toEqual([
                { line: '{"one":1}', sourcePath, sequence: 1 },
                { line: 'not-json', sourcePath, sequence: 2 },
            ]);
        } finally {
            await rm(root, { recursive: true, force: true });
        }
    });

    it('supports explicit close, abort, and runtime disposal cleanup', async () => {
        const root = await createTempRoot('happier-plugin-file-follow-lifecycle-');
        const explicitPath = join(root, 'explicit.jsonl');
        const abortPath = join(root, 'abort.jsonl');
        const retainedPath = join(root, 'retained.jsonl');
        await writeFile(explicitPath, '{"first":1}\n', 'utf8');
        await writeFile(abortPath, '', 'utf8');
        await writeFile(retainedPath, '', 'utf8');
        const registry = createPluginDisposableRegistry();
        const received: string[] = [];
        const service = createPluginTranscriptFileFollowService({
            allowedPathRoots: [root],
            addDisposable: registry.add,
            watchFile: () => () => undefined,
            policy: {
                activeBurstPollIntervalMs: 60_000,
                activeFallbackPollIntervalMs: 60_000,
                idleFallbackPollIntervalMs: 60_000,
            },
        });

        try {
            const explicit = await service.follow({
                path: explicitPath,
                startAt: 'beginning',
                onLine: (line) => {
                    received.push(`explicit:${line.line}`);
                },
            });
            await explicit.close();
            await appendFile(explicitPath, '{"afterClose":true}\n', 'utf8');
            await explicit.drainNow();

            const abortController = new AbortController();
            const aborted = await service.follow({
                path: abortPath,
                startAt: 'end',
                signal: abortController.signal,
                onLine: (line) => {
                    received.push(`abort:${line.line}`);
                },
            });
            abortController.abort();
            await appendFile(abortPath, '{"afterAbort":true}\n', 'utf8');
            await aborted.drainNow();

            const retained = await service.follow({
                path: retainedPath,
                startAt: 'end',
                onLine: (line) => {
                    received.push(`retained:${line.line}`);
                },
            });
            await registry.dispose();
            await appendFile(retainedPath, '{"afterDispose":true}\n', 'utf8');
            await retained.drainNow();

            expect(received).toEqual(['explicit:{"first":1}']);
        } finally {
            await registry.dispose().catch(() => undefined);
            await rm(root, { recursive: true, force: true });
        }
    });

    it('runs a bounded final drain during close when requested', async () => {
        const root = await createTempRoot('happier-plugin-file-follow-final-drain-');
        const filePath = join(root, 'session.jsonl');
        await writeFile(filePath, '{"first":1}\n', 'utf8');
        const received: string[] = [];
        const service = createPluginTranscriptFileFollowService({
            allowedPathRoots: [root],
            watchFile: () => () => undefined,
            policy: {
                activeBurstPollIntervalMs: 60_000,
                activeFallbackPollIntervalMs: 60_000,
                idleFallbackPollIntervalMs: 60_000,
            },
        });

        try {
            const handle = await service.follow({
                path: filePath,
                startAt: 'end',
                onLine: (line) => {
                    received.push(line.line);
                },
            });
            await appendFile(filePath, '{"final":true}\n', 'utf8');
            await handle.close({ finalDrain: true, drainTimeoutMs: 1_000 });

            expect(received).toEqual(['{"final":true}']);
        } finally {
            await rm(root, { recursive: true, force: true });
        }
    });

    it('closes safely from inside a line handler when final drain is requested', async () => {
        const root = await createTempRoot('happier-plugin-file-follow-close-from-handler-');
        const filePath = join(root, 'session.jsonl');
        await writeFile(filePath, '', 'utf8');
        const received: string[] = [];
        const service = createPluginTranscriptFileFollowService({
            allowedPathRoots: [root],
            watchFile: () => () => undefined,
            policy: {
                activeBurstPollIntervalMs: 60_000,
                activeFallbackPollIntervalMs: 60_000,
                idleFallbackPollIntervalMs: 60_000,
            },
        });
        let handle: Awaited<ReturnType<typeof service.follow>>;

        try {
            handle = await service.follow({
                path: filePath,
                startAt: 'end',
                onLine: async (line) => {
                    received.push(line.line);
                    await handle.close({ finalDrain: true, drainTimeoutMs: 1_000 });
                },
            });
            await appendFile(filePath, '{"inside":true}\n{"after":true}\n', 'utf8');

            await expect(handle.drainNow({ timeoutMs: 2_000 })).resolves.toBeUndefined();
            await expect(handle.close()).resolves.toBeUndefined();
            expect(received).toEqual(['{"inside":true}']);
        } finally {
            await rm(root, { recursive: true, force: true });
        }
    });

    it('rejects unsupported strategies and invalid policy intervals with stable codes', async () => {
        const root = await createTempRoot('happier-plugin-file-follow-policy-');
        const filePath = join(root, 'session.jsonl');
        await writeFile(filePath, '', 'utf8');
        const service = createPluginTranscriptFileFollowService({ allowedPathRoots: [root] });

        try {
            await expect(service.follow({
                path: filePath,
                startAt: 'beginning',
                strategy: 'chokidar' as 'poll',
                onLine: () => undefined,
            })).rejects.toMatchObject({ code: 'PLUGIN_TRANSCRIPTS_FILE_FOLLOW_STRATEGY_UNSUPPORTED' });
            await expect(service.follow({
                path: filePath,
                startAt: 'beginning',
                policy: { pollIntervalMs: 24 },
                onLine: () => undefined,
            })).rejects.toMatchObject({ code: 'PLUGIN_TRANSCRIPTS_FILE_FOLLOW_POLICY_INVALID' });
        } finally {
            await rm(root, { recursive: true, force: true });
        }
    });

    it('keeps provider parsing out of the host file-follow service', async () => {
        const source = await readFile(new URL('./fileFollow.ts', import.meta.url), 'utf8');
        expect(source).not.toContain('JSON.parse');
    });
});
