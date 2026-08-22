import { describe, expect, it, vi } from 'vitest';

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

    it('resolves a packaged runtime only for the exact current managed-Provider invocation', async () => {
        const resolvePackagedRuntimeBinary = vi.fn(async () => ({
            command: '/runtime/tools/unpacked/happier-cliproxyapi-managed',
        }));
        const resolver = createStableManagedExecutableResolver({
            systemTools: [],
            managedDependencies: {
                resolveExecutable: async () => { throw new Error('managed dependency path not expected'); },
            },
            resolveSystemTool: async () => { throw new Error('system tool path not expected'); },
            resolvePackagedRuntimeBinary,
        });
        const ref = {
            kind: 'packaged-runtime-binary',
            directorySegments: ['tools', 'unpacked'],
            executableBaseName: 'happier-cliproxyapi-managed',
        } as const satisfies ManagedExecutableRef;
        const context = Object.freeze({
            kind: 'managedProviderRuntime' as const,
            pluginId: 'happier.provider.cliproxyapi',
            providerLocalId: 'cliproxyapi',
            contributionQualifiedId: 'happier.provider.cliproxyapi/providers/cliproxyapi',
            generation: 'generation-1',
            isCurrent: () => true,
        });

        await expect(resolver(
            ref,
            'happier.provider.cliproxyapi',
            context,
        )).resolves.toEqual({
            command: '/runtime/tools/unpacked/happier-cliproxyapi-managed',
        });
        expect(resolvePackagedRuntimeBinary).toHaveBeenCalledWith(ref, context);
    });

    it.each([
        ['missing invocation context', undefined],
        ['Agent contribution', {
            kind: 'agentRuntime',
            pluginId: 'happier.provider.cliproxyapi',
            providerLocalId: 'codex',
            contributionQualifiedId: 'happier.provider.cliproxyapi/agents/codex',
            generation: 'generation-1',
            isCurrent: () => true,
        }],
        ['different plugin contribution', {
            kind: 'managedProviderRuntime',
            pluginId: 'other.provider',
            providerLocalId: 'cliproxyapi',
            contributionQualifiedId: 'other.provider/providers/cliproxyapi',
            generation: 'generation-1',
            isCurrent: () => true,
        }],
        ['same-plugin mismatched Provider contribution', {
            kind: 'managedProviderRuntime',
            pluginId: 'happier.provider.cliproxyapi',
            providerLocalId: 'cliproxyapi',
            contributionQualifiedId:
                'happier.provider.cliproxyapi/providers/other-provider',
            generation: 'generation-1',
            isCurrent: () => true,
        }],
        ['same-plugin wrong contribution family', {
            kind: 'managedProviderRuntime',
            pluginId: 'happier.provider.cliproxyapi',
            providerLocalId: 'cliproxyapi',
            contributionQualifiedId:
                'happier.provider.cliproxyapi/agents/cliproxyapi',
            generation: 'generation-1',
            isCurrent: () => true,
        }],
        ['retired Provider contribution', {
            kind: 'managedProviderRuntime',
            pluginId: 'happier.provider.cliproxyapi',
            providerLocalId: 'cliproxyapi',
            contributionQualifiedId: 'happier.provider.cliproxyapi/providers/cliproxyapi',
            generation: 'generation-1',
            isCurrent: () => false,
        }],
    ])('rejects packaged runtime authority for %s before asset resolution', async (_label, context) => {
        const resolvePackagedRuntimeBinary = vi.fn(async () => ({ command: '/not-reached' }));
        const resolver = createStableManagedExecutableResolver({
            systemTools: [],
            managedDependencies: {
                resolveExecutable: async () => { throw new Error('managed dependency path not expected'); },
            },
            resolveSystemTool: async () => { throw new Error('system tool path not expected'); },
            resolvePackagedRuntimeBinary,
        });

        await expect(resolver({
            kind: 'packaged-runtime-binary',
            directorySegments: ['tools', 'unpacked'],
            executableBaseName: 'happier-cliproxyapi-managed',
        } as ManagedExecutableRef, 'happier.provider.cliproxyapi', context)).rejects.toMatchObject({
            code: 'plugin_packaged_runtime_binary_unavailable',
        });
        expect(resolvePackagedRuntimeBinary).not.toHaveBeenCalled();
    });
});
