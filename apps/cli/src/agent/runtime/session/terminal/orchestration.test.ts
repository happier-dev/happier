import { describe, expect, it, vi } from 'vitest';

import { MessageQueue2 } from '@/agent/runtime/modeMessageQueue';

import { createTerminalRuntimeHostOrchestration } from './orchestration';

describe('createTerminalRuntimeHostOrchestration', () => {
    it('creates the complete host-owned terminal orchestration surface from session runtime owners', () => {
        const messageQueue = new MessageQueue2<{ permissionMode: string }, { text: string }>(
            (mode) => mode.permissionMode,
        );
        const session = {
            rpcHandlerManager: {
                registerHandler: vi.fn(),
            },
        };
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
