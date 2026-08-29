import type {
    PluginContributionIdentityV1,
    PluginProjectedActionV2,
    PluginResourceContextV1,
} from '@happier-dev/protocol';
import {
    PluginUiSelectActionInputResultV1Schema,
    type PluginUiJsonValueV1,
    type PluginUiTargetedContributionsV1,
} from '@happier-dev/protocol/plugins/ui';
import { Linking } from 'react-native';
import * as React from 'react';
import { act } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';

import { createMachineFixture, renderHook } from '@/dev/testkit';
import type { PluginProjectionEntry } from '@/agents/backendCatalog/daemonContributionRegistryProjectionAdapters';
import { log } from '@/log';
import { storage } from '@/sync/domains/state/storageStore';
import {
    createBoundPluginSurfaceController,
    useBoundPluginSurfaceController,
    usePluginSurfaceDaemonInteraction,
} from './boundPluginSurfaceController';
import type { PluginSurfaceResourceReadTransport } from './pluginSurfaceResourceRead';

const clipboard = vi.hoisted(() => ({
    getStringAsync: vi.fn(),
    setStringAsync: vi.fn(),
}));

vi.mock('expo-clipboard', () => clipboard);

const CURRENT_ACCOUNT_LIFETIME = Object.freeze({
    scope: { serverId: 'server-1', accountId: 'account-a' },
    isCurrent: () => true,
    onRetire: () => Object.freeze({ dispose: () => {} }),
});

function resolveDaemonTargetAction(
    identity: PluginContributionIdentityV1,
): PluginProjectedActionV2 {
    return {
        id: identity.localId,
        pluginId: identity.pluginId,
        title: identity.localId,
        scopes: ['session'],
        surfaces: ['ui'],
        execution: { target: 'daemon' },
        dangerLevel: 'safe',
        // The canonical daemon writer stamps `available` on every projected
        // Action (apps/cli/src/plugins/projection/registry/projection/v2.ts),
        // so an ordinary reachable fixture must carry it too. The deliberate
        // unavailable case lives in its own negative control below.
        available: true,
    };
}

function resolveClientTargetAction(
    identity: PluginContributionIdentityV1,
): PluginProjectedActionV2 {
    return {
        id: identity.localId,
        pluginId: identity.pluginId,
        title: identity.localId,
        scopes: ['session'],
        surfaces: ['ui'],
        execution: {
            target: 'client',
            client: {
                artifactId: 'client-action-bundle',
                modulePath: './actions/clientAction',
                exportName: 'execute',
            },
            platforms: ['web'],
        },
        dangerLevel: 'safe',
        available: true,
    };
}

/**
 * The exact same client target the daemon reports as not currently
 * registered. This is the negative control for the one fail-closed
 * executability rule (`isPluginProjectedActionExecutable`).
 */
function resolveUnavailableClientTargetAction(
    identity: PluginContributionIdentityV1,
): PluginProjectedActionV2 {
    return { ...resolveClientTargetAction(identity), available: false };
}

const FACTS = {
    pluginId: 'acme.browser',
    contributionId: 'panel',
    surfaceId: 'surfacePlacement:acme.browser:panel',
    placement: 'browserSurface',
    platform: 'web',
    channel: 'internal',
    machineId: 'machine_1',
    serverId: 'server-1',
    projectionGeneration: 12,
    executionOrigin: {
        serverIdentityId: 'srv_browser_fixture',
        materializationRef: {
            machineId: 'machine_1',
            materializationId: 'materialization-browser-current',
            pluginId: 'acme.browser',
        },
    },
    resourceCapability: { readable: true, dynamic: true },
    resolveContributedAction: resolveDaemonTargetAction,
    accountLifetime: CURRENT_ACCOUNT_LIFETIME,
    interactionEnabled: true,
    daemonInteractionEnabled: true,
} as const;

const TARGETED_RESOURCE_MOUNT_INSTANCE_KEY = 'targeted-surface:v1:review:mount-a';

function createTargetedSurfaceResourceContext(
    launchInput: PluginUiJsonValueV1,
): PluginResourceContextV1 {
    return Object.freeze({
        kind: 'surface' as const,
        mountInstanceKey: TARGETED_RESOURCE_MOUNT_INSTANCE_KEY,
        launchInput,
    });
}

function request(method: string, payload?: unknown) {
    return {
        version: 1,
        requestId: `req:${method}`,
        surface: {
            pluginId: FACTS.pluginId,
            contributionId: FACTS.contributionId,
            surfaceId: FACTS.surfaceId,
            placement: FACTS.placement,
            platform: FACTS.platform,
            channel: FACTS.channel,
            resourceScope: [],
            diagnostics: [],
        },
        method,
        ...(payload === undefined ? {} : { payload }),
    } as never;
}

describe('BoundPluginSurfaceController (§3.1)', () => {
    it('passes the raw client target to the canonical dispatcher before daemon availability', async () => {
        const executeContributedAction = vi.fn();
        const controller = createBoundPluginSurfaceController({
            facts: {
                ...FACTS,
                daemonInteractionEnabled: false,
                resolveContributedAction: resolveClientTargetAction,
            },
            binding: { executeContributedAction: executeContributedAction as never },
        });

        await expect(controller.hostApi.handleRequest(request('executeAction', {
            action: 'refresh-index',
            input: {},
        }))).resolves.toEqual({
            code: 'unavailable',
            diagnostics: ['plugin_surface_client_action_unavailable'],
        });
        expect(executeContributedAction).not.toHaveBeenCalled();
    });

    it('refuses an Action the daemon projection reports as not currently available', async () => {
        const executeContributedAction = vi.fn();
        const controller = createBoundPluginSurfaceController({
            facts: {
                ...FACTS,
                daemonInteractionEnabled: false,
                resolveContributedAction: resolveUnavailableClientTargetAction,
            },
            binding: { executeContributedAction: executeContributedAction as never },
        });

        // Same identity, same target, same transport state as the positive
        // twin above — only `available` differs, so this discriminates the
        // fail-closed executability rule from every other refusal.
        await expect(controller.hostApi.handleRequest(request('executeAction', {
            action: 'refresh-index',
            input: {},
        }))).resolves.toEqual({
            code: 'unavailable',
            diagnostics: ['plugin_surface_action_projection_unavailable'],
        });
        expect(executeContributedAction).not.toHaveBeenCalled();
    });

    it('keeps raw daemon reachability factual when projection admission disables actions', async () => {
        const previousState = storage.getState();
        try {
            await act(async () => {
                storage.setState((state) => ({
                    ...state,
                    endpointStatus: 'online',
                    machines: {
                        ...state.machines,
                        'machine_1': createMachineFixture({
                            id: 'machine_1',
                            active: true,
                            activeAt: Date.now(),
                            daemonStateVersion: 13,
                        }),
                    },
                }));
            });
            const hook = await renderHook(() => usePluginSurfaceDaemonInteraction({
                machineId: 'machine_1',
                projectionInteractionEnabled: false,
            }));

            // A projection can withhold Action/Resource admission while the
            // exact daemon remains reachable for its separately-owned Settings
            // target. Collapsing these facts would suppress that read.
            expect(hook.getCurrent()).toEqual({
                endpointOnline: true,
                hasAddressedMachine: true,
                daemonReachable: true,
                enabled: false,
                daemonStateVersion: 13,
            });
            await hook.unmount();
        } finally {
            await act(async () => {
                storage.setState(previousState);
            });
        }
    });

    it('fails closed when the mount has no captured active Account lifetime', () => {
        const executeContributedAction = vi.fn();
        const controller = createBoundPluginSurfaceController({
            facts: { ...FACTS, accountLifetime: null },
            binding: { executeContributedAction: executeContributedAction as never },
        });

        // An absent Account scope is not an implicit global lifetime. The facade
        // must neither advertise handlers nor answer even its local context.
        expect(controller.isCurrent()).toBe(false);
        expect(controller.installedMethods).toEqual([]);
        expect(controller.interactive).toBe(false);
        expect(controller.hostApi.handleRequest(request('context'))).toEqual({
            code: 'stale_surface',
            diagnostics: ['plugin_surface_retired'],
        });
        expect(executeContributedAction).not.toHaveBeenCalled();
    });

    it('publishes qualified data through the exact mounted Host API and distinguishes null from an absent payload', async () => {
        const publication = {
            publish: vi.fn(() => true),
            clear: vi.fn(),
            restore: vi.fn(),
            dispose: vi.fn(),
        };
        const createMountedHostApiHandlers = vi.fn(() => ({
            handlers: {},
            currentUiContext: publication,
        }));
        const controller = createBoundPluginSurfaceController({
            facts: FACTS,
            binding: { createMountedHostApiHandlers } as never,
        });
        const enrichment = {
            entity: {
                kind: 'issue',
                label: 'Issue A',
                reference: { number: 1 },
            },
            detail: { state: 'open' },
            commands: [{
                title: 'Open issue B',
                description: 'Navigate to the related issue',
                command: {
                    kind: 'openSurface',
                    destination: 'issues',
                    input: { issueNumber: 2 },
                },
            }],
        };

        expect(controller.installedMethods).toContain('publishCurrentUiContext');
        await expect(Promise.resolve(controller.hostApi.handleRequest(request('publishCurrentUiContext', {
            enrichment,
        })))).resolves.toBeNull();
        expect(publication.publish).toHaveBeenCalledWith({
            entity: enrichment.entity,
            detail: enrichment.detail,
            commands: [{
                title: 'Open issue B',
                description: 'Navigate to the related issue',
                command: {
                    kind: 'openSurface',
                    destination: { pluginId: FACTS.pluginId, localId: 'issues' },
                    input: { issueNumber: 2 },
                },
            }],
        });

        await expect(Promise.resolve(controller.hostApi.handleRequest(request('publishCurrentUiContext', {
            enrichment: null,
        })))).resolves.toBeNull();
        expect(publication.publish).toHaveBeenLastCalledWith(null);

        await expect(Promise.resolve(controller.hostApi.handleRequest(request('publishCurrentUiContext', {})))).resolves.toEqual({
            code: 'invalid_payload',
            diagnostics: ['plugin_current_ui_context_payload_invalid'],
        });
        expect(publication.publish).toHaveBeenCalledTimes(2);

        controller.clearCurrentUiContext();
        expect(publication.clear).toHaveBeenCalledTimes(1);
        controller.dispose();
        expect(publication.dispose).toHaveBeenCalledTimes(1);
    });

    it('does not admit a competing mounted publish handler without the controller-bound publication capability', async () => {
        const forbiddenPublish = vi.fn(() => ({ accepted: true }));
        const controller = createBoundPluginSurfaceController({
            facts: FACTS,
            binding: {
                mountedHostApiHandlers: {
                    publishCurrentUiContext: forbiddenPublish,
                },
            },
        });

        expect(controller.installedMethods).not.toContain('publishCurrentUiContext');
        await expect(Promise.resolve(controller.hostApi.handleRequest(request('publishCurrentUiContext', {
            enrichment: { entity: { kind: 'issue', label: 'Bypass' } },
        })))).resolves.toEqual({
            code: 'unsupported_method',
            diagnostics: ['host_api_method_not_installed:publishCurrentUiContext'],
        });
        expect(forbiddenPublish).not.toHaveBeenCalled();
    });

    it('retires an A publication before B can publish and fences late A work', async () => {
        const publications: Array<{
            publish: ReturnType<typeof vi.fn>;
            clear: ReturnType<typeof vi.fn>;
            restore: ReturnType<typeof vi.fn>;
            dispose: ReturnType<typeof vi.fn>;
        }> = [];
        const createMountedHostApiHandlers = vi.fn(() => {
            const publication = {
                publish: vi.fn(() => true),
                clear: vi.fn(),
                restore: vi.fn(),
                dispose: vi.fn(),
            };
            publications.push(publication);
            return {
                handlers: {},
                currentUiContext: publication,
            };
        });
        const binding = { createMountedHostApiHandlers } as never;
        const hook = await renderHook(
            (sessionId: string) => useBoundPluginSurfaceController({
                facts: { ...FACTS, sessionId },
                binding,
            }),
            { initialProps: 'session-a' },
        );
        const first = hook.getCurrent();

        await expect(Promise.resolve(first.hostApi.handleRequest(request('publishCurrentUiContext', {
            enrichment: { entity: { kind: 'issue', label: 'Issue A' } },
        })))).resolves.toBeNull();
        expect(publications[0]?.publish).toHaveBeenCalledTimes(1);

        const second = await hook.rerender('session-b');
        expect(first.isCurrent()).toBe(false);
        expect(publications[0]?.dispose).toHaveBeenCalledTimes(1);
        await expect(Promise.resolve(first.hostApi.handleRequest(request('publishCurrentUiContext', {
            enrichment: { entity: { kind: 'issue', label: 'Late A' } },
        })))).resolves.toEqual({
            code: 'stale_surface',
            diagnostics: ['plugin_surface_retired'],
        });
        expect(publications[0]?.publish).toHaveBeenCalledTimes(1);

        await expect(Promise.resolve(second.hostApi.handleRequest(request('publishCurrentUiContext', {
            enrichment: { entity: { kind: 'issue', label: 'Issue B' } },
        })))).resolves.toBeNull();
        expect(publications[1]?.publish).toHaveBeenCalledTimes(1);
        await hook.unmount();
        expect(publications[1]?.dispose).toHaveBeenCalledTimes(1);
    });

    it('replaces and retires the controller when its exact Session identity changes', async () => {
        const hook = await renderHook(
            (sessionId: string) => useBoundPluginSurfaceController({
                facts: { ...FACTS, sessionId },
            }),
            { initialProps: 'session-1' },
        );
        const first = hook.getCurrent();

        const second = await hook.rerender('session-2');

        expect(second).not.toBe(first);
        expect(first.isCurrent()).toBe(false);
        expect(second.surfaceContext.sessionId).toBe('session-2');
    });

    it('replaces and retires the controller when its private target authority changes under one Session', async () => {
        const hook = await renderHook(
            (targetAuthorityKey: string) => useBoundPluginSurfaceController({
                facts: {
                    ...FACTS,
                    sessionId: 'session-1',
                    targetAuthorityKey,
                },
            }),
            { initialProps: '["browser","target-a",null]' },
        );
        const first = hook.getCurrent();

        const second = await hook.rerender('["browser","target-b",null]');

        expect(second).not.toBe(first);
        expect(first.isCurrent()).toBe(false);
        // The private key fences the facade only; it must not mutate the
        // controller's public Protocol surface identity into a second target
        // representation.
        expect(second.surfaceContext.sessionId).toBe('session-1');
    });

    it('keeps one controller for equivalent daemon target snapshots and retires it for semantic projection or target-generation replacement', async () => {
        const daemonFactsFor = (input: Readonly<{
            targetGeneration: string;
            actionTitle: string;
            unrelatedTitle: string;
        }>) => {
            const operation = {
                point: { pointId: 'review', protocol: { id: 'review', version: 1 } },
                contributor: {
                    pluginId: FACTS.pluginId,
                    contributionId: 'review',
                    immutableGenerationId: 'review-contributor-generation-a',
                },
                role: 'setup' as const,
                action: { pluginId: FACTS.pluginId, localId: 'configure' },
            };
            const targetedContributions = {
                target: {
                    pluginId: FACTS.pluginId,
                    immutableGenerationId: input.targetGeneration,
                },
                points: [{
                    pointId: operation.point.pointId,
                    protocols: [{
                        protocol: operation.point.protocol,
                        contributions: [{
                            contributor: operation.contributor,
                            protocol: operation.point.protocol,
                            operations: [operation],
                            surfaces: [],
                        }],
                    }],
                }],
            } satisfies PluginUiTargetedContributionsV1;
            const pluginProjectionById = {
                [FACTS.pluginId]: {
                    pluginId: FACTS.pluginId,
                    immutableGenerationId: input.targetGeneration,
                    title: 'Browser',
                    description: null,
                    version: '1.0.0',
                    enabled: true,
                    generation: 12,
                    generationLabel: '12',
                    status: null,
                    provenance: null,
                    diagnostics: [],
                    actions: [{
                        id: operation.action.localId,
                        title: input.actionTitle,
                        description: null,
                        icon: null,
                        scopes: [],
                        surfaces: ['plugin'],
                        placementBindings: [],
                        inputSchema: null,
                        inputHints: null,
                        slash: null,
                        priority: null,
                        dangerLevel: 'safe',
                        confirmation: null,
                        available: true,
                    }],
                    resources: [],
                    editableSettingsGroups: [],
                },
                'acme.unrelated': {
                    pluginId: 'acme.unrelated',
                    immutableGenerationId: 'unrelated-generation-a',
                    title: input.unrelatedTitle,
                    description: null,
                    version: '1.0.0',
                    enabled: true,
                    generation: 12,
                    generationLabel: '12',
                    status: null,
                    provenance: null,
                    diagnostics: [],
                    actions: [],
                    resources: [],
                    editableSettingsGroups: [],
                },
            } satisfies Readonly<Record<string, PluginProjectionEntry>>;
            return { targetedContributions, pluginProjectionById };
        };
        const initialDaemonFacts = daemonFactsFor({
            targetGeneration: 'browser-generation-a',
            actionTitle: 'Configure browser',
            unrelatedTitle: 'Unrelated initial',
        });
        const hook = await renderHook(
            (daemonFacts: ReturnType<typeof daemonFactsFor>) => useBoundPluginSurfaceController({
                facts: { ...FACTS, ...daemonFacts },
            }),
            { initialProps: initialDaemonFacts },
        );
        const first = hook.getCurrent();
        const firstRetirement = vi.fn();
        first.onRetire(firstRetirement);

        const equivalentDaemonFacts = daemonFactsFor({
            targetGeneration: 'browser-generation-a',
            actionTitle: 'Configure browser',
            unrelatedTitle: 'Unrelated initial',
        });
        expect(equivalentDaemonFacts.targetedContributions).not.toBe(initialDaemonFacts.targetedContributions);
        expect(equivalentDaemonFacts.pluginProjectionById).not.toBe(initialDaemonFacts.pluginProjectionById);
        const equivalent = await hook.rerender(equivalentDaemonFacts);

        // Daemon responses reconstruct maps and target snapshots. Object identity
        // is not a currentness fact: the mount, facade, and subscriptions remain.
        expect(equivalent).toBe(first);
        expect(equivalent.hostApi).toBe(first.hostApi);
        expect(first.isCurrent()).toBe(true);
        expect(firstRetirement).not.toHaveBeenCalled();

        const unrelatedProjectionRefresh = await hook.rerender(daemonFactsFor({
            targetGeneration: 'browser-generation-a',
            actionTitle: 'Configure browser',
            unrelatedTitle: 'Unrelated revised',
        }));
        // The target snapshot cannot select this plugin, so its independent
        // projection update must not retire the mount or its subscriptions.
        expect(unrelatedProjectionRefresh).toBe(first);
        expect(first.isCurrent()).toBe(true);
        expect(firstRetirement).not.toHaveBeenCalled();

        const projectionReplacement = await hook.rerender(daemonFactsFor({
            targetGeneration: 'browser-generation-a',
            actionTitle: 'Configure revised browser',
            unrelatedTitle: 'Unrelated revised',
        }));
        expect(projectionReplacement).not.toBe(first);
        expect(first.isCurrent()).toBe(false);
        expect(firstRetirement).toHaveBeenCalledTimes(1);

        const targetReplacement = await hook.rerender(daemonFactsFor({
            targetGeneration: 'browser-generation-b',
            actionTitle: 'Configure revised browser',
            unrelatedTitle: 'Unrelated revised',
        }));
        expect(targetReplacement).not.toBe(projectionReplacement);
        expect(projectionReplacement.isCurrent()).toBe(false);
        expect(targetReplacement.isCurrent()).toBe(true);
        await hook.unmount();
    });

    it('keeps an equivalent targeted Resource context mounted but replaces it when its launch input changes', async () => {
        const hook = await renderHook(
            (launchInput: PluginUiJsonValueV1) => {
                const facts = {
                    ...FACTS,
                    resourceContext: createTargetedSurfaceResourceContext(launchInput),
                };
                return useBoundPluginSurfaceController({ facts });
            },
            { initialProps: { reviewId: 'review-a' } },
        );
        const first = hook.getCurrent();

        const same = await hook.rerender({ reviewId: 'review-a' });

        // A parent refresh must not replace the existing Resource watch just
        // because it reconstructed equivalent JSON input.
        expect(same).toBe(first);

        const replacement = await hook.rerender({ reviewId: 'review-b' });

        expect(replacement).not.toBe(first);
        expect(first.isCurrent()).toBe(false);
        await hook.unmount();
    });

    it('forwards the exact host-stamped targeted Resource context through a mounted snapshot read', async () => {
        const requests: unknown[] = [];
        const context = createTargetedSurfaceResourceContext({ reviewId: 'review-a' });
        const read: PluginSurfaceResourceReadTransport = async (machineId, options) => {
            requests.push({ machineId, ...options });
            return {
                supported: true,
                result: {
                    ok: true,
                    resource: options.resource,
                    kind: 'asset',
                    contentType: 'text/plain',
                    digest: `sha256:${'a'.repeat(64)}`,
                    bytesBase64: 'b2s=',
                },
            };
        };
        const facts = { ...FACTS, resourceContext: context };
        const controller = createBoundPluginSurfaceController({
            facts,
            binding: { readResource: read },
        });

        await expect(controller.hostApi.handleRequest(request('readResource', {
            resource: 'review-summary',
        }))).resolves.toMatchObject({ contentType: 'text/plain' });
        expect(requests).toEqual([expect.objectContaining({
            machineId: 'machine_1',
            callerPluginId: FACTS.pluginId,
            expectedGeneration: '12',
            resource: { pluginId: FACTS.pluginId, localId: 'review-summary' },
            context,
        })]);
        controller.dispose();
    });

    it('fences a targeted Resource read that settles after same-mount launch input replacement', async () => {
        let settle: ((value: unknown) => void) | undefined;
        const read = vi.fn(() => new Promise((resolve) => { settle = resolve; }));
        const hook = await renderHook(
            (launchInput: PluginUiJsonValueV1) => {
                const facts = {
                    ...FACTS,
                    resourceContext: createTargetedSurfaceResourceContext(launchInput),
                };
                return useBoundPluginSurfaceController({
                    facts,
                    binding: { readResource: read as never },
                });
            },
            { initialProps: { reviewId: 'review-a' } },
        );
        const original = hook.getCurrent();
        const pending = original.hostApi.handleRequest(request('readResource', {
            resource: 'review-summary',
        }));
        expect(read).toHaveBeenCalledTimes(1);

        await hook.rerender({ reviewId: 'review-b' });
        settle!({
            supported: true,
            result: {
                ok: true,
                contentType: 'text/plain',
                digest: `sha256:${'b'.repeat(64)}`,
                bytesBase64: 'b2s=',
            },
        });

        await expect(pending).resolves.toEqual({
            code: 'unavailable',
            diagnostics: ['plugin_surface_retired'],
        });
        await hook.unmount();
    });

    it('aborts an in-flight targeted Resource read when same-mount launch input replacement retires its controller', async () => {
        let resourceSignal: AbortSignal | undefined;
        const read: PluginSurfaceResourceReadTransport = async (_machineId, options) => {
            resourceSignal = options.signal;
            return await new Promise((resolve) => {
                options.signal?.addEventListener('abort', () => {
                    resolve({ supported: false, reason: 'aborted' });
                }, { once: true });
            });
        };
        const hook = await renderHook(
            (launchInput: PluginUiJsonValueV1) => {
                const facts = {
                    ...FACTS,
                    resourceContext: createTargetedSurfaceResourceContext(launchInput),
                };
                return useBoundPluginSurfaceController({
                    facts,
                    binding: { readResource: read },
                });
            },
            { initialProps: { reviewId: 'review-a' } },
        );
        const original = hook.getCurrent();
        const pending = original.hostApi.handleRequest(request('readResource', {
            resource: 'review-summary',
        }));
        await vi.waitFor(() => { expect(resourceSignal).toBeDefined(); });

        await hook.rerender({ reviewId: 'review-b' });

        expect(resourceSignal?.aborted).toBe(true);
        await expect(pending).resolves.toEqual({
            code: 'unavailable',
            diagnostics: ['plugin_surface_retired'],
        });
        await hook.unmount();
    });

    it('composes caller cancellation into an otherwise-current targeted Resource read', async () => {
        let resourceSignal: AbortSignal | undefined;
        const read: PluginSurfaceResourceReadTransport = async (_machineId, options) => {
            resourceSignal = options.signal;
            return await new Promise((resolve) => {
                options.signal?.addEventListener('abort', () => {
                    resolve({ supported: false, reason: 'aborted' });
                }, { once: true });
            });
        };
        const controller = createBoundPluginSurfaceController({
            facts: {
                ...FACTS,
                resourceContext: createTargetedSurfaceResourceContext({ reviewId: 'review-a' }),
            },
            binding: { readResource: read },
        });
        const caller = new AbortController();
        const pending = controller.hostApi.handleRequest(
            request('readResource', { resource: 'review-summary' }),
            { signal: caller.signal },
        );
        await vi.waitFor(() => { expect(resourceSignal).toBeDefined(); });
        expect(controller.isCurrent()).toBe(true);

        caller.abort();

        expect(resourceSignal?.aborted).toBe(true);
        await expect(pending).resolves.toEqual({
            code: 'unavailable',
            diagnostics: ['plugin_resource_aborted'],
        });
        expect(controller.isCurrent()).toBe(true);
        controller.dispose();
    });

    it('host-stamps the mounted exact machine for detached execution.run Actions', async () => {
        const executeHostAction = vi.fn(async () => ({ ok: true as const, result: { runId: 'run_1' } }));
        const controller = createBoundPluginSurfaceController({
            facts: FACTS,
            binding: { executeHostAction },
        });

        await expect(controller.hostApi.handleRequest(request('executeAction', {
            action: 'execution.run.start',
            input: {
                sessionId: null,
                intent: 'delegate',
                backendTarget: { kind: 'builtInAgent', agentId: 'codex' },
                permissionMode: 'read_only',
                retentionPolicy: 'ephemeral',
                runClass: 'bounded',
                ioMode: 'request_response',
            },
        }))).resolves.toEqual({ runId: 'run_1' });

        expect(executeHostAction).toHaveBeenCalledWith(
            'execution.run.start',
            expect.objectContaining({ sessionId: null }),
            expect.objectContaining({
                serverId: 'server-1',
                executionRunTargetMachineId: 'machine_1',
                surface: 'plugin',
                actionCaller: {
                    kind: 'plugin',
                    pluginId: FACTS.pluginId,
                    contributionLocalId: FACTS.contributionId,
                    materialization: FACTS.executionOrigin.materializationRef,
                },
            }),
        );
    });

    it('keeps the exact mounted caller for a local host Action when daemon transport is unavailable', async () => {
        const executeHostAction = vi.fn(async () => ({ ok: true as const, result: { reloaded: true } }));
        const controller = createBoundPluginSurfaceController({
            facts: { ...FACTS, daemonInteractionEnabled: false },
            binding: { executeHostAction },
        });

        await expect(controller.hostApi.handleRequest(request('executeAction', {
            action: 'plugins.reload',
            input: {},
        }))).resolves.toEqual({ reloaded: true });

        expect(executeHostAction).toHaveBeenCalledWith('plugins.reload', {}, {
            serverId: 'server-1',
            surface: 'plugin',
            actionCaller: {
                kind: 'plugin',
                pluginId: FACTS.pluginId,
                contributionLocalId: FACTS.contributionId,
                materialization: FACTS.executionOrigin.materializationRef,
            },
        });
    });

    it('refuses a mounted Action when its origin no longer matches the mounted plugin', async () => {
        const executeHostAction = vi.fn(async () => ({ ok: true as const, result: { shouldNotRun: true } }));
        const controller = createBoundPluginSurfaceController({
            facts: {
                ...FACTS,
                executionOrigin: {
                    ...FACTS.executionOrigin,
                    materializationRef: {
                        ...FACTS.executionOrigin.materializationRef,
                        pluginId: 'acme.replaced',
                    },
                },
            },
            binding: { executeHostAction },
        });

        await expect(controller.hostApi.handleRequest(request('executeAction', {
            action: 'plugins.reload',
            input: {},
        }))).resolves.toEqual({
            code: 'unavailable',
            diagnostics: ['plugin_mounted_caller_unavailable'],
        });
        expect(executeHostAction).not.toHaveBeenCalled();
    });

    it('fences an in-flight daemon read behind the mount lifetime it owns', async () => {
        let settle: ((value: unknown) => void) | undefined;
        const read = vi.fn(() => new Promise((resolve) => {
            settle = resolve;
        }));
        const controller = createBoundPluginSurfaceController({
            facts: FACTS,
            binding: { readResource: read as never },
        });

        const pending = controller.hostApi.handleRequest(request('readResource', { resource: 'index' }));
        expect(read).toHaveBeenCalledTimes(1);

        // The surface retires while the daemon is still reading. The bytes it
        // eventually returns must not be disclosed to a mount that no longer
        // exists — a controller that installed the handlers without its own
        // lifetime would resolve them.
        controller.dispose();
        settle!({
            supported: true,
            result: {
                ok: true,
                contentType: 'application/json',
                digest: 'sha256:0000000000000000000000000000000000000000000000000000000000000000',
                bytesBase64: 'e30=',
            },
        });

        await expect(pending).resolves.toEqual({
            code: 'unavailable',
            diagnostics: ['plugin_surface_retired'],
        });
    });

    it('installs openSurface only where the placement owns a destination selector', () => {
        const withoutDestination = createBoundPluginSurfaceController({ facts: FACTS });
        expect(withoutDestination.installedMethods).not.toContain('openSurface');

        const withDestination = createBoundPluginSurfaceController({
            facts: FACTS,
            binding: { openSurface: () => ({ ok: true }) },
        });
        expect(withDestination.installedMethods).toContain('openSurface');
    });

    it('installs the closed Session draft selector for every exact daemon mount while retaining target scope for contributed selection', () => {
        const pluginProjectionById = {
            'acme.provider': {
                pluginId: 'acme.provider',
                title: 'Provider',
                description: null,
                version: '1.0.0',
                enabled: true,
                generation: 12,
                generationLabel: '12',
                status: null,
                provenance: null,
                diagnostics: [],
                actions: [{
                    id: 'connection/prepare-v1',
                    title: 'Prepare',
                    description: null,
                    icon: null,
                    scopes: ['settings'],
                    surfaces: ['plugin'],
                    placementBindings: [],
                    inputSchema: null,
                    inputHints: null,
                    slash: null,
                    priority: null,
                    dangerLevel: 'safe',
                    confirmation: null,
                    available: true,
                }],
                resources: [],
                editableSettingsGroups: [],
            },
        } as const;
        const targetedContributions: PluginUiTargetedContributionsV1 = {
            target: {
                pluginId: FACTS.pluginId,
                immutableGenerationId: 'browser-generation-a',
            },
            points: [{
                pointId: 'connection',
                protocols: [{
                    protocol: { id: 'provider', version: 1 },
                    contributions: [{
                        contributor: {
                            pluginId: 'acme.provider',
                            contributionId: 'provider',
                            immutableGenerationId: 'provider-generation-a',
                        },
                        protocol: { id: 'provider', version: 1 },
                        operations: [{
                            point: { pointId: 'connection', protocol: { id: 'provider', version: 1 } },
                            contributor: {
                                pluginId: 'acme.provider',
                                contributionId: 'provider',
                                immutableGenerationId: 'provider-generation-a',
                            },
                            role: 'setup',
                            action: { pluginId: 'acme.provider', localId: 'connection/prepare-v1' },
                        }],
                        surfaces: [],
                    }],
                }],
            }],
        };

        const withoutSnapshot = createBoundPluginSurfaceController({
            facts: {
                ...FACTS,
                pluginProjectionById,
            },
        });
        expect(withoutSnapshot.installedMethods).toContain('selectActionInput');

        const withMountedSnapshot = createBoundPluginSurfaceController({
            facts: {
                ...FACTS,
                pluginProjectionById,
                targetedContributions,
            },
        });
        expect(withMountedSnapshot.installedMethods).toContain('selectActionInput');

        const wrongTarget = createBoundPluginSurfaceController({
            facts: {
                ...FACTS,
                pluginProjectionById,
                targetedContributions: {
                    ...targetedContributions,
                    target: { ...targetedContributions.target, pluginId: 'acme.other-target' },
                },
            },
        });
        expect(wrongTarget.installedMethods).toContain('selectActionInput');
    });

    it('keeps the mounted Channels caller binding while its selected provider form consumes only host-resolved Connected Account options', async () => {
        const account = {
            service: { pluginId: 'happier.channel.discord', localId: 'discord-bot' },
            accountId: 'account-discord-a',
        } as const;
        const operation = {
            point: { pointId: 'providers', protocol: { id: 'happier.channels/providers', version: 1 } },
            contributor: {
                pluginId: 'happier.channel.discord',
                contributionId: 'discord-provider',
                immutableGenerationId: 'discord-generation-a',
            },
            role: 'setup',
            action: { pluginId: 'happier.channel.discord', localId: 'channels/setup-v1' },
        } as const;
        const channelsFacts = {
            ...FACTS,
            pluginId: 'happier.channels',
            contributionId: 'settings',
            surfaceId: 'surfacePlacement:happier.channels:settings',
            executionOrigin: {
                ...FACTS.executionOrigin,
                materializationRef: {
                    ...FACTS.executionOrigin.materializationRef,
                    materializationId: 'channels-materialization-a',
                    pluginId: 'happier.channels',
                },
            },
        } as const;
        const pluginProjectionById: Readonly<Record<string, PluginProjectionEntry>> = {
            'happier.channel.discord': {
                pluginId: 'happier.channel.discord',
                immutableGenerationId: 'discord-generation-a',
                title: 'Discord Channels',
                description: null,
                version: '1.0.0',
                enabled: true,
                generation: 12,
                generationLabel: '12',
                status: null,
                provenance: null,
                diagnostics: [],
                actions: [{
                    id: 'channels/setup-v1',
                    title: 'Set up Discord Channels',
                    description: null,
                    icon: null,
                    scopes: ['settings'],
                    surfaces: ['plugin'],
                    placementBindings: [],
                    inputSchema: {
                        type: 'object',
                        properties: {
                            credentialRef: {
                                type: 'object',
                                properties: {
                                    service: {
                                        type: 'object',
                                        properties: {
                                            pluginId: { type: 'string' },
                                            localId: { type: 'string' },
                                        },
                                        required: ['pluginId', 'localId'],
                                        additionalProperties: false,
                                    },
                                    accountId: { type: 'string' },
                                },
                                required: ['service', 'accountId'],
                                additionalProperties: false,
                            },
                        },
                        required: ['credentialRef'],
                        additionalProperties: false,
                    },
                    inputHints: {
                        fields: [{
                            path: 'credentialRef',
                            title: 'Discord bot account',
                            widget: 'select',
                            connectedAccountOptions: true,
                            required: true,
                        }],
                    },
                    slash: null,
                    priority: null,
                    dangerLevel: 'safe',
                    confirmation: null,
                    available: true,
                }],
                resources: [],
                editableSettingsGroups: [],
            },
        };
        const targetedContributions: PluginUiTargetedContributionsV1 = {
            target: {
                pluginId: channelsFacts.pluginId,
                immutableGenerationId: 'channels-generation-a',
            },
            points: [{
                pointId: operation.point.pointId,
                protocols: [{
                    protocol: operation.point.protocol,
                    contributions: [{
                        contributor: operation.contributor,
                        protocol: operation.point.protocol,
                        operations: [operation],
                        surfaces: [],
                    }],
                }],
            }],
        };
        const executeContributedAction = vi.fn(async () => ({
            supported: true as const,
            result: { ok: true as const, result: { prepared: true } },
        }));
        const optionsTransport = await import('@/sync/ops/machineContributionRegistryProjection');
        const resolveOptions = vi.spyOn(
            optionsTransport,
            'machinePluginActionFormConnectedAccountOptionsResolve',
        ).mockResolvedValue({
            supported: true,
            result: {
                ok: true,
                options: [{ value: account, label: 'Discord bot' }],
            },
        });
        const { Modal } = await import('@/modal');
        type PresentedForm = Readonly<{
            replaceInput(input: Readonly<Record<string, unknown>>): void;
            submit(): Promise<unknown>;
            getInput(): Readonly<Record<string, unknown>>;
        }>;
        let form: PresentedForm | undefined;
        const show = vi.spyOn(Modal, 'show').mockImplementation((config) => {
            form = (config as unknown as Readonly<{ props: Readonly<{ form: PresentedForm }> }>).props.form;
            return 'channels-provider-setup-form';
        });
        const hide = vi.spyOn(Modal, 'hide').mockImplementation(() => {});
        try {
            const controller = createBoundPluginSurfaceController({
                facts: {
                    ...channelsFacts,
                    pluginProjectionById,
                    targetedContributions,
                },
                binding: { executeContributedAction: executeContributedAction as never },
            });
            const channelsRequest = (method: string, payload?: unknown) => ({
                version: 1 as const,
                requestId: `channels:${method}`,
                surface: {
                    pluginId: channelsFacts.pluginId,
                    contributionId: channelsFacts.contributionId,
                    surfaceId: channelsFacts.surfaceId,
                    placement: channelsFacts.placement,
                    platform: channelsFacts.platform,
                    channel: channelsFacts.channel,
                    resourceScope: [],
                    diagnostics: [],
                },
                method,
                ...(payload === undefined ? {} : { payload }),
            }) as never;

            const selecting = controller.hostApi.handleRequest(channelsRequest('selectActionInput', { operation }));
            await vi.waitFor(() => expect(form).toBeDefined());
            form!.replaceInput({ credentialRef: account });
            await form!.submit();

            const selection = PluginUiSelectActionInputResultV1Schema.parse(await selecting);
            if (selection.kind !== 'submitted') {
                throw new Error('Expected a submitted provider selection.');
            }
            expect(selection).toEqual({
                kind: 'submitted',
                action: operation.action,
                input: {},
                selection: {
                    target: targetedContributions.target,
                    point: operation.point,
                    contributor: operation.contributor,
                },
                connectedAccount: { kind: 'selected', ref: account, fieldPath: 'credentialRef' },
            });
            expect(resolveOptions).toHaveBeenCalledWith('machine_1', expect.objectContaining({
                serverId: 'server-1',
                expectedGeneration: '12',
                qualifiedActionId: 'happier.channel.discord/channels/setup-v1',
                fieldPath: 'credentialRef',
            }));
            expect(form!.getInput()).toEqual({});

            await expect(controller.hostApi.handleRequest(channelsRequest('executeAction', {
                action: 'connection/prepare-v1',
                input: {
                    providerSelection: selection.selection,
                    providerSetupInput: selection.input,
                    credentialRef: account,
                },
            }))).resolves.toEqual({ prepared: true });
            expect(executeContributedAction).toHaveBeenCalledWith('machine_1', {
                serverId: 'server-1',
                expectedGeneration: '12',
                qualifiedActionId: 'happier.channels/connection/prepare-v1',
                input: {
                    providerSelection: selection.selection,
                    providerSetupInput: selection.input,
                    credentialRef: account,
                },
                executionSurface: 'ui',
                invocation: {
                    kind: 'mountedPluginSurface',
                    mountedBinding: {
                        contributionLocalId: 'settings',
                        materializationRef: channelsFacts.executionOrigin.materializationRef,
                    },
                },
            });
        } finally {
            hide.mockRestore();
            show.mockRestore();
            resolveOptions.mockRestore();
        }
    });

    it('withholds the targeted provider form when the admitted operation names a client Action whose registration has not committed', async () => {
        const operation = {
            point: { pointId: 'providers', protocol: { id: 'happier.channels/providers', version: 1 } },
            contributor: {
                pluginId: 'happier.channel.discord',
                contributionId: 'discord-provider',
                immutableGenerationId: 'discord-generation-a',
            },
            role: 'setup',
            action: { pluginId: 'happier.channel.discord', localId: 'channels/setup-v1' },
        } as const;
        const channelsFacts = {
            ...FACTS,
            pluginId: 'happier.channels',
            contributionId: 'settings',
            surfaceId: 'surfacePlacement:happier.channels:settings',
            resolveContributedAction: resolveClientTargetAction,
            executionOrigin: {
                ...FACTS.executionOrigin,
                materializationRef: {
                    ...FACTS.executionOrigin.materializationRef,
                    materializationId: 'channels-materialization-a',
                    pluginId: 'happier.channels',
                },
            },
        } as const;
        const pluginProjectionById: Readonly<Record<string, PluginProjectionEntry>> = {
            'happier.channel.discord': {
                pluginId: 'happier.channel.discord',
                immutableGenerationId: 'discord-generation-a',
                title: 'Discord Channels',
                description: null,
                version: '1.0.0',
                enabled: true,
                generation: 12,
                generationLabel: '12',
                status: null,
                provenance: null,
                diagnostics: [],
                actions: [{
                    id: 'channels/setup-v1',
                    title: 'Set up Discord Channels',
                    description: null,
                    icon: null,
                    scopes: ['settings'],
                    surfaces: ['plugin'],
                    placementBindings: [],
                    inputSchema: {
                        type: 'object',
                        properties: { workspace: { type: 'string', minLength: 1 } },
                        required: ['workspace'],
                        additionalProperties: false,
                    },
                    inputHints: {
                        fields: [{
                            path: 'workspace',
                            title: 'Workspace',
                            widget: 'text',
                            required: true,
                        }],
                    },
                    slash: null,
                    priority: null,
                    dangerLevel: 'safe',
                    confirmation: null,
                    available: true,
                }],
                resources: [],
                editableSettingsGroups: [],
            },
        };
        const targetedContributions: PluginUiTargetedContributionsV1 = {
            target: {
                pluginId: channelsFacts.pluginId,
                immutableGenerationId: 'channels-generation-a',
            },
            points: [{
                pointId: operation.point.pointId,
                protocols: [{
                    protocol: operation.point.protocol,
                    contributions: [{
                        contributor: operation.contributor,
                        protocol: operation.point.protocol,
                        operations: [operation],
                        surfaces: [],
                    }],
                }],
            }],
        };
        const { Modal } = await import('@/modal');
        const show = vi.spyOn(Modal, 'show').mockImplementation(() => 'unexpected-form');
        try {
            const controller = createBoundPluginSurfaceController({
                facts: {
                    ...channelsFacts,
                    pluginProjectionById,
                    targetedContributions,
                },
            });

            await expect(controller.hostApi.handleRequest({
                version: 1 as const,
                requestId: 'channels:selectActionInput',
                surface: {
                    pluginId: channelsFacts.pluginId,
                    contributionId: channelsFacts.contributionId,
                    surfaceId: channelsFacts.surfaceId,
                    placement: channelsFacts.placement,
                    platform: channelsFacts.platform,
                    channel: channelsFacts.channel,
                    resourceScope: [],
                    diagnostics: [],
                },
                method: 'selectActionInput',
                payload: { operation },
            } as never)).resolves.toEqual({
                code: 'stale_surface',
                diagnostics: ['action_retired'],
            });
            expect(show).not.toHaveBeenCalled();
        } finally {
            show.mockRestore();
        }
    });

    it('keeps placement-local openSurface available when daemon interaction is inactive', async () => {
        const openSurface = vi.fn(async () => ({ ok: true as const }));
        const controller = createBoundPluginSurfaceController({
            facts: { ...FACTS, interactionEnabled: false, daemonInteractionEnabled: false },
            binding: { openSurface },
        });

        // Navigation is owned by the selected destination/pane, not the daemon
        // Action/Resource transport. A disconnected Account must therefore not
        // make an already-admitted local page destination unreachable.
        expect(controller.installedMethods).toContain('openSurface');
        expect(controller.interactive).toBe(true);
        await expect(controller.hostApi.handleRequest(request('openSurface', {
            destination: { pluginId: 'acme.browser', localId: 'settings' },
        }))).resolves.toBeNull();
        expect(openSurface).toHaveBeenCalledWith({
            destination: { pluginId: 'acme.browser', localId: 'settings' },
        });
        expect(controller.hostApi.handleRequest(request('executeAction', {
            action: 'save',
            input: {},
        }))).toEqual({
            code: 'unsupported_method',
            diagnostics: ['host_api_method_not_installed:executeAction'],
        });

        await expect(controller.applyComposer(
            { kind: 'session', sessionId: 'session-offline' },
            { expectedRevision: 0, operations: [{ kind: 'text.clear' }] },
        )).resolves.toEqual({
            code: 'unsupported_method',
            diagnostics: ['host_api_method_not_installed:applyComposer'],
        });
    });

    it('keeps canonical Connected Accounts navigation available without daemon interaction', async () => {
        const openConnectedAccounts = vi.fn(async () => undefined);
        const controller = createBoundPluginSurfaceController({
            facts: { ...FACTS, interactionEnabled: false, daemonInteractionEnabled: false },
            binding: { openConnectedAccounts },
        });

        expect(controller.installedMethods).toContain('openConnectedAccounts');
        await expect(controller.hostApi.handleRequest(request('openConnectedAccounts', {
            service: { pluginId: 'happier.scm.github', localId: 'github-account' },
            accountId: 'github:work',
        }))).resolves.toBeNull();
        expect(openConnectedAccounts).toHaveBeenCalledWith({
            service: { pluginId: 'happier.scm.github', localId: 'github-account' },
            accountId: 'github:work',
        });
    });

    it('keeps locally served host methods when only the daemon binding is unavailable', async () => {
        const executeContributedAction = vi.fn();
        clipboard.getStringAsync.mockReset();
        clipboard.setStringAsync.mockReset();
        clipboard.getStringAsync.mockResolvedValue('  copied review link  ');
        clipboard.setStringAsync.mockResolvedValue(undefined);
        const diagnosticLog = vi.spyOn(log, 'log').mockImplementation(() => {});
        const openUrl = vi.spyOn(Linking, 'openURL').mockResolvedValue(undefined);
        vi.stubGlobal('open', undefined);
        const controller = createBoundPluginSurfaceController({
            facts: { ...FACTS, daemonInteractionEnabled: false },
            binding: { executeContributedAction: executeContributedAction as never },
        });

        // A mount with a current Account but no exact daemon target still owns
        // local context, feedback and host-Action presentation. It must not
        // advertise a daemon-contributed Action merely because the renderer is
        // mounted; that binding requires the exact daemon admission separately.
        // `openNewSession` is locally served from the current Account lifetime,
        // so it stays installed beside the other local methods.
        expect(controller.installedMethods).toEqual([
            'context',
            'executeAction',
            'notify',
            'confirm',
            'diagnostic',
            'readClipboard',
            'writeClipboard',
            'openExternalLink',
            'openNewSession',
        ]);
        expect(controller.interactive).toBe(true);
        await expect(controller.hostApi.handleRequest(request('executeAction', {
            action: 'plugin-owned-action',
            input: {},
        }))).resolves.toEqual({
            code: 'unavailable',
            diagnostics: ['plugin_surface_contributed_action_unavailable'],
        });
        expect(executeContributedAction).not.toHaveBeenCalled();
        expect(controller.hostApi.handleRequest(request('diagnostic', {
            code: 'plugin.ui.ready',
            severity: 'warning',
            message: 'aws_secret_access_key=wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
        }))).toBeNull();
        expect(diagnosticLog).toHaveBeenCalledTimes(1);
        const diagnosticText = diagnosticLog.mock.calls[0]?.[0] ?? '';
        expect(diagnosticText).toContain('plugin.ui.ready');
        expect(diagnosticText).not.toContain('wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY');
        await expect(controller.hostApi.handleRequest(request('readClipboard'))).resolves.toEqual({
            value: '  copied review link  ',
        });
        clipboard.getStringAsync.mockRejectedValueOnce(new Error('clipboard is unavailable'));
        await expect(controller.hostApi.handleRequest(request('readClipboard'))).resolves.toEqual({
            code: 'unavailable',
            diagnostics: ['plugin_surface_clipboard_unavailable'],
        });
        await expect(controller.hostApi.handleRequest(request('writeClipboard', {
            value: 'review link',
        }))).resolves.toBeNull();
        expect(clipboard.setStringAsync).toHaveBeenCalledWith('review link');
        await expect(controller.hostApi.handleRequest(request('openExternalLink', {
            url: 'https://example.test/reviews/7',
        }))).resolves.toBeNull();
        expect(openUrl).toHaveBeenCalledWith('https://example.test/reviews/7');
        diagnosticLog.mockRestore();
        openUrl.mockRestore();
        vi.unstubAllGlobals();
    });

    it('keeps a non-interactive factual method set mountable for typed host refusal', () => {
        const controller = createBoundPluginSurfaceController({
            facts: {
                ...FACTS,
                interactionEnabled: false,
            },
        });

        // The facade is still useful even though it has no semantic producer:
        // the SDK can read its exact context and receives the canonical typed
        // refusal for every omitted method. Suppressing this facade turns the
        // controller's factual handler set into a renderer-local decision.
        expect(controller.installedMethods).toEqual(['context']);
        expect(controller.interactive).toBe(true);
    });

    it('fences clipboard reads behind the exact mounted lifetime and caller cancellation', async () => {
        let settleRetiredRead: ((value: string) => void) | undefined;
        clipboard.getStringAsync.mockReset();
        clipboard.getStringAsync.mockImplementationOnce(() => new Promise<string>((resolve) => {
            settleRetiredRead = resolve;
        }));
        const retiredController = createBoundPluginSurfaceController({
            facts: { ...FACTS, daemonInteractionEnabled: false },
        });
        const retiredRead = retiredController.hostApi.handleRequest(request('readClipboard'));
        retiredController.dispose();
        settleRetiredRead!('late clipboard value');
        await expect(retiredRead).resolves.toEqual({
            code: 'stale_surface',
            diagnostics: ['plugin_surface_retired'],
        });

        let settleCancelledRead: ((value: string) => void) | undefined;
        clipboard.getStringAsync.mockImplementationOnce(() => new Promise<string>((resolve) => {
            settleCancelledRead = resolve;
        }));
        const cancelledController = createBoundPluginSurfaceController({
            facts: { ...FACTS, daemonInteractionEnabled: false },
        });
        const cancellation = new AbortController();
        const cancelledRead = cancelledController.hostApi.handleRequest(
            request('readClipboard'),
            { signal: cancellation.signal },
        );
        cancellation.abort();
        settleCancelledRead!('late clipboard value');
        await expect(cancelledRead).resolves.toEqual({
            code: 'unavailable',
            diagnostics: ['plugin_surface_clipboard_read_cancelled'],
        });
        cancelledController.dispose();
    });

    it('preserves a known openSurface success when its mount retires after settlement wins', async () => {
        let settle: ((value: { ok: true }) => void) | undefined;
        const openSurface = vi.fn(() => new Promise<{ ok: true }>((resolve) => {
            settle = resolve;
        }));
        const controller = createBoundPluginSurfaceController({
            facts: FACTS,
            binding: { openSurface },
        });

        const pending = controller.hostApi.handleRequest(request('openSurface', {
            destination: { pluginId: 'acme.browser', localId: 'settings' },
        }));
        expect(openSurface).toHaveBeenCalledTimes(1);

        settle!({ ok: true });

        await expect(pending).resolves.toBeNull();
        controller.dispose();
    });

    it('rejects openSurface before its outward effect is admitted after mount retirement', async () => {
        const openSurface = vi.fn(async () => ({ ok: true as const }));
        const controller = createBoundPluginSurfaceController({
            facts: FACTS,
            binding: { openSurface },
        });

        controller.dispose();

        // A retired mount refuses synchronously, so the host result is
        // normalised the same way every other refusal assertion in this file
        // is — the contract is the value, not whether it was awaited.
        await expect(Promise.resolve(controller.hostApi.handleRequest(request('openSurface', {
            destination: { pluginId: 'acme.browser', localId: 'settings' },
        })))).resolves.toEqual({
            code: 'stale_surface',
            diagnostics: ['plugin_surface_retired'],
        });
        expect(openSurface).not.toHaveBeenCalled();
    });

    it('preserves a known Action success when its mount retires after settlement wins', async () => {
        let settle: ((value: unknown) => void) | undefined;
        const executeContributedAction = vi.fn(() => new Promise((resolve) => {
            settle = resolve;
        }));
        const controller = createBoundPluginSurfaceController({
            facts: FACTS,
            binding: { executeContributedAction: executeContributedAction as never },
        });

        const pending = controller.hostApi.handleRequest(request('executeAction', {
            action: 'refresh-index',
            input: {},
        }));
        expect(executeContributedAction).toHaveBeenCalledTimes(1);

        controller.dispose();
        settle!({
            supported: true,
            result: { ok: true, result: { applied: true } },
        });

        await expect(pending).resolves.toEqual({ applied: true });
    });

    it('routes a declarative action through this mount\'s one bound host facade', async () => {
        const executeContributedAction = vi.fn(async () => ({
            supported: true,
            result: { ok: true as const, result: { applied: true } },
        }));
        const controller = createBoundPluginSurfaceController({
            facts: FACTS,
            binding: { executeContributedAction: executeContributedAction as never },
        });

        await expect(controller.dispatchAction(
            { pluginId: FACTS.pluginId, localId: 'save' },
            null,
        )).resolves.toEqual({ applied: true });

        expect(executeContributedAction).toHaveBeenCalledWith('machine_1', {
            serverId: 'server-1',
            expectedGeneration: '12',
            qualifiedActionId: 'acme.browser/save',
            input: null,
            executionSurface: 'ui',
            invocation: {
                kind: 'mountedPluginSurface',
                mountedBinding: {
                    contributionLocalId: FACTS.contributionId,
                    materializationRef: FACTS.executionOrigin.materializationRef,
                },
            },
        });
    });

    it('routes declarative composerApply through the mounted Host API with the host-owned Composer ref', async () => {
        const applyComposer = vi.fn(async () => ({ status: 'applied' as const, revision: 8 }));
        const controller = createBoundPluginSurfaceController({
            facts: FACTS,
            binding: { mountedHostApiHandlers: { applyComposer } },
        });
        const composer = { kind: 'session' as const, sessionId: 'session-composer-bound' };
        const transaction = {
            expectedRevision: 7,
            operations: [{ kind: 'text.set' as const, text: 'Review the incident' }],
        };

        await expect((controller as unknown as Readonly<{
            applyComposer: (ref: typeof composer, value: typeof transaction) => Promise<unknown>;
        }>).applyComposer(composer, transaction)).resolves.toEqual({ status: 'applied', revision: 8 });

        expect(applyComposer).toHaveBeenCalledWith(expect.objectContaining({
            version: 1,
            method: 'applyComposer',
            surface: controller.surfaceContext,
            payload: { ref: composer, transaction },
        }), undefined);
    });

    it('routes a declarative destination through this mount\'s one bound host facade', async () => {
        const openSurface = vi.fn(async () => ({ ok: true as const }));
        const controller = createBoundPluginSurfaceController({
            facts: FACTS,
            binding: { openSurface },
        });

        await expect(controller.openSurface(
            { pluginId: FACTS.pluginId, localId: 'settings' },
        )).resolves.toBeNull();

        expect(openSurface).toHaveBeenCalledWith({
            destination: { pluginId: FACTS.pluginId, localId: 'settings' },
        });
    });

    it('keeps the mounted caller when that surface invokes a cross-plugin action', async () => {
        const executeContributedAction = vi.fn(async () => ({
            supported: true,
            result: { ok: true as const, result: { applied: true } },
        }));
        const controller = createBoundPluginSurfaceController({
            facts: FACTS,
            binding: { executeContributedAction: executeContributedAction as never },
        });

        await expect(controller.dispatchAction(
            { pluginId: 'acme.reviewer', localId: 'publish' },
            { source: 'mounted-surface' },
        )).resolves.toEqual({ applied: true });

        expect(executeContributedAction).toHaveBeenCalledWith('machine_1', {
            serverId: 'server-1',
            expectedGeneration: '12',
            qualifiedActionId: 'acme.reviewer/publish',
            input: { source: 'mounted-surface' },
            executionSurface: 'ui',
            // The bound placement, never the target, supplies this claim; the
            // daemon revalidates it before deriving caller provenance.
            invocation: {
                kind: 'mountedPluginSurface',
                mountedBinding: {
                    contributionLocalId: FACTS.contributionId,
                    materializationRef: FACTS.executionOrigin.materializationRef,
                },
            },
        });
    });

    it('carries the bound Session into the canonical contributed Action binding', async () => {
        const executeContributedAction = vi.fn(async () => ({
            supported: true,
            result: { ok: true as const, result: { applied: true } },
        }));
        const controller = createBoundPluginSurfaceController({
            facts: { ...FACTS, sessionId: 'session-bound' },
            binding: { executeContributedAction: executeContributedAction as never },
        });

        await expect(controller.dispatchAction(
            { pluginId: 'acme.reviewer', localId: 'publish' },
            { source: 'bound-session' },
        )).resolves.toEqual({ applied: true });

        expect(executeContributedAction).toHaveBeenCalledWith('machine_1', {
            serverId: 'server-1',
            expectedGeneration: '12',
            qualifiedActionId: 'acme.reviewer/publish',
            input: { source: 'bound-session' },
            executionSurface: 'ui',
            sessionId: 'session-bound',
            invocation: {
                kind: 'mountedPluginSurface',
                mountedBinding: {
                    contributionLocalId: FACTS.contributionId,
                    materializationRef: FACTS.executionOrigin.materializationRef,
                },
            },
        });
    });

    it('installs bounded openable-content handlers only for the selected reference', async () => {
        const stat = vi.fn(async () => ({
            status: 'ready' as const,
            contentClass: 'text' as const,
            mimeType: 'text/plain',
            extension: '.md',
            sizeBytes: 5,
            revision: 'workspace-file:5:100',
        }));
        const read = vi.fn(async () => ({
            status: 'ready' as const,
            content: { kind: 'utf8' as const, text: 'hello' },
            revision: 'workspace-file:5:100',
        }));
        const controller = createBoundPluginSurfaceController({
            facts: FACTS,
            // The public method must be installed only from a host-created
            // binding. Before the producer exists, the controller must keep
            // rejecting the methods rather than fabricate a path-bearing read.
            binding: {
                ...{
                    openableContent: {
                        ref: { kind: 'workspaceFile', handle: 'workspaceFile_opaque' },
                        stat,
                        read,
                    },
                },
            },
        });

        expect(controller.installedMethods).toEqual([
            'context',
            'statOpenableContent',
            'readOpenableContent',
        ]);

        await expect(controller.hostApi.handleRequest(request('statOpenableContent', {
            ref: {
                kind: 'workspaceFile',
                handle: 'workspaceFile_opaque',
            },
        }))).resolves.toEqual({
            status: 'ready',
            contentClass: 'text',
            mimeType: 'text/plain',
            extension: '.md',
            sizeBytes: 5,
            revision: 'workspace-file:5:100',
        });

        await expect(controller.hostApi.handleRequest(request('readOpenableContent', {
            ref: { kind: 'workspaceFile', handle: 'workspaceFile_other' },
            expectedRevision: 'workspace-file:5:100',
        }))).resolves.toEqual({ status: 'unsupported' });
        expect(read).not.toHaveBeenCalled();

        await expect(controller.hostApi.handleRequest(request('readOpenableContent', {
            ref: { kind: 'workspaceFile', handle: 'workspaceFile_opaque' },
            expectedRevision: 'workspace-file:5:100',
            maxBytes: 5,
        }))).resolves.toEqual({
            status: 'ready',
            content: { kind: 'utf8', text: 'hello' },
            revision: 'workspace-file:5:100',
        });
        expect(read).toHaveBeenCalledWith({
            ref: { kind: 'workspaceFile', handle: 'workspaceFile_opaque' },
            expectedRevision: 'workspace-file:5:100',
            maxBytes: 5,
        }, undefined);
    });

    it('narrows an opaque file viewer to context and openable-content methods without narrowing the same renderer elsewhere', async () => {
        const executeContributedAction = vi.fn(async () => ({
            supported: true,
            result: { ok: true as const, result: { applied: true } },
        }));
        const readComposer = vi.fn(() => ({
            status: 'unavailable' as const,
            reason: 'scopeClosed' as const,
        }));
        const openableBinding = {
            ref: { kind: 'workspaceFile' as const, handle: 'workspaceFile_opaque' },
            stat: async () => ({
                status: 'ready' as const,
                contentClass: 'text' as const,
                mimeType: 'text/plain',
                sizeBytes: 5,
                revision: 'workspace-file:5:100',
            }),
            read: async () => ({ status: 'unsupported' as const }),
        };
        const fileViewer = createBoundPluginSurfaceController({
            facts: FACTS,
            binding: {
                executeContributedAction: executeContributedAction as never,
                openableContent: openableBinding,
                // A renderer declaration can request a generic mounted Host
                // API method, but the selected file-viewer role is factual:
                // only the host-owned opaque read/stat pair is installed.
                mountedHostApiHandlers: { readComposer },
            },
        });

        expect(fileViewer.installedMethods).toEqual([
            'context',
            'statOpenableContent',
            'readOpenableContent',
        ]);
        for (const method of [
            'executeAction',
            'readClipboard',
            'writeClipboard',
            'openExternalLink',
            'notify',
            'readResource',
            'watchResource',
            'openSurface',
            'selectActionInput',
            'readComposer',
        ] as const) {
            await expect(Promise.resolve(fileViewer.hostApi.handleRequest(request(method, {})))).resolves.toEqual({
                code: 'unsupported_method',
                diagnostics: [`host_api_method_not_installed:${method}`],
            });
        }
        expect(executeContributedAction).not.toHaveBeenCalled();
        expect(readComposer).not.toHaveBeenCalled();
        await expect(fileViewer.dispatchAction(
            { pluginId: FACTS.pluginId, localId: 'save' },
            null,
        )).resolves.toEqual({
            code: 'unsupported_method',
            diagnostics: ['host_api_method_not_installed:executeAction'],
        });

        const appPage = createBoundPluginSurfaceController({
            facts: FACTS,
            binding: { executeContributedAction: executeContributedAction as never },
        });
        expect(appPage.installedMethods).toContain('executeAction');
        await expect(appPage.dispatchAction(
            { pluginId: FACTS.pluginId, localId: 'save' },
            null,
        )).resolves.toEqual({ applied: true });
    });

    it('builds mounted semantic handlers from the controller lifetime and never invokes that factory for a file viewer', () => {
        const dispose = vi.fn();
        const buildMountedHandlers = vi.fn((input: Readonly<{ isCurrent: () => boolean }>) => {
            expect(input.isCurrent()).toBe(true);
            return {
                handlers: {
                    readComposer: () => ({ status: 'unavailable' as const, reason: 'scopeClosed' as const }),
                },
                dispose,
            };
        });
        const generic = createBoundPluginSurfaceController({
            facts: FACTS,
            binding: {
                createMountedHostApiHandlers: buildMountedHandlers,
            } as never,
        });

        expect(buildMountedHandlers).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
            isCurrent: expect.any(Function),
        }));
        expect(generic.installedMethods).toContain('readComposer');
        generic.dispose();
        expect(dispose).toHaveBeenCalledTimes(1);

        const viewerFactory = vi.fn(buildMountedHandlers);
        const fileViewer = createBoundPluginSurfaceController({
            facts: FACTS,
            binding: {
                openableContent: {
                    ref: { kind: 'workspaceFile', handle: 'workspaceFile_opaque' },
                    stat: async () => ({ status: 'unsupported' as const }),
                    read: async () => ({ status: 'unsupported' as const }),
                },
                createMountedHostApiHandlers: viewerFactory,
            } as never,
        });

        expect(viewerFactory).not.toHaveBeenCalled();
        expect(fileViewer.installedMethods).not.toContain('readComposer');
    });

    it('activates and updates a mounted current-UI handler only after its controller commits, then retires it with that controller', async () => {
        const activate = vi.fn();
        const setCurrentUiContextEligibility = vi.fn();
        const dispose = vi.fn();
        const buildMountedHandlers = vi.fn(() => Object.freeze({
            handlers: {},
            activate,
            setCurrentUiContextEligibility,
            dispose,
        }));

        const hook = await renderHook(
            (focusEligible: boolean) => {
                const controller = useBoundPluginSurfaceController({
                    facts: FACTS,
                    binding: {
                        createMountedHostApiHandlers: buildMountedHandlers as never,
                    },
                });
                // This mirrors the physical host's post-commit focus observer.
                // It must update data on the exact committed controller rather
                // than replace the controller or retain plugin enrichment.
                React.useEffect(() => {
                    (controller as unknown as Readonly<{
                        setCurrentUiContextEligibility?: (eligible: boolean) => void;
                    }>).setCurrentUiContextEligibility?.(focusEligible);
                }, [controller, focusEligible]);
                return controller;
            },
            { initialProps: true },
        );

        expect(buildMountedHandlers).toHaveBeenCalledTimes(1);
        expect(activate).toHaveBeenCalledTimes(1);
        expect(setCurrentUiContextEligibility).toHaveBeenLastCalledWith(true);

        await hook.rerender(false);
        expect(buildMountedHandlers).toHaveBeenCalledTimes(1);
        expect(setCurrentUiContextEligibility).toHaveBeenLastCalledWith(false);

        await hook.unmount();
        expect(dispose).toHaveBeenCalledTimes(1);
    });

    it('does not activate a mounted handler while constructing an uncommitted controller', () => {
        const activate = vi.fn();
        const dispose = vi.fn();
        const controller = createBoundPluginSurfaceController({
            facts: FACTS,
            binding: {
                createMountedHostApiHandlers: (() => Object.freeze({
                    handlers: {},
                    activate,
                    dispose,
                })) as never,
            },
        });

        // Controller construction is the same render-time work an abandoned
        // React render performs. Registration must wait for the hook effect.
        expect(activate).not.toHaveBeenCalled();
        controller.dispose();
        expect(dispose).toHaveBeenCalledTimes(1);
    });

    it('does not advertise Resource methods when the selected surface has no readable Resource capability', () => {
        const controller = createBoundPluginSurfaceController({
            // The selected-member capability is an admission fact. A sibling
            // projection cannot make this mount read or watch Resources.
            facts: {
                ...FACTS,
                resourceCapability: { readable: false, dynamic: false },
            },
        });

        expect(controller.installedMethods).not.toContain('readResource');
        expect(controller.installedMethods).not.toContain('watchResource');
        expect(controller.hostApi.handleRequest(request('readResource', {
            resource: 'sibling-or-static-resource',
        }))).toEqual({
            code: 'unsupported_method',
            diagnostics: ['host_api_method_not_installed:readResource'],
        });
    });

    it('installs only snapshot reads for a readable non-dynamic selected Resource capability', async () => {
        const controller = createBoundPluginSurfaceController({
            facts: {
                ...FACTS,
                resourceCapability: { readable: true, dynamic: false },
            },
        });

        expect(controller.installedMethods).toContain('readResource');
        expect(controller.installedMethods).not.toContain('watchResource');
        // This remains an envelope-only transport operation, so it is never
        // advertised in `version().methods`; without watch ownership it is not
        // installed behind that transport path either.
        expect(controller.installedMethods).not.toContain('unsubscribeResource');
        expect(controller.hostApi.handleRequest(request('unsubscribeResource', {
            subscriptionId: 'static-resource',
        }))).toEqual({
            code: 'unsupported_method',
            diagnostics: ['host_api_method_not_installed:unsubscribeResource'],
        });
    });

    it('installs snapshot and invalidation methods only for a dynamic selected Resource capability', async () => {
        const controller = createBoundPluginSurfaceController({
            facts: {
                ...FACTS,
                resourceCapability: { readable: true, dynamic: true },
            },
        });

        expect(controller.installedMethods).toContain('readResource');
        expect(controller.installedMethods).toContain('watchResource');
        // Disposal is intentionally a transport operation rather than an
        // advertised author method. Dynamic capability installs its handler
        // behind that private envelope path.
        expect(controller.installedMethods).not.toContain('unsubscribeResource');
        await expect(controller.hostApi.handleRequest(request('disposeHostResource', {
            subscriptionId: 'dynamic-resource',
        }))).resolves.toBeNull();
    });

    it('fences the facade when the captured Account lifetime retires', async () => {
        let accountCurrent = true;
        let retireController: (() => void) | undefined;
        const publication = {
            publish: vi.fn(() => true),
            clear: vi.fn(),
            restore: vi.fn(),
            dispose: vi.fn(),
        };
        const controller = createBoundPluginSurfaceController({
            facts: {
                ...FACTS,
                accountLifetime: {
                    scope: { serverId: 'server-1', accountId: 'account-a' },
                    isCurrent: () => accountCurrent,
                    onRetire: (cancel) => {
                        retireController = cancel;
                        return { dispose() {} };
                    },
                },
            },
            binding: {
                createMountedHostApiHandlers: (() => ({
                    handlers: {},
                    currentUiContext: publication,
                })) as never,
            },
        });

        await expect(Promise.resolve(controller.hostApi.handleRequest(request('publishCurrentUiContext', {
            enrichment: { entity: { kind: 'issue', label: 'Account-scoped issue' } },
        })))).resolves.toBeNull();

        accountCurrent = false;
        expect(retireController).toBeTypeOf('function');
        retireController!();

        expect(controller.hostApi.handleRequest(request('context'))).toEqual({
            code: 'stale_surface',
            diagnostics: ['plugin_surface_retired'],
        });
        expect(publication.dispose).toHaveBeenCalledTimes(1);
    });

    it('inherits parent mount retirement so a retained targeted child aborts its own Resource work', async () => {
        let parentCurrent = true;
        let retireParent: (() => void) | undefined;
        let resourceSignal: AbortSignal | undefined;
        let settleRead: ((value: Awaited<ReturnType<PluginSurfaceResourceReadTransport>>) => void) | undefined;
        const publication = {
            publish: vi.fn(() => true),
            clear: vi.fn(),
            restore: vi.fn(),
            dispose: vi.fn(),
        };
        const controller = createBoundPluginSurfaceController({
            facts: {
                ...FACTS,
                parentLifetime: {
                    isCurrent: () => parentCurrent,
                    onRetire: (cancel) => {
                        retireParent = cancel;
                        return { dispose() {} };
                    },
                },
            },
            binding: {
                readResource: ((_machineId, options) => {
                    resourceSignal = options.signal;
                    return new Promise((resolve) => { settleRead = resolve; });
                }) as PluginSurfaceResourceReadTransport,
                createMountedHostApiHandlers: (() => ({
                    handlers: {},
                    currentUiContext: publication,
                })) as never,
            },
        });

        await expect(Promise.resolve(controller.hostApi.handleRequest(request('publishCurrentUiContext', {
            enrichment: { entity: { kind: 'issue', label: 'Parent-scoped issue' } },
        })))).resolves.toBeNull();

        const pending = Promise.resolve(controller.hostApi.handleRequest(request('readResource', {
            resource: 'review-summary',
        })));
        expect(resourceSignal?.aborted).toBe(false);

        parentCurrent = false;
        expect(retireParent).toBeTypeOf('function');
        retireParent!();

        // A parent callback retained during offline presentation must not leave
        // B's mounted transport live. The child owns its abort controller, but
        // its sole parent lifetime source is the incumbent controller.
        expect(resourceSignal?.aborted).toBe(true);
        expect(controller.hostApi.handleRequest(request('context'))).toEqual({
            code: 'stale_surface',
            diagnostics: ['plugin_surface_retired'],
        });
        expect(publication.dispose).toHaveBeenCalledTimes(1);

        settleRead!({
            supported: true,
            result: {
                ok: true,
                resource: { pluginId: FACTS.pluginId, localId: 'review-summary' },
                kind: 'asset',
                contentType: 'application/json',
                digest: `sha256:${'a'.repeat(64)}`,
                bytesBase64: 'e30=',
            },
        });
        await expect(pending).resolves.toEqual({
            // Existing Resource cancellation maps to unavailable, while a new
            // post-retirement request above is the typed stale-surface path.
            code: 'unavailable',
            diagnostics: ['plugin_surface_retired'],
        });
    });
});
