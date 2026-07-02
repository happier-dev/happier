import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { JsonlFollower } from './followJsonlFile';

function delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(assertion: () => void, opts?: { timeoutMs?: number; intervalMs?: number }) {
    const timeoutMs = opts?.timeoutMs ?? 5000;
    const intervalMs = opts?.intervalMs ?? 10;
    const start = Date.now();

    // eslint-disable-next-line no-constant-condition
    while (true) {
        try {
            assertion();
            return;
        } catch (error) {
            if (Date.now() - start > timeoutMs) {
                throw error;
            }
            await delay(intervalMs);
        }
    }
}

describe('JsonlFollower startAtEnd error handling', () => {
    it('does not emit ENOENT errors while waiting for file creation', async () => {
        const root = await mkdtemp(join(tmpdir(), 'jsonl-follower-missing-'));
        const filePath = join(root, 'rollout.jsonl');

        const received: unknown[] = [];
        const errors: Array<NodeJS.ErrnoException | unknown> = [];
        const follower = new JsonlFollower({
            filePath,
            pollIntervalMs: 5,
            onLine: (line) => {
                received.push(JSON.parse(line) as unknown);
            },
            onError: (error: unknown) => errors.push(error),
        });
        await follower.start();

        try {
            await writeFile(filePath, '{"created":true}\n');
            await waitFor(() => {
                expect(received).toEqual([{ created: true }]);
            });
            expect(errors).toEqual([]);
        } finally {
            await follower.stop().catch(() => {});
            await rm(root, { recursive: true, force: true });
        }
    });
});
