import * as React from 'react';
import { act, create } from 'react-test-renderer';
import { describe, expect, it } from 'vitest';

import { DaemonPluginUiTargetedSurfaceMountV1Schema } from '@happier-dev/protocol';
import { preparePluginJsonSchema } from '@happier-dev/protocol/plugins/actions/json-schema-validation';

import {
    TargetedPluginSurfaceHost,
    type TargetedPluginSurfaceMountRequest,
} from './TargetedPluginSurfaceHost';
import type { PreparedDaemonPluginUiTargetedSurfaceMountV1 } from '@/agents/backendCatalog/loadDaemonMergedProjectionInputs';

function prepareTargetedMount(
    rawMount: ReturnType<typeof DaemonPluginUiTargetedSurfaceMountV1Schema.parse>,
): PreparedDaemonPluginUiTargetedSurfaceMountV1 {
    const inputValidation = preparePluginJsonSchema(rawMount.inputSchema);
    return Object.freeze({
        ...rawMount,
        inputSchema: inputValidation.jsonSchema,
        inputValidation,
    });
}

const target = Object.freeze({
    pluginId: 'acme.triage',
    immutableGenerationId: 'triage-generation-a',
});

const surface = Object.freeze({
    point: Object.freeze({
        pointId: 'triage-detail',
        protocol: Object.freeze({ id: 'triage/detail', version: 1 }),
    }),
    contributor: Object.freeze({
        pluginId: 'acme.review',
        contributionId: 'review-detail',
        immutableGenerationId: 'review-generation-b',
    }),
    role: 'detail',
    presentation: 'content' as const,
});

const mount = prepareTargetedMount(DaemonPluginUiTargetedSurfaceMountV1Schema.parse({
    kind: 'targetedSurface' as const,
    target,
    point: surface.point,
    contributor: surface.contributor,
    role: surface.role,
    presentation: surface.presentation,
    inputSchema: Object.freeze({ type: 'object' }),
    rendererChain: Object.freeze([Object.freeze({ pluginId: 'acme.review', localId: 'review-detail' })]),
    selectedRenderer: Object.freeze({
        identity: Object.freeze({ pluginId: 'acme.review', localId: 'review-detail' }),
        renderer: Object.freeze({
            kind: 'declarative' as const,
            contributionId: 'review-detail',
            model: Object.freeze({
                visible: true,
                identity: Object.freeze({ pluginId: 'acme.review', generation: 'review-generation-b' }),
                root: Object.freeze({ kind: 'state', state: 'empty', title: 'No review selected' }),
            }),
        }),
        availability: Object.freeze({ state: 'available' as const, reason: 'available', diagnostics: Object.freeze([]) }),
    }),
    executionOrigin: Object.freeze({
        serverIdentityId: 'srv_server_a',
        materializationRef: Object.freeze({
            materializationId: 'review-materialization-b',
            machineId: 'machine-a',
            pluginId: 'acme.review',
        }),
    }),
    resourceCapability: Object.freeze({ readable: true, dynamic: true }),
    contributorTargetedContributions: Object.freeze({
        target: Object.freeze({ pluginId: 'acme.review', immutableGenerationId: 'review-generation-b' }),
        points: Object.freeze([]),
    }),
}));

const normalizedLeaf = Object.freeze({
    kind: 'targetedSurface',
    surface,
    input: Object.freeze({ reviewId: 'review-42' }),
    instanceKey: `targeted-surface:v1:${'a'.repeat(64)}`,
});

function MountedTargetedSurface(): React.ReactElement {
    return <React.Fragment />;
}

function TargetedFallback(): React.ReactElement {
    return <React.Fragment />;
}

describe('TargetedPluginSurfaceHost', () => {
    it('takes a normalized declarative leaf through its one exact A→B adapter before invoking the incumbent physical-host callback', async () => {
        const mounted: TargetedPluginSurfaceMountRequest[] = [];
        let rendered!: ReturnType<typeof create>;
        await act(async () => {
            rendered = create(
                <TargetedPluginSurfaceHost
                    node={normalizedLeaf}
                    mounts={[mount]}
                    target={target}
                    renderMountedSurface={(request) => {
                        mounted.push(request);
                        return <MountedTargetedSurface />;
                    }}
                />,
            );
        });

        expect(rendered.root.findAllByType(MountedTargetedSurface)).toHaveLength(1);
        expect(mounted).toHaveLength(1);
        expect(mounted[0]).toMatchObject({
            input: { reviewId: 'review-42' },
            instanceKey: normalizedLeaf.instanceKey,
            mount: {
                kind: 'targetedSurface',
                mount: {
                    contributor: surface.contributor,
                    executionOrigin: mount.executionOrigin,
                    contributorTargetedContributions: mount.contributorTargetedContributions,
                },
            },
        });
    });

    it('does not invoke the physical host for a stale normalized contributor handle', async () => {
        const renderMountedSurface = (request: TargetedPluginSurfaceMountRequest): React.ReactNode => (
            <MountedTargetedSurface key={request.instanceKey} />
        );
        let rendered!: ReturnType<typeof create>;
        await act(async () => {
            rendered = create(
                <TargetedPluginSurfaceHost
                    node={{
                        ...normalizedLeaf,
                        surface: {
                            ...surface,
                            contributor: {
                                ...surface.contributor,
                                immutableGenerationId: 'review-generation-c',
                            },
                        },
                    }}
                    fallback={<TargetedFallback />}
                    mounts={[mount]}
                    target={target}
                    renderMountedSurface={renderMountedSurface}
                />,
            );
        });

        expect(rendered.root.findAllByType(MountedTargetedSurface)).toHaveLength(0);
        // The declarative renderer owns this state. A stale A→B rematch must
        // preserve it rather than return a non-null empty bridge element that
        // suppresses fallback handling upstream.
        expect(rendered.root.findAllByType(TargetedFallback)).toHaveLength(1);
    });

    it('forwards an own explicit null presentation fallback rather than the caller fallback', async () => {
        const mounted: TargetedPluginSurfaceMountRequest[] = [];
        const presentation = Object.freeze({
            surface,
            input: normalizedLeaf.input,
            fallback: null,
        });
        let rendered!: ReturnType<typeof create>;
        await act(async () => {
            rendered = create(
                <TargetedPluginSurfaceHost
                    presentation={presentation}
                    fallback={<TargetedFallback />}
                    mounts={[mount]}
                    target={target}
                    renderMountedSurface={(request) => {
                        mounted.push(request);
                        return <MountedTargetedSurface />;
                    }}
                />,
            );
        });

        expect(rendered.root.findAllByType(MountedTargetedSurface)).toHaveLength(1);
        expect(mounted).toHaveLength(1);
        expect(Object.hasOwn(mounted[0]!, 'fallback')).toBe(true);
        expect(mounted[0]!.fallback).toBeNull();
    });

    it('keeps the one mounted physical host out of a stale cold target-generation update', async () => {
        const mounted: TargetedPluginSurfaceMountRequest[] = [];
        const renderMountedSurface = (request: TargetedPluginSurfaceMountRequest): React.ReactNode => {
            mounted.push(request);
            return <MountedTargetedSurface key={request.instanceKey} />;
        };
        let rendered!: ReturnType<typeof create>;
        await act(async () => {
            rendered = create(
                <TargetedPluginSurfaceHost
                    node={normalizedLeaf}
                    fallback={<TargetedFallback />}
                    mounts={[mount]}
                    target={target}
                    renderMountedSurface={renderMountedSurface}
                />,
            );
        });
        expect(mounted).toHaveLength(1);
        expect(rendered.root.findAllByType(MountedTargetedSurface)).toHaveLength(1);

        await act(async () => {
            rendered.update(
                <TargetedPluginSurfaceHost
                    node={normalizedLeaf}
                    fallback={<TargetedFallback />}
                    mounts={[mount]}
                    target={{ ...target, immutableGenerationId: 'triage-generation-b' }}
                    renderMountedSurface={renderMountedSurface}
                />,
            );
        });

        expect(mounted).toHaveLength(1);
        expect(rendered.root.findAllByType(MountedTargetedSurface)).toHaveLength(0);
        expect(rendered.root.findAllByType(TargetedFallback)).toHaveLength(1);

        await act(async () => {
            rendered.update(
                <TargetedPluginSurfaceHost
                    node={normalizedLeaf}
                    fallback={<TargetedFallback />}
                    mounts={[mount]}
                    target={target}
                    renderMountedSurface={renderMountedSurface}
                />,
            );
        });

        // A mismatched cold snapshot is a refusal for that render, not a
        // terminal latch. Restoring the exact admitted target generation must
        // remount through the same physical owner without recreating a local
        // registry or retaining the stale failure.
        expect(mounted).toHaveLength(2);
        expect(rendered.root.findAllByType(MountedTargetedSurface)).toHaveLength(1);
        expect(rendered.root.findAllByType(TargetedFallback)).toHaveLength(0);
    });
});
