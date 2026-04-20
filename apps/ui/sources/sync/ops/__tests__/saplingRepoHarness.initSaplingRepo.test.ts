import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { execFileSyncMock } = vi.hoisted(() => ({
    execFileSyncMock: vi.fn(),
}));

vi.mock('node:child_process', () => ({
    execFileSync: execFileSyncMock,
}));

describe('saplingRepoHarness initSaplingRepo', () => {
    beforeEach(() => {
        vi.resetModules();
        execFileSyncMock.mockReset();
    });

    afterEach(() => {
        vi.restoreAllMocks();
    });

    it('avoids git identity setup when the real sapling cli is available', async () => {
        execFileSyncMock.mockImplementation((command: string, args?: string[]) => {
            if (command === 'sl' && args?.[0] === 'version') return 'Sapling 1.0';
            if (command === 'sl' && args?.[0] === 'init') return '';
            if (command === 'sl' && args?.[0] === 'config') return '';
            throw new Error(`Unexpected command: ${command} ${(args ?? []).join(' ')}`);
        });

        const { initSaplingRepo } = await import('./saplingRepoHarness');

        initSaplingRepo('/tmp/happier-ui-sapling-real');

        expect(
            execFileSyncMock.mock.calls.some(([command]) => command === 'git'),
        ).toBe(false);
        expect(
            execFileSyncMock.mock.calls.some(
                ([command, args]) =>
                    command === 'sl'
                    && Array.isArray(args)
                    && args[0] === 'config'
                    && args.includes('ui.username'),
            ),
        ).toBe(true);
    });

    it('still configures git identity in the git-backed fallback path', async () => {
        const cwd = mkdtempSync(join(tmpdir(), 'happier-ui-sapling-fallback-'));
        try {
            execFileSyncMock.mockImplementation((command: string, args?: string[]) => {
                if (command === 'sl' && args?.[0] === 'version') {
                    throw new Error('sl unavailable');
                }
                if (command === 'git') return '';
                throw new Error(`Unexpected command: ${command} ${(args ?? []).join(' ')}`);
            });

            const { initSaplingRepo } = await import('./saplingRepoHarness');

            initSaplingRepo(cwd);

            expect(
                execFileSyncMock.mock.calls.some(
                    ([command, args]) =>
                        command === 'git'
                        && Array.isArray(args)
                        && args[0] === 'config'
                        && args[1] === 'user.email'
                        && args[2] === 'test@example.com',
                ),
            ).toBe(true);
            expect(
                execFileSyncMock.mock.calls.some(
                    ([command, args]) =>
                        command === 'git'
                        && Array.isArray(args)
                        && args[0] === 'config'
                        && args[1] === 'user.name'
                        && args[2] === 'Test User',
                ),
            ).toBe(true);
        } finally {
            rmSync(cwd, { recursive: true, force: true });
        }
    });
});
