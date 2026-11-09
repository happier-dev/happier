import { describe, expect, it } from 'vitest';

import { resolveAgentCatalogProjection, resolveConfiguredAcpAgentCatalogProjection } from './agentCatalogProjection';
import { AcpCatalogRecordV1Schema } from '@happier-dev/protocol/acp/catalog/catalogRowsV1';
import { resolveBuiltInAgentForRegistryId } from '@/agents/registry/resolveBuiltInAgentForRegistryId';

describe('bundled Agent declarations without a machine projection', () => {
    it('reads a canonical selected target key through the same cold display owner', () => {
        const direct = resolveAgentCatalogProjection('codex', { enabledAgentIds: [] });
        const selected = resolveAgentCatalogProjection('agent:happier.agent.codex/codex', { enabledAgentIds: [] });
        expect(selected.agentId).toBe(direct.agentId);
        expect(selected.title).toBe(direct.title);
        expect(selected.identity).toEqual(direct.identity);
    });
    it('keeps configured ACP display names and marks distinct from the runtime contribution', () => {
        const record = AcpCatalogRecordV1Schema.parse({ v: 1, definitions: ['review', 'build'].map(id => ({
            id, name: id, title: `${id} configured agent`, launch: { kind: 'npm', package: 'fixture', version: '1.0', args: [] },
            env: {}, createdAt: 1, updatedAt: 1,
        })) });
        const entries = record.definitions.map(definition => resolveConfiguredAcpAgentCatalogProjection(definition, { enabledAgentIds: [] }));
        expect(entries.map(entry => [entry.title, entry.iconName])).toEqual([
            ['review configured agent', 'hard-drives'], ['build configured agent', 'hard-drives'],
        ]);
        expect(entries[0]?.backendTargetKey).not.toBe(entries[1]?.backendTargetKey);
    });
    it('resolves registry overlap from the generated cold declaration without a daemon', () => {
        const entry = resolveAgentCatalogProjection('claude', { enabledAgentIds: [] });
        expect(entry.acpRegistryIds).toEqual(['claude-acp']);
        expect(resolveBuiltInAgentForRegistryId([entry], 'claude-acp')).toBe(entry);
    });
    it('exposes admitted identity and qualified account purposes without asserting a runtime generation', () => {
        const entry = resolveAgentCatalogProjection('claude', { enabledAgentIds: [] });

        expect(entry.identity).toEqual({ pluginId: 'happier.agent.claude', localId: 'claude' });
        expect(entry.connectedAccounts).toEqual(expect.arrayContaining([
            expect.objectContaining({
                service: { pluginId: 'happier.agent.claude', localId: 'claude-subscription' },
            }),
        ]));
        expect(entry.cli?.executable.binaryName).toBe('claude');
        expect(entry.projectionGeneration).toBeNull();
        expect(entry.installedPackage).toBeNull();
    });

    it('does not lend bundled declarations to a colliding external Agent or a missing dynamic contribution', () => {
        const external = resolveAgentCatalogProjection('claude', {
            enabledAgentIds: [],
            mergedProviderProjectionById: {
                claude: { agentId: 'claude', isBuiltIn: false, identity: { pluginId: 'acme.agent', localId: 'claude' } },
            },
        });
        expect(external.connectedAccounts).toEqual([]);
        expect(external.cli).toBeNull();
        const missing = resolveAgentCatalogProjection('acme.agent/claude', { enabledAgentIds: [] });
        expect(missing.identity).toBeNull();
        expect(missing.connectedAccounts).toEqual([]);
        expect(missing.cli).toBeNull();
    });

    it('keeps a current daemon row authoritative when it removes bundled declarative facts', () => {
        const entry = resolveAgentCatalogProjection('claude', {
            enabledAgentIds: [],
            mergedProviderProjectionById: {
                claude: {
                    agentId: 'claude',
                    isBuiltIn: true,
                    identity: { pluginId: 'happier.agent.claude', localId: 'claude' },
                    projectionGeneration: 7,
                    cli: null,
                    connectedAccounts: [],
                },
            },
        });
        expect(entry.connectedAccounts).toEqual([]);
        expect(entry.cli).toBeNull();
        expect(entry.projectionGeneration).toBe(7);
    });
});
