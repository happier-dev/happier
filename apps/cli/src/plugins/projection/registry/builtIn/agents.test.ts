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
            catalogEntry: {
                id: definition.id,
                cliSubcommand: definition.id,
                vendorResumeSupport: 'unsupported',
            },
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

        expect(source).not.toMatch(/createAgentRuntimeCatalogEntryHooks/);
        expect(source).not.toMatch(/runBackendSessionCliCommand/);
        expect(source).not.toMatch(/getAllAgentCatalogDefinitions/);
        expect(source).not.toMatch(/core\.cliSubcommand/);
        expect(source).not.toMatch(/core\.resume\.vendorResume/);
    });

    it('uses registration bindings only to join manifest identity to canonical Agent identity', () => {
        const manifests = manifestAgents();
        const pi = manifests.find((entry) => entry.id === 'pi')!;
        const agents = projectBuiltInAgents({
            manifestAgents: manifests,
            registrationBindings: [{
                identity: createPluginContributionIdentity({
                    pluginId: pi.pluginId!,
                    localId: pi.id,
                }),
                implementationOwnerId: pi.id,
                registrationFamily: 'agents',
            }],
        });

        expect(agents.find((entry) => entry.id === 'pi')).toMatchObject({
            pluginId: pi.pluginId,
            richDefinition: { provenance: 'first_party' },
        });
        expect(agents.find((entry) => entry.id === 'pi')?.catalogEntry)
            .not.toHaveProperty('verifyResumeReachable');
    });

    it('keeps a bundled public manifest Agent even when no private compatibility contract names it', () => {
        const manifests = manifestAgents();
        const template = manifests[0]!;
        const manifestOnly: ResolvedAgentContribution = {
            ...template,
            id: 'manifest-only',
            identity: createPluginContributionIdentity({
                pluginId: 'happier.agent.manifest-only',
                localId: 'manifest-only',
            }),
            pluginId: 'happier.agent.manifest-only',
            definition: {
                kindVersion: 1,
                id: 'manifest-only',
                ownedBackendIds: [],
            },
            runtimeSpec: {
                ...template.runtimeSpec!,
                id: 'manifest-only',
            },
            catalogEntry: {
                ...template.catalogEntry!,
                id: 'manifest-only',
                cliSubcommand: 'manifest-only',
            },
            richDefinition: {
                provenance: 'first_party',
                definition: {
                    ...template.richDefinition!.definition,
                    id: 'manifest-only',
                    title: 'Manifest-only Agent',
                },
            },
        };

        const agents = projectBuiltInAgents({
            manifestAgents: [...manifests, manifestOnly],
            registrationBindings: [{
                identity: manifestOnly.identity!,
                implementationOwnerId: 'manifest-only',
                registrationFamily: 'agents',
            }],
        });

        expect(agents.find((entry) => entry.id === 'manifest-only')).toMatchObject({
            pluginId: 'happier.agent.manifest-only',
            provenance: 'first_party',
            richDefinition: {
                provenance: 'first_party',
                definition: { id: 'manifest-only' },
            },
        });
    });

    it('joins host identity facts without replacing public manifest catalog facts', () => {
        const manifests = manifestAgents();
        const first = manifests[0]!;
        const authored = {
            ...first,
            catalogEntry: {
                ...first.catalogEntry!,
                cliSubcommand: 'manifest-authored-command',
                vendorResumeSupport: 'experimental' as const,
            },
        };
        const agents = projectBuiltInAgents({
            manifestAgents: [authored, ...manifests.slice(1)],
            registrationBindings: [{
                identity: createPluginContributionIdentity({
                    pluginId: authored.pluginId!,
                    localId: authored.id,
                }),
                implementationOwnerId: authored.id,
                registrationFamily: 'agents',
            }],
        });
        expect(agents.map((entry) => entry.id)).toEqual(
            getAllAgentDefinitionContracts().map((entry) => entry.id),
        );
        expect(agents[0]).toMatchObject({
            pluginId: authored.pluginId,
            provenance: 'first_party',
            source: { kind: 'bundled' },
            richDefinition: { provenance: 'first_party' },
            catalogEntry: {
                cliSubcommand: 'manifest-authored-command',
                vendorResumeSupport: 'experimental',
            },
        });
        expect(agents[0]?.catalogEntry?.getCliCommandHandler).toBeTypeOf('function');
    });

    it('does not synthesize a bundled Agent from a private compatibility contract', () => {
        const manifests = manifestAgents().slice(1);
        expect(projectBuiltInAgents({
            manifestAgents: manifests,
            registrationBindings: [],
        }).map((agent) => agent.id)).toEqual(manifests.map((agent) => agent.id));
    });

    it('fails closed when an executable bundled registration lacks its public manifest owner', () => {
        const manifests = manifestAgents();
        const missing = manifests[0]!;
        expect(() => projectBuiltInAgents({
            manifestAgents: manifests.slice(1),
            registrationBindings: [{
                identity: createPluginContributionIdentity({
                    pluginId: missing.pluginId!,
                    localId: missing.id,
                }),
                implementationOwnerId: missing.id,
                registrationFamily: 'agents',
            }],
        })).toThrow(/Missing bundled manifest/);
    });

    it('fails closed when a bundled manifest owner lacks projected CLI metadata', () => {
        const manifests = manifestAgents();
        const first = manifests[0]!;
        expect(() => projectBuiltInAgents({
            manifestAgents: [{
                ...first,
                runtimeSpec: null,
            }, ...manifests.slice(1)],
            registrationBindings: [],
        })).toThrow(/Missing bundled manifest CLI metadata/);
    });

    it('fails closed when a bundled manifest owner lacks its catalog projection', () => {
        const manifests = manifestAgents();
        const first = manifests[0]!;
        expect(() => projectBuiltInAgents({
            manifestAgents: [{
                ...first,
                catalogEntry: null,
            }, ...manifests.slice(1)],
            registrationBindings: [],
        })).toThrow(/Missing bundled manifest catalog projection/);
    });

    it('maps a manifest-local Agent id to its canonical implementation owner', () => {
        const manifests = manifestAgents().map((manifest) => manifest.id === 'ohMyPi'
            ? {
                ...manifest,
                id: 'ohmypi',
                definition: { ...manifest.definition, id: 'ohmypi' },
                catalogEntry: manifest.catalogEntry
                    ? { ...manifest.catalogEntry, id: 'ohmypi', cliSubcommand: 'ohmypi' }
                    : null,
            }
            : manifest);
        const owner = manifests.find((manifest) => manifest.id === 'ohmypi')!;

        const agents = projectBuiltInAgents({
            manifestAgents: manifests,
            registrationBindings: [{
                identity: createPluginContributionIdentity({
                    pluginId: owner.pluginId!,
                    localId: 'ohmypi',
                }),
                implementationOwnerId: 'ohMyPi',
                registrationFamily: 'agents',
            }],
        });
        const projectedOwner = agents.find((agent) => agent.id === 'ohMyPi');

        expect(projectedOwner).toMatchObject({
            id: 'ohMyPi',
            pluginId: owner.pluginId,
            definition: { id: 'ohMyPi' },
            catalogEntry: { id: 'ohMyPi', cliSubcommand: 'ohmypi' },
        });
        expect(projectedOwner?.richDefinition?.definition.id).toBe('ohMyPi');
    });
});
