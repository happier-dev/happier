import { readFileSync } from 'node:fs';

import {
    getAgentCliRuntimeSpec,
    getAllAgentDefinitionContracts,
    isBundledAgentId,
} from '@happier-dev/agents';
import { createPluginContributionIdentity } from '@happier-dev/protocol';
import { describe, expect, it } from 'vitest';

import * as builtInAgentProjection from './agents';
import { projectBuiltInAgents } from './agents';
import type { ResolvedAgentContribution } from '../types';

function manifestAgents(): readonly ResolvedAgentContribution[] {
    return getAllAgentDefinitionContracts().map((definition) => {
        if (!isBundledAgentId(definition.id)) {
            throw new Error(`Unexpected non-canonical built-in Agent '${definition.id}'`);
        }
        return {
            id: definition.id,
            provenance: 'first_party',
            source: { kind: 'bundled' },
            definition: { kindVersion: 1, id: definition.id, ownedBackendIds: [] },
            runtimeSpec: getAgentCliRuntimeSpec(definition.id),
            richDefinition: {
                provenance: 'first_party',
                definition: {
                    id: definition.id,
                    title: definition.id,
                    runtime: { kind: 'custom' },
                    primary: 'sessions',
                    capabilities: {
                        sessions: {
                            open: ['create'],
                            delivery: ['newTurn'],
                            cancel: true,
                        },
                    },
                },
            },
            pluginId: `happier.agent.${definition.id.toLowerCase()}`,
            manifestPath: `bundled:happier.agent.${definition.id.toLowerCase()}`,
            daemonEntryPath: `@happier-dev/plugins-${definition.id.toLowerCase()}`,
            sourceSpec: {
                kind: 'bundled',
                locator: `@happier-dev/plugins-${definition.id.toLowerCase()}`,
                trustPolicy: 'local_trusted',
                installPolicy: 'link',
            },
        };
    });
}

describe('built-in Agent projection overlays', () => {
    it('does not publish a parallel built-in Agent runtime projection', () => {
        expect(builtInAgentProjection).not.toHaveProperty('projectBuiltInAgentRuntimes');
    });

    it('builds the bundled session command through the canonical catalog-entry hook owner', () => {
        const source = readFileSync(new URL('./agents.ts', import.meta.url), 'utf8');

        expect(source).toMatch(/createAgentRuntimeCatalogEntryHooks/);
        expect(source).not.toMatch(/runBackendSessionCliCommand/);
    });

    it('overlays host catalog facts without replacing manifest ownership metadata', () => {
        const manifests = manifestAgents();
        const first = manifests[0]!;
        const agents = projectBuiltInAgents({
            manifestAgents: manifests,
            implementationBindings: [{
                identity: createPluginContributionIdentity({
                    pluginId: first.pluginId!,
                    localId: first.id,
                }),
                implementationOwnerId: first.id,
                registrationFamily: 'agents',
                implementation: () => ({}),
            }],
        });
        expect(agents.map((entry) => entry.id)).toEqual(
            getAllAgentDefinitionContracts().map((entry) => entry.id),
        );
        expect(agents[0]).toMatchObject({
            pluginId: first.pluginId,
            provenance: 'first_party',
            source: { kind: 'bundled' },
            richDefinition: { provenance: 'first_party' },
        });
        expect(agents[0]?.catalogEntry?.getCliCommandHandler).toBeTypeOf('function');
    });

    it('fails closed when a canonical Agent lacks one manifest owner', () => {
        expect(() => projectBuiltInAgents({
            manifestAgents: manifestAgents().slice(1),
            implementationBindings: [],
        })).toThrow(/Missing bundled manifest or catalog definition/);
    });

    it('fails closed when a bundled manifest owner lacks projected CLI metadata', () => {
        const manifests = manifestAgents();
        const first = manifests[0]!;
        expect(() => projectBuiltInAgents({
            manifestAgents: [{
                ...first,
                runtimeSpec: null,
            }, ...manifests.slice(1)],
            implementationBindings: [],
        })).toThrow(/Missing bundled manifest CLI metadata/);
    });

    it('maps a manifest-local Agent id to its canonical implementation owner', () => {
        const manifests = manifestAgents().map((manifest) => manifest.id === 'ohMyPi'
            ? {
                ...manifest,
                id: 'ohmypi',
                definition: { ...manifest.definition, id: 'ohmypi' },
            }
            : manifest);
        const owner = manifests.find((manifest) => manifest.id === 'ohmypi')!;

        const agents = projectBuiltInAgents({
            manifestAgents: manifests,
            implementationBindings: [{
                identity: createPluginContributionIdentity({
                    pluginId: owner.pluginId!,
                    localId: 'ohmypi',
                }),
                implementationOwnerId: 'ohMyPi',
                registrationFamily: 'agents',
                implementation: () => ({}),
            }],
        });
        const projectedOwner = agents.find((agent) => agent.id === 'ohMyPi');

        expect(projectedOwner).toMatchObject({
            id: 'ohMyPi',
            pluginId: owner.pluginId,
            definition: { id: 'ohMyPi' },
        });
        expect(projectedOwner?.richDefinition?.definition.id).toBe('ohMyPi');
    });
});
