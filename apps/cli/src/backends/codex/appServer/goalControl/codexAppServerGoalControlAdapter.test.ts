import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { buildCodexAgentRuntimeDescriptor } from '@happier-dev/agents';
import { SESSION_RPC_METHODS } from '@happier-dev/protocol/rpc';
import { describe, expect, it } from 'vitest';

import { withTempDir } from '@/testkit/fs/tempDir';

import {
    createCodexAppServerProcessEnv,
    writeFakeCodexAppServerScript,
} from '../testkit/fakeCodexAppServer';

async function importGoalControlModule(): Promise<{
    createCodexAppServerGoalControlAdapter?: unknown;
}> {
    return await import('./codexAppServerGoalControlAdapter').catch(() => ({}));
}

async function writeGoalControlFakeAppServer(params: Readonly<{
    dir: string;
    requestLogPath: string;
    rejectStatusOnly?: boolean;
    returnNoGoal?: boolean;
    directGoalResult?: boolean;
}>): Promise<string> {
    return await writeFakeCodexAppServerScript({
        dir: params.dir,
        importLines: ['import { appendFileSync } from "node:fs";'],
        setupLines: [
            `const requestLogPath = ${JSON.stringify(params.requestLogPath)};`,
            `const rejectStatusOnly = ${JSON.stringify(params.rejectStatusOnly === true)};`,
            `const returnNoGoal = ${JSON.stringify(params.returnNoGoal === true)};`,
            `const directGoalResult = ${JSON.stringify(params.directGoalResult === true)};`,
        ],
        bodyLines: [
            'for await (const line of rl) {',
            '  if (!line.trim()) continue;',
            '  const msg = JSON.parse(line);',
            '  appendFileSync(requestLogPath, JSON.stringify({ method: msg.method, params: msg.params ?? null }) + "\\n");',
            '  if (msg.method === "initialize") {',
            '    process.stdout.write(JSON.stringify({ id: msg.id, result: { serverInfo: { name: "fake", version: "0.0.0" } } }) + "\\n");',
            '    continue;',
            '  }',
            '  if (msg.method === "initialized") continue;',
            '  if (msg.method === "thread/goal/get") {',
            '    const goal = returnNoGoal ? null : { threadId: msg.params?.threadId ?? "thread-1", objective: "Current objective", status: "active", tokensUsed: 25, timeUsedSeconds: 3, updatedAt: "2026-05-13T10:00:00.000Z" };',
            '    process.stdout.write(JSON.stringify({ id: msg.id, result: directGoalResult ? goal : { goal } }) + "\\n");',
            '    continue;',
            '  }',
            '  if (msg.method === "thread/goal/set") {',
            '    if (rejectStatusOnly && !Object.prototype.hasOwnProperty.call(msg.params ?? {}, "objective")) {',
            '      process.stdout.write(JSON.stringify({ id: msg.id, error: { code: -32602, message: "objective is required" } }) + "\\n");',
            '      continue;',
            '    }',
            '    const goal = {',
            '      threadId: msg.params?.threadId ?? "thread-1",',
            '      objective: msg.params?.objective ?? "Current objective",',
            '      status: msg.params?.status ?? "active",',
            '      tokensUsed: 25,',
            '      timeUsedSeconds: 3,',
            '      updatedAt: "2026-05-13T10:05:00.000Z",',
            '    };',
            '    process.stdout.write(JSON.stringify({ id: msg.id, result: directGoalResult ? goal : { goal } }) + "\\n");',
            '    continue;',
            '  }',
            '  if (msg.method === "thread/goal/clear") {',
            '    process.stdout.write(JSON.stringify({ id: msg.id, result: { ok: true } }) + "\\n");',
            '    continue;',
            '  }',
            '  process.stdout.write(JSON.stringify({ id: msg.id, error: { code: -32601, message: "method not found" } }) + "\\n");',
            '}',
        ],
    });
}

async function readRequestMethods(path: string): Promise<string[]> {
    const text = await readFile(path, 'utf8');
    return text.trim().split('\n').filter(Boolean).map((line) => JSON.parse(line).method as string);
}

async function readRequests(path: string): Promise<Array<{ method: string; params: Record<string, unknown> | null }>> {
    const text = await readFile(path, 'utf8');
    return text.trim().split('\n').filter(Boolean).map((line) => JSON.parse(line));
}

function metadataForThread(threadId = 'thread-1'): Record<string, unknown> {
    return {
        keep: 'yes',
        codexBackendMode: 'appServer',
        codexSessionId: 'legacy-thread',
        agentRuntimeDescriptorV1: buildCodexAgentRuntimeDescriptor({
            backendMode: 'appServer',
            vendorSessionId: threadId,
        }),
        sessionWorkStateV1: {
            v: 1,
            backendId: 'codex',
            updatedAt: 1,
            items: [
                { id: 'todo:other:1', kind: 'todo', origin: 'vendor', status: 'active', title: 'Keep me', updatedAt: 1 },
            ],
            primaryItemId: 'todo:other:1',
        },
    };
}

async function createAdapter(): Promise<{
    getGoal: (params: Record<string, unknown>) => Promise<unknown>;
    setGoal: (params: Record<string, unknown>) => Promise<unknown>;
    clearGoal: (params: Record<string, unknown>) => Promise<unknown>;
}> {
    const module = await importGoalControlModule();
    expect(module.createCodexAppServerGoalControlAdapter).toBeTypeOf('function');
    return (module.createCodexAppServerGoalControlAdapter as () => {
        getGoal: (params: Record<string, unknown>) => Promise<unknown>;
        setGoal: (params: Record<string, unknown>) => Promise<unknown>;
        clearGoal: (params: Record<string, unknown>) => Promise<unknown>;
    })();
}

describe('codexAppServerGoalControlAdapter', () => {
    it('pauses an inactive persisted Codex goal without resuming or starting a turn', async () => {
        await withTempDir('happier-codex-goal-control-pause-', async (root) => {
            const requestLogPath = join(root, 'requests.jsonl');
            const fakeAppServer = await writeGoalControlFakeAppServer({ dir: root, requestLogPath });
            const adapter = await createAdapter();

            const result = await adapter.setGoal({
                cwd: root,
                metadata: metadataForThread('thread-1'),
                processEnv: createCodexAppServerProcessEnv(fakeAppServer),
                status: 'paused',
            });

            expect(result).toMatchObject({
                workState: {
                    items: [
                        expect.objectContaining({ id: 'todo:other:1' }),
                        expect.objectContaining({ id: 'goal:thread-1', status: 'paused', title: 'Current objective' }),
                    ],
                },
            });
            const requests = await readRequests(requestLogPath);
            expect(requests).toEqual(expect.arrayContaining([
                expect.objectContaining({
                    method: 'thread/goal/set',
                    params: { threadId: 'thread-1', status: 'paused' },
                }),
            ]));
            expect(await readRequestMethods(requestLogPath)).not.toEqual(expect.arrayContaining([
                'thread/resume',
                'turn/start',
                'turn/steer',
            ]));
        });
    });

    it('projects direct native goal set responses into returned work-state metadata', async () => {
        await withTempDir('happier-codex-goal-control-direct-goal-result-', async (root) => {
            const requestLogPath = join(root, 'requests.jsonl');
            const fakeAppServer = await writeGoalControlFakeAppServer({
                dir: root,
                requestLogPath,
                directGoalResult: true,
            });
            const adapter = await createAdapter();

            await expect(adapter.setGoal({
                cwd: root,
                metadata: metadataForThread('thread-1'),
                processEnv: createCodexAppServerProcessEnv(fakeAppServer),
                status: 'paused',
            })).resolves.toMatchObject({
                metadata: {
                    sessionWorkStateV1: {
                        items: expect.arrayContaining([
                            expect.objectContaining({
                                id: 'goal:thread-1',
                                status: 'paused',
                                title: 'Current objective',
                            }),
                        ]),
                    },
                },
                workState: {
                    items: expect.arrayContaining([
                        expect.objectContaining({
                            id: 'goal:thread-1',
                            status: 'paused',
                            title: 'Current objective',
                        }),
                    ]),
                },
            });
        });
    });

    it('falls back to the current objective when older Codex rejects status-only goal set', async () => {
        await withTempDir('happier-codex-goal-control-status-fallback-', async (root) => {
            const requestLogPath = join(root, 'requests.jsonl');
            const fakeAppServer = await writeGoalControlFakeAppServer({
                dir: root,
                requestLogPath,
                rejectStatusOnly: true,
            });
            const adapter = await createAdapter();

            await adapter.setGoal({
                cwd: root,
                metadata: metadataForThread('thread-1'),
                processEnv: createCodexAppServerProcessEnv(fakeAppServer),
                status: 'complete',
            });

            const requests = await readRequests(requestLogPath);
            expect(requests).toEqual(expect.arrayContaining([
                expect.objectContaining({
                    method: 'thread/goal/get',
                    params: { threadId: 'thread-1' },
                }),
                expect.objectContaining({
                    method: 'thread/goal/set',
                    params: { threadId: 'thread-1', objective: 'Current objective', status: 'complete' },
                }),
            ]));
        });
    });

    it('reactivates a completed goal when editing the objective', async () => {
        await withTempDir('happier-codex-goal-control-edit-complete-', async (root) => {
            const requestLogPath = join(root, 'requests.jsonl');
            const fakeAppServer = await writeGoalControlFakeAppServer({ dir: root, requestLogPath });
            const adapter = await createAdapter();

            await adapter.setGoal({
                cwd: root,
                metadata: {
                    ...metadataForThread('thread-1'),
                    sessionWorkStateV1: {
                        v: 1,
                        backendId: 'codex',
                        updatedAt: 10,
                        primaryItemId: 'goal:thread-1',
                        items: [
                            { id: 'goal:thread-1', kind: 'goal', origin: 'vendor', backendId: 'codex', vendorRef: 'thread-1', status: 'complete', title: 'Done', updatedAt: 9 },
                        ],
                    },
                },
                processEnv: createCodexAppServerProcessEnv(fakeAppServer),
                objective: 'Revised objective',
            });

            expect(await readRequests(requestLogPath)).toEqual(expect.arrayContaining([
                expect.objectContaining({
                    method: 'thread/goal/set',
                    params: { threadId: 'thread-1', objective: 'Revised objective', status: 'active' },
                }),
            ]));
        });
    });

    it('returns goal_not_found when fallback cannot find a current goal', async () => {
        await withTempDir('happier-codex-goal-control-no-goal-', async (root) => {
            const requestLogPath = join(root, 'requests.jsonl');
            const fakeAppServer = await writeGoalControlFakeAppServer({
                dir: root,
                requestLogPath,
                rejectStatusOnly: true,
                returnNoGoal: true,
            });
            const adapter = await createAdapter();

            await expect(adapter.setGoal({
                cwd: root,
                metadata: metadataForThread('thread-1'),
                processEnv: createCodexAppServerProcessEnv(fakeAppServer),
                status: 'paused',
            })).resolves.toEqual({
                ok: false,
                errorCode: 'goal_not_found',
                error: 'goal_not_found',
            });
        });
    });

    it('clears the inactive Codex goal projection without removing unrelated work-state items', async () => {
        await withTempDir('happier-codex-goal-control-clear-', async (root) => {
            const requestLogPath = join(root, 'requests.jsonl');
            const fakeAppServer = await writeGoalControlFakeAppServer({ dir: root, requestLogPath });
            const adapter = await createAdapter();

            const result = await adapter.clearGoal({
                cwd: root,
                metadata: {
                    ...metadataForThread('thread-1'),
                    sessionWorkStateV1: {
                        v: 1,
                        backendId: 'codex',
                        updatedAt: 10,
                        primaryItemId: 'goal:thread-1',
                        items: [
                            { id: 'goal:thread-1', kind: 'goal', origin: 'vendor', backendId: 'codex', vendorRef: 'thread-1', status: 'active', title: 'Codex', updatedAt: 9 },
                            { id: 'todo:other:1', kind: 'todo', origin: 'vendor', status: 'active', title: 'Keep me', updatedAt: 1 },
                        ],
                    },
                },
                processEnv: createCodexAppServerProcessEnv(fakeAppServer),
            });

            expect(result).toMatchObject({
                workState: {
                    items: [expect.objectContaining({ id: 'todo:other:1' })],
                    primaryItemId: 'todo:other:1',
                },
            });
            expect(await readRequests(requestLogPath)).toEqual(expect.arrayContaining([
                expect.objectContaining({
                    method: 'thread/goal/clear',
                    params: { threadId: 'thread-1' },
                }),
            ]));
        });
    });

    it('returns a stable unsupported result when native goal set is unavailable', async () => {
        await withTempDir('happier-codex-goal-control-unsupported-', async (root) => {
            const fakeAppServer = await writeFakeCodexAppServerScript({
                dir: root,
                bodyLines: [
                    'for await (const line of rl) {',
                    '  if (!line.trim()) continue;',
                    '  const msg = JSON.parse(line);',
                    '  if (msg.method === "initialize") {',
                    '    process.stdout.write(JSON.stringify({ id: msg.id, result: { serverInfo: { name: "fake", version: "0.0.0" } } }) + "\\n");',
                    '    continue;',
                    '  }',
                    '  if (msg.method === "initialized") continue;',
                    '  process.stdout.write(JSON.stringify({ id: msg.id, error: { code: -32601, message: "Method not found" } }) + "\\n");',
                    '}',
                ],
            });
            const adapter = await createAdapter();

            await expect(adapter.setGoal({
                cwd: root,
                metadata: metadataForThread('thread-1'),
                processEnv: createCodexAppServerProcessEnv(fakeAppServer),
                status: 'paused',
            })).resolves.toEqual({
                ok: false,
                errorCode: 'unsupported_session_runtime_method',
                error: `unsupported_session_runtime_method:${SESSION_RPC_METHODS.SESSION_GOAL_SET}`,
            });
        });
    });

    it('returns the goal-get unsupported method when native goal get is unavailable', async () => {
        await withTempDir('happier-codex-goal-control-get-unsupported-', async (root) => {
            const fakeAppServer = await writeFakeCodexAppServerScript({
                dir: root,
                bodyLines: [
                    'for await (const line of rl) {',
                    '  if (!line.trim()) continue;',
                    '  const msg = JSON.parse(line);',
                    '  if (msg.method === "initialize") {',
                    '    process.stdout.write(JSON.stringify({ id: msg.id, result: { serverInfo: { name: "fake", version: "0.0.0" } } }) + "\\n");',
                    '    continue;',
                    '  }',
                    '  if (msg.method === "initialized") continue;',
                    '  process.stdout.write(JSON.stringify({ id: msg.id, error: { code: -32601, message: "Method not found" } }) + "\\n");',
                    '}',
                ],
            });
            const adapter = await createAdapter();

            await expect(adapter.getGoal({
                cwd: root,
                metadata: metadataForThread('thread-1'),
                processEnv: createCodexAppServerProcessEnv(fakeAppServer),
            })).resolves.toEqual({
                ok: false,
                errorCode: 'unsupported_session_runtime_method',
                error: `unsupported_session_runtime_method:${SESSION_RPC_METHODS.SESSION_GOAL_GET}`,
            });
        });
    });

    it('returns the goal-get unsupported method when app-server control is unsupported', async () => {
        const adapter = await createAdapter();

        await expect(adapter.getGoal({
            cwd: process.cwd(),
            metadata: {
                agentRuntimeDescriptorV1: buildCodexAgentRuntimeDescriptor({
                    backendMode: 'mcp',
                    vendorSessionId: 'thread-1',
                }),
            },
        })).resolves.toEqual({
            ok: false,
            errorCode: 'unsupported_session_runtime_method',
            error: `unsupported_session_runtime_method:${SESSION_RPC_METHODS.SESSION_GOAL_GET}`,
        });
    });

    it('returns the goal-clear unsupported method when app-server control is unsupported', async () => {
        const adapter = await createAdapter();

        await expect(adapter.clearGoal({
            cwd: process.cwd(),
            metadata: {
                agentRuntimeDescriptorV1: buildCodexAgentRuntimeDescriptor({
                    backendMode: 'mcp',
                    vendorSessionId: 'thread-1',
                }),
            },
        })).resolves.toEqual({
            ok: false,
            errorCode: 'unsupported_session_runtime_method',
            error: `unsupported_session_runtime_method:${SESSION_RPC_METHODS.SESSION_GOAL_CLEAR}`,
        });
    });
});
