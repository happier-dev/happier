import { describe, expect, it, vi } from 'vitest';
import * as credentialPersistence from '@/persistence';

import type { RpcHandler, RpcHandlerRegistrar } from '@/api/rpc/types';
import {
    RPC_METHODS,
    SESSION_RPC_METHODS,
    resolveSocketRpcSessionAuthorization,
} from '@happier-dev/protocol/rpc';

import { registerSessionHandlers } from './registerSessionHandlers';

describe('shared RPC registration scope', () => {
    it('serves the mediated pending read at the production Session address without borrowing unauthenticated credentials', async () => {
        // Credential storage and the incoming RPC are system boundaries; the
        // production registrar and Action transport admission remain real.
        const credentials = vi.spyOn(credentialPersistence, 'readStoredCredentials').mockResolvedValue(null);
        const handlers = new Map<string, RpcHandler>();
        const registration = registerSessionHandlers({
            registerHandler(method, handler) { handlers.set(method, handler); },
        }, process.cwd(), { sessionId: 'session-1' });
        try {
            const result = await handlers.get('session.permission.remote.pending.list')?.({
                kind: 'targeted_action_rpc', v: 1,
                target: { kind: 'session', sessionId: 'session-1' },
                pluginCaller: { pluginId: 'happier.channels', contributionLocalId: 'outward-delivery' },
                input: { sessionId: 'session-1', sourceRef: 'channels:binding:binding-1', sourceRevisionOrEpoch: '1:1' },
            }, {
                signal: new AbortController().signal,
                authorization: { kind: 'session.write', sessionId: 'session-1' },
            });
            expect(result).toMatchObject({ ok: false, errorCode: 'not_authenticated' });
        } finally {
            await registration.dispose();
            credentials.mockRestore();
        }
    });

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
