import { describe, expect, it, vi } from 'vitest';

const runtimeMocks = vi.hoisted(() => ({
    discoverHappierInstallationsMock: vi.fn(),
    discoverHappierServicesMock: vi.fn(),
    buildHappierRuntimeWarningsMock: vi.fn(() => []),
}));

vi.mock('@happier-dev/cli-common/happierRuntime', async (importOriginal) => {
    const actual = await importOriginal<typeof import('@happier-dev/cli-common/happierRuntime')>();
    return {
        ...actual,
        discoverHappierInstallations: runtimeMocks.discoverHappierInstallationsMock,
        discoverHappierServices: runtimeMocks.discoverHappierServicesMock,
        buildHappierRuntimeWarnings: runtimeMocks.buildHappierRuntimeWarningsMock,
    };
});

import { collectSupportMaintenanceContext } from './collectSupportMaintenanceContext.js';

describe('collectSupportMaintenanceContext', () => {
    it('selects the canonical npm-global happier installation for the preferred CLI shim', async () => {
        runtimeMocks.discoverHappierInstallationsMock.mockResolvedValue({
            activeInvocation: null,
            installations: [
                {
                    id: 'npmGlobal:/opt/homebrew/bin/happier',
                    source: 'npmGlobal',
                    components: ['happier-cli', 'happier-daemon'],
                    ring: 'stable',
                    version: '0.1.0-preview.1771774953.99369',
                    path: '/opt/homebrew/bin/happier',
                    realPath: '/opt/homebrew/lib/node_modules/@happier-dev/cli/bin/happier.mjs',
                    shimName: 'happier',
                    onPath: true,
                    managedRoot: '/opt/homebrew',
                },
                {
                    id: 'npmGlobal:/opt/homebrew/lib/node_modules/@happier-dev/cli',
                    source: 'npmGlobal',
                    components: ['happier-cli', 'happier-daemon'],
                    ring: 'stable',
                    version: '0.1.0-preview.1771774953.99369',
                    path: '/opt/homebrew/lib/node_modules/@happier-dev/cli',
                    realPath: '/opt/homebrew/lib/node_modules/@happier-dev/cli',
                    shimName: null,
                    onPath: false,
                    managedRoot: '/opt/homebrew',
                },
            ],
        });
        runtimeMocks.discoverHappierServicesMock.mockResolvedValue({ services: [] });

        const context = await collectSupportMaintenanceContext({
            processEnv: { PATH: '/opt/homebrew/bin' } as NodeJS.ProcessEnv,
            platform: 'darwin',
        });

        expect(context.preferredCliCommand).toBe('happier');
        expect(context.selectedInstallation).toEqual(expect.objectContaining({
            id: 'npmGlobal:/opt/homebrew/lib/node_modules/@happier-dev/cli',
            source: 'npmGlobal',
            path: '/opt/homebrew/lib/node_modules/@happier-dev/cli',
        }));
    });
});
