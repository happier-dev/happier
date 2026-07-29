import { describe, expect, it } from 'vitest';
import type {
    ConnectedAccountPurposeDeclarationV1,
    PluginHostAccessRequestV2,
} from '@happier-dev/protocol';

import { createDefaultPluginAccessScopeRegistry } from '@/plugins/store/install/accessScopeRegistry';
import {
    addConnectedAccountsAvailablePluginInvocationServiceBinding,
    addMcpAvailablePluginInvocationServiceBinding,
    createLoggerAndEventsAvailablePluginInvocationServiceBinding,
    createLoggerAndFilesystemServiceBinding,
    createLoggerAvailablePluginInvocationServiceBinding,
} from '../invocation/services/factory';
import {
    createTargetActionHostBindingResolver,
    projectConnectedAccountPurposeDeclarationsToHostAccess,
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
                    operations: ['callTools'],
                }],
            },
        });
        expect(selectedBinding?.serviceBinding.mcpScopes?.[0]).toEqual({
            serverRefs: [{ pluginId: 'acme.tools', localId: 'runtime' }],
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

    it('does not authorize cooperative ambient access from a persisted optional selection', async () => {
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
                    status: 'denied',
                    code: 'plugin_host_access_resource_not_selected',
                }],
            },
            serviceBinding: { availability: { fetch: 'denied' } },
        });
    });

    it('projects only currently selected secret scopes into the invocation binding', async () => {
        const request = {
            id: 'webhook-secret',
            capability: 'secrets' as const,
            reason: 'Read the selected webhook secret',
            scope: { secretIds: ['webhook-token'], access: ['read' as const] },
        };
        const selection = createDefaultPluginAccessScopeRegistry().createSelection({
            pluginId: action.pluginId,
            accessId: request.id,
            capability: request.capability,
            scope: request.scope,
            selectedAtMs: 1,
        });
        const createServiceBinding = (
            generation: string,
            id: string,
            requests: readonly Readonly<{ request: PluginHostAccessRequestV2; required: boolean }>[] = [],
        ) => createLoggerAndEventsAvailablePluginInvocationServiceBinding(generation, id, requests);
        const selected = createTargetActionHostBindingResolver({
            createServiceBinding,
            resolveOptionalAccess: () => [selection],
        });
        const revoked = createTargetActionHostBindingResolver({
            createServiceBinding,
            resolveOptionalAccess: () => [],
        });

        await expect(selected(action, {
            hostAccessRequests: [{ request, required: false }], surface: 'cli',
        })).resolves.toMatchObject({
            serviceBinding: {
                availability: { secrets: 'available' },
                secretScopes: [{
                    accessId: request.id,
                    required: false,
                    secretIds: ['webhook-token'],
                    access: ['read'],
                }],
            },
        });
        await expect(revoked(action, {
            hostAccessRequests: [{ request, required: false }], surface: 'cli',
        })).resolves.toMatchObject({
            action: { hostAccess: [{ status: 'denied' }] },
            serviceBinding: { availability: { secrets: 'denied' } },
        });
    });

    it('accepts only the exact declared resource scope and rejects stale narrower or wider declarations', async () => {
        const accessScopeRegistry = createDefaultPluginAccessScopeRegistry();
        const selectedScope = {
            serverRefs: [{ pluginId: 'acme.tools', localId: 'runtime' }],
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
            scope: { ...selectedScope, operations: ['listTools' as const, 'callTools' as const, 'discover' as const] },
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
