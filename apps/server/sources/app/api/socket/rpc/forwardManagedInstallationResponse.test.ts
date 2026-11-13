import type { Server, Socket } from 'socket.io';
import { describe, expect, it } from 'vitest';
import { RPC_ERROR_CODES } from '@happier-dev/protocol/rpcErrors';
import { RPC_METHODS } from '@happier-dev/protocol/rpc/methods';
import { forwardManagedInstallationResponse } from './forwardManagedInstallationResponse';

describe('forwardManagedInstallationResponse', () => {
    it('refuses a controller-less installation response instead of failing the socket call', async () => {
        const params = { id: 'tool.systemTasks', method: 'respond', params: {
            homeId: 'home', managedId: 'managed', requestId: 'request', operationId: 'operation', taskId: 'task',
            expectedIntentRevision: 0, resource: { contributionRef: { pluginId: 'fixture.cloud', localId: 'cloud' }, schemaVersion: 1, value: {} },
            expectedPromptKind: 'auth.approveRemoteProvisioning', answer: true } };
        // Socket.IO is the transport boundary; a controller-less request is refused before either is read.
        const io = {} as Server;
        const socket = { id: 'caller', data: {} } as Socket;
        await expect(forwardManagedInstallationResponse({ io, socket, actorAccountId: 'account', inboundAuthorization: undefined,
            method: `machine:${RPC_METHODS.CAPABILITIES_INVOKE}`, params, timeoutMs: null }))
            .resolves.toMatchObject({ ok: false, errorCode: RPC_ERROR_CODES.FORBIDDEN });
    });
});
