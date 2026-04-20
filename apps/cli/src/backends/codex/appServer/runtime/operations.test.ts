import { afterEach, describe, expect, it, vi } from 'vitest';

import { isRuntimeTurnOperations } from '@/agent/runtime/turns/runtimeTurnOperations';
import { createMutableApiSessionClientFixture } from '@/testkit/backends/sessionFixtures';
import { createTempDir, removeTempDir } from '@/testkit/fs/tempDir';

import { createCodexAppServerRuntime } from './index';
import {
    createCodexAppServerProcessEnv,
    createCodexAppServerTestEnvScope,
    writeFakeCodexAppServerScript,
} from '../testkit/fakeCodexAppServer';

const tempDirs = new Set<string>();

afterEach(async () => {
    await Promise.all(Array.from(tempDirs, (dir) => removeTempDir(dir)));
    tempDirs.clear();
});

describe('createCodexAppServerRuntime (native lower-operation surface)', () => {
    it('implements RuntimeTurnOperations directly on the app-server runtime leaf', async () => {
        const root = await createTempDir('happier-codex-runtime-ops-');
        tempDirs.add(root);

        const fakeAppServer = await writeFakeCodexAppServerScript({
            dir: root,
            bodyLines: [
                'for await (const line of rl) {',
                '  if (!line.trim()) continue;',
                '  const msg = JSON.parse(line);',
                '  if (msg.method === "initialize") {',
                '    process.stdout.write(JSON.stringify({ id: msg.id, result: { serverInfo: { name: "fake-codex-app-server", version: "0.0.0" } } }) + "\\n");',
                '    continue;',
                '  }',
                '  if (msg.method === "initialized") continue;',
                '  if (msg.method === "thread/start") {',
                '    process.stdout.write(JSON.stringify({ id: msg.id, result: { threadId: "thread-started", model: "gpt-5.4", serviceTier: null } }) + "\\n");',
                '    continue;',
                '  }',
                '  if (msg.method === "collaborationMode/list") {',
                '    process.stdout.write(JSON.stringify({ id: msg.id, result: [{ name: "Default", mode: "default", reasoning_effort: null }, { name: "Plan", mode: "plan", reasoning_effort: "high" }] }) + "\\n");',
                '    continue;',
                '  }',
                '  if (msg.method === "model/list") {',
                '    process.stdout.write(JSON.stringify({ id: msg.id, result: [{ id: "gpt-5.4", displayName: "GPT-5.4", isDefault: true, supportedReasoningEfforts: ["medium", "high"], defaultReasoningEffort: "medium" }, { id: "gpt-5.4-mini", displayName: "GPT-5.4 Mini", supportedReasoningEfforts: ["medium", "high"], defaultReasoningEffort: "medium" }] }) + "\\n");',
                '    continue;',
                '  }',
                '  process.stdout.write(JSON.stringify({ id: msg.id, error: { code: -32601, message: "method not found" } }) + "\\n");',
                '}',
            ],
        });

        const envScope = createCodexAppServerTestEnvScope();
        const session = createMutableApiSessionClientFixture({
            overrides: {
                sendCodexMessage: vi.fn(),
            },
        });

        try {
            const runtime = createCodexAppServerRuntime({
                directory: root,
                processEnv: createCodexAppServerProcessEnv(fakeAppServer),
                session,
                onThinkingChange: vi.fn(),
            });

            expect(isRuntimeTurnOperations(runtime)).toBe(true);
            if (!isRuntimeTurnOperations(runtime)) {
                throw new Error('Expected Codex app-server runtime to satisfy RuntimeTurnOperations');
            }

            await runtime.startOrLoadSession();
            await runtime.updateSessionRuntimeConfig({
                modeId: 'plan',
                modelId: 'gpt-5.4-mini',
                configOption: { id: 'reasoning_effort', value: 'high' },
            });
            expect(runtime.readSessionIdentity()).toEqual({ sessionId: 'thread-started' });
            await runtime.resetOrDisposeRuntime();
        } finally {
            envScope.restore();
        }
    });
});
