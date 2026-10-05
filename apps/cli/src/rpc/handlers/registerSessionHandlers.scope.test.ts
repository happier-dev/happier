import { describe, expect, it } from 'vitest';

import type { RpcHandler, RpcHandlerRegistrar } from '@/api/rpc/types';
import {
    RPC_METHODS,
    SESSION_RPC_METHODS,
    resolveSocketRpcSessionAuthorization,
} from '@happier-dev/protocol/rpc';

import { registerSessionHandlers } from './registerSessionHandlers';

describe('shared RPC registration scope', () => {
    it('registers Session-only methods only with a bound Session, preserving common machine methods', async () => {
        const machine = new Map<string, RpcHandler>();
        const session = new Map<string, RpcHandler>();
        const registrar = (handlers: Map<string, RpcHandler>): RpcHandlerRegistrar => ({
            registerHandler(method, handler) { handlers.set(method, handler); },
        });
        const enqueueSessionUserMessage = async () => undefined;
        const machineRegistration = registerSessionHandlers(registrar(machine), process.cwd(), { enqueueSessionUserMessage });
        const sessionRegistration = registerSessionHandlers(registrar(session), process.cwd(), {
            sessionId: 'session-1', enqueueSessionUserMessage,
        });
        try {
            const machineMethods = [...machine.keys()];
            const sessionMethods = [...session.keys()];
            const sessionOnlyMethods = sessionMethods.filter((method) =>
                resolveSocketRpcSessionAuthorization(method)?.routeToSessionOwnerDaemon === true);
            expect(sessionOnlyMethods).toEqual(expect.arrayContaining([
                SESSION_RPC_METHODS.SESSION_USER_MESSAGE_SEND,
                SESSION_RPC_METHODS.SESSION_GOAL_GET,
                RPC_METHODS.TRANSCRIPT_PAGE,
            ]));
            expect(machineMethods.filter((method) =>
                resolveSocketRpcSessionAuthorization(method)?.routeToSessionOwnerDaemon === true)).toEqual([]);
            expect(machineMethods).toEqual(sessionMethods.filter((method) =>
                resolveSocketRpcSessionAuthorization(method)?.routeToSessionOwnerDaemon !== true));
            expect(machineMethods).toContain(RPC_METHODS.CAPABILITIES_DESCRIBE);
            expect(machineMethods).toContain(RPC_METHODS.BASH);
        } finally {
            await machineRegistration.dispose();
            await sessionRegistration.dispose();
        }
    });
});
