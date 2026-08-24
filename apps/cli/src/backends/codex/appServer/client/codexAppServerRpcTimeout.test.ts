import { describe, expect, it } from 'vitest';

import {
    readCodexAppServerRequestTimeoutMs,
    readCodexAppServerRpcTimeoutMs,
    readCodexAppServerStartupRpcTimeoutMs,
} from './codexAppServerRpcTimeout';

describe('codexAppServerRpcTimeout', () => {
    it('defaults base RPC timeout to 15s when unset', () => {
        expect(readCodexAppServerRpcTimeoutMs({} as NodeJS.ProcessEnv)).toBe(15_000);
    });

    it('clamps base RPC timeout to the configured value when set', () => {
        expect(readCodexAppServerRpcTimeoutMs({ HAPPIER_CODEX_APP_SERVER_RPC_TIMEOUT_MS: '1200' } as NodeJS.ProcessEnv)).toBe(1200);
        expect(readCodexAppServerRpcTimeoutMs({ HAPPIER_CODEX_APP_SERVER_RPC_TIMEOUT_MS: '0' } as NodeJS.ProcessEnv)).toBe(15_000);
        expect(readCodexAppServerRpcTimeoutMs({ HAPPIER_CODEX_APP_SERVER_RPC_TIMEOUT_MS: '-5' } as NodeJS.ProcessEnv)).toBe(15_000);
        expect(readCodexAppServerRpcTimeoutMs({ HAPPIER_CODEX_APP_SERVER_RPC_TIMEOUT_MS: '9999999' } as NodeJS.ProcessEnv)).toBe(60_000);
    });

    it('keeps provider resume requests alive while preserving bounded initialize and thread/start requests', () => {
        const env = {
            HAPPIER_CODEX_APP_SERVER_RPC_TIMEOUT_MS: '1200',
            HAPPIER_CODEX_APP_SERVER_STARTUP_RPC_TIMEOUT_MS: '20000',
        } as NodeJS.ProcessEnv;

        expect(readCodexAppServerRequestTimeoutMs('initialize', env)).toBe(20_000);
        expect(readCodexAppServerRequestTimeoutMs('thread/start', env)).toBe(20_000);
        expect(readCodexAppServerRequestTimeoutMs('thread/resume', env)).toBeNull();
        expect(readCodexAppServerRequestTimeoutMs('model/list', env)).toBe(1200);
    });

    it('defaults initialize and thread/start to the shared 60s startup budget', () => {
        expect(readCodexAppServerStartupRpcTimeoutMs({} as NodeJS.ProcessEnv)).toBe(60_000);
        expect(readCodexAppServerRequestTimeoutMs('initialize', {} as NodeJS.ProcessEnv)).toBe(60_000);
        expect(readCodexAppServerRequestTimeoutMs('thread/start', {} as NodeJS.ProcessEnv)).toBe(60_000);
    });

    it('keeps provider-native fork requests alive without inflating ordinary RPCs', () => {
        const env = {
            HAPPIER_CODEX_APP_SERVER_RPC_TIMEOUT_MS: '1200',
        } as NodeJS.ProcessEnv;

        expect(readCodexAppServerRequestTimeoutMs('thread/fork', env)).toBeNull();
        expect(readCodexAppServerRequestTimeoutMs('conversation/fork', env)).toBeNull();
        expect(readCodexAppServerRequestTimeoutMs('model/list', env)).toBe(1200);
    });

    it('ensures startup timeout is never lower than the base timeout', () => {
        const env = {
            HAPPIER_CODEX_APP_SERVER_RPC_TIMEOUT_MS: '25000',
            HAPPIER_CODEX_APP_SERVER_STARTUP_RPC_TIMEOUT_MS: '20000',
        } as NodeJS.ProcessEnv;

        expect(readCodexAppServerStartupRpcTimeoutMs(env)).toBe(25_000);
        expect(readCodexAppServerRequestTimeoutMs('thread/start', env)).toBe(25_000);
    });
});
