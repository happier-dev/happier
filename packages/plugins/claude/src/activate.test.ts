import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';
import type {
    PluginApiHookRegistrationV1,
    RegisterDaemonAuthBridgeV1,
} from '@happier-dev/plugin-sdk';

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

        const registerAgentRuntime = vi.fn();
        const daemonAuthBridgeRegistrations: RegisterDaemonAuthBridgeV1[] = [];
        const registerMcpDiscoveryProvider = vi.fn();
        const hookRegistrations: PluginApiHookRegistrationV1[] = [];
        activate({
            registerAgentRuntime,
            registerDaemonAuthBridge: (registration) => {
                daemonAuthBridgeRegistrations.push(registration);
                return { dispose: () => undefined };
            },
            registerMcpDiscoveryProvider,
            registerHook: (registration) => {
                hookRegistrations.push(registration);
                return { dispose: () => undefined };
            },
        });

        expect(registerAgentRuntime).toHaveBeenCalledWith(expect.objectContaining({
            agentId: 'claude',
            create: expect.any(Function),
        }));
        const backendRegistration = registerAgentRuntime.mock.calls[0]?.[0] as Readonly<{
            create: (ctx: unknown) => Promise<unknown>;
        }>;
        const pluginContext = createPluginContextFixture(
            createTerminalHostFixture().service,
            createEventsFixture().service,
        );
        await expect(backendRegistration.create(pluginContext)).resolves.toEqual(expect.objectContaining({
            runtimeCore: expect.any(Object),
        }));
        expect(pluginContext.logger.debug).toHaveBeenCalledWith('[plugins/claude] Creating backend engine');
        expect(pluginContext.logger.info).not.toHaveBeenCalled();
        expect(daemonAuthBridgeRegistrations).toEqual([
            expect.objectContaining({
                serviceId: 'claude-subscription',
                refresh: expect.any(Function),
            }),
        ]);
        expect(registerMcpDiscoveryProvider).toHaveBeenCalledWith(expect.objectContaining({
            id: 'claude.config',
            discover: expect.any(Function),
        }));
        expect(hookRegistrations.map((registration) => registration.hookId)).toEqual([
            'agent.resolvePrerequisites',
            'agent.spawnEnv.augment',
        ]);
        expect(hookRegistrations).toEqual([
            expect.objectContaining({
                hookId: 'agent.resolvePrerequisites',
                filters: { agentId: 'claude' },
            }),
            expect.objectContaining({
                hookId: 'agent.spawnEnv.augment',
                filters: { agentId: 'claude' },
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

        const registerAgentRuntime = vi.fn();
        const registerMcpDiscoveryProvider = vi.fn();
        activate({
            registerAgentRuntime,
            registerDaemonAuthBridge: vi.fn(),
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

    it('passes direct activation-hook payloads through to Claude spawn env augmentation', async () => {
        const hookRegistrations: PluginApiHookRegistrationV1[] = [];

        activate({
            registerAgentRuntime: vi.fn(),
            registerDaemonAuthBridge: vi.fn(),
            registerMcpDiscoveryProvider: vi.fn(),
            registerHook: (registration) => {
                hookRegistrations.push(registration);
                return { dispose: () => undefined };
            },
        });

        const envHook = hookRegistrations.find(
            (registration) => registration.hookId === 'agent.spawnEnv.augment',
        );

        await expect(Promise.resolve(envHook?.handler({
            env: {
                HAPPIER_CLAUDE_CONFIG_DIR: '/tmp/claude-direct',
            },
        }))).resolves.toEqual({
            CLAUDE_CONFIG_DIR: '/tmp/claude-direct',
        });
    });
});
