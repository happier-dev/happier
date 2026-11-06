import { afterEach, describe, expect, it } from 'vitest';

import { PUBLIC_RPC_HANDLER_ERROR_CODES, PublicRpcHandlerError, toSocketRpcTargetFailureV1 } from '@happier-dev/protocol/rpcErrors';
import { createSessionFixture } from '@/dev/testkit';
import { storage } from '@/sync/domains/state/storage';
import { Encryption } from '@/sync/encryption/encryption';

import { apiSocket } from './apiSocket';

const initialStorageState = storage.getState();
const initialSocket = Reflect.get(apiSocket, 'socket');
const initialEncryption = Reflect.get(apiSocket, 'encryption');
const errorCode = PUBLIC_RPC_HANDLER_ERROR_CODES.STRUCTURED_QUESTION_SUBMISSION_UNCONFIRMED;
const failure = toSocketRpcTargetFailureV1(new PublicRpcHandlerError(errorCode));

afterEach(() => {
    storage.setState(initialStorageState, true);
    Reflect.set(apiSocket, 'socket', initialSocket);
    Reflect.set(apiSocket, 'encryption', initialEncryption);
});

describe('RPC target failures inside successful relay responses', () => {
    it.each(['plain', 'e2ee'] as const)('rejects the safe target failure after %s session transport decoding', async (mode) => {
        storage.getState().applySessions([createSessionFixture({ id: 'session-1', encryptionMode: mode })]);
        const encryption = await Encryption.create(new Uint8Array(32).fill(1));
        await encryption.initializeSessions(new Map([['session-1', null]]));
        const cipher = encryption.getSessionEncryption('session-1');
        if (!cipher) throw new Error('Expected initialized session encryption');
        const result = mode === 'plain' ? failure : await cipher.encryptRaw(failure);

        // Inject only the socket boundary; session RPC and encryption execute their real implementations.
        Reflect.set(apiSocket, 'socket', { emitWithAck: async () => ({ ok: true, result }) });
        Reflect.set(apiSocket, 'encryption', encryption);

        await expect(apiSocket.sessionRPC('session-1', 'user_action.respond', { requestId: 'question-1' }))
            .rejects.toMatchObject({ name: 'RpcError', rpcErrorCode: errorCode, message: failure.error });
    });

    it.each(['plain', 'e2ee'] as const)('rejects safe failures while retaining ordinary %s machine results', async (mode) => {
        const encryption = await Encryption.create(new Uint8Array(32).fill(1));
        await encryption.initializeMachines(new Map([['machine-1', null]]), {
            plainMachineIds: mode === 'plain' ? new Set(['machine-1']) : undefined,
        });
        const cipher = encryption.getMachineEncryption('machine-1');
        if (!cipher) throw new Error('Expected initialized machine encryption');
        const encode = (value: unknown) => mode === 'plain' ? value : cipher.encryptRaw(value);

        await expect(cipher.decodeRpcResult(await encode(failure)))
            .rejects.toMatchObject({ name: 'RpcError', rpcErrorCode: errorCode, message: failure.error });

        for (const businessResult of [false, { ok: false, error: 'business result' }, { error: 'business result', errorCode }]) {
            await expect(cipher.decodeRpcResult(await encode(businessResult))).resolves.toEqual(businessResult);
        }
    });
});
