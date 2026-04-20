import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const { spawnMock } = vi.hoisted(() => ({
    spawnMock: vi.fn(),
}));
const { applySqliteMigrationsMock } = vi.hoisted(() => ({
    applySqliteMigrationsMock: vi.fn(),
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
vi.mock('./prismaCli', () => ({
    resolveServerWorkspaceRoot: () => process.cwd(),
}));
vi.mock('./prismaMigrations', () => ({
    applySqliteMigrations: (...args: unknown[]) => applySqliteMigrationsMock(...args),
}));

describe('migrate.sqlite.deploy.ts', () => {
    let tmpDir = '';
    let lightDataDir = '';

    async function waitForSpawnCount(expected: number): Promise<void> {
        for (let i = 0; i < 40; i++) {
            if (spawnMock.mock.calls.length >= expected) {
                return;
            }
            await new Promise((resolve) => setTimeout(resolve, 0));
        }
        throw new Error(`Timed out waiting for ${expected} spawn calls; saw ${spawnMock.mock.calls.length}`);
    }

    async function waitForMigrationCall(expected: number): Promise<void> {
        for (let i = 0; i < 40; i++) {
            if (applySqliteMigrationsMock.mock.calls.length >= expected) {
                return;
            }
            await new Promise((resolve) => setTimeout(resolve, 0));
        }
        throw new Error(`Timed out waiting for ${expected} migration calls; saw ${applySqliteMigrationsMock.mock.calls.length}`);
    }

    beforeEach(async () => {
        tmpDir = await mkdtemp(join(tmpdir(), 'happier-server-light-deploy-'));
        lightDataDir = join(tmpDir, 'happy server #light');
        await mkdir(lightDataDir, { recursive: true });
        spawnMock.mockClear();
        applySqliteMigrationsMock.mockReset();
        applySqliteMigrationsMock.mockResolvedValue({ applied: [] });
        process.env.HAPPY_SERVER_LIGHT_DATA_DIR = lightDataDir;
        process.env.HAPPIER_SERVER_LIGHT_DATA_DIR = lightDataDir;
        delete process.env.DATABASE_URL;
    });

    afterEach(async () => {
        await rm(tmpDir, { recursive: true, force: true });
        delete process.env.HAPPY_SERVER_LIGHT_DATA_DIR;
        delete process.env.HAPPIER_SERVER_LIGHT_DATA_DIR;
        delete process.env.DATABASE_URL;
        vi.resetModules();
    });

    it('uses a safe file URL for sqlite DATABASE_URL when deriving the deploy env', async () => {
        await import('./migrate.sqlite.deploy');
        await waitForSpawnCount(1);
        await waitForMigrationCall(1);

        const prismaCall = applySqliteMigrationsMock.mock.calls[0]?.[0] as { databasePath?: string } | undefined;

        expect(prismaCall).toBeDefined();
        const expected = join(lightDataDir, 'happier-server-light.sqlite');
        expect(prismaCall?.databasePath).toBe(expected);
        const encodedDirExists = await import('node:fs/promises')
            .then(({ stat }) => stat(join(tmpDir, 'happy%20server%20%23light')))
            .then(() => true)
            .catch(() => false);
        expect(encodedDirExists).toBe(false);
    });
});
