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

    it('pins the embedded Redis fallback to a build-compatible version', async () => {
        const redisMemory = {
            start: vi.fn(async () => true),
            stop: vi.fn(async () => true),
            getIp: vi.fn(async () => '127.0.0.1'),
            getPort: vi.fn(async () => 6379),
        };
        const create = vi.fn(async () => redisMemory);

        await expect(resolveRedisAdapterValidationRedisUrl({
            env: {} as NodeJS.ProcessEnv,
            loadRedisMemoryServer: async () => ({
                RedisMemoryServer: { create },
            }),
        })).resolves.toEqual({
            redisUrl: 'redis://127.0.0.1:6379',
            redisMemory,
        });

        expect(create).toHaveBeenCalledWith({
            binary: { version: '7.2.4' },
        });
    });

    it('reports a usable Redis prerequisite when the embedded fallback cannot start', async () => {
        const create = vi.fn(async () => ({
            start: vi.fn(async () => true),
            stop: vi.fn(async () => true),
            getIp: vi.fn(async () => {
                throw new Error('GNU Make version is too old');
            }),
            getPort: vi.fn(async () => 6379),
        }));

        await expect(resolveRedisAdapterValidationRedisUrl({
            env: {} as NodeJS.ProcessEnv,
            loadRedisMemoryServer: async () => ({
                RedisMemoryServer: { create },
            }),
        })).rejects.toThrow(/REDIS_URL.*embedded Redis.*7\.2\.4/i);
    });
});
