import { describe, expect, it } from 'vitest';

import type { ManagedExecutableRef } from '@happier-dev/protocol';

import { createStableManagedExecutableResolver } from './managedExecutableResolver';

describe('stable managed executable resolver', () => {
    it('resolves only declared structured system-tool refs through the canonical system owner', async () => {
        const resolver = createStableManagedExecutableResolver({
            systemTools: [{
                provenance: 'external',
                source: { kind: 'bundled' },
                pluginId: 'acme.plugin',
                definition: {
                    id: 'git',
                    title: 'Git',
                    executableNames: ['fixture-git'],
                    allowedArguments: ['status'],
                    platforms: ['linux'],
                },
            }],
            managedDependencies: {
                resolveExecutable: async () => { throw new Error('managed dependency path not expected'); },
            },
            resolveSystemTool: async (request) => ({
                toolId: request.toolId,
                command: '/usr/bin/fixture-git',
                args: ['host-default'],
            }),
        }, 'linux');

        await expect(resolver({ kind: 'systemTool', id: 'git' }, 'acme.plugin')).resolves.toEqual({
            command: '/usr/bin/fixture-git',
            args: ['host-default'],
            allowedArguments: ['status'],
        });
        await expect(resolver({
            kind: 'systemTool',
            id: { pluginId: 'other.plugin', localId: 'git' },
        }, 'acme.plugin')).rejects.toMatchObject({ code: 'plugin_system_tool_undeclared' });
    });

    it('rejects a declared system tool on a host platform it does not support', async () => {
        const resolver = createStableManagedExecutableResolver({
            systemTools: [{
                provenance: 'external',
                source: { kind: 'bundled' },
                pluginId: 'acme.plugin',
                definition: {
                    id: 'git',
                    title: 'Git',
                    executableNames: ['fixture-git'],
                    platforms: ['linux'],
                },
            }],
            managedDependencies: {
                resolveExecutable: async () => { throw new Error('managed dependency path not expected'); },
            },
            resolveSystemTool: async () => {
                throw new Error('unsupported platform must fail before system resolution');
            },
        }, 'darwin');

        await expect(resolver({ kind: 'systemTool', id: 'git' }, 'acme.plugin')).rejects.toMatchObject({
            code: 'plugin_system_tool_platform_unsupported',
        });
    });

    it('delegates managed-dependency refs without accepting a raw executable path', async () => {
        const expected = { command: '/managed/tool', release: () => {} };
        const seen: ManagedExecutableRef[] = [];
        const resolver = createStableManagedExecutableResolver({
            systemTools: [],
            managedDependencies: {
                resolveExecutable: async (ref) => {
                    seen.push(ref);
                    return expected;
                },
            },
            resolveSystemTool: async () => { throw new Error('system tool path not expected'); },
        });
        const ref = { kind: 'managedDependency', id: 'tool' } as const;

        await expect(resolver(ref, 'acme.plugin')).resolves.toBe(expected);
        expect(seen).toEqual([ref]);
    });
});
