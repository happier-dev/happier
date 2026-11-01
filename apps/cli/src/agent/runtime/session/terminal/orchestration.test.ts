import { describe, expect, it, vi } from 'vitest';

import { MessageQueue2 } from '@/agent/runtime/modeMessageQueue';
import { RpcHandlerManager } from '@/api/rpc/RpcHandlerManager';

import { createTerminalRuntimeHostOrchestration } from './orchestration';

describe('createTerminalRuntimeHostOrchestration', () => {
    it('composes sanitized input and switch delivery through the host runtime owners', async () => {
        const messageQueue = new MessageQueue2<{ permissionMode: string }, { text: string }>(
            (mode) => mode.permissionMode,
        );
        const rpcHandlerManager = new RpcHandlerManager({
            scopePrefix: 'terminal-orchestration', encryptionMode: 'plain',
        });
        const session = { rpcHandlerManager };
        const process = Object.freeze({ launch: vi.fn() });
        const projection = Object.freeze({
            publishControlState: vi.fn(),
            publishProviderSessionId: vi.fn(),
            publishSubagentStarted: vi.fn(),
            publishSubagentCompleted: vi.fn(),
        });
        const transcriptFollow = Object.freeze({
            bindProviderSession: vi.fn(),
            releaseActiveBindings: vi.fn(),
        });

        const host = createTerminalRuntimeHostOrchestration({
            messageQueue,
            session,
            process,
            projection,
            transcriptFollow,
        });

        expect(host).toEqual({
            input: expect.objectContaining({ subscribe: expect.any(Function) }),
            switching: expect.objectContaining({ register: expect.any(Function) }),
            process,
            projection,
            transcriptFollow,
        });
        if (!host) throw new Error('Expected host terminal orchestration');
        const inputs: unknown[] = [];
        const switches: unknown[] = [];
        const inputSubscription = host.input.subscribe((trigger) => { inputs.push(trigger); });
        const switchSubscription = host.switching.register(async (request) => {
            switches.push(request);
            return true;
        });
        try {
            messageQueue.push({ text: 'private prompt' }, { permissionMode: 'default' });
            expect(inputs).toEqual([{ sequence: 1 }]);
            await expect(rpcHandlerManager.handleRequest({
                method: 'terminal-orchestration:switch',
                params: { to: 'remote', privateContext: 'do not disclose' },
            })).resolves.toBe(true);
            expect(switches).toEqual([{ target: 'remote' }]);

            inputSubscription.unsubscribe();
            switchSubscription.unsubscribe();
            messageQueue.push({ text: 'after unsubscribe' }, { permissionMode: 'default' });
            await expect(rpcHandlerManager.handleRequest({
                method: 'terminal-orchestration:switch', params: { to: 'local' },
            })).resolves.toBe(false);
            expect(inputs).toEqual([{ sequence: 1 }]);
            expect(switches).toEqual([{ target: 'remote' }]);
        } finally {
            inputSubscription.unsubscribe();
            switchSubscription.unsubscribe();
            rpcHandlerManager.onSocketDisconnect();
            messageQueue.close();
        }
    });

    it('does not create host orchestration without terminal projection services', () => {
        const messageQueue = new MessageQueue2<{ permissionMode: string }, { text: string }>(
            (mode) => mode.permissionMode,
        );
        const session = {
            rpcHandlerManager: {
                registerHandler: vi.fn(),
            },
        };
        const process = Object.freeze({ launch: vi.fn() });
        expect(createTerminalRuntimeHostOrchestration({
            messageQueue,
            session,
            process,
        })).toBeNull();
    });

    it('does not create host orchestration without a host session message queue', () => {
        const session = {
            rpcHandlerManager: {
                registerHandler: vi.fn(),
            },
        };
        const process = Object.freeze({ launch: vi.fn() });
        expect(createTerminalRuntimeHostOrchestration({
            session,
            process,
        })).toBeNull();
    });

    it('does not create default process orchestration without a host executable grant verifier', () => {
        const messageQueue = new MessageQueue2<{ permissionMode: string }, { text: string }>(
            (mode) => mode.permissionMode,
        );
        const session = {
            rpcHandlerManager: {
                registerHandler: vi.fn(),
            },
        };

        expect(createTerminalRuntimeHostOrchestration({
            messageQueue,
            session,
        })).toBeNull();
    });

    it('creates default process orchestration with a host executable grant verifier', () => {
        const messageQueue = new MessageQueue2<{ permissionMode: string }, { text: string }>(
            (mode) => mode.permissionMode,
        );
        const session = {
            rpcHandlerManager: {
                registerHandler: vi.fn(),
            },
        };
        const projection = Object.freeze({
            publishControlState: vi.fn(),
            publishProviderSessionId: vi.fn(),
            publishSubagentStarted: vi.fn(),
            publishSubagentCompleted: vi.fn(),
        });

        const host = createTerminalRuntimeHostOrchestration({
            messageQueue,
            session,
            projection,
            verifyExecutableGrant: vi.fn(() => true),
        });

        expect(host?.process).toEqual(expect.objectContaining({ launch: expect.any(Function) }));
    });
});
