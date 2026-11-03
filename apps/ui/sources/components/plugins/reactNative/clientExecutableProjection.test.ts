import { describe, expect, it } from 'vitest';
import {
    PluginContributesV2Schema,
} from '@happier-dev/protocol';
import {
    PluginUiArtifactsManifestEntryV2Schema,
} from '@happier-dev/protocol/plugins/ui';
import { PluginSourceCustodyV1Schema } from '@happier-dev/protocol/plugins/runtime/sourceCustody';

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
const voiceOccurrenceId = 'acme-shared-voice-occurrence-12';
const target = Object.freeze({
    artifactId: 'shared-action-runtime',
    exportName: 'activate',
    platform: 'web' as const,
});
const artifactDigest: PluginReactNativeBundleCacheIdentity['artifactDigest'] =
    'sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
const artifactGraph = PluginUiArtifactsManifestEntryV2Schema.parse({
    artifactId: target.artifactId,
    tier: 'reactNative',
    entry: 'react-native/shared-action-runtime/entry.cjs.bundle',
    files: [{
        relativePath: 'react-native/shared-action-runtime/entry.cjs.bundle',
        digest: 'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        byteSize: 1,
    }],
    digest: artifactDigest,
    builtWith: { bundler: 'esbuild', version: '0.27.2' },
    executable: { exports: [target.exportName] },
    hostUiApiRange: '^1.0.0',
});
const hostOrigin = Object.freeze({
    machineId: origin.materializationRef.machineId,
    serverId: 'server-1',
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
        cacheIdentity: Readonly<{ artifactDigest: PluginReactNativeBundleCacheIdentity['artifactDigest'] }>;
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
        occurrenceId: 'acme-shared-actions-occurrence-12',
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
    const cacheIdentity = { artifactDigest };
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
        occurrenceId: voiceOccurrenceId,
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
        voiceProviderIds: new Set(Object.keys(projectionInput.voiceProvidersById)),
        platform: 'web',
    });
}

it('activates an authentication-only Account module through its declared target and exact custody', () => {
    const hostAccountOrigin = { serverId: 'home', accountId: 'account', custodyId: 'release:authentication',
        sourceCustody: { kind: 'bundled_first_party' as const,
            packagedRuntime: { kind: 'source_declaration' as const, packageName: '@acme/shared-actions' } } };
    const definition = PluginContributesV2Schema.parse({ connectedAccountDescriptors: [{
        id: 'subscription', title: 'Subscription', authentication: {
            account: { artifactId: target.artifactId, exportName: target.exportName },
            defaultModeId: 'device', modes: [{ id: 'device', kind: 'oauthDeviceCode', outcomeReconciliation: 'none' }],
        },
    }] }).connectedAccountDescriptors[0]!;
    const descriptor = { id: definition.id, pluginId, occurrenceId: hostAccountOrigin.custodyId,
        definition, hostAccountOrigin };
    const accountBundle = { ...bundle(`connectedAccountDescriptors/${definition.id}`), hostAccountOrigin,
        [PLUGIN_UI_CONTRIBUTION_ORIGIN_KEY]: undefined };
    const projection = { ...EMPTY_PLUGIN_UI_PROJECTION,
        connectedAccountDescriptorsById: { [`${pluginId}/${definition.id}`]: descriptor },
        reactNativeBundlesById: { [accountBundle.id]: accountBundle } };
    const result = resolve(projection);
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ target: { realm: 'account', artifactId: target.artifactId, exportName: target.exportName },
        contributes: { connectedAccountDescriptors: [definition] }, executionOrigin: null,
        authority: { kind: 'account', custodyId: hostAccountOrigin.custodyId },
        artifactAnchor: { artifactOwnerKind: 'clientContribution', clientContribution: {
            family: 'connectedAccountDescriptors', contribution: { pluginId, localId: definition.id },
        } } });
    expect(resolve({ ...projection, connectedAccountDescriptorsById: { [`${pluginId}/${definition.id}`]: {
        ...descriptor, occurrenceId: 'retired',
    } } })).toEqual([]);
    expect(resolve({ ...projection, reactNativeBundlesById: { [accountBundle.id]: {
        ...accountBundle, hostAccountOrigin: { ...hostAccountOrigin, custodyId: 'other-selection' },
    } } })).toEqual([]);
});

it('admits an Account Action and its exact custody without a Machine projection', () => {
    const accountOrigin = { serverId: 'home', accountId: 'account', custodyId: 'release:1',
        sourceCustody: PluginSourceCustodyV1Schema.parse({ kind: 'bundled_first_party',
            packagedRuntime: { kind: 'source_declaration', packageName: '@acme/shared-actions' } }) };
    const current = singleActionProjection();
    const accountAction = { ...action(firstActionId), occurrenceId: accountOrigin.custodyId,
        execution: { target: 'account' as const, account: { artifactId: target.artifactId, exportName: target.exportName } },
        hostAccountOrigin: accountOrigin, [PLUGIN_UI_CONTRIBUTION_ORIGIN_KEY]: undefined,
    };
    const accountBundle = { ...bundle(firstActionId), hostAccountOrigin: accountOrigin, [PLUGIN_UI_CONTRIBUTION_ORIGIN_KEY]: undefined };
    const accountProjection = { ...current, generation: null, actionsById: { [firstActionKey]: accountAction },
        reactNativeBundlesById: { [firstBundleKey]: accountBundle } };
    const result = resolve(accountProjection);
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ occurrenceId: 'release:1', executionOrigin: null,
        authority: { kind: 'account', serverId: 'home', accountId: 'account', custodyId: 'release:1' } });
    expect(resolve({ ...accountProjection, reactNativeBundlesById: { [firstBundleKey]: {
        ...accountBundle, hostAccountOrigin: { ...accountOrigin, custodyId: 'release:2' },
    } } })).toEqual([]);
    expect(resolve({ ...accountProjection, actionsById: { [firstActionKey]: {
        ...accountAction, hostAccountOrigin: { ...accountOrigin,
            sourceCustody: { kind: 'development', registeredRootId: 'machine-only-source' } },
    } } })).toEqual([]);
});

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
    it('prepares only demanded Voice providers and retains the active provider alongside a new selection', () => {
        const current = voiceOnlyProjection();
        const source = { projection: current };
        expect(resolveProjectedPluginUiClientExecutables({ voiceProjection: source, voiceProviderIds: new Set(), platform: 'web' })).toEqual([]);
        const selected = resolveProjectedPluginUiClientExecutables({ voiceProjection: source,
            voiceProviderIds: new Set([voiceKey]), platform: 'web' });
        expect(selected).toHaveLength(1);
        expect(selected[0]?.voiceProviders.map(provider => provider.entry.id)).toEqual([voiceKey]);
        expect(resolveProjectedPluginUiClientExecutables({ voiceProjection: source,
            voiceProviderIds: new Set(['other/next', voiceKey]), platform: 'web' })).toEqual(selected);
    });
    it('retains co-declared Voice rights when an Action already demands the same executable', () => {
        const actions = projection();
        const voice = voiceOnlyProjection();
        const current = { ...actions,
            voiceProvidersById: { [voiceKey]: { ...voice.voiceProvidersById[voiceKey]!,
                occurrenceId: actions.actionsById[firstActionKey]!.occurrenceId } },
            reactNativeBundlesById: { ...actions.reactNativeBundlesById, ...voice.reactNativeBundlesById },
        };
        const targets = resolveProjectedPluginUiClientExecutables({ actionProjection: { projection: current },
            voiceProjection: { projection: current }, voiceProviderIds: new Set(), platform: 'web' });
        expect(targets).toHaveLength(1);
        expect(targets[0]?.contributes.voiceProviders).toEqual([voiceDeclaration]);
        expect(targets[0]?.actions).toHaveLength(2);
    });
    it('activates source and target rights from their exact shared answering artifact without an Action declaration', () => {
        const definitions = PluginContributesV2Schema.parse({
            workItems: [{ id: 'work-items', client: { artifactId: target.artifactId, exportName: target.exportName }, platforms: ['web'] }],
            dragSources: [{ id: 'entry', title: 'Entry', referenceSchema: { type: 'string' }, client: { artifactId: target.artifactId, exportName: target.exportName }, platforms: ['web'] }],
            dropTargets: [{ id: 'entry', title: 'Review', acceptedKinds: ['session'], actions: [{ kind: 'host', actionId: 'session.open' }], client: { artifactId: target.artifactId, exportName: target.exportName }, platforms: ['web'] }],
        });
        const entry = { id: `${pluginId}/entry`, pluginId, pluginVersion: '1.0.0', occurrenceId: 'entity-occurrence', [PLUGIN_UI_CONTRIBUTION_ORIGIN_KEY]: hostOrigin };
        const projected = { ...EMPTY_PLUGIN_UI_PROJECTION, generation,
            installedPackagesById: { [pluginId]: { id: pluginId, displayName: pluginId, version: '1.0.0', enabled: true,
                source: { kind: 'local', locator: pluginId } } },
            dragSourcesById: { [entry.id]: { ...entry, definition: definitions.dragSources[0]! } },
            workItemsById: { [`${pluginId}/work-items`]: { ...entry, id: `${pluginId}/work-items`, definition: definitions.workItems[0]! } },
            dropTargetsById: { [entry.id]: { ...entry, definition: definitions.dropTargets[0]! } },
            reactNativeBundlesById: { [`reactNativeBundle:${pluginId}:workItems/work-items`]: bundle('workItems/work-items'), [`reactNativeBundle:${pluginId}:dragSources/entry`]: bundle('dragSources/entry'), [`reactNativeBundle:${pluginId}:dropTargets/entry`]: bundle('dropTargets/entry') },
        };
        const resolved = resolve(projected);
        expect(resolved).toHaveLength(1);
        expect(resolved[0]?.contributes).toMatchObject({ dragSources: [{ id: 'entry' }], dropTargets: [{ id: 'entry' }] });
        const missing = resolve({ ...projected, reactNativeBundlesById: {} });
        expect(missing).toEqual([]);
        expect(resolved[0]?.contributes).toMatchObject({ workItems: [{ id: 'work-items' }] });
        expect(resolve({ ...projected, dragSourcesById: {}, dropTargetsById: {}, workItemsById: {} })).toEqual([]);
    });
    it('returns a Voice-only target through the generic executable projection', () => {
        const resolved = resolve(voiceOnlyProjection());

        expect(resolved).toHaveLength(1);
        expect(resolved[0]).toMatchObject({
            pluginId,
            occurrenceId: voiceOccurrenceId,
            target,
            executionOrigin: origin,
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
                [voiceKey]: Object.freeze({ ...currentVoice, executionOrigin: origin }),
            }),
            reactNativeBundlesById: Object.freeze({
                [voiceBundleKey]: Object.freeze({ ...currentBundle, executionOrigin: origin }),
            }),
        }) satisfies PluginUiProjectionModel;

        expect(resolveProjectedPluginUiClientExecutables({
            voiceProjection: Object.freeze({
                projection: directSource,
                directMachineAuthority: Object.freeze({ machineId: 'machine-2', serverId: 'server-1' }),
            }),
            voiceProviderIds: new Set([voiceKey]),
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
        }) as unknown as PluginUiProjectionModel; // Deliberately malformed boundary fixture.
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
        const malformedOccurrence = Object.freeze({
            ...current,
            voiceProvidersById: Object.freeze({
                ...current.voiceProvidersById,
                [voiceKey]: Object.freeze({
                    ...currentVoice,
                    occurrenceId: null,
                }),
            }),
        }) as unknown as PluginUiProjectionModel;

        expect(resolve(malformedOrigin)).toEqual([]);
        expect(resolve(malformedPlatform)).toEqual([]);
        expect(resolve(malformedArtifact)).toEqual([]);
        expect(resolve(malformedOccurrence)).toEqual([]);
    });

    it('admits an exact current native target without an unrelated catalog generation', () => {
        const source = singleActionProjection();
        const currentAction = source.actionsById[firstActionKey];
        const currentBundle = source.reactNativeBundlesById[firstBundleKey];
        if (!currentAction || !currentBundle) throw new Error('first projected client Action missing');
        const currentOrigin = hostOrigin;
        const withOrigin = (interactionEnabled: boolean): PluginUiProjectionModel => Object.freeze({
            ...source,
            actionsById: Object.freeze({ [firstActionKey]: Object.freeze({
                ...currentAction,
                [PLUGIN_UI_CONTRIBUTION_ORIGIN_KEY]: Object.freeze({ ...currentOrigin, interactionEnabled }),
            }) }),
            reactNativeBundlesById: Object.freeze({ [firstBundleKey]: Object.freeze({
                ...currentBundle,
                [PLUGIN_UI_CONTRIBUTION_ORIGIN_KEY]: Object.freeze({ ...currentOrigin, interactionEnabled }),
            }) }),
        });

        expect(resolve(withOrigin(true))).toMatchObject([{
            pluginId, occurrenceId: currentAction.occurrenceId, target, executionOrigin: origin,
        }]);
        expect(resolve(withOrigin(false))).toEqual([]);
    });

    it('groups every current Action sharing one exact executable target into one activation input', () => {
        const resolved = resolve(projection());

        expect(resolved).toHaveLength(1);
        expect(resolved[0]).toMatchObject({
            pluginId,
            target,
            executionOrigin: origin,
            contributes: {
                actions: [
                    expect.objectContaining({ id: 'open-first' }),
                    expect.objectContaining({ id: 'open-second' }),
                ],
            },
        });
    });

    it('retains exact source provenance for client registration and rejects another machine', () => {
        const current = singleActionProjection();
        const sourceOrigin = { serverIdentityId: origin.serverIdentityId, sourceRef: {
            pluginId, machineId: hostOrigin.machineId,
            sourceCustody: { kind: 'development' as const, registeredRootId: 'registered-source' },
        } };
        const sourceHost = { ...hostOrigin, executionOrigin: sourceOrigin };
        const projected = { ...current,
            actionsById: { [firstActionKey]: { ...firstAction(current), [PLUGIN_UI_CONTRIBUTION_ORIGIN_KEY]: sourceHost } },
            reactNativeBundlesById: { [firstBundleKey]: { ...firstBundle(current), [PLUGIN_UI_CONTRIBUTION_ORIGIN_KEY]: sourceHost } },
        } satisfies PluginUiProjectionModel;
        expect(resolve(projected)).toMatchObject([{ executionOrigin: sourceOrigin, authority: { machineId: hostOrigin.machineId } }]);
        const foreignHost = { ...sourceHost, executionOrigin: { ...sourceOrigin,
            sourceRef: { ...sourceOrigin.sourceRef, machineId: 'another-machine' } } };
        expect(resolve({ ...projected,
            actionsById: { [firstActionKey]: { ...firstAction(current), [PLUGIN_UI_CONTRIBUTION_ORIGIN_KEY]: foreignHost } },
        })).toEqual([]);
    });

    it('routes an originless bundled Action through its projecting daemon', () => {
        // A bundled or development plugin has no materialization: its union
        // stamp names only the projecting daemon, which is also its route.
        const originless = Object.freeze({ ...hostOrigin, executionOrigin: null });
        const current = singleActionProjection();
        const projected = Object.freeze({
            ...current,
            actionsById: Object.freeze({
                [firstActionKey]: { ...firstAction(current), [PLUGIN_UI_CONTRIBUTION_ORIGIN_KEY]: originless },
            }),
            reactNativeBundlesById: Object.freeze({
                [firstBundleKey]: { ...firstBundle(current), [PLUGIN_UI_CONTRIBUTION_ORIGIN_KEY]: originless },
            }),
        }) satisfies PluginUiProjectionModel;

        const resolved = resolve(projected);

        expect(resolved).toHaveLength(1);
        expect(resolved[0]).toMatchObject({
            pluginId,
            executionOrigin: null,
            authority: { machineId: hostOrigin.machineId, serverId: hostOrigin.serverId },
        });

        // An origin, when present, must still live on the projecting daemon.
        const elsewhere = Object.freeze({
            ...hostOrigin,
            executionOrigin: {
                ...origin,
                materializationRef: { ...origin.materializationRef, machineId: 'machine-other' },
            },
        });
        expect(resolve(Object.freeze({
            ...projected,
            actionsById: Object.freeze({
                [firstActionKey]: { ...firstAction(current), [PLUGIN_UI_CONTRIBUTION_ORIGIN_KEY]: elsewhere },
            }),
            reactNativeBundlesById: Object.freeze({
                [firstBundleKey]: { ...firstBundle(current), [PLUGIN_UI_CONTRIBUTION_ORIGIN_KEY]: elsewhere },
            }),
        }) satisfies PluginUiProjectionModel)).toEqual([]);
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
                        executionOrigin: Object.freeze({
                            ...origin,
                            materializationRef: Object.freeze({
                                ...origin.materializationRef,
                                materializationId: 'another-install',
                            }),
                        }),
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

});
