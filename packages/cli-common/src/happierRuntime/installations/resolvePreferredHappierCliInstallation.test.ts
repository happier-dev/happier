import { describe, expect, it } from 'vitest';

import { resolvePreferredHappierCliInstallation } from './resolvePreferredHappierCliInstallation.js';

describe('resolvePreferredHappierCliInstallation', () => {
    it('prefers the canonical npm package root over the PATH shim entry for the selected CLI shim', () => {
        const installation = resolvePreferredHappierCliInstallation({
            preferredCliCommand: 'happier',
            inventory: {
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
                        pathOrder: 0,
                        managedRoot: '/opt/homebrew',
                        packageManager: null,
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
                        pathOrder: null,
                        managedRoot: '/opt/homebrew',
                        packageManager: {
                            kind: 'npmGlobal',
                            executablePath: '/opt/homebrew/bin/npm',
                            packageName: '@happier-dev/cli',
                        },
                    },
                ],
            },
        });

        expect(installation).toEqual(expect.objectContaining({
            id: 'npmGlobal:/opt/homebrew/lib/node_modules/@happier-dev/cli',
            packageManager: expect.objectContaining({
                executablePath: '/opt/homebrew/bin/npm',
                packageName: '@happier-dev/cli',
            }),
        }));
    });
});
