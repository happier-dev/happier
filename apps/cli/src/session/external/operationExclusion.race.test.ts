import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

const releaseRenameEntered = vi.hoisted(() => ({
    resolve: null as null | (() => void),
    promise: null as null | Promise<void>,
}));
const allowReleaseRename = vi.hoisted(() => ({
    resolve: null as null | (() => void),
    promise: null as null | Promise<void>,
}));

vi.mock('node:fs/promises', async () => {
    const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
    return {
        ...actual,
        rename: async (oldPath: string, newPath: string) => {
            if (newPath.includes('.released-')) {
                releaseRenameEntered.resolve?.();
                await allowReleaseRename.promise;
            }
            return await actual.rename(oldPath, newPath);
        },
    };
});

import { createExternalSessionOperationExclusion } from './operationExclusion';

const createdDirectories: string[] = [];

function resetBarrier(target: typeof releaseRenameEntered): void {
    target.promise = new Promise<void>((resolve) => {
        target.resolve = resolve;
    });
}

afterEach(async () => {
    await Promise.all(createdDirectories.splice(0).map(async (directory) => {
        await rm(directory, { recursive: true, force: true });
    }));
});

describe('external session operation exclusion mutation races', () => {
    it('does not let a stale release remove a successor claim published after its read', async () => {
        resetBarrier(releaseRenameEntered);
        resetBarrier(allowReleaseRename);
        let nowMs = 1_000;
        const activeServerDir = await mkdtemp(join(tmpdir(), 'happier-external-operation-race-'));
        createdDirectories.push(activeServerDir);
        const firstOwner = createExternalSessionOperationExclusion({
            activeServerDir,
            ownerId: 'daemon:first',
            nowMs: () => nowMs,
            ttlMs: 100,
        });
        const first = await firstOwner.acquire({
            kind: 'materialize',
            sessionId: 'session-race',
            requestId: 'materialize-first',
            sourceIdentity: 'source:first',
            sourceGeneration: 'generation:first',
        });
        expect(first.status).toBe('acquired');
        if (first.status !== 'acquired') throw new Error('expected first claim');

        const staleRelease = first.claim.release();
        await releaseRenameEntered.promise;

        nowMs = 1_101;
        const successorOwner = createExternalSessionOperationExclusion({
            activeServerDir,
            ownerId: 'daemon:successor',
            nowMs: () => nowMs,
            ttlMs: 100,
        });
        let successorSettled = false;
        const successorPromise = successorOwner.acquire({
            kind: 'takeover',
            sessionId: 'session-race',
            requestId: 'takeover-successor',
            sourceIdentity: 'source:successor',
            sourceGeneration: 'generation:successor',
            plan: 'persisted',
        }).finally(() => {
            successorSettled = true;
        });
        try {
            await new Promise((resolve) => setTimeout(resolve, 20));
            expect(successorSettled).toBe(false);
        } finally {
            allowReleaseRename.resolve?.();
        }
        await staleRelease;
        const successor = await successorPromise;
        expect(successor.status).toBe('acquired');

        await expect(firstOwner.acquire({
            kind: 'materialize',
            sessionId: 'session-race',
            requestId: 'materialize-after-race',
            sourceIdentity: 'source:third',
            sourceGeneration: 'generation:third',
        })).resolves.toMatchObject({
            status: 'conflict',
            active: { request: { requestId: 'takeover-successor' } },
        });
    });
});
