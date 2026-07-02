import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const { spawnMock, fileSyncMock } = vi.hoisted(() => ({
    spawnMock: vi.fn(),
    fileSyncMock: vi.fn(),
}));

vi.mock('node:child_process', () => ({
    spawn: (...args: unknown[]) => {
        spawnMock(...args);
        return {
            on(event: string, handler: (code: number) => void) {
                if (event === 'exit') {
                    queueMicrotask(() => handler(0));
                }
                return this;
            },
        };
    },
}));

vi.mock('tmp', () => ({
    default: {
        fileSync: (...args: unknown[]) => fileSyncMock(...args),
    },
}));

describe('migrate.light.new.ts', () => {
    let tmpDir = '';
    let originalArgv: string[] = [];

    async function waitForSpawnCount(expected: number): Promise<void> {
        for (let i = 0; i < 40; i++) {
            if (spawnMock.mock.calls.length >= expected) {
                return;
            }
            await new Promise((resolve) => setTimeout(resolve, 0));
        }
        throw new Error(`Timed out waiting for ${expected} spawn calls; saw ${spawnMock.mock.calls.length}`);
    }

    beforeEach(async () => {
        tmpDir = await mkdtemp(join(tmpdir(), 'happier-server-light-new-migrate-'));
        spawnMock.mockClear();
        fileSyncMock.mockReset().mockReturnValue({
            name: join(tmpDir, 'happy server #light.sqlite'),
        });
        originalArgv = process.argv.slice();
        process.argv = [...originalArgv, '--name', 'add_test'];
    });

    afterEach(async () => {
        await rm(tmpDir, { recursive: true, force: true });
        process.argv = originalArgv;
        vi.resetModules();
    });

    it('derives a safe sqlite DATABASE_URL for the temporary migration database', async () => {
        await import('./migrate.light.new');
        await waitForSpawnCount(2);

        const prismaCall = spawnMock.mock.calls.find(([, args]) => {
            const argv = Array.isArray(args) ? args : [];
            return argv.includes('prisma') && argv.includes('migrate') && argv.includes('dev');
        });

        expect(prismaCall).toBeDefined();
        const env = (prismaCall?.[2] as { env?: NodeJS.ProcessEnv } | undefined)?.env;
        const expected = `${pathToFileURL(join(tmpDir, 'happy server #light.sqlite')).href}?socket_timeout=30`;
        expect(env?.DATABASE_URL).toBe(expected);
    });
});
