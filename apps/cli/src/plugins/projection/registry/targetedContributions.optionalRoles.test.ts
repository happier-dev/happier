import { describe, expect, it } from 'vitest';

import {
    createPluginContributionIdentity,
    type PluginContributionPointV1,
    type PluginTargetedContributionV1,
} from '@happier-dev/protocol';

import { resolveAdmittedTargetedContributions } from './targetedContributions';
import type {
    ResolvedPluginContributionPointDeclaration,
    ResolvedTargetedPluginContributionDeclaration,
} from './types';

const targetPluginId = 'examples.target';
const contributorPluginId = 'examples.contributor';
const pointId = 'providers';
const protocol = { id: 'provider', version: 1 } as const;

function point(
    operations: PluginContributionPointV1['protocols'][number]['operations'],
    surfaces?: PluginContributionPointV1['protocols'][number]['surfaces'],
): ResolvedPluginContributionPointDeclaration {
    const definition: PluginContributionPointV1 = {
        id: pointId,
        maxContributionsPerContributor: 1,
        protocols: [{
            ...protocol,
            operations,
            ...(surfaces === undefined ? {} : { surfaces }),
        }],
    };
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
        immutableGenerationIdsByPluginId: {
            [targetPluginId]: 'immutable-target-a',
            [contributorPluginId]: 'immutable-contributor-a',
        },
    });
}

describe('targeted contribution optional-role admission', () => {
    it('rejects an unknown optional operation whose same-contributor Action is absent', () => {
        const result = admit({
            point: point({
                setup: {
                    required: false,
                    input: { kind: 'contributorDefined' },
                    resultSchema: { type: 'object' },
                    action: { surface: 'plugin', dangerLevel: 'safe' },
                },
            }),
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
                target: { immutableGenerationId: 'immutable-target-a' },
                contributions: [],
            });
    });

    it('rejects an unknown optional surface whose same-contributor renderer is absent', () => {
        const result = admit({
            point: point({}, {
                detail: {
                    required: false,
                    inputSchema: { type: 'object' },
                    presentation: 'content',
                },
            }),
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
                target: { immutableGenerationId: 'immutable-target-a' },
                contributions: [],
            });
    });
});
