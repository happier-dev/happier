import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ApiSessionClient } from './apiSession';
import type { RawJSONLines } from '@/backends/claude/types';
import { decodeBase64, decrypt, encodeBase64, encrypt } from './encryption';
import { __resetToolTraceForTests } from '@/agent/tools/trace/toolTrace';

// Use vi.hoisted to ensure mock function is available when vi.mock factory runs
const { mockIo } = vi.hoisted(() => ({
    mockIo: vi.fn(),
}));

vi.mock('socket.io-client', () => ({
    io: mockIo
}));

describe('ApiSessionClient connection handling', () => {
    let mockSocket: any;
    let mockUserSocket: any;
    let consoleSpy: any;
    let mockSession: any;

    beforeEach(() => {
        consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

        // Mock socket.io client
        mockSocket = {
            connected: false,
            connect: vi.fn(),
            on: vi.fn(),
            off: vi.fn(),
            disconnect: vi.fn(),
            close: vi.fn(),
            emit: vi.fn(),
        };

        mockUserSocket = {
            connected: false,
            connect: vi.fn(),
            on: vi.fn(),
            off: vi.fn(),
            disconnect: vi.fn(),
            close: vi.fn(),
            emit: vi.fn(),
        };

        mockIo.mockReset();
        mockIo
            .mockImplementationOnce(() => mockSocket)
            .mockImplementationOnce(() => mockUserSocket)
            .mockImplementation(() => mockSocket);

        // Create a proper mock session with metadata
        mockSession = {
            id: 'test-session-id',
            seq: 0,
            metadata: {
                path: '/tmp',
                host: 'localhost',
                homeDir: '/home/user',
                happyHomeDir: '/home/user/.happy',
                happyLibDir: '/home/user/.happy/lib',
                happyToolsDir: '/home/user/.happy/tools'
            },
            metadataVersion: 0,
            agentState: null,
            agentStateVersion: 0,
            encryptionKey: new Uint8Array(32),
            encryptionVariant: 'legacy' as const
        };
    });

    afterEach(() => {
        delete process.env.HAPPIER_STACK_TOOL_TRACE;
        delete process.env.HAPPIER_STACK_TOOL_TRACE_FILE;
        __resetToolTraceForTests();
    });

    it('clears accountIdPromise on failure so later calls can retry', async () => {
        const axiosMod = await import('axios');
        const axios = axiosMod.default as any;

        const getSpy = vi
            .spyOn(axios, 'get')
            .mockRejectedValueOnce(new Error('temporary failure'))
            .mockResolvedValueOnce({ data: { id: 'acc-1' } });

        const client = new ApiSessionClient('token', mockSession);

        const first = await (client as any).getAccountId();
        expect(first).toBeNull();

        const second = await (client as any).getAccountId();
        expect(second).toBe('acc-1');

        expect(getSpy).toHaveBeenCalledTimes(2);
    });

    it('normalizes outbound ACP tool-call names and inputs to V2 canonical keys', () => {
        const client = new ApiSessionClient('fake-token', mockSession);
        client.sendAgentMessage('opencode', {
            type: 'tool-call',
            callId: 'call-1',
            name: 'execute',
            input: { command: ['bash', '-lc', 'echo hi'] },
            id: 'msg-1',
        });

        const call = mockSocket.emit.mock.calls.find((c: any[]) => c[0] === 'message');
        expect(call).toBeTruthy();
        const payload = call![1];
        const decrypted = decrypt(
            mockSession.encryptionKey,
            mockSession.encryptionVariant,
            decodeBase64(payload.message),
        ) as any;

        expect(decrypted.content.type).toBe('acp');
        expect(decrypted.content.provider).toBe('opencode');
        expect(decrypted.content.data).toMatchObject({
            type: 'tool-call',
            name: 'Bash',
            input: expect.objectContaining({ command: 'echo hi' }),
        });
    });

    it('does not emit metadata-updated after close() when a snapshot sync resolves late', async () => {
        const snapshotSync = await import('./session/snapshotSync');

        let resolveFetch!: (value: any) => void;
        const fetchPromise = new Promise<any>((resolve) => {
            resolveFetch = resolve;
        });

        const fetchSpy = vi
            .spyOn(snapshotSync, 'fetchSessionSnapshotUpdateFromServer')
            .mockReturnValue(fetchPromise as any);

        try {
            const client = new ApiSessionClient('fake-token', mockSession);
            const onMetadataUpdated = vi.fn();
            client.on('metadata-updated', onMetadataUpdated);

            const syncPromise = (client as any).syncSessionSnapshotFromServer({ reason: 'connect' });
            await client.close();

            resolveFetch({
                metadata: {
                    metadata: { ...mockSession.metadata, path: '/tmp/late' },
                    metadataVersion: mockSession.metadataVersion + 1,
                },
                agentState: null,
            });

            await syncPromise;
            expect(onMetadataUpdated).not.toHaveBeenCalled();
            expect(client.getMetadataSnapshot()?.path).toBe('/tmp');
        } finally {
            fetchSpy.mockRestore();
        }
    });

    it('ensureMetadataSnapshot waits for a decrypted snapshot when starting with metadataVersion=-1', async () => {
        const snapshotSync = await import('./session/snapshotSync');

        mockSession.metadataVersion = -1;
        mockSession.agentStateVersion = -1;
        mockSession.metadata = { ...mockSession.metadata, path: '/tmp/local' };

        let resolveFetch!: (value: any) => void;
        const fetchPromise = new Promise<any>((resolve) => {
            resolveFetch = resolve;
        });

        const fetchSpy = vi
            .spyOn(snapshotSync, 'fetchSessionSnapshotUpdateFromServer')
            .mockReturnValue(fetchPromise as any);

        try {
            const client = new ApiSessionClient('fake-token', mockSession);

            let completed = false;
            const p = client.ensureMetadataSnapshot({ timeoutMs: 10_000 }).then((meta) => {
                completed = true;
                return meta;
            });

            await new Promise((r) => setTimeout(r, 0));
            expect(completed).toBe(false);

            resolveFetch({
                metadata: {
                    metadata: { ...mockSession.metadata, path: '/tmp/remote' },
                    metadataVersion: 0,
                },
                agentState: null,
            });

            const meta = await p;
            expect(meta?.path).toBe('/tmp/remote');
            expect(client.getMetadataSnapshot()?.path).toBe('/tmp/remote');
        } finally {
            fetchSpy.mockRestore();
        }
    });

    it('backfills missing Read tool-call input details from permission-request toolCall.rawInput', () => {
        const client = new ApiSessionClient('fake-token', mockSession);

        client.sendAgentMessage('opencode', {
            type: 'permission-request',
            permissionId: 'call-1',
            toolName: 'read',
            description: 'read',
            options: {
                toolCall: {
                    rawInput: { filepath: '/etc/hosts' },
                },
            },
        });

        client.sendAgentMessage('opencode', {
            type: 'tool-call',
            callId: 'call-1',
            name: 'read',
            input: {
                locations: [],
                description: 'read',
                _acp: { kind: 'read', title: 'read', rawInput: {} },
            },
            id: 'msg-1',
        });

        const calls = mockSocket.emit.mock.calls.filter((c: any[]) => c[0] === 'message');
        const decryptedToolCall = calls
            .map((call: any[]) => {
                const payload = call[1];
                return decrypt(
                    mockSession.encryptionKey,
                    mockSession.encryptionVariant,
                    decodeBase64(payload.message),
                ) as any;
            })
            .find((msg: any) => msg?.content?.type === 'acp' && msg?.content?.data?.type === 'tool-call');

        expect(decryptedToolCall).toBeTruthy();
        expect(decryptedToolCall.content.data).toMatchObject({
            type: 'tool-call',
            name: 'Read',
            input: expect.objectContaining({ file_path: '/etc/hosts' }),
        });
    });

    it('includes server-createdAt on delivered user messages so permission precedence can be timestamped', () => {
        const client = new ApiSessionClient('fake-token', mockSession);

        const received: any[] = [];
        client.onUserMessage((msg: any) => received.push(msg));

        const plaintext = {
            role: 'user',
            content: { type: 'text', text: 'hello' },
            meta: { source: 'ui', sentFrom: 'e2e', permissionMode: 'read-only' },
        };

        const ciphertext = encodeBase64(encrypt(mockSession.encryptionKey, mockSession.encryptionVariant, plaintext));
        const update = {
            id: 'u-1',
            seq: 0,
            createdAt: 1234,
            body: {
                t: 'new-message',
                sid: mockSession.id,
                message: {
                    id: 'm-1',
                    seq: 1,
                    content: { t: 'encrypted', c: ciphertext },
                },
            },
        };

        (client as any).handleUpdate(update, { source: 'session-scoped' });

        expect(received.length).toBe(1);
        expect(received[0]).toMatchObject({
            role: 'user',
            content: { type: 'text', text: 'hello' },
            meta: { permissionMode: 'read-only' },
            createdAt: 1234,
        });
    });

    it('can resolve the latest permission intent from the encrypted transcript (legacy tokens supported)', async () => {
        const axiosMod = await import('axios');
        const axios = axiosMod.default as any;

        const client = new ApiSessionClient('fake-token', mockSession);

        const newerUser = {
            role: 'user',
            content: { type: 'text', text: 'hi' },
            meta: { source: 'ui', sentFrom: 'e2e', permissionMode: 'acceptEdits' },
        };
        const olderUser = {
            role: 'user',
            content: { type: 'text', text: 'older' },
            meta: { source: 'ui', sentFrom: 'e2e', permissionMode: 'read-only' },
        };

        const newerCipher = encodeBase64(encrypt(mockSession.encryptionKey, mockSession.encryptionVariant, newerUser));
        const olderCipher = encodeBase64(encrypt(mockSession.encryptionKey, mockSession.encryptionVariant, olderUser));

        const getSpy = vi.spyOn(axios, 'get').mockResolvedValueOnce({
            data: {
                messages: [
                    { createdAt: 200, content: { t: 'encrypted', c: newerCipher } },
                    { createdAt: 100, content: { t: 'encrypted', c: olderCipher } },
                ],
            },
        });

        const res = await client.fetchLatestUserPermissionIntentFromTranscript({ take: 25 });
        expect(res).toEqual({ intent: 'safe-yolo', updatedAt: 200 });
        expect(getSpy.mock.calls[0]?.[0]).toContain(`/v1/sessions/${mockSession.id}/messages`);
        expect(getSpy.mock.calls[0]?.[1]).toEqual(expect.objectContaining({ params: { limit: 25 } }));

        getSpy.mockRestore();
    });

    it('normalizes outbound ACP permission-request toolName to V2 canonical keys (supports TodoWrite)', () => {
        const client = new ApiSessionClient('fake-token', mockSession);

        client.sendAgentMessage('gemini', {
            type: 'permission-request',
            permissionId: 'write_todos-1',
            toolName: 'write',
            description: 'write',
            options: {},
        });

        const call = mockSocket.emit.mock.calls.find((c: any[]) => c[0] === 'message');
        expect(call).toBeTruthy();
        const payload = call![1];
        const decrypted = decrypt(
            mockSession.encryptionKey,
            mockSession.encryptionVariant,
            decodeBase64(payload.message),
        ) as any;

        expect(decrypted.content.type).toBe('acp');
        expect(decrypted.content.data).toMatchObject({
            type: 'permission-request',
            toolName: 'TodoWrite',
        });
    });

    it('backfills missing permission-request input details from nested options.toolCall.content (Gemini ACP)', () => {
        const client = new ApiSessionClient('fake-token', mockSession);

        client.sendAgentMessage('gemini', {
            type: 'permission-request',
            permissionId: 'replace-1',
            toolName: 'edit',
            description: 'edit',
            options: {
                options: {
                    toolCall: {
                        kind: 'edit',
                        title: 'Editing /tmp/a.txt',
                        locations: [{ path: '/tmp/a.txt' }],
                        content: [{ path: 'a.txt', oldText: 'hello', newText: 'hi', type: 'diff' }],
                    },
                    input: {},
                },
            },
        });

        const call = mockSocket.emit.mock.calls.find((c: any[]) => c[0] === 'message');
        expect(call).toBeTruthy();
        const payload = call![1];
        const decrypted = decrypt(
            mockSession.encryptionKey,
            mockSession.encryptionVariant,
            decodeBase64(payload.message),
        ) as any;

        expect(decrypted.content.type).toBe('acp');
        expect(decrypted.content.provider).toBe('gemini');
        expect(decrypted.content.data.type).toBe('permission-request');
        expect(decrypted.content.data.options).toMatchObject({
            options: {
                input: {
                    items: [{ path: 'a.txt', oldText: 'hello', newText: 'hi', type: 'diff' }],
                },
            },
        });
    });

    it('normalizes outbound ACP tool-result outputs using the canonical tool name for the callId', () => {
        const client = new ApiSessionClient('fake-token', mockSession);

        client.sendAgentMessage('opencode', {
            type: 'tool-call',
            callId: 'call-1',
            name: 'execute',
            input: { command: ['bash', '-lc', 'echo hi'] },
            id: 'msg-1',
        });

        client.sendAgentMessage('opencode', {
            type: 'tool-result',
            callId: 'call-1',
            output: 'TRACE_OK\n',
            id: 'msg-2',
        });

        const calls = mockSocket.emit.mock.calls.filter((c: any[]) => c[0] === 'message');
        expect(calls).toHaveLength(2);

        const payload = calls[1][1];
        const decrypted = decrypt(
            mockSession.encryptionKey,
            mockSession.encryptionVariant,
            decodeBase64(payload.message),
        ) as any;

        expect(decrypted.content.type).toBe('acp');
        expect(decrypted.content.data).toMatchObject({
            type: 'tool-result',
            callId: 'call-1',
            output: expect.objectContaining({
                stdout: 'TRACE_OK\n',
                _happier: expect.objectContaining({ v: 2, canonicalToolName: 'Bash' }),
                _raw: expect.anything(),
            }),
        });
    });

    it('backfills empty TodoWrite tool-result outputs with the requested todos', () => {
        const client = new ApiSessionClient('fake-token', mockSession);

        client.sendAgentMessage('gemini', {
            type: 'tool-call',
            callId: 'write_todos-1',
            name: 'write',
            input: { todos: [{ content: 'a', status: 'pending' }] },
            id: 'msg-1',
        });

        client.sendAgentMessage('gemini', {
            type: 'tool-result',
            callId: 'write_todos-1',
            output: [],
            id: 'msg-2',
        });

        const calls = mockSocket.emit.mock.calls.filter((c: any[]) => c[0] === 'message');
        expect(calls).toHaveLength(2);

        const payload = calls[1][1];
        const decrypted = decrypt(
            mockSession.encryptionKey,
            mockSession.encryptionVariant,
            decodeBase64(payload.message),
        ) as any;

        expect(decrypted.content.type).toBe('acp');
        expect(decrypted.content.provider).toBe('gemini');
        expect(decrypted.content.data).toMatchObject({
            type: 'tool-result',
            callId: 'write_todos-1',
            output: expect.objectContaining({
                todos: [{ content: 'a', status: 'pending' }],
            }),
        });
    });

    it('normalizes outbound Codex MCP tool-call names to V2 canonical keys', () => {
        const client = new ApiSessionClient('fake-token', mockSession);
        client.sendCodexMessage({
            type: 'tool-call',
            callId: 'call-1',
            name: 'CodexBash',
            input: { command: ['bash', '-lc', 'echo hi'] },
            id: 'msg-1',
        });

        const call = mockSocket.emit.mock.calls.find((c: any[]) => c[0] === 'message');
        expect(call).toBeTruthy();
        const payload = call![1];
        const decrypted = decrypt(
            mockSession.encryptionKey,
            mockSession.encryptionVariant,
            decodeBase64(payload.message),
        ) as any;

        expect(decrypted.content.type).toBe('codex');
        expect(decrypted.content.data).toMatchObject({
            type: 'tool-call',
            name: 'Bash',
        });
    });

    it('normalizes outbound Codex MCP tool-call-result outputs using the canonical tool name for the callId', () => {
        const client = new ApiSessionClient('fake-token', mockSession);

        client.sendCodexMessage({
            type: 'tool-call',
            callId: 'call-1',
            name: 'CodexBash',
            input: { command: ['bash', '-lc', 'echo hi'] },
            id: 'msg-1',
        });

        client.sendCodexMessage({
            type: 'tool-call-result',
            callId: 'call-1',
            output: { stdout: 'TRACE_OK\n', exit_code: 0 },
            id: 'msg-2',
        });

        const calls = mockSocket.emit.mock.calls.filter((c: any[]) => c[0] === 'message');
        expect(calls).toHaveLength(2);

        const payload = calls[1][1];
        const decrypted = decrypt(
            mockSession.encryptionKey,
            mockSession.encryptionVariant,
            decodeBase64(payload.message),
        ) as any;

        expect(decrypted.content.type).toBe('codex');
        expect(decrypted.content.data).toMatchObject({
            type: 'tool-call-result',
            callId: 'call-1',
            output: expect.objectContaining({
                stdout: 'TRACE_OK\n',
                _happier: expect.objectContaining({ v: 2, canonicalToolName: 'Bash' }),
                _raw: expect.anything(),
            }),
        });
    });

    it('should handle socket connection failure gracefully', async () => {
        // Should not throw during client creation
        // Note: socket is created with autoConnect: false, so connection happens later
        expect(() => {
            new ApiSessionClient('fake-token', mockSession);
        }).not.toThrow();
    });

    it('should emit correct events on socket connection', () => {
        const client = new ApiSessionClient('fake-token', mockSession);

        // Should have set up event listeners
        expect(mockSocket.on).toHaveBeenCalledWith('connect', expect.any(Function));
        expect(mockSocket.on).toHaveBeenCalledWith('disconnect', expect.any(Function));
        expect(mockSocket.on).toHaveBeenCalledWith('error', expect.any(Function));
    });

    it('close closes both the session-scoped and user-scoped sockets', async () => {
        const client = new ApiSessionClient('fake-token', mockSession);

        await client.close();

        expect(mockSocket.close).toHaveBeenCalledTimes(1);
        expect(mockUserSocket.close).toHaveBeenCalledTimes(1);
    });

    it('waitForMetadataUpdate ensures the user-scoped socket is connected so metadata updates can wake idle agents', async () => {
        const client = new ApiSessionClient('fake-token', mockSession);

        const controller = new AbortController();
        const promise = client.waitForMetadataUpdate(controller.signal);

        expect(mockUserSocket.connect).toHaveBeenCalledTimes(1);

        controller.abort();
        await expect(promise).resolves.toBe(false);
    });

    it('emits messages even when disconnected (socket.io will buffer)', () => {
        mockSocket.connected = false;

        const client = new ApiSessionClient('fake-token', mockSession);

        const payload: RawJSONLines = {
            type: 'user',
            uuid: 'test-uuid',
            message: {
                content: 'hello',
            },
        } as const;

        client.sendClaudeSessionMessage(payload);

        expect(mockSocket.emit).toHaveBeenCalledWith(
            'message',
            expect.objectContaining({
                sid: mockSession.id,
                message: expect.any(String),
                localId: expect.any(String),
            })
        );
    });

		    it('attaches server localId onto decrypted user messages', async () => {
		        const client = new ApiSessionClient('fake-token', mockSession);

	        const onUserMessage = vi.fn();
	        client.onUserMessage(onUserMessage);

	        const updateHandler = (mockSocket.on.mock.calls.find((call: any[]) => call[0] === 'update') ?? [])[1];
	        expect(typeof updateHandler).toBe('function');

        const plaintext = {
            role: 'user',
            content: { type: 'text', text: 'hello' },
            meta: { sentFrom: 'web' },
        };
        const encrypted = encodeBase64(encrypt(mockSession.encryptionKey, mockSession.encryptionVariant, plaintext));

        updateHandler({
            id: 'update-1',
            seq: 1,
            createdAt: Date.now(),
            body: {
                t: 'new-message',
                sid: mockSession.id,
                message: {
                    id: 'msg-1',
                    seq: 1,
                    localId: 'local-1',
                    content: { t: 'encrypted', c: encrypted },
                },
            },
        } as any);

		        expect(onUserMessage).toHaveBeenCalledWith(
		            expect.objectContaining({
		                content: expect.objectContaining({ text: 'hello' }),
		                localId: 'local-1',
		            }),
		        );
		    });

        it('delivers UI user messages from user-scoped updates even when not materialized locally', async () => {
            const client = new ApiSessionClient('fake-token', mockSession);

            const onUserMessage = vi.fn();
            client.onUserMessage(onUserMessage);

            const userUpdateHandler = (mockUserSocket.on.mock.calls.find((call: any[]) => call[0] === 'update') ?? [])[1];
            expect(typeof userUpdateHandler).toBe('function');

            const plaintext = {
                role: 'user',
                content: { type: 'text', text: 'hello from ui' },
                localId: 'local-ui-1',
                meta: { source: 'ui', sentFrom: 'e2e' },
            };
            const encrypted = encodeBase64(encrypt(mockSession.encryptionKey, mockSession.encryptionVariant, plaintext));

            userUpdateHandler({
                id: 'update-ui-1',
                seq: 1,
                createdAt: Date.now(),
                body: {
                    t: 'new-message',
                    sid: mockSession.id,
                    message: {
                        id: 'msg-ui-1',
                        seq: 1,
                        localId: 'local-ui-1',
                        content: { t: 'encrypted', c: encrypted },
                    },
                },
            } as any);

            expect(onUserMessage).toHaveBeenCalledWith(
                expect.objectContaining({
                    content: expect.objectContaining({ text: 'hello from ui' }),
                    localId: 'local-ui-1',
                }),
            );
        });

        it('does not emit user-message events when committing outbound CLI user messages (ACK is not a prompt)', async () => {
            const sessionSocket: any = {
                connected: true,
                connect: vi.fn(),
                on: vi.fn(),
                off: vi.fn(),
                disconnect: vi.fn(),
                close: vi.fn(),
                emit: vi.fn(),
                timeout: vi.fn().mockReturnThis(),
                emitWithAck: vi.fn().mockResolvedValue({
                    ok: true,
                    id: 'msg-1',
                    seq: 1,
                    localId: 'local-1',
                }),
            };

            const userSocket: any = {
                connected: false,
                connect: vi.fn(),
                on: vi.fn(),
                off: vi.fn(),
                disconnect: vi.fn(),
                close: vi.fn(),
                emit: vi.fn(),
            };

            mockIo.mockReset();
            mockIo
                .mockImplementationOnce(() => sessionSocket)
                .mockImplementationOnce(() => userSocket);

            const client = new ApiSessionClient('fake-token', mockSession);

            const onUserMessageEvent = vi.fn();
            client.on('user-message', onUserMessageEvent);

            await client.sendUserTextMessageCommitted('hello', { localId: 'local-1' });

            expect(onUserMessageEvent).not.toHaveBeenCalled();
        });

        it('does not deliver self-sent CLI user messages to onUserMessage callback (prevents ACK echo loops)', async () => {
            const client = new ApiSessionClient('fake-token', mockSession);

            const onUserMessage = vi.fn();
            client.onUserMessage(onUserMessage);

            const updateHandler = (mockSocket.on.mock.calls.find((call: any[]) => call[0] === 'update') ?? [])[1];
            expect(typeof updateHandler).toBe('function');

            const plaintext = {
                role: 'user',
                content: { type: 'text', text: 'hello from cli' },
                meta: { sentFrom: 'cli' },
            };
            const encrypted = encodeBase64(encrypt(mockSession.encryptionKey, mockSession.encryptionVariant, plaintext));

            updateHandler({
                id: 'update-2',
                seq: 2,
                createdAt: Date.now(),
                body: {
                    t: 'new-message',
                    sid: mockSession.id,
                    message: {
                        id: 'msg-2',
                        seq: 2,
                        localId: 'local-2',
                        content: { t: 'encrypted', c: encrypted },
                    },
                },
            } as any);

            expect(onUserMessage).not.toHaveBeenCalled();
        });

				    it('waitForMetadataUpdate resolves when session metadata updates', async () => {
				        const client = new ApiSessionClient('fake-token', mockSession);

				        const waitPromise = client.waitForMetadataUpdate();

	        const updateHandler = (mockSocket.on.mock.calls.find((call: any[]) => call[0] === 'update') ?? [])[1];
	        expect(typeof updateHandler).toBe('function');

	        const nextMetadata = { ...mockSession.metadata, path: '/tmp/next' };
	        const encrypted = encodeBase64(encrypt(mockSession.encryptionKey, mockSession.encryptionVariant, nextMetadata));

	        updateHandler({
	            id: 'update-2',
	            seq: 2,
	            createdAt: Date.now(),
	            body: {
	                t: 'update-session',
	                sid: mockSession.id,
	                metadata: {
	                    version: 1,
	                    value: encrypted,
	                },
	            },
	        } as any);

				        await expect(waitPromise).resolves.toBe(true);
				    });

	                it('waitForMetadataUpdate resolves when the user-scoped socket connects (wakes idle agents)', async () => {
	                    const client = new ApiSessionClient('fake-token', mockSession);

	                    const waitPromise = client.waitForMetadataUpdate();

	                    const connectHandlers = mockUserSocket.on.mock.calls
	                        .filter((call: any[]) => call[0] === 'connect')
	                        .map((call: any[]) => call[1]);
	                    const lastConnectHandler = connectHandlers[connectHandlers.length - 1];
	                    expect(typeof lastConnectHandler).toBe('function');

	                    lastConnectHandler();
	                    await expect(waitPromise).resolves.toBe(true);
	                });

                    it('waitForMetadataUpdate syncs a session snapshot on user-scoped connect so missed metadata updates are observed', async () => {
                        const client = new ApiSessionClient('fake-token', mockSession);

                        const syncSpy = vi.fn(async () => {
                            await new Promise((r) => setTimeout(r, 0));
                            (client as any).metadata = { ...(client as any).metadata, path: '/tmp/from-sync' };
                            (client as any).metadataVersion = ((client as any).metadataVersion ?? 0) + 1;
                            client.emit('metadata-updated');
                        });
                        (client as any).syncSessionSnapshotFromServer = syncSpy;

                        const waitPromise = client.waitForMetadataUpdate();

                        const connectHandlers = mockUserSocket.on.mock.calls
                            .filter((call: any[]) => call[0] === 'connect')
                            .map((call: any[]) => call[1]);
                        const lastConnectHandler = connectHandlers[connectHandlers.length - 1];
                        expect(typeof lastConnectHandler).toBe('function');

                        lastConnectHandler();

                        await expect(waitPromise).resolves.toBe(true);
                        expect(syncSpy).toHaveBeenCalled();
                        expect(client.getMetadataSnapshot()?.path).toBe('/tmp/from-sync');
                    });

            it('waitForMetadataUpdate resolves when session metadata updates (server sends update-session with id)', async () => {
                const client = new ApiSessionClient('fake-token', mockSession);

                const waitPromise = client.waitForMetadataUpdate();

                const updateHandler = (mockSocket.on.mock.calls.find((call: any[]) => call[0] === 'update') ?? [])[1];
                expect(typeof updateHandler).toBe('function');

                const nextMetadata = { ...mockSession.metadata, path: '/tmp/next2' };
                const encrypted = encodeBase64(encrypt(mockSession.encryptionKey, mockSession.encryptionVariant, nextMetadata));

                updateHandler({
                    id: 'update-2b',
                    seq: 3,
                    createdAt: Date.now(),
                    body: {
                        t: 'update-session',
                        id: mockSession.id,
                        metadata: {
                            version: 1,
                            value: encrypted,
                        },
                    },
                } as any);

	                await expect(waitPromise).resolves.toBe(true);
	            });

	            it('waitForMetadataUpdate resolves false when user-scoped socket disconnects', async () => {
	                const client = new ApiSessionClient('fake-token', mockSession);

	                const waitPromise = client.waitForMetadataUpdate();

	                const disconnectHandlers = mockUserSocket.on.mock.calls
	                    .filter((call: any[]) => call[0] === 'disconnect')
	                    .map((call: any[]) => call[1]);
	                const lastDisconnectHandler = disconnectHandlers[disconnectHandlers.length - 1];
	                expect(typeof lastDisconnectHandler).toBe('function');

	                lastDisconnectHandler();
	                await expect(waitPromise).resolves.toBe(false);
	            });

                it('waitForMetadataUpdate does not miss fast user-scoped update-session wakeups', async () => {
                    const client = new ApiSessionClient('fake-token', mockSession);

                    const updateHandler = (mockUserSocket.on.mock.calls.find((call: any[]) => call[0] === 'update') ?? [])[1];
                    expect(typeof updateHandler).toBe('function');

                    mockUserSocket.connect.mockImplementation(() => {
                        const nextMetadata = { ...mockSession.metadata, path: '/tmp/fast' };
                        const encrypted = encodeBase64(encrypt(mockSession.encryptionKey, mockSession.encryptionVariant, nextMetadata));
                        updateHandler({
                            id: 'update-fast',
                            seq: 999,
                            createdAt: Date.now(),
                            body: {
                                t: 'update-session',
                                sid: mockSession.id,
                                metadata: {
                                    version: 2,
                                    value: encrypted,
                                },
                            },
                        } as any);
                    });

                    const controller = new AbortController();
                    const promise = client.waitForMetadataUpdate(controller.signal);

                    queueMicrotask(() => controller.abort());
                    await expect(promise).resolves.toBe(true);
                });

                it('waitForMetadataUpdate does not miss snapshot sync updates started before handlers attach', async () => {
                    const client = new ApiSessionClient('fake-token', mockSession);

                    (client as any).metadataVersion = -1;
                    (client as any).agentStateVersion = -1;

                    (client as any).syncSessionSnapshotFromServer = () => {
                        (client as any).metadataVersion = 1;
                        (client as any).agentStateVersion = 1;
                        client.emit('metadata-updated');
                        return Promise.resolve();
                    };

                    const promise = client.waitForMetadataUpdate();
                    await expect(
                        Promise.race([
                            promise,
                            new Promise((_, reject) =>
                                setTimeout(() => reject(new Error('waitForMetadataUpdate() hung after snapshot sync')), 50)
                            )
                        ])
                    ).resolves.toBe(true);
                });

	            it('updateMetadata syncs a snapshot first when metadataVersion is unknown', async () => {
	                const sessionSocket: any = {
	                    connected: false,
                    connect: vi.fn(),
                    on: vi.fn(),
                    off: vi.fn(),
                    disconnect: vi.fn(),
                    close: vi.fn(),
                    emit: vi.fn(),
                };

                const userSocket: any = {
                    connected: false,
                    connect: vi.fn(),
                    on: vi.fn(),
                    off: vi.fn(),
                    disconnect: vi.fn(),
                    close: vi.fn(),
                    emit: vi.fn(),
                };

                const serverMetadata = {
                    ...mockSession.metadata,
                    tools: ['tool-1'],
                };
                const encryptedServerMetadata = encodeBase64(encrypt(mockSession.encryptionKey, mockSession.encryptionVariant, serverMetadata));

                const emitWithAck = vi.fn().mockResolvedValueOnce({
                    result: 'success',
                    version: 6,
                    metadata: encryptedServerMetadata,
                });
                sessionSocket.emitWithAck = emitWithAck;

                mockIo.mockReset();
                mockIo
                    .mockImplementationOnce(() => sessionSocket)
                    .mockImplementationOnce(() => userSocket);

                const axiosMod = await import('axios');
                const axios = axiosMod.default as any;
                vi.spyOn(axios, 'get').mockResolvedValueOnce({
                    status: 200,
                    data: {
                        session: {
                            id: mockSession.id,
                            metadataVersion: 5,
                            metadata: encryptedServerMetadata,
                            agentStateVersion: 0,
                            agentState: null,
                        },
                    },
                });

                const client = new ApiSessionClient('fake-token', {
                    ...mockSession,
                    metadataVersion: -1,
                    metadata: {
                        ...mockSession.metadata,
                        tools: [],
                    },
                });

                let observedToolsFromSnapshot = false;
                client.updateMetadata((metadata) => {
                    observedToolsFromSnapshot = Array.isArray((metadata as any).tools) && (metadata as any).tools.length === 1;
                    return metadata;
                });

                await vi.waitFor(() => {
                    expect(observedToolsFromSnapshot).toBe(true);
                    expect(emitWithAck).toHaveBeenCalledWith(
                        'update-metadata',
                        expect.objectContaining({ expectedVersion: 5 }),
                    );
                });
            });

	    afterEach(() => {
	        consoleSpy.mockRestore();
	        vi.restoreAllMocks();
	    });
});
