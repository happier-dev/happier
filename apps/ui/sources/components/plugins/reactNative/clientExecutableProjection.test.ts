import { describe, expect, it } from 'vitest';
import {
    PluginContributesV2Schema,
} from '@happier-dev/protocol';
import {
    PluginUiArtifactsManifestEntryV1Schema,
} from '@happier-dev/protocol/plugins/ui';

import { EMPTY_PLUGIN_UI_PROJECTION, type PluginUiProjectionModel } from '@/sync/domains/plugins/ui/projection';
import { PLUGIN_UI_CONTRIBUTION_ORIGIN_KEY } from '@/sync/domains/plugins/ui/projectionUnion';
import type { PluginReactNativeBundleCacheIdentity } from '@/sync/domains/plugins/ui/reactNativeRuntime';

import { resolveProjectedPluginUiClientExecutables } from './clientExecutableProjection';

const pluginId = 'acme.shared-actions';
const origin = Object.freeze({
    serverIdentityId: 'srv_shared_actions',
    materializationRef: Object.freeze({
        pluginId,
        machineId: 'machine-1',
        materializationId: 'shared-actions-install',
    }),
});
const generation = 12;
const firstActionId = 'open-first';
const firstActionKey = `${pluginId}/${firstActionId}`;
const firstBundleKey = `reactNativeBundle:${pluginId}:${firstActionId}`;
const voiceLocalId = 'conversation';
const voiceKey = `${pluginId}/${voiceLocalId}`;
const voiceBundleKey = `reactNativeBundle:${pluginId}:${voiceLocalId}`;
const target = Object.freeze({
    artifactId: 'shared-action-runtime',
    modulePath: './sharedActionRuntime',
    exportName: 'activate',
    platform: 'web' as const,
});
const artifactDigest: PluginReactNativeBundleCacheIdentity['artifactDigest'] =
    'sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
const artifactGraph = PluginUiArtifactsManifestEntryV1Schema.parse({
    contributionId: target.artifactId,
    tier: 'reactNative',
    platform: target.platform,
    entry: 'react-native/shared-action-runtime/index.js',
    files: [{
        relativePath: 'react-native/shared-action-runtime/index.js',
        digest: 'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        byteSize: 1,
    }],
    digest: artifactDigest,
    builtWith: { bundler: 'vite', version: '7.0.0' },
    hostUiApiVersion: '1.0.0',
    compat: { react: '19.0.0', reactNative: '0.83.4' },
});
const hostOrigin = Object.freeze({
    machineId: origin.materializationRef.machineId,
    serverId: 'server-1',
    generation,
    interactionEnabled: true,
    phase: 'current' as const,
    executionOrigin: origin,
});

type ClientActionBundleFixture = PluginUiProjectionModel['reactNativeBundlesById'][string] & Readonly<{
    generatedOwnerKind: 'clientContribution';
    artifactGraph: typeof artifactGraph;
    runtime: Readonly<{
        decision: Readonly<{ state: 'load' }>;
        loadPolicy: Readonly<{ source: 'installedArtifact' }>;
        cacheIdentity: PluginReactNativeBundleCacheIdentity;
    }>;
    [PLUGIN_UI_CONTRIBUTION_ORIGIN_KEY]: typeof hostOrigin;
}>;

type ClientActionProjectionFixture = Omit<PluginUiProjectionModel, 'reactNativeBundlesById'> & Readonly<{
    reactNativeBundlesById: Readonly<Record<string, ClientActionBundleFixture>>;
}>;

function action(localId: string) {
    return {
        id: localId,
        pluginId,
        title: localId,
        scopes: ['session'],
        surfaces: ['ui'],
        placementBindings: ['detailsPanel'],
        dangerLevel: 'safe',
        available: true,
        execution: {
            target: 'client' as const,
            client: target,
            platforms: [target.platform],
        },
        [PLUGIN_UI_CONTRIBUTION_ORIGIN_KEY]: hostOrigin,
    } satisfies PluginUiProjectionModel['actionsById'][string];
}

function bundle(localId: string): ClientActionBundleFixture {
    const cacheIdentity: PluginReactNativeBundleCacheIdentity = {
        pluginId,
        contributionId: localId,
        artifactDigest,
        hostAppVersion: '2.0.0',
        hostUiApiVersion: '1.0.0',
        reactVersion: '19.0.0',
        reactNativeVersion: '0.83.4',
        platform: target.platform,
        channel: 'internal',
        nativeCapabilitiesDigest: 'sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc',
        projectionGeneration: generation,
    };
    return {
        id: `reactNativeBundle:${pluginId}:${localId}`,
        pluginId,
        contributionKind: 'reactNativeBundle' as const,
        contributionId: localId,
        generatedOwnerKind: 'clientContribution' as const,
        artifactGraph,
        runtime: {
            decision: { state: 'load' as const },
            loadPolicy: { source: 'installedArtifact' as const },
            cacheIdentity,
        },
        [PLUGIN_UI_CONTRIBUTION_ORIGIN_KEY]: hostOrigin,
    } satisfies PluginUiProjectionModel['reactNativeBundlesById'][string];
}

const voiceDeclaration = PluginContributesV2Schema.parse({
    voiceProviders: [{
        id: voiceLocalId,
        title: 'Conversation',
        kind: 'conversation',
        roles: ['realtime_conversation'],
        platforms: [target.platform],
        capabilities: {
            turn: {
                cancelResponse: true,
                bargeIn: false,
            },
        },
        client: {
            artifactId: target.artifactId,
            modulePath: target.modulePath,
            exportName: target.exportName,
        },
    }],
}).voiceProviders[0]!;

function voiceBundle(): PluginUiProjectionModel['reactNativeBundlesById'][string] {
    return Object.freeze({
        ...bundle(voiceLocalId),
        generatedOwnerKind: 'voiceProvider',
    });
}

function voiceOnlyProjection(): PluginUiProjectionModel {
    const voice = Object.freeze({
        id: voiceKey,
        pluginId,
        generation,
        contributionKey: voiceKey,
        definition: voiceDeclaration,
        [PLUGIN_UI_CONTRIBUTION_ORIGIN_KEY]: hostOrigin,
    });
    return Object.freeze({
        ...EMPTY_PLUGIN_UI_PROJECTION,
        generation,
        voiceProvidersById: Object.freeze({ [voiceKey]: voice }),
        reactNativeBundlesById: Object.freeze({ [voiceBundleKey]: voiceBundle() }),
    }) satisfies PluginUiProjectionModel;
}

function projection(): ClientActionProjectionFixture {
    const first = action(firstActionId);
    const second = action('open-second');
    return Object.freeze({
        ...EMPTY_PLUGIN_UI_PROJECTION,
        generation,
        actionsById: Object.freeze({
            [firstActionKey]: first,
            [`${pluginId}/open-second`]: second,
        }),
        reactNativeBundlesById: Object.freeze({
            [firstBundleKey]: bundle(firstActionId),
            [`reactNativeBundle:${pluginId}:open-second`]: bundle('open-second'),
        }),
    }) satisfies PluginUiProjectionModel;
}

function singleActionProjection(): ClientActionProjectionFixture {
    const current = projection();
    const currentAction = current.actionsById[firstActionKey];
    const currentBundle = current.reactNativeBundlesById[firstBundleKey];
    if (!currentAction || !currentBundle) throw new Error('first projected client Action missing');
    return Object.freeze({
        ...current,
        actionsById: Object.freeze({ [firstActionKey]: currentAction }),
        reactNativeBundlesById: Object.freeze({ [firstBundleKey]: currentBundle }),
    }) satisfies PluginUiProjectionModel;
}

function resolve(projectionInput: PluginUiProjectionModel) {
    return resolveProjectedPluginUiClientExecutables({
        actionProjection: Object.freeze({ projection: projectionInput }),
        voiceProjection: Object.freeze({ projection: projectionInput }),
        platform: 'web',
    });
}

function firstAction(projectionInput: ClientActionProjectionFixture) {
    const current = projectionInput.actionsById[firstActionKey];
    if (!current) throw new Error('first projected Action missing');
    return current;
}

function firstBundle(projectionInput: ClientActionProjectionFixture) {
    const current = projectionInput.reactNativeBundlesById[firstBundleKey];
    if (!current) throw new Error('first projected bundle missing');
    return current;
}

function bundleCacheIdentity(bundleInput: ReturnType<typeof firstBundle>) {
    const current = bundleInput.runtime.cacheIdentity;
    if (!current) throw new Error('first projected bundle cache identity missing');
    return current;
}

describe('resolveProjectedPluginUiClientExecutables', () => {
    it('returns a Voice-only target through the generic executable projection', () => {
        const resolved = resolve(voiceOnlyProjection());

        expect(resolved).toHaveLength(1);
        expect(resolved[0]).toMatchObject({
            pluginId,
            target,
            executionOrigin: origin,
            projectionGeneration: generation,
            contributes: {
                voiceProviders: [expect.objectContaining({ id: voiceLocalId })],
            },
        });
    });

    it('does not let a union stamp bypass the direct Voice machine authority', () => {
        const current = voiceOnlyProjection();
        const currentVoice = current.voiceProvidersById[voiceKey];
        const currentBundle = current.reactNativeBundlesById[voiceBundleKey];
        if (!currentVoice || !currentBundle) throw new Error('Voice projection fixture missing');
        const directSource = Object.freeze({
            ...current,
            voiceProvidersById: Object.freeze({
                [voiceKey]: Object.freeze({ ...currentVoice, ...origin }),
            }),
            reactNativeBundlesById: Object.freeze({
                [voiceBundleKey]: Object.freeze({ ...currentBundle, ...origin }),
            }),
        }) satisfies PluginUiProjectionModel;

        expect(resolveProjectedPluginUiClientExecutables({
            voiceProjection: Object.freeze({
                projection: directSource,
                directMachineAuthority: Object.freeze({ machineId: 'machine-2', serverId: 'server-1' }),
            }),
            platform: 'web',
        })).toEqual([]);
    });

    it('withholds a Voice target when its origin, platform, or artifact anchor is malformed', () => {
        const current = voiceOnlyProjection();
        const currentBundle = current.reactNativeBundlesById[voiceBundleKey];
        const currentVoice = current.voiceProvidersById[voiceKey];
        if (!currentBundle || !currentVoice) throw new Error('Voice projection fixture missing');
        const malformedExecutionOrigin = Object.freeze({
            ...hostOrigin,
            executionOrigin: Object.freeze({
                ...origin,
                materializationRef: Object.freeze({
                    ...origin.materializationRef,
                    pluginId: 'acme.other-plugin',
                }),
            }),
        });
        const malformedOrigin = Object.freeze({
            ...current,
            voiceProvidersById: Object.freeze({
                ...current.voiceProvidersById,
                [voiceKey]: Object.freeze({
                    ...currentVoice,
                    [PLUGIN_UI_CONTRIBUTION_ORIGIN_KEY]: malformedExecutionOrigin,
                }),
            }),
            reactNativeBundlesById: Object.freeze({
                ...current.reactNativeBundlesById,
                [voiceBundleKey]: Object.freeze({
                    ...currentBundle,
                    [PLUGIN_UI_CONTRIBUTION_ORIGIN_KEY]: malformedExecutionOrigin,
                }),
            }),
        }) satisfies PluginUiProjectionModel;
        const mismatchedOriginGeneration = Object.freeze({
            ...current,
            reactNativeBundlesById: Object.freeze({
                ...current.reactNativeBundlesById,
                [voiceBundleKey]: Object.freeze({
                    ...currentBundle,
                    [PLUGIN_UI_CONTRIBUTION_ORIGIN_KEY]: Object.freeze({
                        ...hostOrigin,
                        generation: generation + 1,
                    }),
                }),
            }),
        }) satisfies PluginUiProjectionModel;
        const malformedPlatform = Object.freeze({
            ...current,
            reactNativeBundlesById: Object.freeze({
                ...current.reactNativeBundlesById,
                [voiceBundleKey]: Object.freeze({
                    ...currentBundle,
                    artifactGraph: Object.freeze({ ...artifactGraph, platform: 'ios' }),
                }),
            }),
        }) satisfies PluginUiProjectionModel;
        const malformedArtifact = Object.freeze({
            ...current,
            reactNativeBundlesById: Object.freeze({
                ...current.reactNativeBundlesById,
                [voiceBundleKey]: Object.freeze({
                    ...currentBundle,
                    artifactGraph: Object.freeze({
                        ...artifactGraph,
                        contributionId: 'another-artifact',
                    }),
                }),
            }),
        }) satisfies PluginUiProjectionModel;

        expect(resolve(malformedOrigin)).toEqual([]);
        expect(resolve(mismatchedOriginGeneration)).toEqual([]);
        expect(resolve(malformedPlatform)).toEqual([]);
        expect(resolve(malformedArtifact)).toEqual([]);
    });

    it('groups every current Action sharing one exact executable target into one activation input', () => {
        const resolved = resolve(projection());

        expect(resolved).toHaveLength(1);
        expect(resolved[0]).toMatchObject({
            pluginId,
            target,
            executionOrigin: origin,
            projectionGeneration: generation,
            contributes: {
                actions: [
                    expect.objectContaining({ id: 'open-first' }),
                    expect.objectContaining({ id: 'open-second' }),
                ],
            },
        });
    });

    it('withholds a web Action whose exact artifact is projected for another platform', () => {
        const current = singleActionProjection();
        const currentBundle = firstBundle(current);
        const mismatched = Object.freeze({
            ...current,
            reactNativeBundlesById: Object.freeze({
                ...current.reactNativeBundlesById,
                [firstBundleKey]: Object.freeze({
                    ...currentBundle,
                    artifactGraph: Object.freeze({ ...currentBundle.artifactGraph, platform: 'ios' }),
                }),
            }),
        }) satisfies PluginUiProjectionModel;

        expect(resolve(mismatched)).toEqual([]);
    });

    it('withholds a bundle whose current origin is not the Action origin', () => {
        const current = singleActionProjection();
        const currentBundle = firstBundle(current);
        const mismatched = Object.freeze({
            ...current,
            reactNativeBundlesById: Object.freeze({
                ...current.reactNativeBundlesById,
                [firstBundleKey]: Object.freeze({
                    ...currentBundle,
                    [PLUGIN_UI_CONTRIBUTION_ORIGIN_KEY]: Object.freeze({
                        ...hostOrigin,
                        generation: generation + 1,
                    }),
                }),
            }),
        }) satisfies PluginUiProjectionModel;

        expect(resolve(mismatched)).toEqual([]);
    });

    it('withholds a Voice-owned bundle from a client Action activation', () => {
        const current = singleActionProjection();
        const currentBundle = firstBundle(current);
        const mismatched = Object.freeze({
            ...current,
            reactNativeBundlesById: Object.freeze({
                ...current.reactNativeBundlesById,
                [firstBundleKey]: Object.freeze({
                    ...currentBundle,
                    generatedOwnerKind: 'voiceProvider',
                }),
            }),
        }) satisfies PluginUiProjectionModel;

        expect(resolve(mismatched)).toEqual([]);
    });

    it('withholds a bundle whose artifact graph is not anchored to the declared executable artifact', () => {
        const current = singleActionProjection();
        const currentBundle = firstBundle(current);
        const mismatched = Object.freeze({
            ...current,
            reactNativeBundlesById: Object.freeze({
                ...current.reactNativeBundlesById,
                [firstBundleKey]: Object.freeze({
                    ...currentBundle,
                    artifactGraph: Object.freeze({
                        ...currentBundle.artifactGraph,
                        contributionId: 'different-action-runtime',
                    }),
                }),
            }),
        }) satisfies PluginUiProjectionModel;

        expect(resolve(mismatched)).toEqual([]);
    });

    it('withholds a cache identity bound to another Action declaration', () => {
        const current = singleActionProjection();
        const currentBundle = firstBundle(current);
        const mismatched = Object.freeze({
            ...current,
            reactNativeBundlesById: Object.freeze({
                ...current.reactNativeBundlesById,
                [firstBundleKey]: Object.freeze({
                    ...currentBundle,
                    runtime: Object.freeze({
                        ...currentBundle.runtime,
                        cacheIdentity: Object.freeze({
                            ...bundleCacheIdentity(currentBundle),
                            contributionId: 'open-second',
                        }),
                    }),
                }),
            }),
        }) satisfies PluginUiProjectionModel;

        expect(resolve(mismatched)).toEqual([]);
    });

    it('withholds a cache identity whose bytes do not match the projected artifact graph', () => {
        const current = singleActionProjection();
        const currentBundle = firstBundle(current);
        const mismatched = Object.freeze({
            ...current,
            reactNativeBundlesById: Object.freeze({
                ...current.reactNativeBundlesById,
                [firstBundleKey]: Object.freeze({
                    ...currentBundle,
                    runtime: Object.freeze({
                        ...currentBundle.runtime,
                        cacheIdentity: Object.freeze({
                            ...bundleCacheIdentity(currentBundle),
                            artifactDigest: 'sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc',
                        }),
                    }),
                }),
            }),
        }) satisfies PluginUiProjectionModel;

        expect(resolve(mismatched)).toEqual([]);
    });

    it('withholds a cache identity from another projection generation', () => {
        const current = singleActionProjection();
        const currentBundle = firstBundle(current);
        const mismatched = Object.freeze({
            ...current,
            reactNativeBundlesById: Object.freeze({
                ...current.reactNativeBundlesById,
                [firstBundleKey]: Object.freeze({
                    ...currentBundle,
                    runtime: Object.freeze({
                        ...currentBundle.runtime,
                        cacheIdentity: Object.freeze({
                            ...bundleCacheIdentity(currentBundle),
                            projectionGeneration: generation + 1,
                        }),
                    }),
                }),
            }),
        }) as PluginUiProjectionModel;

        expect(resolve(mismatched)).toEqual([]);
    });
});
