import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';
import type { PluginApiHookRegistrationV1 } from '@happier-dev/plugin-sdk';

import { activate } from './activate.js';
import {
    createEventsFixture,
    createPluginContextFixture,
    createTerminalHostFixture,
} from './agent/runtime/engine.testkit.js';

describe('activate', () => {
    afterEach(() => {
        vi.unstubAllEnvs();
    });

    it('registers the Claude config MCP discovery provider through the plugin API', async () => {
        const root = await mkdtemp(join(tmpdir(), 'claude-plugin-mcp-'));
        const configRoot = join(root, '.claude');
        await mkdir(configRoot, { recursive: true });
        await writeFile(
            join(configRoot, 'settings.json'),
            JSON.stringify({
                mcpServers: {
                    review: {
                        command: 'review-mcp',
                        args: ['--stdio'],
                    },
                },
            }),
            'utf8',
        );
        vi.stubEnv('HOME', root);
        vi.stubEnv('CLAUDE_CONFIG_DIR', configRoot);

        const registerBackendEngine = vi.fn();
        const registerMcpDiscoveryProvider = vi.fn();
        const hookRegistrations: PluginApiHookRegistrationV1[] = [];
        activate({
            registerBackendEngine,
            registerMcpDiscoveryProvider,
            registerHook: (registration) => {
                hookRegistrations.push(registration);
                return { dispose: () => undefined };
            },
        });

        expect(registerBackendEngine).toHaveBeenCalledWith(expect.objectContaining({
            backendId: 'claude',
            create: expect.any(Function),
        }));
        const backendRegistration = registerBackendEngine.mock.calls[0]?.[0] as Readonly<{
            create: (ctx: unknown) => Promise<unknown>;
        }>;
        await expect(backendRegistration.create(createPluginContextFixture(
            createTerminalHostFixture().service,
            createEventsFixture().service,
        ))).resolves.toEqual(expect.objectContaining({
            runtimeCore: expect.any(Object),
        }));
        expect(registerMcpDiscoveryProvider).toHaveBeenCalledWith(expect.objectContaining({
            id: 'claude.config',
            discover: expect.any(Function),
        }));
        expect(hookRegistrations.map((registration) => registration.hookId)).toEqual([
            'backend.resolveRuntimePrerequisites',
            'spawn.augmentEnv',
        ]);
        expect(hookRegistrations).toEqual([
            expect.objectContaining({
                hookId: 'backend.resolveRuntimePrerequisites',
                filters: { backendId: 'claude' },
            }),
            expect.objectContaining({
                hookId: 'spawn.augmentEnv',
                filters: { backendId: 'claude' },
            }),
        ]);

        const discovery = registerMcpDiscoveryProvider.mock.calls[0]?.[0] as {
            discover: () => Promise<Readonly<{
                servers: readonly unknown[];
                warnings: readonly unknown[];
            }>>;
        };
        await expect(discovery.discover()).resolves.toEqual({
            servers: [
                expect.objectContaining({
                    id: 'claude.config.review',
                    name: 'review',
                    transport: {
                        kind: 'stdio',
                        launch: {
                            kind: 'binary',
                            executablePath: 'review-mcp',
                            args: ['--stdio'],
                        },
                    },
                }),
            ],
            warnings: [],
        });
    });

    it('propagates Claude MCP discovery warnings through the plugin API', async () => {
        const root = await mkdtemp(join(tmpdir(), 'claude-plugin-mcp-warning-'));
        const configRoot = join(root, '.claude');
        await mkdir(configRoot, { recursive: true });
        const settingsPath = join(configRoot, 'settings.json');
        await writeFile(settingsPath, '{', 'utf8');
        vi.stubEnv('HOME', root);
        vi.stubEnv('CLAUDE_CONFIG_DIR', configRoot);

        const registerBackendEngine = vi.fn();
        const registerMcpDiscoveryProvider = vi.fn();
        activate({
            registerBackendEngine,
            registerMcpDiscoveryProvider,
            registerHook: vi.fn(),
        });

        const discovery = registerMcpDiscoveryProvider.mock.calls[0]?.[0] as {
            discover: () => Promise<Readonly<{
                servers: readonly unknown[];
                warnings: readonly unknown[];
            }>>;
        };

        await expect(discovery.discover()).resolves.toEqual({
            servers: [],
            warnings: [{
                provider: 'claude',
                code: 'parse_failed',
                path: settingsPath,
            }],
        });
    });
});
