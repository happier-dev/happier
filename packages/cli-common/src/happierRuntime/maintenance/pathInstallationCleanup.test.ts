import { describe, expect, it } from 'vitest';

import type { HappierInstallationInventory, HappierService } from '../types.js';
import { buildPathInstallationCleanupPlan } from './pathInstallationCleanup.js';

describe('buildPathInstallationCleanupPlan', () => {
    it('keeps the first on-path happier installation and plans direct uninstall for removable duplicates', () => {
        const inventory: HappierInstallationInventory = {
            activeInvocation: null,
            installations: [
                {
                    id: 'npmGlobal:/opt/homebrew/bin/happier',
                    source: 'npmGlobal',
                    components: ['happier-cli', 'happier-daemon'],
                    ring: 'stable',
                    version: '1.0.0',
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
                    version: '1.0.0',
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
                {
                    id: 'managed:stable:/Users/tester/.happier/cli/current',
                    source: 'firstPartyManaged',
                    components: ['happier-cli', 'happier-daemon'],
                    ring: 'stable',
                    version: '2.0.0',
                    path: '/Users/tester/.happier/cli/current',
                    realPath: '/Users/tester/.happier/cli/current',
                    shimName: 'happier',
                    onPath: true,
                    pathOrder: 1,
                    managedRoot: '/Users/tester/.happier/cli',
                    packageManager: null,
                },
            ],
        };

        const plan = buildPathInstallationCleanupPlan({
            inventory,
            services: [],
            keepService: false,
        });

        expect(plan.preservedInstallations).toEqual([
            expect.objectContaining({
                shimName: 'happier',
                installation: expect.objectContaining({
                    id: 'npmGlobal:/opt/homebrew/lib/node_modules/@happier-dev/cli',
                }),
            }),
        ]);
        expect(plan.actions).toEqual([
            expect.objectContaining({
                kind: 'uninstall-installation',
                shimName: 'happier',
                installation: expect.objectContaining({
                    id: 'managed:stable:/Users/tester/.happier/cli/current',
                }),
                previewCommand: 'uninstall Happier CLI at /Users/tester/.happier/cli/current',
            }),
        ]);
    });

    it('leaves different shim names alone and emits manual cleanup for unsupported duplicate sources', () => {
        const inventory: HappierInstallationInventory = {
            activeInvocation: null,
            installations: [
                {
                    id: 'pathBinary:/usr/local/bin/happier',
                    source: 'pathBinary',
                    components: ['happier-cli', 'happier-daemon'],
                    ring: 'stable',
                    version: '1.0.0',
                    path: '/usr/local/bin/happier',
                    realPath: '/usr/local/bin/happier',
                    shimName: 'happier',
                    onPath: true,
                    pathOrder: 0,
                    managedRoot: null,
                    packageManager: null,
                },
                {
                    id: 'fromSource:/Users/tester/repo/apps/cli/bin/happier.mjs',
                    source: 'fromSource',
                    components: ['happier-cli', 'happier-daemon'],
                    ring: 'stable',
                    version: '2.0.0-dev.1',
                    path: '/Users/tester/repo/apps/cli/bin/happier.mjs',
                    realPath: '/Users/tester/repo/apps/cli/bin/happier.mjs',
                    shimName: 'happier',
                    onPath: true,
                    pathOrder: 1,
                    managedRoot: null,
                    packageManager: null,
                },
                {
                    id: 'managed:publicdev:/Users/tester/.happier/cli-dev/current',
                    source: 'firstPartyManaged',
                    components: ['happier-cli', 'happier-daemon'],
                    ring: 'dev',
                    version: '3.0.0-dev.1',
                    path: '/Users/tester/.happier/cli-dev/current',
                    realPath: '/Users/tester/.happier/cli-dev/current',
                    shimName: 'hdev',
                    onPath: true,
                    pathOrder: 0,
                    managedRoot: '/Users/tester/.happier/cli-dev',
                    packageManager: null,
                },
            ],
        };
        const services: HappierService[] = [];

        const plan = buildPathInstallationCleanupPlan({
            inventory,
            services,
            keepService: false,
        });

        expect(plan.preservedInstallations).toEqual([
            expect.objectContaining({
                shimName: 'happier',
                installation: expect.objectContaining({ id: 'pathBinary:/usr/local/bin/happier' }),
            }),
        ]);
        expect(plan.actions).toEqual([
            expect.objectContaining({
                kind: 'manual-installation-cleanup',
                shimName: 'happier',
                installation: expect.objectContaining({
                    id: 'fromSource:/Users/tester/repo/apps/cli/bin/happier.mjs',
                }),
            }),
        ]);
    });
});
