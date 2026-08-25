import { describe, expect, it } from 'vitest';

import {
    readCodexAppServerRealtimeStartTimeoutMs,
    readCodexAppServerRequestTimeoutMs,
    readCodexAppServerResumeRecoveryTimeoutMs,
    readCodexAppServerRpcTimeoutMs,
    readCodexAppServerStartupRpcTimeoutMs,
} from './timeout';

describe('codex app-server RPC timeout policy', () => {
    it('defaults base RPC timeout to 15s when unset', () => {
        expect(readCodexAppServerRpcTimeoutMs({})).toBe(15_000);
    });

    it('clamps base RPC timeout to the configured value when set', () => {
        expect(readCodexAppServerRpcTimeoutMs({ HAPPIER_CODEX_APP_SERVER_RPC_TIMEOUT_MS: '1200' })).toBe(1200);
        expect(readCodexAppServerRpcTimeoutMs({ HAPPIER_CODEX_APP_SERVER_RPC_TIMEOUT_MS: '0' })).toBe(15_000);
        expect(readCodexAppServerRpcTimeoutMs({ HAPPIER_CODEX_APP_SERVER_RPC_TIMEOUT_MS: '-5' })).toBe(15_000);
        expect(readCodexAppServerRpcTimeoutMs({ HAPPIER_CODEX_APP_SERVER_RPC_TIMEOUT_MS: '9999999' })).toBe(60_000);
    });

    it('keeps provider resume requests alive while preserving bounded initialize and thread/start requests', () => {
        const env = {
            HAPPIER_CODEX_APP_SERVER_RPC_TIMEOUT_MS: '1200',
            HAPPIER_CODEX_APP_SERVER_STARTUP_RPC_TIMEOUT_MS: '20000',
        };

        expect(readCodexAppServerRequestTimeoutMs('initialize', env)).toBe(20_000);
        expect(readCodexAppServerRequestTimeoutMs('thread/start', env)).toBe(20_000);
        expect(readCodexAppServerRequestTimeoutMs('thread/resume', env)).toBeNull();
        expect(readCodexAppServerRequestTimeoutMs('model/list', env)).toBe(1200);
    });

    it('defaults initialize and thread/start to the shared 60s startup budget', () => {
        expect(readCodexAppServerStartupRpcTimeoutMs({})).toBe(60_000);
        expect(readCodexAppServerRequestTimeoutMs('initialize', {})).toBe(60_000);
        expect(readCodexAppServerRequestTimeoutMs('thread/start', {})).toBe(60_000);
    });

    it('keeps provider-native fork requests alive without inflating ordinary RPCs', () => {
        const env = {
            HAPPIER_CODEX_APP_SERVER_RPC_TIMEOUT_MS: '1200',
        };

        expect(readCodexAppServerRequestTimeoutMs('thread/fork', env)).toBeNull();
        expect(readCodexAppServerRequestTimeoutMs('conversation/fork', env)).toBeNull();
        expect(readCodexAppServerRequestTimeoutMs('model/list', env)).toBe(1200);
    });

    it('uses the evidence-backed 45s timeout for realtime start admission and settlement', () => {
        const settlementTimeoutMs = readCodexAppServerRealtimeStartTimeoutMs({});

        expect(settlementTimeoutMs).toBe(45_000);
        expect(readCodexAppServerRequestTimeoutMs('thread/realtime/start', {}))
            .toBe(settlementTimeoutMs);
    });

    it('ensures startup timeout is never lower than the base timeout', () => {
        const env = {
            HAPPIER_CODEX_APP_SERVER_RPC_TIMEOUT_MS: '25000',
            HAPPIER_CODEX_APP_SERVER_STARTUP_RPC_TIMEOUT_MS: '20000',
        };

        expect(readCodexAppServerStartupRpcTimeoutMs(env)).toBe(25_000);
        expect(readCodexAppServerRequestTimeoutMs('thread/start', env)).toBe(25_000);
    });

    it('uses a longer bounded timeout for recoverable no-history resume hydration', () => {
        expect(readCodexAppServerResumeRecoveryTimeoutMs({
            HAPPIER_CODEX_APP_SERVER_RPC_TIMEOUT_MS: '250',
            HAPPIER_CODEX_APP_SERVER_STARTUP_RPC_TIMEOUT_MS: '500',
            HAPPIER_CODEX_APP_SERVER_RESUME_RECOVERY_TIMEOUT_MS: '1200',
        })).toBe(1200);

        expect(readCodexAppServerResumeRecoveryTimeoutMs({
            HAPPIER_CODEX_APP_SERVER_RPC_TIMEOUT_MS: '25000',
            HAPPIER_CODEX_APP_SERVER_STARTUP_RPC_TIMEOUT_MS: '20000',
            HAPPIER_CODEX_APP_SERVER_RESUME_RECOVERY_TIMEOUT_MS: '1200',
        })).toBe(25_000);
    });
});
