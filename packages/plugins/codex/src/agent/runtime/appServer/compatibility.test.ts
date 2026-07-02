import { describe, expect, it } from 'vitest';

import {
    createCodexAppServerRpcError,
    isCodexAppServerInvalidParamsForFieldError,
    isCodexAppServerMethodNotFoundError,
    isCodexAppServerNoActiveTurnToSteerError,
    shouldRetryCodexAppServerRequestWithoutExperimentalParams,
} from './compatibility';

describe('Codex app-server compatibility predicates', () => {
    it('recognizes method-not-found and invalid-params compatibility failures', () => {
        expect(isCodexAppServerMethodNotFoundError(createCodexAppServerRpcError({
            method: 'plugin/list',
            code: -32601,
        }))).toBe(true);
        expect(isCodexAppServerInvalidParamsForFieldError(createCodexAppServerRpcError({
            method: 'turn/start',
            code: -32602,
            data: { field: 'structuredInput' },
        }), 'structuredInput')).toBe(true);
    });

    it('recognizes no-active-turn steer failures without widening other methods', () => {
        expect(isCodexAppServerNoActiveTurnToSteerError(createCodexAppServerRpcError({
            method: 'turn/steer',
            message: 'No active turn to steer',
        }))).toBe(true);
        expect(isCodexAppServerNoActiveTurnToSteerError(createCodexAppServerRpcError({
            method: 'turn/start',
            message: 'No active turn to steer',
        }))).toBe(false);
    });

    it('keeps experimental-parameter retry policy in the provider leaf', () => {
        expect(shouldRetryCodexAppServerRequestWithoutExperimentalParams(createCodexAppServerRpcError({
            method: 'thread/start',
            code: -32602,
            message: 'Invalid params: experimental field unsupported',
        }))).toBe(true);
    });
});
