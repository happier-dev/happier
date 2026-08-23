import { createPluginContributionIdentity } from '@happier-dev/protocol';
import { describe, expect, it, vi } from 'vitest';

import { ingestCanonicalPluginManifest } from '@/plugins/manifest/ingest';
import type {
    ResolvedActivationTarget,
    ResolvedProviderContribution,
} from '@/plugins/projection/registry/types';
import type { ContributionRuntimeRegistration } from '../../api/registrationRightsHost';
import { projectTargetProviderRuntimes } from './targetProviders';

type ProviderRuntimeRegistrationValue = Extract<
    ContributionRuntimeRegistration,
    { family: 'providers' }
>['value'];
type ManagedProviderRuntime = NonNullable<
    ProviderRuntimeRegistrationValue['managedRuntime']
>;

const start = vi.fn<ManagedProviderRuntime['start']>();
const managedRuntime = Object.freeze({ start }) satisfies ManagedProviderRuntime;
const runtime = Object.freeze({ managedRuntime }) satisfies ProviderRuntimeRegistrationValue;

function provider(input: Readonly<{
    pluginId: string;
    provenance: ResolvedProviderContribution['provenance'];
    source: ResolvedProviderContribution['source']['kind'];
    managed?: boolean;
    managedEndpointTemplateIds?: string[];
    contributedCatalogFormat?: string;
}>): ResolvedProviderContribution {
    return {
        provenance: input.provenance,
        source: { kind: input.source },
        pluginId: input.pluginId,
        identity: createPluginContributionIdentity({
            pluginId: input.pluginId,
            localId: 'gateway',
        }),
        definition: {
            v: 1,
            id: 'gateway',
            name: 'Gateway',
            kind: 'aggregator',
            endpointTemplates: [{
                id: 'api',
                protocol: 'openai-responses',
                baseUrl: 'https://example.test/v1',
                capabilities: {
                    streaming: 'supported',
                    toolRoundTrips: 'supported',
                    statefulResponses: 'unknown',
                    reasoningControls: 'supported',
                },
            }, {
                id: 'chat',
                protocol: 'openai-chat',
                baseUrl: 'https://example.test/chat',
                capabilities: {
                    streaming: 'supported',
                    toolRoundTrips: 'supported',
                    statefulResponses: 'unknown',
                    reasoningControls: 'supported',
                },
            }],
            catalog: input.contributedCatalogFormat
                ? {
                    source: 'probe' as const,
                    manualModelPolicy: 'allowed' as const,
                    probes: [{
                        endpointTemplateId: 'api',
                        path: '/v1/catalog',
                        parser: input.contributedCatalogFormat,
                    }],
                }
                : {
                    source: 'static' as const,
                    manualModelPolicy: 'allowed' as const,
                    staticModels: [{ id: 'example', name: 'Example' }],
                },
            ...(input.managed
                ? {
                    managedRuntime: {
                        kind: 'managed' as const,
                        endpointTemplateIds:
                            input.managedEndpointTemplateIds ?? ['api'],
                    },
                }
                : {}),
        },
    };
}

function activationTarget(
    contribution: ResolvedProviderContribution,
): ResolvedActivationTarget {
    const ingested = ingestCanonicalPluginManifest({
        schemaVersion: 2,
        id: contribution.pluginId,
        version: '1.0.0',
        displayName: contribution.definition.name,
        engines: { happier: '^0.2.0' },
        runtime: { apiVersion: 1 },
        entrypoints: { daemon: './daemon.mjs' },
        contributes: { providers: [contribution.definition] },
    }, { sourceProvenance: 'registryCustodied' });
    if (!ingested.ok) {
        throw new Error(ingested.diagnostics.map((entry) => entry.message).join('\n'));
    }
    return {
        provenance: contribution.provenance,
        source: contribution.source,
        pluginId: contribution.pluginId,
        manifestPath: `/plugins/${contribution.pluginId}/plugin.json`,
        daemonEntryPath: `/plugins/${contribution.pluginId}/daemon.mjs`,
        sourceSpec: {
            kind: 'path',
            locator: `/plugins/${contribution.pluginId}`,
            trustPolicy: 'local_trusted',
            installPolicy: 'link',
        },
        manifest: ingested.manifest,
    };
}

function registration(pluginId: string, generation = '9') {
    return {
        pluginId,
        generation,
        registration: {
            family: 'providers',
            localId: 'gateway',
            value: runtime,
        } satisfies ContributionRuntimeRegistration,
    };
}

describe('projectTargetProviderRuntimes', () => {
    it('projects the same public runtime outcome for bundled, development, and installed external Providers', () => {
        const providers = [
            provider({
                pluginId: 'acme.provider.bundled',
                provenance: 'first_party',
                source: 'bundled',
                managed: true,
            }),
            provider({
                pluginId: 'acme.provider.development',
                provenance: 'external',
                source: 'path',
                managed: true,
            }),
            provider({
                pluginId: 'acme.provider.installed',
                provenance: 'external',
                source: 'package',
                managed: true,
            }),
        ];
        const immutableGenerationIdsByPluginId = new Map(providers.map((entry) => [
            entry.pluginId,
            `immutable:${entry.pluginId}`,
        ]));

        const projected = projectTargetProviderRuntimes({
            providers,
            activationTargets: providers.map(activationTarget),
            targetRegistrations: providers.map((entry) => registration(entry.pluginId)),
            activationGeneration: '9',
            immutableGenerationIdsByPluginId,
            isRegistrationCurrent: () => true,
        }).providers;

        expect(projected.map((entry) => entry.managedRuntime)).toEqual(providers.map((entry) => (
            expect.objectContaining({
                runtime: managedRuntime,
                activationGeneration: '9',
                immutableGenerationId: `immutable:${entry.pluginId}`,
                isCurrent: expect.any(Function),
            })
        )));
        expect(projected.every((entry) => (
            !Object.hasOwn(entry.managedRuntime ?? {}, 'manifestDigest')
        ))).toBe(true);
        expect(projected.every((entry) => entry.managedRuntime?.isCurrent())).toBe(true);
    });

    it('leaves descriptor-only Providers without a runtime', () => {
        const descriptorOnly = provider({
            pluginId: 'acme.provider.descriptor',
            provenance: 'external',
            source: 'archive',
        });

        expect(projectTargetProviderRuntimes({
            providers: [descriptorOnly],
            activationTargets: [activationTarget(descriptorOnly)],
            targetRegistrations: [],
            activationGeneration: '9',
            immutableGenerationIdsByPluginId: new Map(),
            isRegistrationCurrent: () => true,
        }).providers[0]?.managedRuntime).toBeUndefined();
    });

    it('refuses a runtime without an exact managed declaration or immutable generation', () => {
        const descriptorOnly = provider({
            pluginId: 'acme.provider.descriptor',
            provenance: 'external',
            source: 'archive',
        });
        const withoutDeclaration = projectTargetProviderRuntimes({
            providers: [descriptorOnly],
            activationTargets: [activationTarget(descriptorOnly)],
            targetRegistrations: [registration(descriptorOnly.pluginId)],
            activationGeneration: '9',
            immutableGenerationIdsByPluginId: new Map([[descriptorOnly.pluginId, 'immutable:descriptor']]),
            isRegistrationCurrent: () => true,
        });
        expect(withoutDeclaration.providers[0]?.managedRuntime).toBeUndefined();
        expect(withoutDeclaration.diagnosticsByPluginId[descriptorOnly.pluginId]).toEqual([
            expect.objectContaining({
                code: 'plugin_activation_failed',
                message: expect.stringMatching(/managed declaration/i),
            }),
        ]);

        const managed = provider({
            pluginId: 'acme.provider.managed',
            provenance: 'external',
            source: 'marketplace',
            managed: true,
        });
        const withoutGeneration = projectTargetProviderRuntimes({
            providers: [managed],
            activationTargets: [activationTarget(managed)],
            targetRegistrations: [registration(managed.pluginId)],
            activationGeneration: '9',
            immutableGenerationIdsByPluginId: new Map(),
            isRegistrationCurrent: () => true,
        });
        expect(withoutGeneration.providers[0]?.managedRuntime).toBeUndefined();
        expect(withoutGeneration.diagnosticsByPluginId[managed.pluginId]).toEqual([
            expect.objectContaining({
                code: 'plugin_activation_failed',
                message: expect.stringMatching(/immutable generation/i),
            }),
        ]);
    });

    it('does not alias a retained P registration onto desired/current Q', () => {
        const managed = provider({
            pluginId: 'acme.provider.managed',
            provenance: 'external',
            source: 'package',
            managed: true,
        });
        const retainedRuntime = Object.freeze({
            managedRuntime: Object.freeze({
                start: vi.fn<ManagedProviderRuntime['start']>(),
            }),
        }) satisfies ProviderRuntimeRegistrationValue;
        let current = true;

        const projected = projectTargetProviderRuntimes({
            providers: [managed],
            activationTargets: [activationTarget(managed)],
            targetRegistrations: [{
                ...registration(managed.pluginId, '8'),
                registration: {
                    family: 'providers',
                    localId: 'gateway',
                    value: retainedRuntime,
                },
            }, registration(managed.pluginId, '9')],
            activationGeneration: '9',
            immutableGenerationIdsByPluginId: new Map([[managed.pluginId, 'immutable:Q']]),
            isRegistrationCurrent: (entry) => current && entry.generation === '9',
        }).providers;

        expect(projected[0]?.managedRuntime?.runtime).toBe(managedRuntime);
        expect(projected[0]?.managedRuntime?.immutableGenerationId).toBe('immutable:Q');
        expect(projected[0]?.managedRuntime?.isCurrent()).toBe(true);
        current = false;
        expect(projected[0]?.managedRuntime?.isCurrent()).toBe(false);
    });

    it('rejects current Q when its direct managed declaration differs from the exact activation target', () => {
        const providerDeclaration = provider({
            pluginId: 'acme.provider.current-q',
            provenance: 'external',
            source: 'package',
            managed: true,
            managedEndpointTemplateIds: ['api'],
        });
        const activationTargetDeclaration = provider({
            pluginId: providerDeclaration.pluginId,
            provenance: providerDeclaration.provenance,
            source: providerDeclaration.source.kind,
            managed: true,
            managedEndpointTemplateIds: ['chat'],
        });

        const projected = projectTargetProviderRuntimes({
            providers: [providerDeclaration],
            activationTargets: [activationTarget(activationTargetDeclaration)],
            targetRegistrations: [registration(providerDeclaration.pluginId)],
            activationGeneration: '9',
            immutableGenerationIdsByPluginId: new Map([
                [providerDeclaration.pluginId, 'immutable:Q'],
            ]),
            isRegistrationCurrent: () => true,
        });
        expect(projected.providers[0]?.managedRuntime).toBeUndefined();
        expect(projected.diagnosticsByPluginId[providerDeclaration.pluginId]).toEqual([
            expect.objectContaining({
                code: 'plugin_activation_failed',
                message: expect.stringMatching(/current activation target declaration/i),
            }),
        ]);
    });

    it('projects contributed catalog formats for an external Provider with no managed runtime', () => {
        const external = provider({
            pluginId: 'acme.provider.catalog-format',
            provenance: 'external',
            source: 'package',
            contributedCatalogFormat: 'acme-catalog-v3',
        });
        const parse = vi.fn(() => ({ models: [{ id: 'acme/one' }] }));

        const projected = projectTargetProviderRuntimes({
            providers: [external],
            activationTargets: [activationTarget(external)],
            targetRegistrations: [{
                ...registration(external.pluginId),
                registration: {
                    family: 'providers',
                    localId: 'gateway',
                    value: { catalogParsers: { 'acme-catalog-v3': parse } },
                },
            }],
            activationGeneration: '9',
            immutableGenerationIdsByPluginId: new Map([
                [external.pluginId, 'immutable:Q'],
            ]),
            isRegistrationCurrent: () => true,
        }).providers;

        expect(projected[0]?.managedRuntime).toBeUndefined();
        expect(projected[0]?.catalogParsers?.parsersByFormat['acme-catalog-v3']).toBe(parse);
        expect(projected[0]?.catalogParsers?.immutableGenerationId).toBe('immutable:Q');
        expect(projected[0]?.catalogParsers?.isCurrent()).toBe(true);
    });

    it('refuses a catalog format registration that does not implement its declaration', () => {
        const external = provider({
            pluginId: 'acme.provider.catalog-format-mismatch',
            provenance: 'external',
            source: 'package',
            contributedCatalogFormat: 'acme-catalog-v3',
        });

        const projected = projectTargetProviderRuntimes({
            providers: [external],
            activationTargets: [activationTarget(external)],
            targetRegistrations: [{
                ...registration(external.pluginId),
                registration: {
                    family: 'providers',
                    localId: 'gateway',
                    value: { catalogParsers: { 'other-format': vi.fn(() => ({ models: [] })) } },
                },
            }],
            activationGeneration: '9',
            immutableGenerationIdsByPluginId: new Map([
                [external.pluginId, 'immutable:Q'],
            ]),
            isRegistrationCurrent: () => true,
        });

        expect(projected.providers[0]?.catalogParsers).toBeUndefined();
        expect(projected.diagnosticsByPluginId[external.pluginId]).toEqual([
            expect.objectContaining({
                code: 'plugin_activation_failed',
                contribution: createPluginContributionIdentity({
                    pluginId: external.pluginId,
                    localId: 'gateway',
                }),
                message: expect.stringContaining(
                    'does not implement its declared catalog formats: '
                    + 'declared [acme-catalog-v3], registered [other-format]',
                ),
            }),
        ]);
    });

    it('normalizes a missing activation-target list before failing current Q closed', () => {
        const managed = provider({
            pluginId: 'acme.provider.missing-target-list',
            provenance: 'external',
            source: 'package',
            managed: true,
        });

        const projected = projectTargetProviderRuntimes({
            providers: [managed],
            activationTargets: undefined,
            targetRegistrations: [registration(managed.pluginId)],
            activationGeneration: '9',
            immutableGenerationIdsByPluginId: new Map([
                [managed.pluginId, 'immutable:Q'],
            ]),
            isRegistrationCurrent: () => true,
        });
        expect(projected.providers[0]?.managedRuntime).toBeUndefined();
        expect(projected.diagnosticsByPluginId[managed.pluginId]).toEqual([
            expect.objectContaining({
                code: 'plugin_activation_failed',
                message: expect.stringMatching(/no exact current activation target/i),
            }),
        ]);
    });

    // P0 regression: one mis-authored Provider plugin used to throw out of this
    // global projection, so the whole plugin runtime registry became unavailable
    // and every correctly-authored Provider died with it.
    it('isolates one mis-authored Provider plugin instead of failing the whole projection', () => {
        const good = provider({
            pluginId: 'good.plugin',
            provenance: 'external',
            source: 'package',
            contributedCatalogFormat: 'good-catalog-v1',
        });
        const bad = provider({
            pluginId: 'bad.plugin',
            provenance: 'external',
            source: 'package',
            contributedCatalogFormat: 'bad-catalog-v3',
        });
        const goodParse = vi.fn(() => ({ models: [{ id: 'good/one' }] }));
        const badParse = vi.fn(() => ({ models: [] }));

        const projected = projectTargetProviderRuntimes({
            providers: [good, bad],
            activationTargets: [good, bad].map(activationTarget),
            targetRegistrations: [{
                ...registration(good.pluginId),
                registration: {
                    family: 'providers',
                    localId: 'gateway',
                    value: { catalogParsers: { 'good-catalog-v1': goodParse } },
                },
            }, {
                ...registration(bad.pluginId),
                registration: {
                    family: 'providers',
                    localId: 'gateway',
                    // One author typo: declares 'bad-catalog-v3', registers 'bad-catalog-v4'.
                    value: { catalogParsers: { 'bad-catalog-v4': badParse } },
                },
            }],
            activationGeneration: '9',
            immutableGenerationIdsByPluginId: new Map([
                [good.pluginId, 'immutable:good'],
                [bad.pluginId, 'immutable:bad'],
            ]),
            isRegistrationCurrent: () => true,
        });

        expect(projected.providers).toHaveLength(2);
        expect(projected.providers[0]?.catalogParsers?.parsersByFormat['good-catalog-v1'])
            .toBe(goodParse);
        expect(projected.providers[0]?.catalogParsers?.isCurrent()).toBe(true);
        expect(projected.providers[1]?.catalogParsers).toBeUndefined();
        expect(projected.diagnosticsByPluginId[good.pluginId]).toBeUndefined();
        expect(projected.diagnosticsByPluginId[bad.pluginId]).toEqual([
            expect.objectContaining({
                code: 'plugin_activation_failed',
                contribution: createPluginContributionIdentity({
                    pluginId: bad.pluginId,
                    localId: 'gateway',
                }),
                message: expect.stringContaining(
                    "Provider catalog format registration 'bad.plugin/gateway' does not implement "
                    + 'its declared catalog formats: declared [bad-catalog-v3], '
                    + 'registered [bad-catalog-v4]',
                ),
            }),
        ]);
    });

    it('fails one Provider contribution closed on both arms rather than half-projecting it', () => {
        const managedAndFormats = provider({
            pluginId: 'acme.provider.both-arms',
            provenance: 'external',
            source: 'package',
            managed: true,
            contributedCatalogFormat: 'acme-catalog-v3',
        });

        const projected = projectTargetProviderRuntimes({
            providers: [managedAndFormats],
            activationTargets: [activationTarget(managedAndFormats)],
            targetRegistrations: [{
                ...registration(managedAndFormats.pluginId),
                registration: {
                    family: 'providers',
                    localId: 'gateway',
                    value: {
                        managedRuntime,
                        catalogParsers: { 'typo-format': vi.fn(() => ({ models: [] })) },
                    },
                },
            }],
            activationGeneration: '9',
            immutableGenerationIdsByPluginId: new Map([
                [managedAndFormats.pluginId, 'immutable:both'],
            ]),
            isRegistrationCurrent: () => true,
        });

        expect(projected.providers[0]?.managedRuntime).toBeUndefined();
        expect(projected.providers[0]?.catalogParsers).toBeUndefined();
        expect(projected.diagnosticsByPluginId[managedAndFormats.pluginId]).toHaveLength(1);
    });
});
