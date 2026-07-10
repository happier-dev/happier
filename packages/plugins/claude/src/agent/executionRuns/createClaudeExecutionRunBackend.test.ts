import type { ExecClientHandleV1, JsonStreamClientV1, PluginContextV1 } from '@happier-dev/plugin-sdk';
import { describe, expect, it, vi } from 'vitest';

import { createClaudeExecutionRunBackend } from './createClaudeExecutionRunBackend.js';
import type { SDKMessage } from '../sdk/types.js';

function createJsonStreamHandle() {
    const listeners = new Set<(record: unknown) => void | Promise<void>>();
    const dispose = vi.fn(async () => undefined);
    const client: JsonStreamClientV1 = {
        closed: new Promise(() => undefined),
        subscribe(listener) {
            listeners.add(listener);
            return () => listeners.delete(listener);
        },
        async writeRecord() {},
    };
    const handle: ExecClientHandleV1<JsonStreamClientV1> = {
        client,
        process: {
            pid: 123,
            exit: new Promise(() => undefined),
            async writeStdin() {},
            kill() {},
            async dispose() {},
        },
        status: 'running',
        onExit() {
            return () => undefined;
        },
        dispose,
    };
    return {
        dispose,
        handle,
        async emit(record: unknown) {
            await Promise.all([...listeners].map((listener) => listener(record)));
        },
        listenerCount() {
            return listeners.size;
        },
    };
}

function createContextFixture(stream = createJsonStreamHandle()) {
    const requestDecision = vi.fn(async () => ({ decision: 'approved' as const }));
    const writeStateField = vi.fn(async () => undefined);
    const spawnClient = vi.fn(async () => stream.handle);
    const currentSession = {
        writeStateField,
        permissions: {
            requestDecision,
            getMode: () => 'default',
        },
    };
    const ctx = {
        agentRuntime: {
            exec: {
                spawnClient,
            },
        },
        logger: {
            debug: vi.fn(),
        },
        session: currentSession,
        sessions: {
            current: currentSession,
        },
    } as unknown as PluginContextV1;
    return { ctx, requestDecision, spawnClient, stream };
}

async function flushMicrotasks(times = 4): Promise<void> {
    for (let index = 0; index < times; index += 1) {
        await Promise.resolve();
    }
}

async function waitForCondition(predicate: () => boolean, label: string): Promise<void> {
    for (let index = 0; index < 20; index += 1) {
        if (predicate()) return;
        await Promise.resolve();
    }
    throw new Error(`Timed out waiting for ${label}`);
}

describe('createClaudeExecutionRunBackend', () => {
    it('does not advertise synthetic execution-run ids as resumable provider identities', async () => {
        const { ctx, stream } = createContextFixture();
        const backend = createClaudeExecutionRunBackend({
            ctx,
            executionRunParams: {
                backendId: 'claude',
                cwd: '/tmp/project',
                runId: 'run_1',
            },
        });

        await expect(backend.readResumeSupport()).resolves.toBe(false);
        await expect(backend.readResumeSupport({ captureReplay: true })).resolves.toBe(false);

        const provision = backend.provisionSession({ initialPrompt: 'review this' });
        await waitForCondition(() => stream.listenerCount() > 0, 'Claude SDK stream subscription');

        await stream.emit({
            type: 'system',
            subtype: 'init',
            session_id: 'claude-provider-session-1',
        } satisfies SDKMessage);
        await stream.emit({
            type: 'result',
            subtype: 'success',
            num_turns: 1,
            total_cost_usd: 0,
            duration_ms: 1,
            duration_api_ms: 1,
            is_error: false,
            session_id: 'claude-provider-session-1',
        } satisfies SDKMessage);

        await expect(provision).resolves.toEqual({ sessionId: 'claude-execution-run:run_1' });
        expect(ctx.sessions.current.writeStateField).toHaveBeenCalledWith({
            fieldId: 'identity.providerSessionId',
            value: {
                metadataKey: 'claudeSessionId',
                value: 'claude-provider-session-1',
            },
            reason: 'claude-agent-sdk-session-id',
        });
        expect(ctx.sessions.current.writeStateField).not.toHaveBeenCalledWith(expect.objectContaining({
            fieldId: 'identity.providerSessionId',
            value: expect.objectContaining({
                value: 'claude-execution-run:run_1',
            }),
        }));
        await backend.dispose();
    });

    it('drives execution runs through the shared turn-operations adapter', async () => {
        const { ctx, requestDecision, spawnClient, stream } = createContextFixture();

        const backend = createClaudeExecutionRunBackend({
            ctx,
            executionRunParams: {
                backendId: 'claude',
                cwd: '/tmp/project',
                runId: 'run_1',
                permissionMode: 'safe-yolo',
            },
        });

        let provisionSettled = false;
        const provision = backend.provisionSession({ initialPrompt: 'review this' }).then((result) => {
            provisionSettled = true;
            return result;
        });
        await flushMicrotasks();
        await waitForCondition(() => spawnClient.mock.calls.length > 0, 'Claude SDK spawn');
        await waitForCondition(() => stream.listenerCount() > 0, 'Claude SDK stream subscription');

        expect(provisionSettled).toBe(false);
        expect(spawnClient).toHaveBeenCalledWith(expect.objectContaining({
            launch: expect.objectContaining({
                kind: 'agent-cli',
                agentId: 'claude',
                cwd: '/tmp/project',
            }),
            protocol: { kind: 'json-stream' },
            transport: { kind: 'stdio', framing: { kind: 'strict-lf-json' } },
        }), expect.anything());

        await stream.emit({
            type: 'system',
            subtype: 'init',
            session_id: 'claude-provider-session-1',
        } satisfies SDKMessage);
        await stream.emit({
            type: 'result',
            subtype: 'success',
            num_turns: 1,
            total_cost_usd: 0,
            duration_ms: 1,
            duration_api_ms: 1,
            is_error: false,
            session_id: 'claude-provider-session-1',
        });
        await expect(provision).resolves.toEqual({ sessionId: 'claude-execution-run:run_1' });
        await backend.respondToPermission?.('permission-1', true);

        expect(requestDecision).toHaveBeenCalledWith({
            provider: 'claude',
            requestId: 'permission-1',
            approved: true,
        });
        await backend.dispose();
        expect(stream.dispose).toHaveBeenCalled();
    });
});
