import { describe, expect, it } from 'vitest';
import type { ConnectedAccountPurposeDeclarationV1 } from '@happier-dev/protocol';
import type { PluginAccountStorageScope } from '@happier-dev/plugin-sdk/storage';

import { createDefaultPluginAccessScopeRegistry } from '@/plugins/store/install/accessScopeRegistry';
import {
    addConnectedAccountsAvailablePluginInvocationServiceBinding,
    addMcpAvailablePluginInvocationServiceBinding,
    createLoggerAndEventsAvailablePluginInvocationServiceBinding,
    createLoggerAndFilesystemServiceBinding,
    createLoggerAvailablePluginInvocationServiceBinding,
    createUnavailablePluginInvocationServiceBinding,
} from '../invocation/services/factory';
import { withPluginInvocationServiceBindingAvailability } from '../invocation/services/unavailable';
import {
    createPluginInvocationHostPolicyResolver,
    createPluginResourceAccountStorageResolver,
    createTargetActionHostBindingResolver,
    projectConnectedAccountPurposeDeclarationsToHostAccess,
    type TargetActionHostBindingContext,
} from './resolve';

const action = Object.freeze({
    qualifiedId: 'acme.alpha/actions/run',
    pluginId: 'acme.alpha',
    localId: 'run',
    generation: '7',
    dangerLevel: 'safe',
    scopes: Object.freeze(['global']),
    surfaces: Object.freeze(['cli']),
    hostAccess: Object.freeze([]),
    input: Object.freeze({}),
    policyFingerprint: 'a'.repeat(64),
});

describe('target action HostAccess binding resolver', () => {
    it('binds required Account storage and fails closed before a Resource callback when unavailable', () => {
        const scope = Object.freeze({ marker: true }) as unknown as PluginAccountStorageScope;
        let binds = 0;
        const request = Object.freeze({
            required: true,
            request: Object.freeze({
                id: 'account-storage',
                capability: 'storage.account' as const,
                reason: 'Persist Account-scoped Resource state',
                scope: Object.freeze({ enabled: true as const }),
            }),
        });
        const input = {
            pluginId: 'acme.alpha',
            resourceId: 'live',
            generation: '7',
            hostAccessRequests: [request],
            signal: new AbortController().signal,
            isGenerationCurrent: () => true,
        };
        const available = createPluginResourceAccountStorageResolver({
            accountStorage: {
                bind() {
                    binds += 1;
                    return scope;
                },
            },
        });

        expect(available(input)).toBe(scope);
        expect(binds).toBe(1);
        expect(() => createPluginResourceAccountStorageResolver({})(input)).toThrow(
            expect.objectContaining({ code: 'plugin_account_storage_unavailable' }),
        );
    });

    it('omits optional Account storage when the request was not selected', () => {
        let binds = 0;
        const resolve = createPluginResourceAccountStorageResolver({
            accountStorage: {
                bind() {
                    binds += 1;
                    return Object.freeze({ marker: true }) as unknown as PluginAccountStorageScope;
                },
            },
            resolveOptionalAccess: () => [],
        });

        expect(resolve({
            pluginId: 'acme.alpha',
            resourceId: 'live',
            generation: '7',
            hostAccessRequests: [{
                required: false,
                request: {
                    id: 'account-storage',
                    capability: 'storage.account',
                    reason: 'Persist Account-scoped Resource state when selected',
                    scope: { enabled: true },
                },
            }],
            signal: new AbortController().signal,
            isGenerationCurrent: () => true,
        })).toBeUndefined();
        expect(binds).toBe(0);
    });

    it('projects long-lived contribution purposes into the same bounded HostAccess facts', () => {
        const declarations: ConnectedAccountPurposeDeclarationV1[] = [
            {
                purpose: 'primary',
                service: 'local-account',
                materializationKinds: ['files'],
            },
            {
                purpose: 'fallback',
                service: Object.freeze({
                    pluginId: 'acme.accounts',
                    localId: 'shared-account',
                }),
                required: false,
            },
        ];

        expect(projectConnectedAccountPurposeDeclarationsToHostAccess(declarations)).toEqual([
            {
                required: true,
                request: {
                    id: 'primary',
                    capability: 'connectedAccounts',
                    reason: expect.any(String),
                    scope: {
                        serviceRefs: ['local-account'],
                        operations: ['select', 'use'],
                        materializationKinds: ['files'],
                    },
                },
            },
            {
                required: true,
                request: {
                    id: 'fallback',
                    capability: 'connectedAccounts',
                    reason: expect.any(String),
                    scope: {
                        serviceRefs: [{
                            pluginId: 'acme.accounts',
                            localId: 'shared-account',
                        }],
                        operations: ['select', 'use'],
                    },
                },
            },
        ]);
    });

    it('delegates service binding construction to the injected host factory', async () => {
        const resolve = createTargetActionHostBindingResolver({
            createServiceBinding: createLoggerAvailablePluginInvocationServiceBinding,
        });

        const binding = await resolve(action, {
            hostAccessRequests: [],
            surface: 'cli',
        });

        expect(binding?.serviceBinding).toMatchObject({
            generation: '7',
            availability: { logger: 'available', storage: 'unavailable' },
        });
    });

    it('uses persisted optional selections only for real host-owned resources', async () => {
        const request = {
            id: 'selected-mcp',
            capability: 'mcp' as const,
            reason: 'Use the selected MCP server',
            scope: {
                serverRefs: [{ pluginId: 'acme.tools', localId: 'runtime' }],
                discoverySourceRefs: [],
                operations: ['callTools' as const],
            },
        };
        const selection = createDefaultPluginAccessScopeRegistry().createSelection({
            pluginId: action.pluginId,
            accessId: request.id,
            capability: request.capability,
            scope: request.scope,
            selectedAtMs: 1,
        });
        const createServiceBinding = (generation: string, id: string) => (
            addMcpAvailablePluginInvocationServiceBinding(
                createLoggerAvailablePluginInvocationServiceBinding(generation, id),
            )
        );
        const selected = createTargetActionHostBindingResolver({
            createServiceBinding,
            resolveOptionalAccess: () => [selection],
        });
        const unselected = createTargetActionHostBindingResolver({
            createServiceBinding,
            resolveOptionalAccess: () => [],
        });

        const selectedBinding = await selected(action, {
            hostAccessRequests: [{ request, required: false }], surface: 'cli',
        });
        expect(selectedBinding).toMatchObject({
            action: { hostAccess: [{ id: request.id, status: 'available' }] },
            serviceBinding: {
                availability: { mcp: 'available' },
                mcpScopes: [{
                    serverRefs: [{ pluginId: 'acme.tools', localId: 'runtime' }],
                    discoverySourceRefs: [],
                    operations: ['callTools'],
                }],
            },
        });
        expect(selectedBinding?.serviceBinding.mcpScopes?.[0]).toEqual({
            serverRefs: [{ pluginId: 'acme.tools', localId: 'runtime' }],
            discoverySourceRefs: [],
            operations: ['callTools'],
        });
        await expect(unselected(action, {
            hostAccessRequests: [{ request, required: false }], surface: 'cli',
        })).resolves.toMatchObject({
            action: {
                hostAccess: [{
                    id: request.id,
                    status: 'denied',
                    code: 'plugin_host_access_resource_not_selected',
                }],
            },
            serviceBinding: { availability: { mcp: 'denied' } },
        });
    });

    it('projects only selected Session HostAccess scopes into the invocation binding', () => {
        const request = {
            id: 'project-session-access',
            capability: 'sessions' as const,
            reason: 'Read and control project Sessions',
            scope: {
                access: ['read' as const, 'control' as const],
                machineIds: ['machine-a'],
                projectIds: ['project-a'],
            },
        };
        const selection = createDefaultPluginAccessScopeRegistry().createSelection({
            pluginId: action.pluginId,
            accessId: request.id,
            capability: request.capability,
            scope: request.scope,
            selectedAtMs: 1,
        });
        const createServiceBinding = (generation: string, id: string) => (
            withPluginInvocationServiceBindingAvailability(
                createLoggerAvailablePluginInvocationServiceBinding(generation, id),
                { serviceId: 'sessions', availability: 'available' },
            )
        );
        const selected = createPluginInvocationHostPolicyResolver({
            createServiceBinding,
            resolveOptionalAccess: () => [selection],
        });
        const unselected = createPluginInvocationHostPolicyResolver({
            createServiceBinding,
            resolveOptionalAccess: () => [],
        });

        expect(selected(action, {
            hostAccessRequests: [{ request, required: false }],
            surface: 'cli',
        })).toMatchObject({
            hostAccess: [{ id: request.id, status: 'available' }],
            serviceBinding: {
                availability: { sessions: 'available' },
                sessionScopes: [{
                    access: ['read', 'control'],
                    machineIds: ['machine-a'],
                    projectIds: ['project-a'],
                }],
            },
        });
        expect(unselected(action, {
            hostAccessRequests: [{ request, required: false }],
            surface: 'cli',
        })).toMatchObject({
            hostAccess: [{
                id: request.id,
                status: 'denied',
                code: 'plugin_host_access_resource_not_selected',
            }],
            serviceBinding: { availability: { sessions: 'denied' } },
        });
        expect(selected(action, {
            hostAccessRequests: [],
            surface: 'cli',
        })).toMatchObject({
            serviceBinding: { availability: { sessions: 'unavailable' } },
        });
    });

    it('projects a selected MCP discovery source independently from server refs', async () => {
        const request = {
            id: 'selected-mcp-discovery',
            capability: 'mcp' as const,
            reason: 'Use the selected MCP discovery source',
            scope: {
                serverRefs: [],
                discoverySourceRefs: [
                    'local-discovery',
                    { pluginId: 'acme.discovery', localId: 'shared' },
                ],
                operations: ['discover' as const],
            },
        };
        const selection = createDefaultPluginAccessScopeRegistry().createSelection({
            pluginId: action.pluginId,
            accessId: request.id,
            capability: request.capability,
            scope: request.scope,
            selectedAtMs: 1,
        });
        const resolve = createTargetActionHostBindingResolver({
            createServiceBinding: (generation, id) => addMcpAvailablePluginInvocationServiceBinding(
                createLoggerAvailablePluginInvocationServiceBinding(generation, id),
            ),
            resolveOptionalAccess: () => [selection],
        });

        await expect(resolve(action, {
            hostAccessRequests: [{ request, required: false }],
            surface: 'cli',
        })).resolves.toMatchObject({
            action: { hostAccess: [{ id: request.id, status: 'available' }] },
            serviceBinding: {
                availability: { mcp: 'available' },
                mcpScopes: [{
                    serverRefs: [],
                    discoverySourceRefs: [
                        { pluginId: action.pluginId, localId: 'local-discovery' },
                        { pluginId: 'acme.discovery', localId: 'shared' },
                    ],
                    operations: ['discover'],
                }],
            },
        });
    });

    it('projects only authorized Connected Accounts purposes, qualified services, and operations', async () => {
        const request = {
            id: 'realtime_upstream',
            capability: 'connectedAccounts' as const,
            reason: 'Use an upstream account',
            scope: {
                serviceRefs: [
                    'local-account',
                    { pluginId: 'acme.accounts', localId: 'shared-account' },
                ],
                operations: ['select' as const, 'use' as const],
                materializationKinds: ['environment' as const],
            },
        };
        const resolve = createTargetActionHostBindingResolver({
            createServiceBinding: (generation, id) => addConnectedAccountsAvailablePluginInvocationServiceBinding(
                createLoggerAvailablePluginInvocationServiceBinding(generation, id),
            ),
        });

        await expect(resolve(action, {
            hostAccessRequests: [{ request, required: true }],
            surface: 'cli',
        })).resolves.toMatchObject({
            serviceBinding: {
                availability: { connectedAccounts: 'available' },
                connectedAccountScopes: [{
                    purpose: 'realtime_upstream',
                    serviceRefs: [
                        { pluginId: 'acme.alpha', localId: 'local-account' },
                        { pluginId: 'acme.accounts', localId: 'shared-account' },
                    ],
                    operations: ['select', 'use'],
                    materializationKinds: ['environment'],
                }],
            },
        });
    });

    it('keeps Connected Accounts unavailable or denied when no purpose is authorized', async () => {
        const request = {
            id: 'realtime_upstream',
            capability: 'connectedAccounts' as const,
            reason: 'Use an upstream account',
            scope: {
                serviceRefs: [{ pluginId: 'acme.accounts', localId: 'shared-account' }],
                operations: ['select' as const],
            },
        };
        const selection = createDefaultPluginAccessScopeRegistry().createSelection({
            pluginId: action.pluginId,
            accessId: request.id,
            capability: request.capability,
            scope: request.scope,
            selectedAtMs: 1,
        });
        const createServiceBinding = (generation: string, id: string) => (
            addConnectedAccountsAvailablePluginInvocationServiceBinding(
                createLoggerAvailablePluginInvocationServiceBinding(generation, id),
            )
        );
        const selected = createTargetActionHostBindingResolver({
            createServiceBinding,
            resolveOptionalAccess: () => [selection],
        });
        const denied = createTargetActionHostBindingResolver({
            createServiceBinding,
            resolveOptionalAccess: () => [],
        });

        await expect(selected(action, {
            hostAccessRequests: [{ request, required: false }],
            surface: 'cli',
        })).resolves.toMatchObject({
            serviceBinding: {
                availability: { connectedAccounts: 'available' },
                connectedAccountScopes: [{
                    purpose: request.id,
                    operations: ['select'],
                }],
            },
        });
        await expect(denied(action, {
            hostAccessRequests: [{ request, required: false }],
            surface: 'cli',
        })).resolves.toMatchObject({
            serviceBinding: {
                availability: { connectedAccounts: 'denied' },
            },
        });
        await expect(selected(action, {
            hostAccessRequests: [],
            surface: 'cli',
        })).resolves.toMatchObject({
            serviceBinding: {
                availability: { connectedAccounts: 'unavailable' },
            },
        });
    });

    it('preserves required ambient filesystem access as cooperative service availability', async () => {
        const request = {
            id: 'workspace-files',
            capability: 'filesystem' as const,
            reason: 'Read workspace files through the host service',
            scope: { locations: [{ root: 'workspace' as const }], access: ['read' as const] },
        };
        const resolve = createTargetActionHostBindingResolver({
            createServiceBinding: (generation, id, requests) => createLoggerAndFilesystemServiceBinding(
                generation,
                id,
                requests,
                { pluginData: '/plugin-data', workspace: '/workspace', projects: new Map() },
            ),
            resolveOptionalAccess: () => [],
        });

        await expect(resolve(action, {
            hostAccessRequests: [{ request, required: true }], surface: 'cli',
        })).resolves.toMatchObject({
            action: { hostAccess: [{ id: request.id, status: 'available' }] },
        });
    });

    it('diagnoses a declared filesystem capability when its host service is unavailable', () => {
        const request = {
            id: 'workspace-files',
            capability: 'filesystem' as const,
            reason: 'Read workspace files through the host service',
            scope: { locations: [{ root: 'workspace' as const }], access: ['read' as const] },
        };
        const resolve = createPluginInvocationHostPolicyResolver({
            createServiceBinding: createUnavailablePluginInvocationServiceBinding,
        });

        expect(resolve(action, {
            hostAccessRequests: [{ request, required: true }],
            surface: 'cli',
        })).toMatchObject({
            hostAccess: [{
                id: request.id,
                status: 'unavailable',
                code: 'plugin_host_access_service_unavailable',
            }],
            serviceBinding: {
                availability: { fs: 'unavailable' },
                unavailableDiagnostics: {
                    fs: {
                        unavailableHostAccessCapability: 'filesystem',
                    },
                },
            },
        });
    });

    it('marks Agent-session-only HostAccess as not applicable to an ordinary invocation', () => {
        const request = {
            id: 'terminal-control',
            capability: 'terminal' as const,
            reason: 'Control the current Agent terminal',
            scope: { operations: ['open' as const, 'send' as const] },
        };
        const resolve = createPluginInvocationHostPolicyResolver({
            createServiceBinding: createLoggerAvailablePluginInvocationServiceBinding,
        });

        expect(resolve(action, {
            hostAccessRequests: [{ request, required: true }],
            surface: 'cli',
        })).toMatchObject({
            hostAccess: [{
                id: request.id,
                status: 'notApplicable',
                code: 'plugin_host_access_not_applicable',
            }],
        });
    });

    it('reports deferred HostAccess capabilities as unavailable rather than not applicable', () => {
        // `notApplicable` is satisfied-by-final-policy. Only the Agent-session
        // terminal topology earns it: `terminal` HostAccess projects into the
        // `terminalHost` runtime capability, so an ordinary invocation really is
        // outside its topology. Browser, clipboard and external-link access have
        // no authority or service owner at all, so declaring them must not make a
        // plugin look executable.
        const deferred = [
            {
                id: 'browser-control',
                capability: 'browser' as const,
                reason: 'Drive the host browser',
                scope: { operations: ['read' as const, 'navigate' as const] },
            },
            {
                id: 'clipboard-io',
                capability: 'clipboard' as const,
                reason: 'Read and write the host clipboard',
                scope: { access: ['read' as const, 'write' as const] },
            },
            {
                id: 'external-links',
                capability: 'externalLinks' as const,
                reason: 'Open a declared external origin',
                scope: { origins: ['https://example.com'] },
            },
        ];
        const resolve = createPluginInvocationHostPolicyResolver({
            createServiceBinding: createLoggerAvailablePluginInvocationServiceBinding,
        });

        expect(resolve(action, {
            hostAccessRequests: deferred.map((request) => ({ request, required: true })),
            surface: 'cli',
        }).hostAccess).toMatchObject(deferred.map((request) => ({
            id: request.id,
            status: 'unavailable',
            code: 'plugin_host_access_service_unavailable',
        })));
    });

    it('does not require a user grant or persisted resource selection for optional cooperative ambient access', async () => {
        const request = {
            id: 'api-network',
            capability: 'network' as const,
            reason: 'Call the declared API',
            scope: {
                targets: [{ kind: 'fixedOrigin' as const, origin: 'https://api.example.com' }],
            },
        };
        const selection = createDefaultPluginAccessScopeRegistry().createSelection({
            pluginId: action.pluginId,
            accessId: request.id,
            capability: request.capability,
            scope: request.scope,
            selectedAtMs: 1,
        });
        const resolve = createTargetActionHostBindingResolver({
            createServiceBinding: (generation, id, requests) => (
                createLoggerAndEventsAvailablePluginInvocationServiceBinding(generation, id, requests)
            ),
            resolveOptionalAccess: () => [selection],
        });

        await expect(resolve(action, {
            hostAccessRequests: [{ request, required: false }], surface: 'cli',
        })).resolves.toMatchObject({
            action: {
                hostAccess: [{
                    id: request.id,
                    status: 'available',
                }],
            },
            serviceBinding: { availability: { http: 'available' } },
        });
    });

    it('keeps network.client daemon-only while preserving ordinary network HTTP in the runner realm', () => {
        const requests = [{
            required: true,
            request: {
                id: 'api-http',
                capability: 'network' as const,
                reason: 'Call the declared HTTPS API',
                scope: {
                    targets: [{ kind: 'fixedOrigin' as const, origin: 'https://api.example.com' }],
                    methods: ['GET' as const],
                },
            },
        }, {
            required: true,
            request: {
                id: 'gateway-socket',
                capability: 'network.client' as const,
                reason: 'Maintain the declared provider gateway connection',
                scope: {
                    targets: [{ kind: 'fixedOrigin' as const, origin: 'https://gateway.example.com' }],
                    transports: ['websocket' as const],
                    privateNetwork: false,
                },
            },
        }];
        const resolve = createPluginInvocationHostPolicyResolver({
            createServiceBinding: createLoggerAndEventsAvailablePluginInvocationServiceBinding,
        });

        const daemon = resolve(action, {
            hostAccessRequests: requests,
            surface: 'background',
        });
        const runner = resolve(action, {
            hostAccessRequests: requests,
            surface: 'agent',
            executionRealm: 'runner',
        } as TargetActionHostBindingContext);

        expect(daemon).toMatchObject({
            hostAccess: [
                { id: 'api-http', status: 'available' },
                { id: 'gateway-socket', status: 'available' },
            ],
            serviceBinding: {
                availability: { http: 'available' },
                networkClientRequestIds: ['gateway-socket'],
            },
        });
        expect(runner).toMatchObject({
            hostAccess: [
                { id: 'api-http', status: 'available' },
                {
                    id: 'gateway-socket',
                    status: 'unavailable',
                    code: 'plugin_websocket_runner_connection_protocol_unavailable',
                },
            ],
            serviceBinding: {
                availability: { http: 'available' },
                networkRequestIds: ['api-http'],
                networkClientRequestIds: [],
            },
        });
    });

    it('accepts only the exact declared resource scope and rejects stale narrower or wider declarations', async () => {
        const accessScopeRegistry = createDefaultPluginAccessScopeRegistry();
        const selectedScope = {
            serverRefs: [{ pluginId: 'acme.tools', localId: 'runtime' }],
            discoverySourceRefs: [],
            operations: ['listTools' as const, 'callTools' as const],
        };
        const selection = accessScopeRegistry.createSelection({
            pluginId: action.pluginId,
            accessId: 'selected-mcp',
            capability: 'mcp',
            scope: selectedScope,
            selectedAtMs: 1,
        });
        const resolve = createTargetActionHostBindingResolver({
            createServiceBinding: (generation, id) => addMcpAvailablePluginInvocationServiceBinding(
                createLoggerAvailablePluginInvocationServiceBinding(generation, id),
            ),
            resolveOptionalAccess: () => [selection],
        });
        const narrowedRequest = {
            id: 'selected-mcp', capability: 'mcp' as const, reason: 'List the selected server',
            scope: { ...selectedScope, operations: ['listTools' as const] },
        };
        const widenedRequest = {
            ...narrowedRequest,
            scope: {
                ...selectedScope,
                discoverySourceRefs: [{ pluginId: 'acme.discovery', localId: 'runtime' }],
                operations: ['listTools' as const, 'callTools' as const, 'discover' as const],
            },
        };
        const exactRequest = {
            ...narrowedRequest,
            scope: selectedScope,
        };

        await expect(resolve(action, {
            hostAccessRequests: [{ request: narrowedRequest, required: false }], surface: 'cli',
        })).resolves.toMatchObject({
            action: { hostAccess: [{ status: 'denied', code: 'plugin_host_access_resource_not_selected' }] },
        });
        await expect(resolve(action, {
            hostAccessRequests: [{ request: widenedRequest, required: false }], surface: 'cli',
        })).resolves.toMatchObject({
            action: { hostAccess: [{ status: 'denied', code: 'plugin_host_access_resource_not_selected' }] },
        });
        await expect(resolve(action, {
            hostAccessRequests: [{ request: exactRequest, required: false }], surface: 'cli',
        })).resolves.toMatchObject({ action: { hostAccess: [{ status: 'available' }] } });
    });

    it('fails closed when the durable generation authority is no longer current', async () => {
        const resolve = createTargetActionHostBindingResolver({
            isGenerationCurrent: async () => false,
        });

        await expect(resolve(action, {
            hostAccessRequests: [], surface: 'cli',
        })).rejects.toMatchObject({ code: 'plugin_generation_stale' });
    });
});
