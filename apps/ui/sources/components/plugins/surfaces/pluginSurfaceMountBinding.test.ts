import { describe, expect, it } from 'vitest';

import {
    ComposerSurfaceMountBindingV1Schema,
    normalizePluginUiDestinationBindingV1,
    type PluginUiDestinationBindingV1,
    type PluginUiTargetedContributionSurfaceV1,
} from '@happier-dev/protocol/plugins/ui';
import type {
    DaemonContributionRegistryProjectionAutomationEligibleEventSetupSurfaceV1,
    DaemonPluginUiComposerSurfaceCatalogEntryV1,
    DaemonPluginUiTargetedSurfaceMountV1,
} from '@happier-dev/protocol';

import {
    createPluginSurfaceComposerMountContext,
    createPluginSurfaceDestinationMountContext,
    createPluginSurfaceEphemeralMountContext,
    createPluginSurfaceTargetedMountContext,
    readPluginSurfaceComposerMountBinding,
    readPluginSurfaceEphemeralMountBinding,
    readPluginSurfaceMountBinding,
    readPluginSurfaceTargetedMountBinding,
} from './pluginSurfaceMountBinding';

function eventSetupSurface(
    renderer: Readonly<Record<string, unknown>>,
): DaemonContributionRegistryProjectionAutomationEligibleEventSetupSurfaceV1 {
    const pluginId = 'acme.events';
    const localId = 'repository-picker';
    return {
        contribution: { pluginId, localId: 'repository-pushed' },
        immutableGenerationId: 'events-generation-a',
        projectionGeneration: 31,
        rendererChain: [{ pluginId, localId }],
        selectedRenderer: {
            identity: { pluginId, localId },
            renderer,
            availability: { state: 'available', reason: 'available', diagnostics: [] },
        },
        executionOrigin: {
            serverIdentityId: 'srv_acme',
            materializationRef: {
                machineId: 'machine-events',
                materializationId: 'events-install-a',
                pluginId,
            },
        },
        resourceCapability: { readable: true, dynamic: true },
        contributorTargetedContributions: {
            target: { pluginId, immutableGenerationId: 'events-generation-a' },
            points: [],
        },
    } as DaemonContributionRegistryProjectionAutomationEligibleEventSetupSurfaceV1;
}

function destinationBinding(): PluginUiDestinationBindingV1 {
    const binding = normalizePluginUiDestinationBindingV1({
        pluginId: 'acme.reviews',
        destinationId: 'triage',
        rendererId: 'review-panel',
        container: 'rightPane',
        target: { kind: 'session', sessionIdPath: '/sessionId' },
    });
    if (!binding) throw new Error('fixture destination binding must be admitted');
    return binding;
}

const targetedSurfaceHandle = {
    point: {
        pointId: 'triage-details',
        protocol: { id: 'triage-source', version: 1 },
    },
    contributor: {
        pluginId: 'acme.source',
        contributionId: 'pull-request-detail',
        immutableGenerationId: 'source-generation-a',
    },
    role: 'detail',
    presentation: 'content',
} as const satisfies PluginUiTargetedContributionSurfaceV1;

function targetedMount(): DaemonPluginUiTargetedSurfaceMountV1 {
    return {
        kind: 'targetedSurface',
        target: {
            pluginId: 'acme.reviews',
            immutableGenerationId: 'reviews-generation-a',
        },
        ...targetedSurfaceHandle,
        inputSchema: { type: 'object' },
        rendererChain: [{ pluginId: 'acme.source', localId: 'pull-request-detail-view' }],
        selectedRenderer: {
            identity: { pluginId: 'acme.source', localId: 'pull-request-detail-view' },
            renderer: {
                kind: 'declarative',
                contributionId: 'pull-request-detail-view',
                model: { visible: true },
            },
            availability: { state: 'available', reason: 'available', diagnostics: [] },
        },
        executionOrigin: {
            serverIdentityId: 'srv_acme',
            materializationRef: {
                machineId: 'machine-source',
                materializationId: 'source-install-a',
                pluginId: 'acme.source',
            },
        },
        resourceCapability: { readable: true, dynamic: true },
        contributorTargetedContributions: {
            target: {
                pluginId: 'acme.source',
                immutableGenerationId: 'source-generation-a',
            },
            points: [],
        },
    };
}

function composerSurfaceMount() {
    return ComposerSurfaceMountBindingV1Schema.parse({
        kind: 'composer',
        contribution: { pluginId: 'acme.review', localId: 'review-summary' },
        immutableGenerationId: 'review-generation-a',
        projectionGeneration: 17,
        role: 'region',
        selectedRenderer: { pluginId: 'acme.review', localId: 'review-summary-view' },
        rendererChain: [{ pluginId: 'acme.review', localId: 'review-summary-view' }],
        composer: { kind: 'session', sessionId: 'session-a' },
        instanceKey: 'composer-region:session-a:review-summary',
        input: {
            v: 1,
            role: 'region',
            composer: { kind: 'session', sessionId: 'session-a' },
            regionLocalId: 'review-summary',
        },
    });
}

function composerSurfaceCatalogEntry(): DaemonPluginUiComposerSurfaceCatalogEntryV1 {
    return {
        contribution: { pluginId: 'acme.review', localId: 'review-summary' },
        immutableGenerationId: 'review-generation-a',
        projectionGeneration: 17,
        role: 'region',
        rendererChain: [{ pluginId: 'acme.review', localId: 'review-summary-view' }],
        selectedRenderer: {
            identity: { pluginId: 'acme.review', localId: 'review-summary-view' },
            renderer: {
                kind: 'declarative',
                contributionId: 'review-summary-view',
                model: { visible: true },
            },
            availability: { state: 'available', reason: 'available', diagnostics: [] },
        },
        executionOrigin: {
            serverIdentityId: 'srv_acme',
            materializationRef: {
                machineId: 'machine-review',
                materializationId: 'review-materialization-a',
                pluginId: 'acme.review',
            },
        },
        resourceCapability: { readable: true, dynamic: true },
        contributorTargetedContributions: {
            target: {
                pluginId: 'acme.review',
                immutableGenerationId: 'review-generation-a',
            },
            points: [],
        },
    };
}

describe('readPluginSurfaceMountBinding', () => {
    it('carries an exact admitted destination to the incumbent host without cloning renderer or binding facts', () => {
        const binding = destinationBinding();
        const descriptor = {
            pluginId: 'acme.reviews',
            descriptorId: 'triage',
            binding,
        } as const;
        const renderer = {
            kind: 'reactNative',
            contributionId: 'review-panel',
        } as const;

        const mount = readPluginSurfaceMountBinding({ descriptor, renderer });

        expect(mount).toMatchObject({ kind: 'destination', destinationBinding: binding });
        if (!mount || mount.kind !== 'destination') throw new Error('fixture mount must be destination');
        expect(mount.descriptor).toBe(descriptor);
        expect(mount.renderer).toBe(renderer);
        expect(mount.destinationBinding).toBe(binding);
    });

    it('projects the public destination mount only from the admitted binding', () => {
        const binding = destinationBinding();
        const mount = readPluginSurfaceMountBinding({
            descriptor: {
                pluginId: 'acme.reviews',
                descriptorId: 'triage',
                binding,
            },
            renderer: { kind: 'reactNative', contributionId: 'review-panel' },
        });
        if (!mount || mount.kind !== 'destination') throw new Error('fixture mount must be destination');

        expect(createPluginSurfaceDestinationMountContext(mount)).toEqual({
            kind: 'destination',
            destination: { pluginId: 'acme.reviews', localId: 'triage' },
            container: 'rightPane',
        });
    });

    it('fails closed instead of reselecting a renderer or accepting a mismatched destination', () => {
        const binding = destinationBinding();
        const descriptor = {
            pluginId: 'acme.reviews',
            descriptorId: 'triage',
            binding,
        } as const;

        expect(readPluginSurfaceMountBinding({
            descriptor,
            renderer: { kind: 'reactNative', contributionId: 'other-renderer' },
        })).toBeNull();
        expect(readPluginSurfaceMountBinding({
            descriptor: { ...descriptor, descriptorId: 'other-destination' },
            renderer: { kind: 'reactNative', contributionId: 'review-panel' },
        })).toBeNull();
    });

    it('consumes one exact cold target projection without requiring a public structural snapshot', () => {
        const mount = targetedMount();
        const read = (target: typeof mount.target) => readPluginSurfaceTargetedMountBinding({
            mounts: [mount],
            surface: targetedSurfaceHandle,
            target,
        });

        expect(read(mount.target)).toMatchObject({ kind: 'targetedSurface', mount });
        expect(read({
            ...mount.target,
            immutableGenerationId: 'reviews-generation-b',
        })).toBeNull();
    });

    it('admits an embedded mount only when one exact cold candidate matches its current target and surface', () => {
        const mount = targetedMount();

        const binding = readPluginSurfaceTargetedMountBinding({
            mounts: [mount],
            target: mount.target,
            surface: targetedSurfaceHandle,
        });

        expect(binding).toMatchObject({ kind: 'targetedSurface', mount });
        expect(binding?.mount).toBe(mount);
        expect(binding?.renderer).toBe(mount.selectedRenderer.renderer);
        if (!binding || binding.kind !== 'targetedSurface') {
            throw new Error('fixture target mount must be admitted');
        }
        expect(createPluginSurfaceTargetedMountContext(binding)).toEqual({
            kind: 'embedded',
            role: 'detail',
            presentation: 'content',
        });

        expect(readPluginSurfaceTargetedMountBinding({
            mounts: [mount],
            target: {
                ...mount.target,
                immutableGenerationId: 'reviews-generation-b',
            },
            surface: targetedSurfaceHandle,
        })).toBeNull();
        expect(readPluginSurfaceTargetedMountBinding({
            mounts: [mount],
            target: mount.target,
            surface: { ...targetedSurfaceHandle, role: 'other' },
        })).toBeNull();
        expect(readPluginSurfaceTargetedMountBinding({
            mounts: [mount, mount],
            target: mount.target,
            surface: targetedSurfaceHandle,
        })).toBeNull();
    });
});

describe('readPluginSurfaceComposerMountBinding', () => {
    it('joins one host-stamped Composer mount to one exact current daemon selection without reselecting its renderer', () => {
        const mount = composerSurfaceMount();
        const catalogEntry = composerSurfaceCatalogEntry();

        const binding = readPluginSurfaceComposerMountBinding({
            mount,
            catalogEntries: [catalogEntry],
        });

        expect(binding).toMatchObject({ kind: 'composer', mount, catalogEntry });
        if (!binding || binding.kind !== 'composer') {
            throw new Error('fixture Composer mount must be admitted');
        }
        expect(binding.mount).toBe(mount);
        expect(binding.catalogEntry).toBe(catalogEntry);
        expect(binding.renderer).toBe(catalogEntry.selectedRenderer.renderer);
        expect(createPluginSurfaceComposerMountContext(binding)).toEqual({
            kind: 'embedded',
            role: 'region',
            presentation: 'content',
        });
    });

    it('fails closed for stale generation, changed renderer provenance, malformed host input, and ambiguous catalog entries', () => {
        const mount = composerSurfaceMount();
        const catalogEntry = composerSurfaceCatalogEntry();
        const read = (catalogEntries: readonly DaemonPluginUiComposerSurfaceCatalogEntryV1[]) => (
            readPluginSurfaceComposerMountBinding({ mount, catalogEntries })
        );

        expect(read([{
            ...catalogEntry,
            immutableGenerationId: 'review-generation-b',
        }])).toBeNull();
        expect(read([{
            ...catalogEntry,
            projectionGeneration: 18,
        }])).toBeNull();
        expect(read([{
            ...catalogEntry,
            rendererChain: [
                ...catalogEntry.rendererChain,
                { pluginId: 'acme.review', localId: 'review-summary-fallback' },
            ],
            selectedRenderer: {
                ...catalogEntry.selectedRenderer,
                identity: { pluginId: 'acme.review', localId: 'review-summary-fallback' },
                renderer: {
                    ...catalogEntry.selectedRenderer.renderer,
                    contributionId: 'review-summary-fallback',
                },
            },
        }])).toBeNull();
        expect(read([catalogEntry, catalogEntry])).toBeNull();

        // Boundary fixture deliberately violates the closed mount schema: the
        // UI adapter must not admit a caller-mutated launch input by type alone.
        const malformedMount = {
            ...mount,
            input: { ...mount.input, regionLocalId: 'other-region' },
        } as unknown as typeof mount;
        expect(readPluginSurfaceComposerMountBinding({
            mount: malformedMount,
            catalogEntries: [catalogEntry],
        })).toBeNull();
    });
});

describe('readPluginSurfaceEphemeralMountBinding', () => {
    it.each([
        ['declarative', { kind: 'declarative', contributionId: 'repository-picker', model: { visible: true } }],
        ['reactNative', { kind: 'reactNative', contributionId: 'repository-picker', artifactId: 'picker-native' }],
        ['hostedWeb', { kind: 'hostedWeb', contributionId: 'repository-picker' }],
    ] as const)('carries the exact %s renderer through the one ephemeral mount seam', (_kind, renderer) => {
        const surface = eventSetupSurface(renderer);
        const binding = readPluginSurfaceEphemeralMountBinding(surface);

        expect(binding).toEqual({ kind: 'ephemeral', surface, renderer });
        expect(binding?.surface).toBe(surface);
        expect(binding?.renderer).toBe(surface.selectedRenderer.renderer);
        expect(createPluginSurfaceEphemeralMountContext()).toEqual({
            kind: 'embedded',
            role: 'ephemeralInput',
            presentation: 'content',
        });
    });

    it('fails closed for cross-plugin renderer, origin, chain, or retained-target generation facts', () => {
        const surface = eventSetupSurface({
            kind: 'hostedWeb',
            contributionId: 'repository-picker',
        });
        expect(readPluginSurfaceEphemeralMountBinding({
            ...surface,
            selectedRenderer: {
                ...surface.selectedRenderer,
                identity: { pluginId: 'acme.other', localId: 'repository-picker' },
            },
        })).toBeNull();
        expect(readPluginSurfaceEphemeralMountBinding({
            ...surface,
            executionOrigin: {
                ...surface.executionOrigin,
                materializationRef: {
                    ...surface.executionOrigin.materializationRef,
                    pluginId: 'acme.other',
                },
            },
        })).toBeNull();
        expect(readPluginSurfaceEphemeralMountBinding({
            ...surface,
            rendererChain: [{ pluginId: 'acme.other', localId: 'repository-picker' }],
        })).toBeNull();
        expect(readPluginSurfaceEphemeralMountBinding({
            ...surface,
            contributorTargetedContributions: {
                ...surface.contributorTargetedContributions,
                target: {
                    ...surface.contributorTargetedContributions.target,
                    immutableGenerationId: 'events-generation-retired',
                },
            },
        })).toBeNull();
    });
});
