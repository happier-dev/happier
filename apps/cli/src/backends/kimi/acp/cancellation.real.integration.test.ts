import { describe, expect, it } from 'vitest';

import { createKimiBackend } from './backend';
import {
    createKimiLoopbackModel,
    KIMI_FIXTURE_FOREGROUND,
    KIMI_FIXTURE_SECOND_FOREGROUND,
} from './kimiLoopbackModel.testkit';
import type { AgentMessage } from '@/agent/core';
import { withTempDir } from '@/testkit/fs/tempDir';

const executable = process.env.HAPPIER_TEST_KIMI_PATH?.trim();

describe.skipIf(!executable || process.platform === 'win32')('Kimi cancellation with waiting native tasks', () => {
    it('stops a background process after the foreground settles and resumes without replaying its continuation', async () => {
        await withTempDir('happier-kimi-waiting-cancel-', async (directory) => {
            const model = await createKimiLoopbackModel(directory, { interveningForeground: true, continuationTool: true });
            const events: AgentMessage[] = [];
            const backend = createKimiBackend({
                cwd: model.workspace,
                env: { HAPPIER_KIMI_PATH: executable!, KIMI_CODE_HOME: model.home, KIMI_DISABLE_TELEMETRY: '1' },
                permissionMode: 'default',
                permissionHandler: { handleToolCall: async () => ({ decision: 'approved' }) },
            });
            backend.onMessage(event => { events.push(event); });
            try {
                const { sessionId } = await backend.startSession();
                await backend.sendPrompt(sessionId, 'Start the isolated background cancellation fixture.');
                await backend.waitForResponseComplete?.();
                expect(model.getRequestCount()).toBe(2);
                expect(events).toContainEqual(expect.objectContaining({ type: 'model-output', textDelta: KIMI_FIXTURE_FOREGROUND }));
                const task = (await model.readNativeEvents()).find(event => event.type === 'task.started');
                const pid = (task?.info as { pid?: unknown } | undefined)?.pid;
                if (typeof pid !== 'number' || pid <= 0) throw new Error('Native fixture did not publish its owned task pid');
                const isAlive = () => {
                    try { process.kill(pid, 0); return true; }
                    catch (error) {
                        if ((error as NodeJS.ErrnoException).code === 'ESRCH') return false;
                        throw error;
                    }
                };
                expect(isAlive()).toBe(true);
                await backend.cancel(sessionId);
                await expect.poll(isAlive, { timeout: 5_000 }).toBe(false);
                events.length = 0;
                await model.releaseBackground();
                model.releaseContinuation();
                await backend.sendPrompt(sessionId, 'Continue after the stopped background task.');
                await backend.waitForResponseComplete?.();
                expect(model.getRequestCount()).toBe(3);
                expect(events).toContainEqual(expect.objectContaining({ type: 'model-output', textDelta: KIMI_FIXTURE_SECOND_FOREGROUND }));
                expect(events.some(event => event.type === 'model-output' && event.textDelta === KIMI_FIXTURE_FOREGROUND)).toBe(false);
                expect((await model.readNativeEvents()).some(event => event.type === 'turn.prompt'
                    && (event.origin as { kind?: unknown } | undefined)?.kind === 'task')).toBe(false);
                expect(await model.continuationExecuted()).toBe(false);
            } finally {
                model.releaseContinuation();
                await backend.dispose();
                await model.close();
            }
        });
    }, 30_000);
});
