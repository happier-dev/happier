import { describe, expect, it } from 'vitest';

import type { PluginProjectionEntry } from '@/agents/backendCatalog/daemonContributionRegistryProjectionAdapters';
import {
    resolveAgentDetailExternalSessionsBinding,
    resolveAgentDetailPluginSettingsProjection,
    resolveAgentDetailQualifiedIdentity,
} from './resolveAgentDetailSettingsProjection';

const IDENTITY_ONE = { pluginId: 'acme.one', localId: 'helper' } as const;
const IDENTITY_TWO = { pluginId: 'acme.two', localId: 'helper' } as const;

function agentSettingsGroup(identity: Readonly<{ pluginId: string; localId: string }>, label: string) {
    return {
        target: {
            kind: 'agent' as const,
            agent: { pluginId: identity.pluginId, localId: identity.localId },
        },
        label,
    };
}

function pluginEntry(pluginId: string, groups: ReturnType<typeof agentSettingsGroup>[]): PluginProjectionEntry {
    return {
        pluginId,
        immutableGenerationId: null,
        title: pluginId,
        description: null,
        version: null,
        enabled: true,
        generation: null,
        generationLabel: null,
        status: null,
        provenance: null,
        diagnostics: [],
        actions: [],
        resources: [],
        editableSettingsGroups: groups,
    } as unknown as PluginProjectionEntry;
}

describe('resolveAgentDetailQualifiedIdentity', () => {
    it('prefers the qualified route identity over the resolved projection identity', () => {
        expect(resolveAgentDetailQualifiedIdentity({
            routeQualifiedAgent: IDENTITY_ONE,
            projectionIdentity: IDENTITY_TWO,
        })).toEqual(IDENTITY_ONE);
    });

    it('falls back to the resolved projection identity for an unqualified route', () => {
        expect(resolveAgentDetailQualifiedIdentity({
            routeQualifiedAgent: null,
            projectionIdentity: IDENTITY_TWO,
        })).toEqual(IDENTITY_TWO);
        expect(resolveAgentDetailQualifiedIdentity({
            routeQualifiedAgent: null,
            projectionIdentity: null,
        })).toBeNull();
    });
});

describe('resolveAgentDetailPluginSettingsProjection', () => {
    it('never resolves a same-localId Agent group from another plugin', () => {
        // Both installed plugins declare an Agent with localId `helper`. The
        // exact identity names acme.two, so the localId-only match the screen
        // used before would have returned whichever plugin projected first.
        const projection = resolveAgentDetailPluginSettingsProjection({
            pluginProjectionById: {
                'acme.one': pluginEntry('acme.one', [agentSettingsGroup(IDENTITY_ONE, 'one settings')]),
                'acme.two': pluginEntry('acme.two', [agentSettingsGroup(IDENTITY_TWO, 'two settings')]),
            },
            identity: IDENTITY_TWO,
        });

        expect(projection?.pluginId).toBe('acme.two');
        expect(projection?.editableSettingsGroups).toHaveLength(1);
        expect(projection?.editableSettingsGroups[0]).toMatchObject({ label: 'two settings' });
    });

    it('resolves nothing without an exact identity', () => {
        expect(resolveAgentDetailPluginSettingsProjection({
            pluginProjectionById: {
                'acme.one': pluginEntry('acme.one', [agentSettingsGroup(IDENTITY_ONE, 'one settings')]),
            },
            identity: null,
        })).toBeNull();
    });
});

describe('resolveAgentDetailExternalSessionsBinding', () => {
    function projectionWithContributions(contributions: readonly Readonly<{
        pluginId: string;
        localId: string;
    }>[]) {
        return {
            generation: 4,
            agentsById: {},
            contributionIntrospection: {
                contributions: contributions.map(({ pluginId, localId }) => ({
                    progression: { merged: true },
                    projection: { state: 'projected' },
                    contribution: { kind: 'localId', family: 'agents', pluginId, localId },
                })),
            },
        } as unknown as Parameters<typeof resolveAgentDetailExternalSessionsBinding>[0]['projection'];
    }

    it('binds the exact qualified identity when two plugins declare one localId', () => {
        // The previous localId-only scan found two unique candidates and
        // silently dropped the binding; the qualified identity binds it.
        const binding = resolveAgentDetailExternalSessionsBinding({
            projection: projectionWithContributions([
                { pluginId: 'acme.one', localId: 'helper' },
                { pluginId: 'acme.two', localId: 'helper' },
            ]),
            agentId: 'helper',
            identity: IDENTITY_TWO,
        });

        expect(binding).not.toBeNull();
        expect(binding?.agent).toEqual(IDENTITY_TWO);
        expect(binding?.generation).toBe(4);
        expect(binding?.browseAvailable).toBe(false);
    });

    it('refuses when the exact identity has no projected agent contribution', () => {
        expect(resolveAgentDetailExternalSessionsBinding({
            projection: projectionWithContributions([
                { pluginId: 'acme.one', localId: 'helper' },
            ]),
            agentId: 'helper',
            identity: IDENTITY_TWO,
        })).toBeNull();
    });

    it('does not accept a live binding for another plugin with the same local id', () => {
        const projection = {
            generation: 4,
            agentsById: {
                helper: {
                    externalSessions: {
                        agent: IDENTITY_ONE,
                        generation: 4,
                    },
                },
            },
            contributionIntrospection: { contributions: [] },
        } as unknown as Parameters<typeof resolveAgentDetailExternalSessionsBinding>[0]['projection'];

        expect(resolveAgentDetailExternalSessionsBinding({
            projection,
            agentId: 'helper',
            identity: IDENTITY_TWO,
        })).toBeNull();
    });
});
