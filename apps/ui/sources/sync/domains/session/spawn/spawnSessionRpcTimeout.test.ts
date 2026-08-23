import { afterEach, describe, expect, it } from 'vitest';

import {
    readForkSessionRpcTimeoutMsFromEnv,
    readSpawnSessionRpcTimeoutMsFromEnv,
} from './spawnSessionRpcTimeout';

const ORIGINAL_TIMEOUT = process.env.EXPO_PUBLIC_HAPPIER_SPAWN_SESSION_RPC_TIMEOUT_MS;
const ORIGINAL_FORK_TIMEOUT = process.env.EXPO_PUBLIC_HAPPIER_FORK_SESSION_RPC_TIMEOUT_MS;

afterEach(() => {
    if (ORIGINAL_TIMEOUT === undefined) {
        delete process.env.EXPO_PUBLIC_HAPPIER_SPAWN_SESSION_RPC_TIMEOUT_MS;
    } else {
        process.env.EXPO_PUBLIC_HAPPIER_SPAWN_SESSION_RPC_TIMEOUT_MS = ORIGINAL_TIMEOUT;
    }

    if (ORIGINAL_FORK_TIMEOUT === undefined) {
        delete process.env.EXPO_PUBLIC_HAPPIER_FORK_SESSION_RPC_TIMEOUT_MS;
    } else {
        process.env.EXPO_PUBLIC_HAPPIER_FORK_SESSION_RPC_TIMEOUT_MS = ORIGINAL_FORK_TIMEOUT;
    }
});

describe('readForkSessionRpcTimeoutMsFromEnv', () => {
    it('keeps the outer fork acknowledgement budget above spawn resolution', () => {
        delete process.env.EXPO_PUBLIC_HAPPIER_FORK_SESSION_RPC_TIMEOUT_MS;

        expect(readForkSessionRpcTimeoutMsFromEnv()).toBe(8 * 60_000);
    });
});

describe('readSpawnSessionRpcTimeoutMsFromEnv', () => {
    it('keeps accepted session launches resolvable through slow provider startup', () => {
        delete process.env.EXPO_PUBLIC_HAPPIER_SPAWN_SESSION_RPC_TIMEOUT_MS;

        expect(readSpawnSessionRpcTimeoutMsFromEnv()).toBe(5 * 60_000);
    });

    it('does not let an environment override shorten the supported startup budget', () => {
        process.env.EXPO_PUBLIC_HAPPIER_SPAWN_SESSION_RPC_TIMEOUT_MS = '90000';

        expect(readSpawnSessionRpcTimeoutMsFromEnv()).toBe(5 * 60_000);
    });
});
