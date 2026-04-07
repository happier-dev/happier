import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

describe('discoverHappierServices default roots', () => {
    afterEach(() => {
        vi.resetModules();
        vi.clearAllMocks();
        vi.doUnmock('../../service/discovery/index.js');
    });

    it('includes macOS LaunchDaemons alongside user LaunchAgents', async () => {
        const root = await mkdtemp(join(tmpdir(), 'happier-runtime-default-roots-'));
        try {
            let capturedRoots: unknown = null;
            const listKnownServiceDefinitionFilesMock = vi.fn(async (params: unknown) => {
                capturedRoots = (params as { roots?: unknown }).roots ?? null;
                return [];
            });

            vi.doMock('../../service/discovery/index.js', () => ({
                listKnownServiceDefinitionFiles: listKnownServiceDefinitionFilesMock,
                parseLaunchdPlist: vi.fn(),
                parseSystemdUnit: vi.fn(),
                parseWindowsScheduledTaskWrapperPs1: vi.fn(),
                readLaunchdLoadedStatus: vi.fn(),
                readScheduledTaskStatus: vi.fn(),
                readSystemdUnitStatus: vi.fn(),
            }));

            const { discoverHappierServices } = await import('./discoverHappierServices.js');
            await discoverHappierServices({
                platform: 'darwin',
                processEnv: {
                    HOME: join(root, 'home'),
                } as NodeJS.ProcessEnv,
            });

            expect(capturedRoots).toEqual([
                { path: join(root, 'home', 'Library', 'LaunchAgents'), scope: 'user' },
                { path: join('/Library', 'LaunchDaemons'), scope: 'system' },
            ]);
        } finally {
            await rm(root, { recursive: true, force: true });
        }
    });
});
