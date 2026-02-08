import { describe, expect, it, vi } from 'vitest';

const statMock = vi.fn();

vi.mock('node:fs/promises', async () => {
    const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
    return {
        ...actual,
        stat: statMock,
    };
});

describe('JsonlFollower (startAtEnd error handling)', () => {
    it('rethrows non-ENOENT errors during startAtEnd initialization', async () => {
        const statError = Object.assign(new Error('permission denied'), { code: 'EACCES' as const });
        statMock.mockRejectedValue(statError);

        const { JsonlFollower } = await import('../jsonlFollower');
        const follower = new JsonlFollower({
            filePath: '/tmp/does-not-matter.jsonl',
            pollIntervalMs: 5,
            startAtEnd: true,
            onJson: () => {},
        });

        try {
            await expect(follower.start()).rejects.toBe(statError);
        } finally {
            await follower.stop();
            statMock.mockReset();
        }
    });
});
