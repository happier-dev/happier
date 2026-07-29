import { describe, expect, it } from 'vitest';

import { createDefaultPluginAccessScopeRegistry } from '@/plugins/store/install/accessScopeRegistry';
import { isPluginHostAccessRequestAuthorizedBySelection } from './resourceSelection';

describe('isPluginHostAccessRequestAuthorizedBySelection', () => {
    it('rejects a stale optional selection that is broader than the current declaration', () => {
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
        })).toBe(false);
    });

    it('requires an exact optional MCP selection instead of semantic effect coverage', () => {
        const registry = createDefaultPluginAccessScopeRegistry();
        const request = {
            id: 'tools',
            capability: 'mcp' as const,
            reason: 'List tools from one selected server',
            scope: {
                serverRefs: [{ pluginId: 'acme.tools', localId: 'runtime' }],
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
        })).toBe(false);
    });
});
