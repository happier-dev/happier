import { describe, expect, it, vi } from 'vitest';

import { resolveRedisAdapterValidationRedisUrl } from './resolveRedisAdapterValidationRedisUrl';

describe('resolveRedisAdapterValidationRedisUrl', () => {
    it('uses REDIS_URL directly when provided', async () => {
        const loadRedisMemoryServer = vi.fn();

        await expect(resolveRedisAdapterValidationRedisUrl({
            env: {
                REDIS_URL: 'redis://127.0.0.1:6379',
            } as NodeJS.ProcessEnv,
            loadRedisMemoryServer,
        })).resolves.toEqual({
            redisUrl: 'redis://127.0.0.1:6379',
            redisMemory: null,
        });

        expect(loadRedisMemoryServer).not.toHaveBeenCalled();
    });

    it('fails with an explicit actionable message when the optional redis-memory-server dependency is unavailable', async () => {
        const loadRedisMemoryServer = vi.fn(async () => {
            throw new Error("Cannot find package 'redis-memory-server'");
        });

        await expect(resolveRedisAdapterValidationRedisUrl({
            env: {} as NodeJS.ProcessEnv,
            loadRedisMemoryServer,
        })).rejects.toThrow(/REDIS_URL.*redis-memory-server/i);
    });
});
