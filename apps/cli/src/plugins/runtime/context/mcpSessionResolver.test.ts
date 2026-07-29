import { describe, expect, it } from 'vitest';

import { createPluginMcpSessionResolver } from './mcp';

describe('createPluginMcpSessionResolver', () => {
    it('returns immutable session-scoped MCP resolution results', async () => {
        const resolver = createPluginMcpSessionResolver({
            resolveForSession: async (input) => [{
                id: 'acme.hosted',
                name: 'acme-hosted',
                scope: {
                    sessionId: input.sessionId,
                    accountId: input.accountId,
                    workspaceId: input.workspaceId,
                    directory: input.directory,
                },
                transport: { kind: 'hosted' },
            }],
        });

        const resolved = await resolver.resolveForSession({
            sessionId: 'session-1',
            accountId: 'account-1',
            workspaceId: 'workspace-1',
            directory: '/repo',
        });

        expect(resolved).toEqual([{
            id: 'acme.hosted',
            name: 'acme-hosted',
            scope: {
                sessionId: 'session-1',
                accountId: 'account-1',
                workspaceId: 'workspace-1',
                directory: '/repo',
            },
            transport: { kind: 'hosted' },
        }]);
        expect(Object.isFrozen(resolved)).toBe(true);
    });
});
