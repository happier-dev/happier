import { describe, it, expect, vi, beforeEach } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';

import { ApiSessionClient } from './apiSession';
import { createMockSession, withToolTraceFile } from './testkit/apiSessionTestkit';

const { mockIo } = vi.hoisted(() => ({
    mockIo: vi.fn(),
}));

vi.mock('socket.io-client', () => ({
    io: mockIo,
}));

function createSocketStub() {
    return {
        connected: false,
        connect: vi.fn(),
        on: vi.fn(),
        off: vi.fn(),
        disconnect: vi.fn(),
        close: vi.fn(),
        emit: vi.fn(),
    };
}

describe('ApiSessionClient tool tracing', () => {
    let sessionSocket: any;
    let userSocket: any;
    let mockSession: any;

    beforeEach(() => {
        sessionSocket = createSocketStub();
        userSocket = createSocketStub();
        mockSession = createMockSession();

        mockIo.mockReset();
        mockIo
            .mockImplementationOnce(() => sessionSocket)
            .mockImplementationOnce(() => userSocket)
            .mockImplementation(() => sessionSocket);
    });

    it('records ACP task_complete events to tool trace when tracing is enabled', async () => {
        await withToolTraceFile('happy-acp-task-complete-', async (filePath) => {
            const client = new ApiSessionClient('fake-token', mockSession);
            client.sendAgentMessage('opencode', { type: 'task_complete', id: 'tc_1' });

            const lines = readFileSync(filePath, 'utf8')
                .trim()
                .split('\n')
                .filter(Boolean);
            expect(lines).toHaveLength(1);
            const evt = JSON.parse(lines[0] as string) as any;
            expect(evt).toMatchObject({
                v: 1,
                direction: 'outbound',
                sessionId: mockSession.id,
                protocol: 'acp',
                provider: 'opencode',
                kind: 'task_complete',
                payload: { type: 'task_complete' },
            });
        });
    });

    it('records outbound ACP tool messages when tool tracing is enabled', async () => {
        await withToolTraceFile('happy-tool-trace-apiSession-', async (filePath) => {
            const client = new ApiSessionClient('fake-token', mockSession);
            client.sendAgentMessage('codex', {
                type: 'tool-call',
                callId: 'call-1',
                name: 'read',
                input: { filePath: '/etc/hosts' },
                id: 'msg-1',
            });

            const raw = readFileSync(filePath, 'utf8');
            const lines = raw.trim().split('\n');
            expect(lines).toHaveLength(1);
            expect(JSON.parse(lines[0] as string)).toMatchObject({
                v: 1,
                direction: 'outbound',
                sessionId: 'test-session-id',
                protocol: 'acp',
                provider: 'codex',
                kind: 'tool-call',
            });
        });
    });

    it('sets isError on outbound ACP tool-result messages when output looks like an error', async () => {
        await withToolTraceFile('happy-tool-trace-apiSession-', async (filePath) => {
            const client = new ApiSessionClient('fake-token', mockSession);
            client.sendAgentMessage('gemini', {
                type: 'tool-result',
                callId: 'call-1',
                output: { error: 'Tool call failed', status: 'failed' },
                id: 'msg-1',
            });

            const raw = readFileSync(filePath, 'utf8');
            const lines = raw.trim().split('\n');
            expect(lines).toHaveLength(1);
            expect(JSON.parse(lines[0] as string)).toMatchObject({
                protocol: 'acp',
                provider: 'gemini',
                kind: 'tool-result',
                payload: expect.objectContaining({
                    type: 'tool-result',
                    isError: true,
                }),
            });
        });
    });

    it('does not record outbound ACP non-tool messages when tool tracing is enabled', async () => {
        await withToolTraceFile('happy-tool-trace-apiSession-', async (filePath) => {
            const client = new ApiSessionClient('fake-token', mockSession);
            client.sendAgentMessage('codex', {
                type: 'message',
                message: 'hello',
            });

            expect(existsSync(filePath)).toBe(false);
        });
    });

    it('records Claude tool_use/tool_result blocks when tool tracing is enabled', async () => {
        await withToolTraceFile('happy-tool-trace-claude-', async (filePath) => {
            const client = new ApiSessionClient('fake-token', mockSession);
            client.sendClaudeSessionMessage({
                type: 'assistant',
                uuid: 'uuid-1',
                message: {
                    content: [
                        { type: 'tool_use', id: 'toolu_1', name: 'Read', input: { file_path: '/etc/hosts' } },
                        { type: 'tool_result', tool_use_id: 'toolu_1', content: 'ok' },
                    ],
                },
            } as any);

            const raw = readFileSync(filePath, 'utf8');
            const lines = raw.trim().split('\n');
            expect(lines).toHaveLength(2);
            expect(JSON.parse(lines[0] as string)).toMatchObject({
                v: 1,
                direction: 'outbound',
                sessionId: 'test-session-id',
                protocol: 'claude',
                provider: 'claude',
                kind: 'tool-call',
            });
            expect(JSON.parse(lines[1] as string)).toMatchObject({
                v: 1,
                direction: 'outbound',
                sessionId: 'test-session-id',
                protocol: 'claude',
                provider: 'claude',
                kind: 'tool-result',
            });
        });
    });

    it('records Claude tool_result blocks sent as user messages when tool tracing is enabled', async () => {
        await withToolTraceFile('happy-tool-trace-claude-user-tool-result-', async (filePath) => {
            const session = createMockSession({ id: 'test-session-id-user-tool-result' });
            const client = new ApiSessionClient('fake-token', session);
            client.sendClaudeSessionMessage({
                type: 'user',
                uuid: 'uuid-2',
                message: {
                    content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: 'ok' }],
                },
            } as any);

            const raw = existsSync(filePath) ? readFileSync(filePath, 'utf8') : '';
            const lines = raw.trim().length > 0 ? raw.trim().split('\n') : [];
            const parsed = lines.map((line) => JSON.parse(line));
            expect(parsed).toContainEqual(expect.objectContaining({
                v: 1,
                direction: 'outbound',
                sessionId: 'test-session-id-user-tool-result',
                protocol: 'claude',
                provider: 'claude',
                kind: 'tool-result',
                payload: expect.objectContaining({
                    type: 'tool_result',
                    tool_use_id: 'toolu_1',
                }),
            }));
        });
    });

    it('does not record Claude user text messages when tool tracing is enabled', async () => {
        await withToolTraceFile('happy-tool-trace-claude-', async (filePath) => {
            const client = new ApiSessionClient('fake-token', mockSession);
            client.sendClaudeSessionMessage({
                type: 'user',
                uuid: 'uuid-2',
                message: { content: 'hello' },
            } as any);

            expect(existsSync(filePath)).toBe(false);
        });
    });
});
