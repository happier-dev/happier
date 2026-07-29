import { describe, expect, it, vi } from 'vitest';

import { PluginError } from '@happier-dev/plugin-sdk';
import type { ActionHandler } from '@happier-dev/plugin-sdk/runtime';
import type { PluginManifest } from '@happier-dev/plugin-sdk/manifest';
import { createPluginTestkit } from '@happier-dev/plugin-sdk/testing';
import type { PluginHostAccessRequestV2 } from '@happier-dev/protocol';
import type {
    HostCurrentSessionInteractionsService,
} from '@/agent/runtime/state/currentSessionUiTypes';
import {
    createNativeAgentCurrentSessionUiServices,
} from '@/agent/runtime/registry/engineRegistry/nativeAgentSessionInteractions';

import { createTargetActionInvocationRegistry } from './targetActionRegistry';
import { createTargetActionHostBindingResolver } from '../hostAccess/resolve';
import { createUnavailablePluginServicesFactory } from './services/factory';

function isJsonRecord(value: unknown): value is Readonly<Record<string, unknown>> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function action(overrides: Record<string, unknown> = {}) {
    return {
        pluginId: 'acme.alpha',
        pluginVersion: '1.2.3',
        generation: '7',
        localId: 'run',
        definition: {
            id: 'run',
            dangerLevel: 'safe',
            scopes: ['global'],
            surfaces: ['cli'],
            inputSchema: {
                type: 'object',
                properties: { value: { type: 'string' } },
                required: ['value'],
                additionalProperties: false,
            },
            resultSchema: {
                type: 'object',
                properties: { echoed: { type: 'string' } },
                required: ['echoed'],
                additionalProperties: false,
            },
            ...overrides,
        },
    } as const;
}

function createRegistry(
    params: Omit<Parameters<typeof createTargetActionInvocationRegistry>[0], 'createServices' | 'resolveHostBinding' | 'resolveAuthorizationFacts'>
        & Partial<Pick<Parameters<typeof createTargetActionInvocationRegistry>[0], 'createServices' | 'resolveHostBinding' | 'resolveAuthorizationFacts'>>,
) {
    return createTargetActionInvocationRegistry({
        resolveAuthorizationFacts: (resolvedAction) => ({
            packageTrust: {
                packageIdentity: resolvedAction.qualifiedId,
                reviewedPackageIdentity: resolvedAction.qualifiedId,
            },
            generation: {
                targetGeneration: resolvedAction.generation,
                desiredGeneration: resolvedAction.generation,
                appliedGeneration: resolvedAction.generation,
            },
            resourceSelections: [],
            scopedGrants: [],
            operatingSystemAuthorization: [],
        }),
        createServices: createUnavailablePluginServicesFactory(),
        resolveHostBinding: createTargetActionHostBindingResolver(),
        ...params,
    });
}

describe('target action invocation registry', () => {
    it('binds context.ui to the validated active session presentation even when public session inventory is unavailable', async () => {
        const notify = vi.fn(async () => ({ status: 'applied' as const, revision: 'r1' }));
        const presentation = {
            notify,
            setStatus: vi.fn(),
            setWidget: vi.fn(),
            setSurfaceTitle: vi.fn(),
            replaceComposerText: vi.fn(),
        };
        const registry = createRegistry({
            resolveCurrentSessionUi: (sessionId) => sessionId === 'session-1'
                ? Object.freeze({
                    interactions: Object.freeze({
                        request: vi.fn() as HostCurrentSessionInteractionsService['request'],
                    }),
                    presentation,
                })
                : null,
            actions: [{
                ...action(),
                handler: async (_input, context) => {
                    await context.ui.notify('Hello');
                    return { echoed: context.session?.id ?? '' };
                },
            }],
        });

        await expect(registry.invoke({
            pluginId: 'acme.alpha', localId: 'run', input: { value: 'x' }, surface: 'cli', sessionId: 'session-1',
        })).resolves.toEqual({ status: 'executed', value: { echoed: 'session-1' } });
        expect(notify).toHaveBeenCalledWith(expect.objectContaining({ message: 'Hello' }), expect.any(Object));
        await expect(registry.invoke({
            pluginId: 'acme.alpha', localId: 'run', input: { value: 'x' }, surface: 'cli', sessionId: 'wrong-session',
        })).resolves.toMatchObject({ status: 'failed', code: 'plugin_ui_unavailable' });
        expect(notify).toHaveBeenCalledTimes(1);
    });

    it('binds target-action services and context.ui to the same validated current-session interaction owner', async () => {
        const handleToolCall = vi.fn(async () => ({ decision: 'approved' as const }));
        const presentation = Object.freeze({
            notify: vi.fn(async () => ({ status: 'applied' as const, revision: 'r1' })),
            setStatus: vi.fn(),
            setWidget: vi.fn(),
            setSurfaceTitle: vi.fn(),
            replaceComposerText: vi.fn(),
        });
        const currentSession = createNativeAgentCurrentSessionUiServices({
            permissionHandler: { handleToolCall },
            pluginId: 'acme.alpha',
            contributionId: 'run',
            runtimeId: 'run',
            sessionId: 'session-1',
            generationId: '7',
            isCurrent: () => true,
            presentation,
        });
        const createServices = vi.fn(createUnavailablePluginServicesFactory());
        const registry = createRegistry({
            createServices,
            resolveCurrentSessionUi: (sessionId) => (
                sessionId === 'session-1' ? currentSession : null
            ),
            actions: [{
                ...action(),
                handler: async (_input, context) => ({
                    echoed: String(await context.ui.confirm('Use the selected account?')),
                }),
            }],
        });

        await expect(registry.invoke({
            pluginId: 'acme.alpha',
            localId: 'run',
            input: { value: 'x' },
            surface: 'cli',
            sessionId: 'session-1',
        })).resolves.toEqual({ status: 'executed', value: { echoed: 'true' } });
        expect(handleToolCall).toHaveBeenCalledOnce();
        expect(createServices).toHaveBeenCalledWith(
            expect.objectContaining({ currentSession }),
            expect.any(Object),
        );
    });

    it('fails closed when late-bound package authorization no longer matches the registered action', async () => {
        const handler = vi.fn(async () => ({ echoed: 'should-not-run' }));
        const registry = createRegistry({
            resolveAuthorizationFacts: (resolvedAction) => ({
                packageTrust: {
                    packageIdentity: resolvedAction.qualifiedId,
                    reviewedPackageIdentity: null,
                },
                generation: {
                    targetGeneration: resolvedAction.generation,
                    desiredGeneration: resolvedAction.generation,
                    appliedGeneration: resolvedAction.generation,
                },
                resourceSelections: [],
                scopedGrants: [],
                operatingSystemAuthorization: [],
            }),
            actions: [{ ...action(), handler }],
        });

        await expect(registry.invoke({
            pluginId: 'acme.alpha', localId: 'run', input: { value: 'x' }, surface: 'cli',
        })).resolves.toMatchObject({ status: 'unavailable', code: 'plugin_action_package_untrusted' });
        expect(handler).not.toHaveBeenCalled();
    });

    it('applies enum and const schemas to JSON objects with own valueOf data properties', async () => {
        const handler = vi.fn(async () => ({ valueOf: 'result', nested: [{ accepted: true }], amount: 4 }));
        const registry = createRegistry({
            actions: [{
                ...action({
                    inputSchema: {
                        type: 'object',
                        required: ['selection'],
                        properties: {
                            selection: { const: { valueOf: 'literal', nested: [{ enabled: true }], amount: 4 } },
                        },
                        additionalProperties: false,
                    },
                    resultSchema: {
                        enum: [{ valueOf: 'result', nested: [{ accepted: true }], amount: 4 }],
                    },
                }),
                handler,
            }],
        });

        const result = await registry.invoke({
            pluginId: 'acme.alpha',
            localId: 'run',
            input: { selection: { amount: 4, nested: [{ enabled: true }], valueOf: 'literal' } },
            surface: 'cli',
        });

        expect(result).toEqual({
            status: 'executed',
            value: { valueOf: 'result', nested: [{ accepted: true }], amount: 4 },
        });
        expect(handler).toHaveBeenCalledOnce();
    });

  it('constructs one immutable qualified context with all services and truthful unavailable errors', async () => {
    let captured: unknown;
    const createServices = vi.fn(createUnavailablePluginServicesFactory());
    const registry = createRegistry({
            createServices,
            actions: [{
                ...action(),
                handler: async (input, context) => {
                    captured = context;
                    expect(Object.keys(context.services).sort()).toEqual([
                        'availability', 'connectedAccounts', 'events', 'exec', 'fetch', 'fs', 'logger',
                        'managed', 'mcp', 'notifications', 'resources', 'secrets', 'sessions',
                        'settings', 'storage',
                    ]);
                    expect(context.services.availability('logger')).toEqual({
                        status: 'unavailable',
                        code: 'plugin_service_unavailable',
                    });
                    expect(context.services.availability('storage')).toEqual({
                        status: 'unavailable',
                        code: 'plugin_service_unavailable',
                    });
                    expect(() => context.services.storage.local.get('x')).toThrowError(PluginError);
                    expect(() => context.services.logger.info('not admitted')).toThrowError(PluginError);
                    await expect(context.ui.confirm('Proceed?')).rejects.toMatchObject({
                        name: 'PluginError',
                        code: 'plugin_ui_unavailable',
                    });
                    const serviceShape = {
                        logger: ['debug', 'diagnostic', 'error', 'info', 'warn'],
                        storage: ['ephemeral', 'local', 'session', 'synced'],
                        settings: ['describe', 'get', 'reset', 'set', 'snapshot', 'watch'],
                        secrets: ['delete', 'get', 'set', 'status'],
                        events: ['emit', 'subscribe'],
                        fetch: ['request'],
                        fs: ['list', 'readFile', 'remove', 'stat', 'writeFile'],
                        exec: ['agentCli', 'clients', 'run', 'spawn', 'systemTools'],
                        managed: ['dependencies', 'servers'],
                        sessions: ['current', 'get', 'list', 'subagents', 'watch'],
                        resources: ['describe', 'read', 'watch'],
                        mcp: ['connect', 'discover', 'list'],
                        notifications: ['listCategories', 'listChannels', 'preferences', 'send', 'watchPreferences'],
                        connectedAccounts: ['getBinding', 'materialize', 'requestSelection', 'watch'],
                    } as const;
                    for (const [serviceId, expectedKeys] of Object.entries(serviceShape)) {
                        const service = context.services[serviceId as keyof typeof serviceShape];
                        expect(Object.keys(service).sort(), serviceId).toEqual([...expectedKeys].sort());
                        expect(Object.isFrozen(service), serviceId).toBe(true);
                        const assertUnavailableLeaves = async (value: Readonly<Record<string, unknown>>, path: string): Promise<void> => {
                            for (const [key, member] of Object.entries(value)) {
                                const memberPath = `${path}.${key}`;
                                if (typeof member === 'function') {
                                    try {
                                        const returned = member();
                                        if (returned instanceof Promise) {
                                            await expect(returned, memberPath).rejects.toMatchObject({
                                                name: 'PluginError',
                                                code: 'plugin_service_unavailable',
                                            });
                                            continue;
                                        }
                                        throw new Error(`${memberPath} returned instead of throwing`);
                                    } catch (error) {
                                        expect(error, memberPath).toBeInstanceOf(PluginError);
                                        expect(error, memberPath).toMatchObject({ code: 'plugin_service_unavailable' });
                                    }
                                    continue;
                                }
                                expect(member && typeof member === 'object', memberPath).toBe(true);
                                expect(Object.isFrozen(member), memberPath).toBe(true);
                                await assertUnavailableLeaves(member as Readonly<Record<string, unknown>>, memberPath);
                            }
                        };
                        await assertUnavailableLeaves(service as unknown as Readonly<Record<string, unknown>>, serviceId);
                    }
                    expect(Object.keys(context.services.storage.local).sort()).toEqual([
                        'consistency', 'delete', 'get', 'list', 'set', 'transaction',
                    ]);
                    expect(Object.keys(context.services.exec.clients)).toEqual(['spawn']);
                    expect(Object.keys(context.services.managed.dependencies).sort()).toEqual(['ensure', 'remove', 'status', 'update']);
                    expect(Object.keys(context.services.managed.servers)).toEqual(['supervise']);
                    expect(Object.keys(context.services.sessions.current).sort()).toEqual([
                        'availability', 'media', 'send', 'summary', 'watch',
                    ]);
                    expect(Object.keys(context.services.sessions.subagents).sort()).toEqual([
                        'capabilities', 'get', 'list', 'observe', 'watch',
                    ]);
                    try {
                        await context.services.storage.local.get('x');
                    } catch (error) {
                        expect(error).toMatchObject({ code: 'plugin_service_unavailable' });
                    }
                    if (!isJsonRecord(input) || typeof input.value !== 'string') {
                        throw new Error('validated action input was not preserved');
                    }
                    return { echoed: input.value };
                },
            }],
        });

        const result = await registry.invoke({
            pluginId: 'acme.alpha',
            localId: 'run',
            input: { value: 'hello' },
            surface: 'cli',
        });

        expect(result).toEqual({ status: 'executed', value: { echoed: 'hello' } });
        expect(captured).toMatchObject({
            plugin: { id: 'acme.alpha', version: '1.2.3' },
            contribution: { id: 'run', qualifiedId: 'acme.alpha/actions/run' },
            surface: 'cli',
        });
        expect(createServices).toHaveBeenCalledWith(
            expect.objectContaining({
                plugin: { id: 'acme.alpha', version: '1.2.3' },
                contribution: { id: 'run', qualifiedId: 'acme.alpha/actions/run' },
                generation: '7',
                correlationId: expect.any(String),
                surface: 'cli',
                isGenerationCurrent: expect.any(Function),
            }),
            expect.objectContaining({ generation: '7' }),
        );
        expect(Object.isFrozen(captured)).toBe(true);
    });

    it('isolates equal local ids by plugin and rejects wrong family or generation publication', async () => {
        const alpha = vi.fn(async () => ({ echoed: 'alpha' }));
        const beta = vi.fn(async () => ({ echoed: 'beta' }));
        const registry = createRegistry({
            actions: [
                { ...action(), handler: alpha },
                { ...action(), pluginId: 'acme.beta', handler: beta },
            ],
        });

        await expect(registry.invoke({ pluginId: 'acme.beta', localId: 'run', input: { value: 'x' }, surface: 'cli' }))
            .resolves.toEqual({ status: 'executed', value: { echoed: 'beta' } });
        expect(alpha).not.toHaveBeenCalled();
        expect(() => createRegistry({
            actions: [{ ...action(), family: 'hooks', handler: alpha }],
        })).toThrow(/family/i);
        expect(() => createRegistry({
            actions: [{ ...action(), localId: 'other', handler: alpha }],
        })).toThrow(/does not match/i);
        expect(() => createRegistry({
            actions: [{ ...action(), handler: alpha }, { ...action(), handler: alpha }],
        })).toThrow(/duplicate/i);
    });

    it('keeps another plugin callable after one handler throws, rejects, or is caller-timed-out', async () => {
        let failure: 'throw' | 'reject' | 'timeout' = 'throw';
        const alpha = vi.fn((_input, context) => {
            if (failure === 'throw') throw new Error('alpha threw');
            if (failure === 'reject') return Promise.reject(new Error('alpha rejected'));
            return new Promise<never>((_resolve, reject) => {
                context.signal.addEventListener('abort', () => reject(context.signal.reason), { once: true });
            });
        });
        const beta = vi.fn(async () => ({ echoed: 'beta healthy' }));
        const registry = createRegistry({
            actions: [
                { ...action(), handler: alpha },
                { ...action(), pluginId: 'acme.beta', handler: beta },
            ],
        });
        const invokeAlpha = (signal?: AbortSignal) => registry.invoke({
            pluginId: 'acme.alpha',
            localId: 'run',
            input: { value: failure },
            surface: 'cli',
            ...(signal ? { signal } : {}),
        });
        const expectBetaHealthy = async () => {
            await expect(registry.invoke({
                pluginId: 'acme.beta',
                localId: 'run',
                input: { value: 'still healthy' },
                surface: 'cli',
            })).resolves.toEqual({ status: 'executed', value: { echoed: 'beta healthy' } });
        };

        await expect(invokeAlpha()).resolves.toMatchObject({
            status: 'failed',
            code: 'plugin_action_execution_failed',
        });
        await expectBetaHealthy();

        failure = 'reject';
        await expect(invokeAlpha()).resolves.toMatchObject({
            status: 'failed',
            code: 'plugin_action_execution_failed',
        });
        await expectBetaHealthy();

        failure = 'timeout';
        const timeout = new AbortController();
        const timedOut = invokeAlpha(timeout.signal);
        await vi.waitFor(() => expect(alpha).toHaveBeenCalledTimes(3));
        timeout.abort(new Error('caller timeout'));
        await expect(timedOut).resolves.toMatchObject({
            status: 'unavailable',
            code: 'plugin_action_aborted',
        });
        await expectBetaHealthy();
        expect(beta).toHaveBeenCalledTimes(3);
    });

    it('admits safe actions without prompting and fails closed for unresolved policy inputs', async () => {
        const handler = vi.fn(async () => ({ echoed: 'no' }));
        const local = createRegistry({ actions: [{ ...action(), handler }] });
        await expect(local.invoke({ pluginId: 'acme.alpha', localId: 'run', input: { value: 'x' }, surface: 'cli' }))
            .resolves.toMatchObject({ status: 'executed' });
        const cases = [
            action({
                hostAccessRequests: [{
                    required: true,
                    request: {
                        id: 'api',
                        capability: 'network',
                        reason: 'API',
                        scope: { targets: [{ kind: 'fixedOrigin', origin: 'https://example.test' }] },
                    },
                }],
            }),
            action({ availability: { when: { fact: 'host.feature', operator: 'enabled', value: 'x' } } }),
            action({ surfaces: ['agent'] }),
            action({ scopes: ['session'] }),
        ];

        for (const candidate of cases) {
            const registry = createRegistry({ actions: [{ ...candidate, handler }] });
            await expect(registry.invoke({ pluginId: 'acme.alpha', localId: 'run', input: { value: 'x' }, surface: 'cli' }))
                .resolves.toMatchObject({ status: 'unavailable' });
        }
        expect(handler).toHaveBeenCalledTimes(1);
    });

    it('evaluates action availability from canonical invocation facts', async () => {
        const handler = vi.fn(async () => ({ echoed: 'yes' }));
        const registry = createRegistry({
            actions: [{
                ...action({
                    availability: { when: { fact: 'plugin.enabled', operator: 'equals', value: true } },
                }),
                handler,
            }],
        });

        await expect(registry.invoke({
            pluginId: 'acme.alpha', localId: 'run', input: { value: 'x' }, surface: 'cli',
        })).resolves.toEqual({ status: 'executed', value: { echoed: 'yes' } });
        expect(handler).toHaveBeenCalledOnce();
    });

    it('snapshots exact structured HostAccess requests at registration time', async () => {
        const request: PluginHostAccessRequestV2 = {
            id: 'api',
            capability: 'network',
            reason: 'API',
            scope: {
                targets: [{ kind: 'fixedOrigin', origin: 'https://example.test' }],
                methods: ['GET'],
            },
        };
        const unavailableResolver = createTargetActionHostBindingResolver();
        const resolveHostBinding = vi.fn(unavailableResolver);
        const registry = createRegistry({
            resolveHostBinding,
            actions: [{
                ...action({ hostAccessRequests: [{ request, required: false }] }),
                handler: async () => ({ echoed: 'ok' }),
            }],
        });

        const target = request.scope.targets[0];
        if (target?.kind !== 'fixedOrigin') throw new Error('network fixture must use a fixed origin');
        target.origin = 'https://mutated.test';
        await registry.invoke({
            pluginId: 'acme.alpha', localId: 'run', input: { value: 'x' }, surface: 'cli',
        });

        expect(resolveHostBinding).toHaveBeenCalledWith(
            expect.anything(),
            expect.objectContaining({
                hostAccessRequests: [expect.objectContaining({
                    request: expect.objectContaining({
                        scope: expect.objectContaining({
                            targets: [{ kind: 'fixedOrigin', origin: 'https://example.test' }],
                        }),
                    }),
                })],
            }),
        );
    });

    it('requires a fingerprint-bound current decision for remote writes', async () => {
        const handler = vi.fn(async () => ({ echoed: 'yes' }));
        const requestCurrentIntent = vi.fn(async ({ fingerprint }) => ({ status: 'approved' as const, fingerprint }));
        const registry = createRegistry({ actions: [{ ...action({ dangerLevel: 'writesRemote' }), handler }] });
        await expect(registry.invoke({ pluginId: 'acme.alpha', localId: 'run', input: { value: 'x' }, surface: 'cli', requestCurrentIntent }))
            .resolves.toMatchObject({ status: 'executed' });
        expect(requestCurrentIntent).toHaveBeenCalledTimes(1);
        expect(handler).toHaveBeenCalledTimes(1);
    });

    it('rejects a decision when refresh replaces the registered generation while intent is pending', async () => {
        const oldHandler = vi.fn(async () => ({ echoed: 'old' }));
        const newHandler = vi.fn(async () => ({ echoed: 'new' }));
        let actions: Parameters<typeof createTargetActionInvocationRegistry>[0]['actions'] = [
            { ...action({ dangerLevel: 'writesRemote' }), handler: oldHandler },
        ];
        const registry = createRegistry({ actions, readActions: () => actions });

        const result = await registry.invoke({
            pluginId: 'acme.alpha', localId: 'run', input: { value: 'x' }, surface: 'cli',
            requestCurrentIntent: async ({ fingerprint }) => {
                actions = [{ ...action({ dangerLevel: 'writesRemote' }), generation: '8', handler: newHandler }];
                registry.refresh();
                return { status: 'approved', fingerprint };
            },
        });

        expect(result).toMatchObject({ status: 'unavailable', code: 'plugin_action_current_intent_mismatch' });
        expect(oldHandler).not.toHaveBeenCalled();
        expect(newHandler).not.toHaveBeenCalled();
    });

    it('validates input and result and invokes a valid handler exactly once', async () => {
        const invalidResult = vi.fn(async () => ({ wrong: true }));
        const registry = createRegistry({ actions: [{ ...action(), handler: invalidResult }] });

        await expect(registry.invoke({ pluginId: 'acme.alpha', localId: 'run', input: {}, surface: 'cli' }))
            .resolves.toMatchObject({ status: 'invalid', code: 'plugin_action_input_schema_invalid' });
        expect(invalidResult).not.toHaveBeenCalled();
        await expect(registry.invoke({ pluginId: 'acme.alpha', localId: 'run', input: { value: 'x' }, surface: 'cli' }))
            .resolves.toMatchObject({ status: 'invalid', code: 'plugin_action_result_schema_invalid' });
        expect(invalidResult).toHaveBeenCalledTimes(1);
    });

    it('normalizes strict JSON at both invocation boundaries and rejects non-JSON values without invoking', async () => {
        const handler = vi.fn(async (input) => input);
        const registry = createRegistry({
            actions: [{
                ...action({ inputSchema: undefined, resultSchema: undefined }),
                handler,
            }],
        });
        const cyclic: Record<string, unknown> = {};
        cyclic.self = cyclic;
        const sparse = new Array(1);

        for (const input of [new Date(), sparse, cyclic, Promise.resolve('not-json')]) {
            await expect(registry.invoke({
                pluginId: 'acme.alpha', localId: 'run', input, surface: 'cli',
            })).resolves.toMatchObject({
                status: 'invalid', code: 'plugin_action_input_schema_invalid',
            });
        }
        expect(handler).not.toHaveBeenCalled();

        const invalidResults = [new Date(), sparse, cyclic, { nested: Promise.resolve('not-json') }];
        for (const result of invalidResults) {
            const resultRegistry = createRegistry({
                actions: [{
                    ...action({ inputSchema: undefined, resultSchema: undefined }),
                    handler: async () => result as never,
                }],
            });
            await expect(resultRegistry.invoke({
                pluginId: 'acme.alpha', localId: 'run', input: {}, surface: 'cli',
            })).resolves.toMatchObject({
                status: 'invalid', code: 'plugin_action_result_schema_invalid',
            });
        }
    });

    it('atomically refreshes the complete target index after lazy activation', async () => {
        const handler = vi.fn(async () => ({ echoed: 'lazy' }));
        let actions = [] as Parameters<typeof createTargetActionInvocationRegistry>[0]['actions'];
        const registry = createRegistry({
            actions,
            readActions: () => actions,
        });

        expect(registry.has('acme.alpha', 'run')).toBe(false);
        actions = [{ ...action(), handler }];
        registry.refresh();

        expect(registry.has('acme.alpha', 'run')).toBe(true);
        await expect(registry.invoke({
            pluginId: 'acme.alpha', localId: 'run', input: { value: 'x' }, surface: 'cli',
        })).resolves.toEqual({ status: 'executed', value: { echoed: 'lazy' } });
    });

    it('links caller and generation cancellation and rejects stale results after retirement', async () => {
        let resolveHandler!: (value: { echoed: string }) => void;
        const handler = vi.fn(() => new Promise<{ echoed: string }>((resolve) => {
            resolveHandler = resolve;
        }));
        const registry = createRegistry({ actions: [{ ...action(), handler }] });
        const invocation = registry.invoke({ pluginId: 'acme.alpha', localId: 'run', input: { value: 'x' }, surface: 'cli' });
        await vi.waitFor(() => expect(handler).toHaveBeenCalledTimes(1));
        registry.dispose();
        resolveHandler({ echoed: 'x' });

        await expect(invocation).resolves.toMatchObject({ status: 'unavailable', code: 'plugin_action_generation_retired' });
        expect(handler).toHaveBeenCalledTimes(1);

        await expect(registry.invoke({ pluginId: 'acme.alpha', localId: 'run', input: { value: 'x' }, surface: 'cli' }))
            .resolves.toMatchObject({ status: 'unavailable', code: 'plugin_action_generation_retired' });

        const aborted = new AbortController();
        aborted.abort(new Error('caller stopped'));
        await expect(createRegistry({ actions: [{ ...action(), handler }] }).invoke({
            pluginId: 'acme.alpha', localId: 'run', input: { value: 'x' }, surface: 'cli', signal: aborted.signal,
        })).resolves.toMatchObject({ status: 'unavailable', code: 'plugin_action_aborted' });
    });

    it('aborts an in-flight handler when its caller is cancelled', async () => {
        const caller = new AbortController();
        const handler = vi.fn((_input, context) => new Promise<never>((_resolve, reject) => {
            context.signal.addEventListener('abort', () => reject(context.signal.reason), { once: true });
        }));
        const registry = createRegistry({ actions: [{ ...action(), handler }] });
        const invocation = registry.invoke({
            pluginId: 'acme.alpha', localId: 'run', input: { value: 'x' }, surface: 'cli', signal: caller.signal,
        });
        await vi.waitFor(() => expect(handler).toHaveBeenCalledTimes(1));
        caller.abort(new Error('caller stopped'));
        await expect(invocation).resolves.toMatchObject({ status: 'unavailable', code: 'plugin_action_aborted' });
    });

    it('does not relabel a successfully committed handler result after caller cancellation', async () => {
        let resolveHandler!: (value: { echoed: string }) => void;
        const caller = new AbortController();
        const registry = createRegistry({
            actions: [{
                ...action(),
                handler: () => new Promise<{ echoed: string }>((resolve) => { resolveHandler = resolve; }),
            }],
        });
        const invocation = registry.invoke({
            pluginId: 'acme.alpha', localId: 'run', input: { value: 'x' }, surface: 'cli', signal: caller.signal,
        });
        await vi.waitFor(() => expect(resolveHandler).toBeTypeOf('function'));
        caller.abort(new Error('caller stopped'));
        resolveHandler({ echoed: 'x' });

        await expect(invocation).resolves.toEqual({ status: 'executed', value: { echoed: 'x' } });
    });
});

describe('SDK testkit and production action invocation parity', () => {
    const parityManifest = {
        schemaVersion: 2,
        id: 'acme.alpha',
        version: '1.2.3',
        displayName: 'Action parity fixture',
        engines: { happier: '^0.2.0' }, runtime: { apiVersion: 1 },
        contributes: {
            actions: [{
                id: 'run',
                title: 'Run',
                scopes: ['global'],
                surfaces: ['cli'],
                placement: 'commandPalette',
                dangerLevel: 'safe',
                inputSchema: {
                    type: 'object',
                    properties: { value: { type: 'string' } },
                    required: ['value'],
                    additionalProperties: false,
                },
                resultSchema: {
                    type: 'object',
                    properties: { echoed: { type: 'string' } },
                    required: ['echoed'],
                    additionalProperties: false,
                },
            }],
        },
    } satisfies PluginManifest;

    async function invokeThroughProduction(
        handler: ActionHandler,
        input: unknown,
        signal?: AbortSignal,
    ) {
        const registry = createRegistry({ actions: [{ ...action(), handler }] });
        try {
            return await registry.invoke({
                pluginId: 'acme.alpha',
                localId: 'run',
                input,
                surface: 'cli',
                ...(signal ? { signal } : {}),
            });
        } finally {
            registry.dispose();
        }
    }

    async function invokeThroughTestkit(
        handler: ActionHandler,
        input: unknown,
        signal?: AbortSignal,
    ) {
        const testkit = await createPluginTestkit({
            manifest: parityManifest,
            module: {
                activate(api) {
                    api.actions.register('run', handler);
                },
            },
        });
        try {
            const value = await testkit.invokeAction('run', input as never, signal ? { signal } : undefined);
            return Object.freeze({ status: 'executed' as const, value: value ?? null });
        } catch (error) {
            return normalizeTestkitResult(error);
        } finally {
            await testkit.dispose();
        }
    }

    function normalizeTestkitResult(error: unknown) {
        if (error instanceof PluginError) {
            const status = error.code.includes('_schema_invalid') ? 'invalid' as const
                : error.code === 'plugin_action_aborted' || error.code === 'plugin_action_generation_retired'
                    ? 'unavailable' as const
                    : 'failed' as const;
            return Object.freeze({ status, code: error.code, message: error.message });
        }
        return Object.freeze({
            status: 'failed' as const,
            code: 'plugin_action_execution_failed',
            message: error instanceof Error ? error.message : 'Plugin action execution failed',
        });
    }

    const invokePaths = [
        ['production', invokeThroughProduction],
        ['testkit', invokeThroughTestkit],
    ] as const;

    for (const [path, invoke] of invokePaths) {
        it(`${path} uses the canonical qualified identity`, async () => {
            await expect(invoke(async (_input, context) => ({
                echoed: context.contribution.qualifiedId,
            }), { value: 'x' })).resolves.toEqual({
                status: 'executed',
                value: { echoed: 'acme.alpha/actions/run' },
            });
        });

        it(`${path} rejects schema-invalid input before invoking the handler`, async () => {
            const handler = vi.fn(async () => ({ echoed: 'not-called' }));
            await expect(invoke(handler, {})).resolves.toMatchObject({
                status: 'invalid',
                code: 'plugin_action_input_schema_invalid',
            });
            expect(handler).not.toHaveBeenCalled();
        });

        it(`${path} rejects schema-invalid and non-JSON results`, async () => {
            await expect(invoke(async () => ({ wrong: true }), { value: 'x' })).resolves.toMatchObject({
                status: 'invalid',
                code: 'plugin_action_result_schema_invalid',
            });
            await expect(invoke(async () => new Date() as never, { value: 'x' })).resolves.toMatchObject({
                status: 'invalid',
                code: 'plugin_action_result_schema_invalid',
            });
        });

        it(`${path} rejects non-JSON input without invoking the handler`, async () => {
            const handler = vi.fn(async () => ({ echoed: 'not-called' }));
            await expect(invoke(handler, new Date())).resolves.toMatchObject({
                status: 'invalid',
                code: 'plugin_action_input_schema_invalid',
            });
            expect(handler).not.toHaveBeenCalled();
        });

        it(`${path} preserves PluginError codes and caller abort`, async () => {
            await expect(invoke(async () => {
                throw new PluginError({ code: 'fixture_failed', message: 'Fixture failed' });
            }, { value: 'x' })).resolves.toMatchObject({
                status: 'failed',
                code: 'fixture_failed',
            });

            const caller = new AbortController();
            caller.abort(new Error('caller stopped'));
            const handler = vi.fn(async () => ({ echoed: 'not-called' }));
            await expect(invoke(handler, { value: 'x' }, caller.signal)).resolves.toMatchObject({
                status: 'unavailable',
                code: 'plugin_action_aborted',
            });
            expect(handler).not.toHaveBeenCalled();
        });

        it(`${path} rejects a late handler result after disposal`, async () => {
            let resolveHandler!: (value: { echoed: string }) => void;
            const handler = vi.fn(() => new Promise<{ echoed: string }>((resolve) => {
                resolveHandler = resolve;
            }));
            if (path === 'production') {
                const registry = createRegistry({ actions: [{ ...action(), handler }] });
                const invocation = registry.invoke({
                    pluginId: 'acme.alpha',
                    localId: 'run',
                    input: { value: 'x' },
                    surface: 'cli',
                });
                await vi.waitFor(() => expect(handler).toHaveBeenCalledOnce());
                registry.dispose();
                resolveHandler({ echoed: 'x' });
                await expect(invocation).resolves.toMatchObject({
                    status: 'unavailable',
                    code: 'plugin_action_generation_retired',
                });
                return;
            }

            const testkit = await createPluginTestkit({
                manifest: parityManifest,
                module: { activate(api) { api.actions.register('run', handler); } },
            });
            const invocation = testkit.invokeAction('run', { value: 'x' }).catch(normalizeTestkitResult);
            await vi.waitFor(() => expect(handler).toHaveBeenCalledOnce());
            await testkit.dispose();
            resolveHandler({ echoed: 'x' });
            await expect(invocation).resolves.toMatchObject({
                status: 'unavailable',
                code: 'plugin_action_generation_retired',
            });
        });
    }
});
