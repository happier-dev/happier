import { describe, expect, it } from 'vitest';

import { SESSION_RPC_METHODS } from '@happier-dev/protocol/rpc';
import { forwardedRpcTargetResponse } from './forwardedRpcTargetResponse';

const publicFailure = {
    type: 'socket-rpc-target-failure-v1',
    errorCode: 'STRUCTURED_QUESTION_RECEIVER_NOT_OWNER',
    error: 'This answer could not be handled safely. Update or reconnect Happier, then try again.',
} as const;

describe('forwardedRpcTargetResponse', () => {
    it.each([
        SESSION_RPC_METHODS.SESSION_PERMISSION_RESPOND_LEGACY,
        SESSION_RPC_METHODS.SESSION_STRUCTURED_QUESTION_RESPOND_V1,
    ])('converts allowlisted public failures for %s to the outer RPC failure', (suffix) => {
        expect(forwardedRpcTargetResponse({ method: `session-1:${suffix}`, targetResponse: publicFailure })).toEqual({
            ok: false,
            errorCode: publicFailure.errorCode,
            error: publicFailure.error,
        });
    });

    it('does not interpret the envelope for unrelated methods', () => {
        expect(forwardedRpcTargetResponse({ method: 'session-1:session.userMessage.send', targetResponse: publicFailure })).toEqual({
            ok: true,
            result: publicFailure,
        });
    });

    it('rejects forged codes and extra payload fields', () => {
        expect(forwardedRpcTargetResponse({
            method: `session-1:${SESSION_RPC_METHODS.SESSION_PERMISSION_RESPOND_LEGACY}`,
            targetResponse: { ...publicFailure, errorCode: 'SECRET', question: 'private' },
        })).toEqual({
            ok: true,
            result: { ...publicFailure, errorCode: 'SECRET', question: 'private' },
        });
    });
});
