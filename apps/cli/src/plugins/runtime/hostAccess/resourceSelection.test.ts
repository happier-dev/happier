import { describe, expect, it } from 'vitest';

import { createDefaultPluginAccessScopeRegistry } from '@/plugins/store/install/accessScopeRegistry';
import { isPluginHostAccessRequestAuthorizedBySelection } from './resourceSelection';

describe('isPluginHostAccessRequestAuthorizedBySelection', () => {
    it('authorizes a current declaration contained in the selected scope, and nothing wider or foreign', () => {
        const registry = createDefaultPluginAccessScopeRegistry();
        const selection = registry.createSelection({
            pluginId: 'acme.plugin',
            accessId: 'account',
            capability: 'connectedAccounts',
            scope: {
                serviceRefs: ['github', 'slack'],
                operations: ['select', 'use'],
                materializationKinds: ['environment', 'files'],
            },
            selectedAtMs: 1,
        });

        expect(isPluginHostAccessRequestAuthorizedBySelection({
            pluginId: 'acme.plugin',
            request: {
                id: 'account',
                capability: 'connectedAccounts',
                reason: 'Use one selected account',
                scope: {
                    serviceRefs: ['github'],
                    operations: ['use'],
                    materializationKinds: ['environment'],
                },
            },
            required: false,
            optionalAccess: [selection],
        })).toBe(true);

        const widerRequest = {
            id: 'account',
            capability: 'connectedAccounts' as const,
            reason: 'Use more accounts',
            scope: {
                serviceRefs: ['github', 'slack', 'linear'],
                operations: ['select', 'use'] as ('select' | 'use')[],
                materializationKinds: ['environment', 'files'] as ('environment' | 'files')[],
            },
        };
        expect(isPluginHostAccessRequestAuthorizedBySelection({
            pluginId: 'acme.plugin',
            request: widerRequest,
            required: false,
            optionalAccess: [selection],
        })).toBe(false);
        expect(isPluginHostAccessRequestAuthorizedBySelection({
            pluginId: 'other.plugin',
            request: { ...widerRequest, scope: { ...widerRequest.scope, serviceRefs: ['github'] } },
            required: false,
            optionalAccess: [selection],
        })).toBe(false);
        expect(isPluginHostAccessRequestAuthorizedBySelection({
            pluginId: 'acme.plugin',
            request: { ...widerRequest, scope: { ...widerRequest.scope, serviceRefs: ['github'] } },
            required: false,
            optionalAccess: [selection, selection],
        })).toBe(false);
    });

    it('authorizes an MCP declaration covered by its selection and refuses one that reaches further', () => {
        const registry = createDefaultPluginAccessScopeRegistry();
        const request = {
            id: 'tools',
            capability: 'mcp' as const,
            reason: 'List tools from one selected server',
            scope: {
                serverRefs: [{ pluginId: 'acme.tools', localId: 'runtime' }],
                discoverySourceRefs: [],
                operations: ['listTools' as const],
            },
        };
        const exactSelection = registry.createSelection({
            pluginId: 'acme.plugin',
            accessId: request.id,
            capability: request.capability,
            scope: request.scope,
            selectedAtMs: 1,
        });
        const staleBroaderSelection = registry.createSelection({
            pluginId: 'acme.plugin',
            accessId: request.id,
            capability: request.capability,
            scope: {
                ...request.scope,
                operations: ['listTools', 'callTools'],
            },
            selectedAtMs: 1,
        });

        expect(isPluginHostAccessRequestAuthorizedBySelection({
            pluginId: 'acme.plugin',
            request,
            required: false,
            optionalAccess: [exactSelection],
        })).toBe(true);
        expect(isPluginHostAccessRequestAuthorizedBySelection({
            pluginId: 'acme.plugin',
            request,
            required: false,
            optionalAccess: [staleBroaderSelection],
        })).toBe(true);
        expect(isPluginHostAccessRequestAuthorizedBySelection({
            pluginId: 'acme.plugin',
            request: { ...request, scope: { ...request.scope, operations: ['listTools', 'callTools'] } },
            required: false,
            optionalAccess: [exactSelection],
        })).toBe(false);
    });
});
