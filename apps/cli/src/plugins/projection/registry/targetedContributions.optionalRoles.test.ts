import { describe, expect, it } from 'vitest';

import {
    createPluginContributionIdentity,
    type PluginTargetedContributionV1,
} from '@happier-dev/protocol';
import { definePlugin } from '@happier-dev/plugin-sdk';
import { defineContributionProtocol } from '@happier-dev/plugin-sdk/contributions';
import { defineProtocolObject } from '@happier-dev/plugin-sdk/protocol';
import { defineDeferredDeclarationField } from '@happier-dev/protocol/plugins/contributions/deferredDeclarationFields';

import { readCanonicalPluginManifest } from '@/plugins/manifest/normalize';
import { createPluginRuntimeOccurrenceId } from '@/plugins/runtime/runtimeSlots';
import { resolveAdmittedTargetedContributions } from './targetedContributions';
import type {
    ResolvedPluginContributionPointDeclaration,
    ResolvedTargetedPluginContributionDeclaration,
} from './types';

const targetPluginId = 'examples.target';
const contributorPluginId = 'examples.contributor';
const pointId = 'providers';
const protocol = { id: 'provider', version: 1 } as const;
const targetOccurrenceId = createPluginRuntimeOccurrenceId(targetPluginId);
const contributorOccurrenceId = createPluginRuntimeOccurrenceId(contributorPluginId);

/** Builds a canonical target manifest declaration for the admission owner. */
function point(params: Readonly<{ optionalSurface?: boolean }> = {}): ResolvedPluginContributionPointDeclaration {
    const target = definePlugin({
        id: targetPluginId,
        version: '0.1.0',
        contributionPoints: {
            [pointId]: defineContributionProtocol({
                id: protocol.id,
                version: protocol.version,
                operations: params.optionalSurface === true ? {} : {
                    setup: {
                        required: false,
                        input: { kind: 'contributorDefined' },
                        resultSchema: defineProtocolObject({}, { policy: 'closed' }),
                        action: { surfaces: ['plugin'], dangerLevel: 'safe' },
                    },
                },
                ...(params.optionalSurface === true
                    ? {
                        surfaces: {
                            detail: {
                                required: false,
                                inputSchema: defineProtocolObject({}, { policy: 'closed' }),
                                presentation: 'content',
                            },
                        },
                    }
                    : {}),
            }).point({ maxContributionsPerContributor: 1 }),
        },
    });
    const definition = readCanonicalPluginManifest(target.manifest)
        ?.contributes?.pluginContributionPoints?.find((candidate) => candidate.id === pointId);
    if (!definition) {
        throw new Error('Expected one canonical target contribution point');
    }
    return {
        provenance: 'external',
        source: { kind: 'path' },
        pluginId: targetPluginId,
        identity: createPluginContributionIdentity({ pluginId: targetPluginId, localId: pointId }),
        manifestPath: '/plugins/target/.happier-plugin/plugin.json',
        definition,
    };
}

function contribution(
    definition: PluginTargetedContributionV1,
): ResolvedTargetedPluginContributionDeclaration {
    return {
        provenance: 'external',
        source: { kind: 'path' },
        pluginId: contributorPluginId,
        identity: createPluginContributionIdentity({ pluginId: contributorPluginId, localId: definition.id }),
        manifestPath: '/plugins/contributor/.happier-plugin/plugin.json',
        definition,
    };
}

function admit(params: Readonly<{
    point: ResolvedPluginContributionPointDeclaration;
    contribution: ResolvedTargetedPluginContributionDeclaration;
}>) {
    return resolveAdmittedTargetedContributions({
        pluginContributionPoints: [params.point],
        targetedPluginContributions: [params.contribution],
        actions: [],
        uiRenderersV2: [],
        occurrenceIdsByPluginId: {
            [targetPluginId]: targetOccurrenceId,
            [contributorPluginId]: contributorOccurrenceId,
        },
    });
}

describe('targeted contribution optional-role admission', () => {
    it('rejects an unknown optional operation whose same-contributor Action is absent', () => {
        const result = admit({
            point: point(),
            contribution: contribution({
                id: 'provider-a',
                target: { pluginId: targetPluginId, pointId },
                protocol,
                operations: { futureSetup: 'future-action-not-installed' },
            }),
        });

        expect(result.diagnosticsByPluginId[contributorPluginId]?.map((diagnostic) => diagnostic.code))
            .toEqual(['action_not_found']);
        expect(result.read({ targetPluginId, pointId, protocol }))
            .toMatchObject({
                target: { occurrenceId: targetOccurrenceId },
                contributions: [],
            });
    });

    it('rejects an unknown optional surface whose same-contributor renderer is absent', () => {
        const result = admit({
            point: point({ optionalSurface: true }),
            contribution: contribution({
                id: 'provider-a',
                target: { pluginId: targetPluginId, pointId },
                protocol,
                operations: {},
                surfaces: { futureDetail: { renderer: 'future-renderer-not-installed' } },
            }),
        });

        expect(result.diagnosticsByPluginId[contributorPluginId]?.map((diagnostic) => diagnostic.code))
            .toEqual(['renderer_not_found']);
        expect(result.read({ targetPluginId, pointId, protocol }))
            .toMatchObject({
                target: { occurrenceId: targetOccurrenceId },
                contributions: [],
            });
    });

    it('admits an operation whose Action schemas are unread deferred declaration fields without reading them', () => {
        // Bundled Action schemas are deferred JSON Schema objects; admission only needs their shape.
        let reads = 0;
        const definition: Record<string, unknown> = { id: 'setup-action', dangerLevel: 'safe', contributionSurfaces: ['plugin'] };
        for (const key of ['inputSchema', 'outputSchema']) {
            defineDeferredDeclarationField(definition, key, () => { reads += 1; return { type: 'object' }; }, { jsonObject: true });
        }
        const result = resolveAdmittedTargetedContributions({
            pluginContributionPoints: [point()],
            targetedPluginContributions: [contribution({
                id: 'provider-a', target: { pluginId: targetPluginId, pointId }, protocol, operations: { setup: 'setup-action' },
            })],
            actions: [{ pluginId: contributorPluginId, definition } as unknown as Parameters<typeof resolveAdmittedTargetedContributions>[0]['actions'][number]],
            uiRenderersV2: [],
            occurrenceIdsByPluginId: { [targetPluginId]: targetOccurrenceId, [contributorPluginId]: contributorOccurrenceId },
        });

        expect(result.diagnosticsByPluginId[contributorPluginId]).toBeUndefined();
        expect(result.read({ targetPluginId, pointId, protocol })?.contributions.map((admitted) => admitted.operations.map((operation) => operation.role)))
            .toEqual([['setup']]);
        expect(reads).toBe(0);
    });
});
