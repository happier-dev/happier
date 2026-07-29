import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';
import type { AgentRuntime } from '@happier-dev/plugin-sdk/agent-runtime';

import { createNativeAgentSessionHostServiceOwners } from './nativeAgentSessionHostServiceOwners';
import { resolveBackendRuntimeCore } from './runtimeCore';
import { createEmptyBackendExecutionSurfaces } from '../engineRegistryTypes';
import { isHostSessionRuntimePlan } from '@/agent/runtime/session/loop/lifecycle';
import { createMutableApiSessionClientFixture } from '@/testkit/backends/sessionFixtures';
import { createTestMetadata } from '@/testkit/backends/sessionMetadata';
import { MessageBuffer } from '@/ui/ink/messageBuffer';
import { createProviderEnforcedPermissionHandler } from '@/agent/permissions/providerEnforced/createHandler';

describe('createNativeAgentSessionHostServiceOwners', () => {
    it('keeps missing carrier authority fail-closed when no child registry exists', async () => {
        const happyHomeDir = await mkdtemp(join(tmpdir(), 'happier-missing-carried-authority-'));
        const owners = createNativeAgentSessionHostServiceOwners({
            runtimeRegistry: null,
            identity: {
                pluginId: 'happier.agent.acme',
                pluginVersion: '1.0.0',
                agentId: 'acme',
                generation: 'generation-1',
                isCurrent: () => true,
            },
            backend: {
                id: 'acme',
                agentId: 'acme',
                provenance: 'first_party',
                source: { kind: 'bundled' },
                definition: { kindVersion: 1, id: 'acme', agentId: 'acme' },
                runtimeKind: 'custom',
                pluginId: 'happier.agent.acme',
            },
            agent: {
                id: 'acme',
                provenance: 'first_party',
                source: { kind: 'bundled' },
                definition: {
                    kindVersion: 1,
                    id: 'acme',
                    ownedBackendIds: ['acme'],
                },
                pluginId: 'happier.agent.acme',
            },
            hostRuntimeParams: {
                session: {
                    getMetadataSnapshot: () => ({}),
                },
            },
            sessionId: 'session-missing-carried-authority',
            directory: happyHomeDir,
            signal: new AbortController().signal,
            happyHomeDir,
        } as never);

        try {
            await expect(owners.sessionHooks.createPluginDir({
                providerId: 'acme',
                files: [],
            })).rejects.toMatchObject({
                code: 'PLUGIN_SESSION_HOOKS_CAPABILITY_REQUIRED',
            });
        } finally {
            await owners.dispose();
            await rm(happyHomeDir, { recursive: true, force: true });
        }
    });

    it('admits session hooks from the daemon carrier manifest authority without child activation', async () => {
        const happyHomeDir = await mkdtemp(join(tmpdir(), 'happier-carried-agent-authority-'));
        const signal = new AbortController().signal;
        const owners = createNativeAgentSessionHostServiceOwners({
            runtimeRegistry: null,
            runtimeAuthority: {
                permissions: ['session.hooks.control'],
                runtimeCapabilities: ['sessionHooks'],
            },
            identity: {
                pluginId: 'happier.agent.acme',
                pluginVersion: '1.0.0',
                agentId: 'acme',
                generation: 'generation-1',
                isCurrent: () => true,
            },
            backend: {
                id: 'acme',
                agentId: 'acme',
                provenance: 'first_party',
                source: { kind: 'bundled' },
                definition: { kindVersion: 1, id: 'acme', agentId: 'acme' },
                runtimeKind: 'custom',
                pluginId: 'happier.agent.acme',
            },
            agent: {
                id: 'acme',
                provenance: 'first_party',
                source: { kind: 'bundled' },
                definition: {
                    kindVersion: 1,
                    id: 'acme',
                    ownedBackendIds: ['acme'],
                },
                pluginId: 'happier.agent.acme',
            },
            hostRuntimeParams: {
                session: {
                    getMetadataSnapshot: () => ({}),
                },
            },
            sessionId: 'session-carried-authority',
            directory: happyHomeDir,
            signal,
            happyHomeDir,
        } as never);

        try {
            const pluginDir = await owners.sessionHooks.createPluginDir({
                providerId: 'acme',
                lifecycle: {
                    kind: 'session',
                    sessionId: 'session-carried-authority',
                },
                files: [{
                    path: '.claude-plugin/plugin.json',
                    json: { name: 'carried-authority-test' },
                }],
            });

            await expect(stat(pluginDir)).resolves.toBeDefined();
        } finally {
            await owners.dispose();
            await rm(happyHomeDir, { recursive: true, force: true });
        }
    });

    it('threads daemon carrier authority through the child runtime core into host services', async () => {
        const happyHomeDir = await mkdtemp(join(tmpdir(), 'happier-carried-runtime-core-'));
        const sessionId = 'session-carried-runtime-core';
        const session = createMutableApiSessionClientFixture({
            overrides: { sessionId },
        });
        const permissionHandler = createProviderEnforcedPermissionHandler({
            session,
            logPrefix: '[carried runtime authority test]',
        });
        let pluginDir: string | null = null;
        const runtime: AgentRuntime = {
            sessions: {
                open: async (_request, context) => {
                    pluginDir = await context.session.services.sessionHooks.createPluginDir({
                        files: [{
                            path: '.claude-plugin/plugin.json',
                            json: { name: 'carried-runtime-core-test' },
                        }],
                    });
                    return {
                        send: async () => ({ status: 'admitted' }),
                        watch: () => ({ dispose: () => undefined }),
                        dispose: async () => undefined,
                    };
                },
            },
        };
        const backend = {
            id: 'claude',
            agentId: 'claude',
            provenance: 'first_party',
            source: { kind: 'bundled' },
            definition: {
                kindVersion: 1,
                id: 'claude',
                agentId: 'claude',
            },
            runtimeKind: 'custom',
            pluginId: 'happier.agent.acme',
        };
        const agent = {
            id: 'claude',
            provenance: 'first_party',
            source: { kind: 'bundled' },
            definition: {
                kindVersion: 1,
                id: 'claude',
                ownedBackendIds: ['claude'],
            },
            richDefinition: {
                provenance: 'first_party',
                definition: {
                    id: 'claude',
                    title: { key: 'agents.acme.title', fallback: 'Acme' },
                    description: {
                        key: 'agents.acme.description',
                        fallback: 'Acme',
                    },
                    runtime: { kind: 'custom' },
                    primary: 'sessions',
                    capabilities: {
                        sessions: {
                            open: ['create'],
                            delivery: ['newTurn'],
                            cancel: true,
                        },
                    },
                },
            },
            pluginId: 'happier.agent.acme',
        };
        const adapter = await resolveBackendRuntimeCore({
            backend,
            agent,
            executionSurfaces: createEmptyBackendExecutionSurfaces(),
            runtimeOwner: {
                backendId: 'claude',
                selected: {
                    kind: 'plugin_engine',
                    ownerId: 'happier.agent.acme',
                    provenance: 'first_party',
                    pluginId: 'happier.agent.acme',
                },
                candidates: [],
            },
            runtimeRegistry: null,
            happyHomeDir,
            nativeAgentRuntime: runtime,
            nativeAgentRuntimeIdentity: {
                pluginId: 'happier.agent.acme',
                pluginVersion: '1.0.0',
                agentId: 'claude',
                generation: 'generation-1',
                runtimeAuthority: {
                    permissions: ['session.hooks.control'],
                    runtimeCapabilities: ['sessionHooks'],
                },
                isCurrent: () => true,
            },
        } as never);
        if (!adapter) throw new Error('Expected carrier-backed native runtime core');

        try {
            const plan = await adapter.runtimeCore.createSessionRuntime({
                credentials: {
                    token: 'test-token',
                    encryption: {
                        type: 'legacy',
                        secret: new Uint8Array(32).fill(1),
                    },
                },
                directory: happyHomeDir,
            });
            if (!isHostSessionRuntimePlan(plan) || !plan.config.createSessionRuntime) {
                throw new Error('Expected carrier-backed host session runtime plan');
            }
            const created = await plan.config.createSessionRuntime({
                directory: happyHomeDir,
                metadata: createTestMetadata({ path: happyHomeDir }),
                machineId: 'machine-1',
                session,
                transcriptSession: session,
                messageBuffer: new MessageBuffer(),
                mcpServers: {},
                permissionHandler,
                getPermissionMode: () => 'default',
                setThinking: () => undefined,
                memoryRecallGuidanceEnabled: false,
            });

            expect(pluginDir).not.toBeNull();
            await expect(stat(pluginDir!)).resolves.toBeDefined();
            await created.operations.resetOrDisposeRuntime('runtime_recovery');
        } finally {
            await rm(happyHomeDir, { recursive: true, force: true });
        }
    });
});
