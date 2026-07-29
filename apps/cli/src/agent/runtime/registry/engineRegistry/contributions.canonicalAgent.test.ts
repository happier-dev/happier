import { describe, expect, it } from 'vitest';

import type {
    ResolvedAgentContribution,
    ResolvedAgentRuntimeContribution,
    ResolvedContributionRegistry,
} from '@/plugins/projection/registry/types';
import { resolveEngineRuntimeContribution } from './contributions';

describe('resolveEngineRuntimeContribution', () => {
    it('derives the executable view from the canonical Agent', () => {
        const agent: ResolvedAgentContribution = {
            id: 'acme',
            provenance: 'external',
            source: { kind: 'path' },
            pluginId: 'acme.plugin',
            definition: {
                kindVersion: 1,
                id: 'acme',
                ownedBackendIds: ['acme'],
            },
            richDefinition: {
                provenance: 'external',
                definition: {
                    id: 'acme',
                    title: 'Acme',
                    runtime: { kind: 'custom' },
                    primary: 'sessions',
                    capabilities: {
                        sessions: {
                            open: ['create'],
                            delivery: ['newTurn'],
                            cancel: true,
                            configuration: false,
                            compaction: { events: true },
                        },
                    },
                },
            },
        };
        const contributions = {
            agentDefinitionsById: new Map([[agent.id, agent]]),
        } satisfies Pick<
            ResolvedContributionRegistry,
            'agentDefinitionsById'
        >;

        const resolved = resolveEngineRuntimeContribution(contributions, 'acme');

        expect(resolved).toMatchObject({
            id: 'acme',
            agentId: 'acme',
            provenance: 'external',
            pluginId: 'acme.plugin',
            runtimeKind: 'custom',
        });
        expect(resolved).not.toHaveProperty('getRuntimeCore');
    });

    it('does not resolve a retired runtime-only projection without a canonical Agent', () => {
        const staleRuntime: ResolvedAgentRuntimeContribution = {
            id: 'orphan',
            agentId: 'orphan',
            provenance: 'first_party',
            source: { kind: 'bundled' },
            definition: {
                kindVersion: 1,
                id: 'orphan',
                agentId: 'orphan',
            },
            runtimeKind: 'legacy',
        };
        const contributions = {
            agentDefinitionsById: new Map(),
            agentRuntimeDefinitionsById: new Map([[staleRuntime.id, staleRuntime]]),
        };

        expect(resolveEngineRuntimeContribution(contributions, staleRuntime.id)).toBeNull();
    });
});
