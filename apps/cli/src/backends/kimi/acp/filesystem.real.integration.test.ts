import { access, readFile, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createKimiBackend } from './backend';
import { createKimiLoopbackEnvironment, createKimiLoopbackModel } from './kimiLoopbackModel.testkit';
import { withTempDir } from '@/testkit/fs/tempDir';
import { createEnvKeyScope } from '@/testkit/env/envScope';

const executable = process.env.HAPPIER_TEST_KIMI_PATH?.trim();
const readMarker = 'KIMI_ISOLATED_FILESYSTEM_READ_FIXTURE';
const writeMarker = 'KIMI_ISOLATED_FILESYSTEM_WRITE_FIXTURE';

describe.skipIf(!executable || process.platform === 'win32')('Kimi ACP host filesystem with the official CLI', () => {
    let env: ReturnType<typeof createEnvKeyScope>;
    beforeEach(() => {
        env = createEnvKeyScope(['HAPPIER_ACP_FS']);
        env.patch({ HAPPIER_ACP_FS: '1' });
    });
    afterEach(() => env.restore());

    it.each(['inside', 'outside', 'symlink'] as const)('serves an %s read through the host, matching the agent tools reach', async (location) => {
        await withTempDir('happier-kimi-fs-read-', async (directory) => {
            const outside = join(directory, 'outside.txt');
            const inside = join(directory, 'workspace', 'inside.txt');
            const path = location === 'outside' ? outside : inside;
            await writeFile(outside, readMarker);
            const model = await createKimiLoopbackModel(directory, { filesystem: { tool: 'Read', path } });
            if (location === 'symlink') await symlink(outside, inside);
            else if (location === 'inside') await writeFile(inside, readMarker);
            const backend = createKimiBackend({
                cwd: model.workspace,
                ...createKimiLoopbackEnvironment(model.home, executable!),
                permissionMode: 'default',
                permissionHandler: { handleToolCall: async () => ({ decision: 'approved' }) },
            });
            try {
                const { sessionId } = await backend.startSession();
                await backend.sendPrompt(sessionId, 'Run the isolated filesystem read fixture.');
                await backend.waitForResponseComplete?.();
                expect(model.getRequestCount()).toBe(2);
                expect(model.getToolResponses().join('\n')).toContain(readMarker);
            } finally {
                await backend.dispose();
                await model.close();
            }
        });
    }, 30_000);

    it.each(['approved', 'denied'] as const)('honors a host %s write decision before the filesystem effect', async (decision) => {
        await withTempDir('happier-kimi-fs-write-', async (directory) => {
            const path = join(directory, 'workspace', 'write-sentinel.txt');
            const model = await createKimiLoopbackModel(directory, {
                filesystem: { tool: 'Write', path, content: writeMarker },
            });
            const permissions: string[] = [];
            const backend = createKimiBackend({
                cwd: model.workspace,
                ...createKimiLoopbackEnvironment(model.home, executable!),
                permissionMode: 'default',
                permissionHandler: {
                    handleToolCall: async (_id, name) => {
                        permissions.push(name);
                        return { decision };
                    },
                },
            });
            try {
                const { sessionId } = await backend.startSession();
                const turn = (async () => {
                    await backend.sendPrompt(sessionId, 'Run the isolated filesystem write fixture.');
                    await backend.waitForResponseComplete?.();
                })();
                if (decision === 'approved') {
                    await turn;
                    expect(model.getRequestCount()).toBe(2);
                    expect(await readFile(path, 'utf8')).toBe(writeMarker);
                } else {
                    // Existing ACP denial cancels the turn before another model request.
                    await expect(turn).rejects.toMatchObject({ name: 'AbortError', message: 'Cancelled by user' });
                    await backend.dispose();
                    expect(model.getRequestCount()).toBe(1);
                    await expect(access(path)).rejects.toMatchObject({ code: 'ENOENT' });
                }
                expect(permissions.length).toBeGreaterThan(0);
            } finally {
                await backend.dispose();
                await model.close();
            }
        });
    }, 30_000);
});
