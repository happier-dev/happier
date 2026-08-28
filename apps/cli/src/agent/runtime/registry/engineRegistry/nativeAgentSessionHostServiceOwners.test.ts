import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';
import type { AgentRuntime } from '@happier-dev/plugin-sdk/agents/runtime';
import { FeaturesResponseSchema, readHookEventEnvelopeV1 } from '@happier-dev/protocol';

import { createNativeAgentSessionHostServiceOwners } from './nativeAgentSessionHostServiceOwners';
import type { CliServerFeaturesSnapshot } from '@/features/featureDecisionService';
import { resolveBackendRuntimeCore } from './runtimeCore';
import { createEmptyBackendExecutionSurfaces } from '../engineRegistryTypes';
import { isHostSessionRuntimePlan } from '@/agent/runtime/session/loop/lifecycle';
import { createMutableApiSessionClientFixture } from '@/testkit/backends/sessionFixtures';
import { createTestMetadata } from '@/testkit/backends/sessionMetadata';
import { MessageBuffer } from '@/ui/ink/messageBuffer';
import { createProviderEnforcedPermissionHandler } from '@/agent/permissions/providerEnforced/createHandler';

describe('createNativeAgentSessionHostServiceOwners', () => {
    it('dispatches Agent tool interception and host-stamped observation through the exact retained runtime registry', async () => {
        const happyHomeDir = await mkdtemp(join(tmpdir(), 'happier-agent-tool-hooks-'));
        const observedAfterPayloads: unknown[] = [];
        const handler = async () => ({
            status: 'continue' as const,
            input: { command: 'pwd', intercepted: true },
        });
        const runtimeRegistry = {
            hookHandlersByHookId: new Map([
                ['agent.tool.execute.before', [{
                    pluginId: 'observer.plugin',
                    localId: 'before-tool',
                    hookId: 'agent.tool.execute.before',
                    priority: 0,
                    registrationIndex: 0,
                    manifestPath: '/plugins/observer/plugin.json',
                    daemonEntryPath: '/plugins/observer/daemon.mjs',
                    registration: {
                        provenance: 'external',
                        source: { kind: 'path' },
                        pluginId: 'observer.plugin',
                        manifestPath: '/plugins/observer/plugin.json',
                        daemonEntryPath: '/plugins/observer/daemon.mjs',
                        sourceSpec: {
                            kind: 'path',
                            locator: '/plugins/observer',
                            trustPolicy: 'local_trusted',
                            installPolicy: 'link',
                        },
                        definition: {
                            hookApiVersion: 1,
                            id: 'agent.tool.execute.before',
                            category: 'augmentation',
                            scope: 'tool',
                            executionKind: 'augment',
                        },
                    },
                    handler,
                }]],
                ['agent.tool.execute.after', [{
                    pluginId: 'observer.plugin',
                    localId: 'after-tool',
                    hookId: 'agent.tool.execute.after',
                    priority: 0,
                    registrationIndex: 1,
                    manifestPath: '/plugins/observer/plugin.json',
                    daemonEntryPath: '/plugins/observer/daemon.mjs',
                    registration: {
                        provenance: 'external',
                        source: { kind: 'path' },
                        pluginId: 'observer.plugin',
                        manifestPath: '/plugins/observer/plugin.json',
                        daemonEntryPath: '/plugins/observer/daemon.mjs',
                        sourceSpec: {
                            kind: 'path',
                            locator: '/plugins/observer',
                            trustPolicy: 'local_trusted',
                            installPolicy: 'link',
                        },
                        definition: {
                            hookApiVersion: 1,
                            id: 'agent.tool.execute.after',
                            category: 'lifecycle',
                            scope: 'tool',
                            executionKind: 'observe',
                        },
                    },
                    handler: async (event: unknown) => {
                        observedAfterPayloads.push(readHookEventEnvelopeV1(event)?.payload);
                    },
                }]],
            ]),
            contributes: {
                catalogEntriesById: {},
                activationTargets: [],
            },
        };
        const owners = createNativeAgentSessionHostServiceOwners({
            runtimeRegistry,
            runtimeAuthority: { runtimeCapabilities: [] },
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
                definition: { kindVersion: 1, id: 'acme', ownedBackendIds: ['acme'] },
                pluginId: 'happier.agent.acme',
            },
            hostSession: { session: { getMetadataSnapshot: () => ({}) } },
            sessionId: 'session-tool-hooks',
            directory: happyHomeDir,
            signal: new AbortController().signal,
            happyHomeDir,
        } as never);

        try {
            await expect(owners.toolExecution.before({
                turnId: 'turn-1',
                callId: 'call-1',
                name: 'Bash',
                input: { command: 'pwd' },
            })).resolves.toEqual({
                status: 'continue',
                input: { command: 'pwd', intercepted: true },
            });
            const forgedCallerRequest = {
                capability: 'interceptable' as const,
                turnId: 'turn-1',
                callId: 'call-1',
                name: 'Bash',
                input: { command: 'pwd', intercepted: true },
                outcome: { status: 'succeeded' as const, result: { output: '/workspace' } },
                timestampMs: 42,
                caller: { kind: 'plugin' as const, pluginId: 'forged.plugin' },
            };
            await owners.toolExecution.observeAfter(forgedCallerRequest);
            expect(observedAfterPayloads).toEqual([expect.objectContaining({
                caller: { kind: 'plugin', pluginId: 'happier.agent.acme' },
            })]);
        } finally {
            await owners.dispose();
            await rm(happyHomeDir, { recursive: true, force: true });
        }
    });

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
            hostSession: {
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
            hostSession: {
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
                agentTargetKey: 'backend:claude',
                session,
                transcriptSession: session,
                messageBuffer: new MessageBuffer(),
                mcpServers: {},
                permissionHandler,
                getPermissionMode: () => 'default',
                setThinking: () => undefined,
                memoryRecallGuidanceEnabled: false,
                runnerProcessIdentity: null,
                startupModelSelection: null,
                runWithTerminalModelSelection: async (effect) => ({
                    status: 'completed',
                    value: await effect(null, async (localEffect) => ({
                        status: 'completed',
                        value: await localEffect(),
                    })),
                }),
            });

            expect(pluginDir).not.toBeNull();
            await expect(stat(pluginDir!)).resolves.toBeDefined();
            await created.operations.resetOrDisposeRuntime('runtime_recovery');
        } finally {
            await rm(happyHomeDir, { recursive: true, force: true });
        }
    });
    it('decides a server-represented feature for plugins through the daemon-owned server features snapshot', async () => {
        const happyHomeDir = await mkdtemp(join(tmpdir(), 'happier-feature-decision-server-'));
        let serverSnapshot: CliServerFeaturesSnapshot | undefined;
        const owners = createNativeAgentSessionHostServiceOwners({
            runtimeRegistry: {
                contributes: { catalogEntriesById: {}, activationTargets: [] },
                hookHandlersByHookId: new Map(),
                resolveServerFeaturesSnapshot: () => serverSnapshot,
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
                definition: { kindVersion: 1, id: 'acme', ownedBackendIds: ['acme'] },
                pluginId: 'happier.agent.acme',
            },
            hostSession: { session: { getMetadataSnapshot: () => ({}) } },
            sessionId: 'session-feature-decision-server',
            directory: happyHomeDir,
            signal: new AbortController().signal,
            happyHomeDir,
        } as never);

        try {
            // `automations` is server-represented, so without the daemon's snapshot the canonical
            // decision owner returns `unknown`/`probe_failed` and the plugin sees it disabled for
            // the whole session even on an Account where the server enabled it.
            expect(owners.features.isEnabled('automations')).toBe(false);

            serverSnapshot = {
                status: 'ready',
                features: FeaturesResponseSchema.parse({
                    features: { automations: { enabled: true } },
                    capabilities: {},
                }),
            };
            expect(owners.features.isEnabled('automations')).toBe(true);

            serverSnapshot = {
                status: 'ready',
                features: FeaturesResponseSchema.parse({
                    features: { automations: { enabled: false } },
                    capabilities: {},
                }),
            };
            expect(owners.features.isEnabled('automations')).toBe(false);
        } finally {
            await owners.dispose();
            await rm(happyHomeDir, { recursive: true, force: true });
        }
    });

    it('re-derives the plugin-facing feature decision on every read instead of caching the first answer', async () => {
        const happyHomeDir = await mkdtemp(join(tmpdir(), 'happier-feature-decision-live-'));
        const previous = process.env.HAPPIER_FEATURE_EXECUTION_RUNS__ENABLED;
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
            hostSession: {
                session: {
                    getMetadataSnapshot: () => ({}),
                },
            },
            sessionId: 'session-feature-decision-live',
            directory: happyHomeDir,
            signal: new AbortController().signal,
            happyHomeDir,
        } as never);

        try {
            // `execution.runs` is client-decidable (no server snapshot required) and its CLI local
            // policy reads the environment, so the SAME session runtime can legitimately see the
            // decision change. A first read that caches its answer reports the stale one forever.
            delete process.env.HAPPIER_FEATURE_EXECUTION_RUNS__ENABLED;
            expect(owners.features.isEnabled('execution.runs')).toBe(true);

            process.env.HAPPIER_FEATURE_EXECUTION_RUNS__ENABLED = '0';
            expect(owners.features.isEnabled('execution.runs')).toBe(false);

            process.env.HAPPIER_FEATURE_EXECUTION_RUNS__ENABLED = '1';
            expect(owners.features.isEnabled('execution.runs')).toBe(true);
        } finally {
            if (previous === undefined) {
                delete process.env.HAPPIER_FEATURE_EXECUTION_RUNS__ENABLED;
            } else {
                process.env.HAPPIER_FEATURE_EXECUTION_RUNS__ENABLED = previous;
            }
            await owners.dispose();
            await rm(happyHomeDir, { recursive: true, force: true });
        }
    });
});
