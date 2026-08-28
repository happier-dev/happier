import { describe, expect, it, vi } from 'vitest';

import {
    preparePluginJsonSchema,
} from '@happier-dev/protocol';
import {
    definePlugin,
    type JsonValue,
} from '@happier-dev/plugin-sdk';
import {
    CHANNELS_PROVIDER_POINT_REF,
} from '@happier-dev/plugins-channels/manifest';
import { PLUGIN_MANIFEST as CHANNELS_PLUGIN_MANIFEST } from '@happier-dev/plugins-channels';
import { PLUGIN_MANIFEST as TELEGRAM_PLUGIN_MANIFEST } from '@happier-dev/plugins-channel-telegram';
import { PLUGIN_MANIFEST as GITHUB_PLUGIN_MANIFEST } from '@happier-dev/plugins-scm-github';
import {
    defineContributionProtocol,
} from '@happier-dev/plugin-sdk/contributions';
import {
    defineProtocolJsonValue,
    defineProtocolObject,
    defineProtocolString,
} from '@happier-dev/plugin-sdk/protocol';
import type { ResolvedExecutablePluginRuntimeRegistry } from '../../resolveExecutablePluginRuntimeRegistry';
import {
    createResolvedContributionRegistry,
} from '@/plugins/projection/registry/createResolvedContributionRegistry';
import type { LoadedPlugin } from '@/plugins/discovery/load/installed';
import { ingestCanonicalPluginManifest } from '@/plugins/manifest/ingest';
import type {
    AdmittedTargetedContributionSnapshot,
    ResolvedContributionRegistry,
} from '@/plugins/projection/registry/types';
import { projectLoadedPluginContributes } from '@/plugins/projection/registry/resolvePluginContributions';
import { createPluginReloadController } from '../../reload/controller';
import type { PluginCompatibilityDiagnostic } from '@/plugins/validation/diagnostics/types';

import {
    createReloadControllerTargetedContributionsService,
    createTargetedContributionsService,
} from './targetedContributions';
import {
    createPluginInvocationActionsService,
    type InvokeContributedAction,
} from './actions';
import { createPluginActionCallerMaterializationFixture } from './actionCaller.testkit';

type Contribution = Readonly<{ id: string }>;

function permissiveTargetProtocol(role: string) {
    return Object.freeze({
        role,
        input: Object.freeze({ kind: 'contributorDefined' as const }),
        resultSchema: defineProtocolJsonValue(),
    });
}

function expectBundledGitHubMissingTriageDiagnostic(
    registry: Pick<ResolvedExecutablePluginRuntimeRegistry, 'pluginDiagnosticsByPluginId'>,
): void {
    expect(registry.pluginDiagnosticsByPluginId).toEqual({
        'happier.scm.forge.github': [expect.objectContaining({
            code: 'target_absent',
            contribution: {
                pluginId: 'happier.scm.forge.github',
                localId: 'github-forge',
            },
            details: expect.objectContaining({
                targetPluginId: 'happier.triage',
                pointId: 'sources',
            }),
        })],
    });
}

const admittedSurfaceDescriptorSchema = defineProtocolObject({
    label: defineProtocolString({ minLength: 1 }),
}, { policy: 'closed' });
const admittedSurfaceInputSchema = defineProtocolObject({
    entryId: defineProtocolString({ minLength: 1 }),
}, { policy: 'closed' });
const admittedSurfaceInputValidation = preparePluginJsonSchema(admittedSurfaceInputSchema.jsonSchema);
const admittedSurfaceTargetProtocol = Object.freeze({
    role: 'detail',
    inputSchema: admittedSurfaceInputSchema,
    presentation: 'content' as const,
});
const admittedSurfaceProtocol = defineContributionProtocol({
    id: 'example-admitted-surface',
    version: 1,
    descriptor: admittedSurfaceDescriptorSchema,
    operations: {},
    surfaces: {
        detail: {
            required: true,
            inputSchema: admittedSurfaceInputSchema,
            presentation: 'content',
        },
    },
});
const admittedSurfaceTarget = definePlugin({
    id: 'acme.target',
    version: '0.1.0',
    contributionPoints: {
        providers: admittedSurfaceProtocol.point(),
    },
});
const admittedOperationResultSchema = defineProtocolObject({}, { policy: 'closed' });
const admittedOperationProtocol = defineContributionProtocol({
    id: 'example-providers',
    version: 1,
    operations: {
        connect: {
            required: true,
            input: { kind: 'contributorDefined' },
            resultSchema: admittedOperationResultSchema,
            action: { surface: 'plugin', dangerLevel: 'safe' },
        },
    },
});
const admittedOperationTarget = definePlugin({
    id: 'acme.target',
    version: '0.1.0',
    contributionPoints: {
        providers: admittedOperationProtocol.point(),
    },
});

type BundledChannelsPluginFixture = Readonly<{
    manifest: unknown;
    packageName: string;
    immutableGenerationId: string;
}>;

const BUNDLED_CHANNELS_TARGET = Object.freeze({
    manifest: CHANNELS_PLUGIN_MANIFEST,
    packageName: '@happier-dev/plugins-channels',
    immutableGenerationId: 'channels-generation-a',
} satisfies BundledChannelsPluginFixture);
const BUNDLED_TELEGRAM_PROVIDER = Object.freeze({
    manifest: TELEGRAM_PLUGIN_MANIFEST,
    packageName: '@happier-dev/plugins-channel-telegram',
    immutableGenerationId: 'telegram-generation-a',
} satisfies BundledChannelsPluginFixture);
const BUNDLED_GITHUB_PROVIDER = Object.freeze({
    manifest: GITHUB_PLUGIN_MANIFEST,
    packageName: '@happier-dev/plugins-scm-github',
    immutableGenerationId: 'github-generation-a',
} satisfies BundledChannelsPluginFixture);

function readBundledChannelsProviderPlugin(
    params: BundledChannelsPluginFixture,
): LoadedPlugin {
    const ingested = ingestCanonicalPluginManifest(params.manifest, { sourceProvenance: 'localSource',
        manifestAuthority: 'bundled_first_party',
        enforceEngineCompatibility: false,
    });
    if (!ingested.ok) {
        throw new Error(ingested.diagnostics.map((diagnostic) => diagnostic.code).join(', '));
    }
    return {
        pluginId: ingested.manifest.id,
        pluginRootPath: params.packageName,
        manifestPath: `bundled:${ingested.manifest.id}`,
        daemonEntryPath: params.packageName,
        devDaemonEntryPath: null,
        manifest: ingested.manifest,
        sourceSpec: {
            kind: 'bundled',
            locator: params.packageName,
            trustPolicy: 'local_trusted',
            installPolicy: 'link',
            resolvedVersion: ingested.manifest.version,
        },
    };
}

function resolveRealChannelsProviderRegistry(params: Readonly<{
    providerPlugins?: readonly BundledChannelsPluginFixture[];
}> = {}): ResolvedContributionRegistry {
    const declarations = [
        BUNDLED_CHANNELS_TARGET,
        ...(params.providerPlugins ?? [
            BUNDLED_TELEGRAM_PROVIDER,
            BUNDLED_GITHUB_PROVIDER,
        ]),
    ];
    const loadedPlugins = declarations.map(readBundledChannelsProviderPlugin);
    const projected = projectLoadedPluginContributes({
        loadResult: {
            loadedPlugins,
            diagnosticsByPluginId: {},
        },
        provenance: 'first_party',
    });
    return createResolvedContributionRegistry({
        ...projected,
        immutableGenerationIdsByPluginId: Object.fromEntries(
            loadedPlugins.map((plugin, index) => [
                plugin.pluginId,
                declarations[index]!.immutableGenerationId,
            ]),
        ),
    });
}

function deferred<T>() {
    let resolve!: (value: T) => void;
    let reject!: (reason?: unknown) => void;
    const promise = new Promise<T>((nextResolve, nextReject) => {
        resolve = nextResolve;
        reject = nextReject;
    });
    return { promise, resolve, reject };
}

function createSubject(options?: Readonly<{
    read?: () => Promise<readonly Contribution[]>;
}>) {
    let invalidate: (() => void) | null = null;
    const target = new AbortController();
    const read = vi.fn(options?.read ?? (async () => Object.freeze([{ id: 'first' }] as const)));
    const unsubscribe = vi.fn();
    const owner = createTargetedContributionsService({
        subscribeToCatalogChanges(listener) {
            invalidate = listener;
            return unsubscribe;
        },
        async readAdmittedSnapshot({ signal }) {
            signal?.throwIfAborted();
            return Object.freeze({
                generation: '17',
                contributions: Object.freeze([...(await read())]),
            });
        },
    });
    const service = owner.bind({
        pluginId: 'acme.target',
        signal: target.signal,
        isCurrent: () => !target.signal.aborted,
    });
    return {
        owner,
        service,
        target,
        read,
        unsubscribe,
        invalidate: () => invalidate?.(),
        registered: () => invalidate !== null,
    };
}

function runtimeRegistry(
    target: AbortController,
    retireLiveSubscriptionConsumers: NonNullable<
        ResolvedExecutablePluginRuntimeRegistry['retireLiveSubscriptionConsumers']
    > = vi.fn(),
    admittedTargetedSnapshot: AdmittedTargetedContributionSnapshot | null = null,
): ResolvedExecutablePluginRuntimeRegistry {
    const readAdmittedTargetedContributions = vi.fn(
        (_request: Parameters<NonNullable<
            ResolvedExecutablePluginRuntimeRegistry['readAdmittedTargetedContributions']
        >>[0]) => admittedTargetedSnapshot,
    );
    const pluginDiagnosticsByPluginId: Record<
        string,
        readonly PluginCompatibilityDiagnostic[]
    > = {};
    const registry = {
        contributes: {
            agents: Object.freeze([]),
            providers: Object.freeze([]),
            actions: Object.freeze([]),
            resources: Object.freeze([]),
            uiViewsV2: Object.freeze([]),
            uiRenderersV2: Object.freeze([]),
            uiTranslationsV2: Object.freeze([]),
            // This observation fixture never dispatches an activation; an empty
            // registry avoids inventing an incomplete activation target.
            activationTargets: Object.freeze([]),
            catalogEntriesById: Object.freeze({}),
            agentDefinitionsById: new Map(),
            pluginDiagnosticsByPluginId: Object.freeze({}),
        },
        hookHandlersByHookId: new Map(),
        agentRuntimesByAgentId: new Map(),
        scmHostingProvidersById: new Map(),
        pluginDiagnosticsByPluginId,
        readAdmittedTargetedContributions,
        activatedPluginIds: new Set(),
        activateContributionsOnDemand: vi.fn(async () => []),
        resolvePromptAssetBlocks: async () => [],
        retireConsumers: () => {},
        async retirePluginConsumers(pluginIds: readonly string[]) {
            if (pluginIds.includes('acme.target')) target.abort(new Error('target replaced'));
        },
        retireLiveSubscriptionConsumers,
        createAgentInvocationServices: async () => {
            throw new Error('Not used by targeted contribution observation');
        },
        retainActivationRegistryComponentsExcluding: () => Object.freeze([]),
        retainPreparedActivationRegistryComponents: () => Object.freeze([]),
        dispose: async () => {},
    } satisfies ResolvedExecutablePluginRuntimeRegistry;
    return registry;
}

function runtimeRegistryForResolvedContributions(
    target: AbortController,
    contributes: ResolvedContributionRegistry,
): ResolvedExecutablePluginRuntimeRegistry {
    const pluginDiagnosticsByPluginId: Record<
        string,
        readonly PluginCompatibilityDiagnostic[]
    > = {
        ...contributes.pluginDiagnosticsByPluginId,
    };
    return {
        contributes,
        hookHandlersByHookId: new Map(),
        agentRuntimesByAgentId: new Map(),
        scmHostingProvidersById: new Map(),
        pluginDiagnosticsByPluginId,
        readAdmittedTargetedContributions:
            contributes.readAdmittedTargetedContributions,
        activatedPluginIds: new Set(),
        activateContributionsOnDemand: vi.fn(async () => []),
        resolvePromptAssetBlocks: async () => [],
        retireConsumers: () => {},
        async retirePluginConsumers(pluginIds: readonly string[]) {
            if (pluginIds.includes('happier.channels')) {
                target.abort(new Error('target replaced'));
            }
        },
        retireLiveSubscriptionConsumers: () => {},
        createAgentInvocationServices: async () => {
            throw new Error('Not used by targeted contribution observation');
        },
        retainActivationRegistryComponentsExcluding: () => Object.freeze([]),
        retainPreparedActivationRegistryComponents: () => Object.freeze([]),
        dispose: async () => {},
    } satisfies ResolvedExecutablePluginRuntimeRegistry;
}

describe('targeted contribution observation service', () => {
    it('projects real bundled Telegram and GitHub providers through cold admission and the reload service', async () => {
        const target = new AbortController();
        const contributes = resolveRealChannelsProviderRegistry();
        const registry = runtimeRegistryForResolvedContributions(target, contributes);
        const controller = createPluginReloadController({
            resolveRuntimeRegistry: async () => registry,
        });
        const owner = createReloadControllerTargetedContributionsService({
            reloadController: controller,
        });
        const lease = await controller.acquireRuntimeRegistry();
        await lease.release();
        const observation = owner.bind({
            pluginId: 'happier.channels',
            signal: target.signal,
            isCurrent: () => !target.signal.aborted,
        }).observeForSelf(
            CHANNELS_PROVIDER_POINT_REF,
            { onInvalidated: vi.fn() },
        );

        const snapshot = await observation.readCurrent();

        expect(snapshot.generation).toBe('channels-generation-a');
        expect(snapshot.contributions.map((contribution) => contribution.contributor)).toEqual([
            {
                pluginId: 'happier.channel.telegram',
                contributionId: 'telegram-provider',
                immutableGenerationId: 'telegram-generation-a',
            },
            {
                pluginId: 'happier.scm.forge.github',
                contributionId: 'github-repository',
                immutableGenerationId: 'github-generation-a',
            },
        ]);
        const telegram = snapshot.contributions[0]!;
        const github = snapshot.contributions[1]!;
        expect(telegram.operations.setup.identity).toMatchObject({
            target: { pluginId: 'happier.channels' },
            point: {
                pointId: 'providers',
                protocol: { id: 'happier.channels/providers', version: 1 },
            },
            contributor: telegram.contributor,
            role: 'setup',
        });
        const githubPrincipalResolve = github.operations.principalResolve;
        if (!githubPrincipalResolve) throw new Error('Expected GitHub principal-resolve operation');
        expect(githubPrincipalResolve.identity).toMatchObject({
            contributor: github.contributor,
            role: 'principalResolve',
        });
        expectBundledGitHubMissingTriageDiagnostic(registry);

        observation.dispose();
        await controller.shutdown();
    });

    it('projects the registry semantic snapshot even when a target runtime ref has no carrier', async () => {
        const target = new AbortController();
        const contributes = resolveRealChannelsProviderRegistry();
        const registry = runtimeRegistryForResolvedContributions(target, contributes);
        const controller = createPluginReloadController({
            resolveRuntimeRegistry: async () => registry,
        });
        const owner = createReloadControllerTargetedContributionsService({
            reloadController: controller,
        });
        const lease = await controller.acquireRuntimeRegistry();
        await lease.release();
        // The registry already admitted the canonical manifest snapshot before
        // publishing this view. A caller's public point ref therefore does not
        // become a second late semantic decoder input.
        const carrierlessPoint = Object.freeze({ ...CHANNELS_PROVIDER_POINT_REF });
        const observation = owner.bind({
            pluginId: 'happier.channels',
            signal: target.signal,
            isCurrent: () => !target.signal.aborted,
        }).observeForSelf(
            carrierlessPoint,
            { onInvalidated: vi.fn() },
        );

        const snapshot = await observation.readCurrent();
        expect(snapshot.generation).toBe('channels-generation-a');
        expect(snapshot.contributions.map((contribution) => contribution.contributor.pluginId))
            .toEqual(['happier.channel.telegram', 'happier.scm.forge.github']);
        expectBundledGitHubMissingTriageDiagnostic(registry);

        observation.dispose();
        await controller.shutdown();
    });

    it('does not reinterpret an admitted snapshot from a caller-visible structural target ref', async () => {
        const target = new AbortController();
        const visiblePoint = Object.freeze({ ...admittedSurfaceTarget.contributionPoints.providers });
        const firstContributor = Object.freeze({
            pluginId: 'acme.v2.first',
            contributionId: 'first',
            immutableGenerationId: 'immutable-first-a',
        });
        const secondContributor = Object.freeze({
            pluginId: 'acme.v2.second',
            contributionId: 'second',
            immutableGenerationId: 'immutable-second-a',
        });
        const v2Protocol = Object.freeze({
            id: 'example-admitted-surface',
            version: 2,
        });
        const registry = runtimeRegistry(target, vi.fn(), Object.freeze({
            target: Object.freeze({
                pluginId: 'acme.target',
                pointId: 'providers',
                immutableGenerationId: 'immutable-target-a',
            }),
            contributions: Object.freeze([
                Object.freeze({
                    contributor: firstContributor,
                    protocol: v2Protocol,
                    descriptor: Object.freeze({ label: 'First' }),
                    operations: Object.freeze([]),
                    surfaces: Object.freeze([Object.freeze({
                        role: 'detail',
                        inputSchema: admittedSurfaceInputSchema.jsonSchema,
                        inputValidation: admittedSurfaceInputValidation,
                        targetProtocol: admittedSurfaceTargetProtocol,
                        presentation: 'content' as const,
                        rendererChain: Object.freeze([]),
                        contributor: firstContributor,
                    })]),
                }),
                Object.freeze({
                    contributor: secondContributor,
                    protocol: v2Protocol,
                    descriptor: Object.freeze({ label: 'Second' }),
                    operations: Object.freeze([]),
                    surfaces: Object.freeze([Object.freeze({
                        role: 'detail',
                        inputSchema: admittedSurfaceInputSchema.jsonSchema,
                        inputValidation: admittedSurfaceInputValidation,
                        targetProtocol: admittedSurfaceTargetProtocol,
                        presentation: 'content' as const,
                        rendererChain: Object.freeze([]),
                        contributor: secondContributor,
                    })]),
                }),
            ]),
        }));
        const controller = createPluginReloadController({
            resolveRuntimeRegistry: async () => registry,
        });
        const owner = createReloadControllerTargetedContributionsService({
            reloadController: controller,
        });
        const lease = await controller.acquireRuntimeRegistry();
        await lease.release();
        const observation = owner.bind({
            pluginId: 'acme.target',
            signal: target.signal,
            isCurrent: () => !target.signal.aborted,
        }).observeForSelf(
            visiblePoint,
            { onInvalidated: vi.fn() },
        );

        const snapshot = await observation.readCurrent();
        expect(snapshot.generation).toBe('immutable-target-a');
        expect(snapshot.contributions).toHaveLength(2);
        expect(snapshot.contributions[0]).toMatchObject({
            contributor: { pluginId: 'acme.v2.first' },
        });
        expect(snapshot.contributions[1]).toMatchObject({
            contributor: { pluginId: 'acme.v2.second' },
        });
        expect(registry.pluginDiagnosticsByPluginId).toEqual({});

        observation.dispose();
        await controller.shutdown();
    });

    it('does not synthesize contributor semantic diagnostics from a bypassed raw fixture', async () => {
        const target = new AbortController();
        const descriptorContributor = Object.freeze({
            pluginId: 'acme.descriptor',
            contributionId: 'descriptor',
            immutableGenerationId: 'immutable-descriptor-a',
        });
        const surfaceContributor = Object.freeze({
            pluginId: 'acme.surface',
            contributionId: 'surface',
            immutableGenerationId: 'immutable-surface-a',
        });
        const pointContributor = Object.freeze({
            pluginId: 'acme.point',
            contributionId: 'point',
            immutableGenerationId: 'immutable-point-a',
        });
        const expectedProtocol = Object.freeze({
            id: 'example-admitted-surface',
            version: 1,
        });
        const registry = runtimeRegistry(target, vi.fn(), Object.freeze({
            target: Object.freeze({
                pluginId: 'acme.target',
                pointId: 'providers',
                immutableGenerationId: 'immutable-target-a',
            }),
            contributions: Object.freeze([
                Object.freeze({
                    contributor: descriptorContributor,
                    protocol: expectedProtocol,
                    descriptor: Object.freeze({ label: 42 }),
                    operations: Object.freeze([]),
                    surfaces: Object.freeze([Object.freeze({
                        role: 'detail',
                        inputSchema: admittedSurfaceInputSchema.jsonSchema,
                        inputValidation: admittedSurfaceInputValidation,
                        targetProtocol: admittedSurfaceTargetProtocol,
                        presentation: 'content' as const,
                        rendererChain: Object.freeze([]),
                        contributor: descriptorContributor,
                    })]),
                }),
                Object.freeze({
                    contributor: surfaceContributor,
                    protocol: expectedProtocol,
                    descriptor: Object.freeze({ label: 'Surface' }),
                    operations: Object.freeze([]),
                    surfaces: Object.freeze([]),
                }),
                Object.freeze({
                    contributor: pointContributor,
                    protocol: Object.freeze({
                        id: 'example-admitted-surface',
                        version: 2,
                    }),
                    descriptor: Object.freeze({ label: 'Point' }),
                    operations: Object.freeze([]),
                    surfaces: Object.freeze([Object.freeze({
                        role: 'detail',
                        inputSchema: admittedSurfaceInputSchema.jsonSchema,
                        inputValidation: admittedSurfaceInputValidation,
                        targetProtocol: admittedSurfaceTargetProtocol,
                        presentation: 'content' as const,
                        rendererChain: Object.freeze([]),
                        contributor: pointContributor,
                    })]),
                }),
            ]),
        }));
        const controller = createPluginReloadController({
            resolveRuntimeRegistry: async () => registry,
        });
        const owner = createReloadControllerTargetedContributionsService({
            reloadController: controller,
        });
        const lease = await controller.acquireRuntimeRegistry();
        await lease.release();
        const observation = owner.bind({
            pluginId: 'acme.target',
            signal: target.signal,
            isCurrent: () => !target.signal.aborted,
        }).observeForSelf(
            admittedSurfaceTarget.contributionPoints.providers,
            { onInvalidated: vi.fn() },
        );

        const snapshot = await observation.readCurrent();
        expect(snapshot.generation).toBe('immutable-target-a');
        expect(snapshot.contributions).toHaveLength(3);
        expect(snapshot.contributions[0]).toMatchObject({
            contributor: { pluginId: 'acme.descriptor' },
        });
        expect(snapshot.contributions[1]).toMatchObject({
            contributor: { pluginId: 'acme.surface' },
        });
        expect(snapshot.contributions[2]).toMatchObject({
            contributor: { pluginId: 'acme.point' },
        });
        expect(registry.pluginDiagnosticsByPluginId).toEqual({});

        observation.dispose();
        await controller.shutdown();
    });

    it('executes opaque real bundled-provider handles, including a typed arbitrary GitHub role', async () => {
        const target = new AbortController();
        const registry = runtimeRegistryForResolvedContributions(
            target,
            resolveRealChannelsProviderRegistry(),
        );
        const controller = createPluginReloadController({
            resolveRuntimeRegistry: async () => registry,
        });
        const owner = createReloadControllerTargetedContributionsService({
            reloadController: controller,
        });
        const lease = await controller.acquireRuntimeRegistry();
        await lease.release();
        const observation = owner.bind({
            pluginId: 'happier.channels',
            signal: target.signal,
            isCurrent: () => !target.signal.aborted,
        }).observeForSelf(
            CHANNELS_PROVIDER_POINT_REF,
            { onInvalidated: vi.fn() },
        );
        const snapshot = await observation.readCurrent();
        const telegram = snapshot.contributions.find((contribution) => (
            contribution.contributor.pluginId === 'happier.channel.telegram'
        ));
        const github = snapshot.contributions.find((contribution) => (
            contribution.contributor.pluginId === 'happier.scm.forge.github'
        ));
        if (!telegram || !github) throw new Error('Expected real bundled provider contributions');
        const githubPrincipalResolve = github.operations.principalResolve;
        if (!githubPrincipalResolve) throw new Error('Expected GitHub principal-resolve operation');

        const setupOutcome = Object.freeze({
            kind: 'requiresRemediation' as const,
        }) satisfies JsonValue;
        const principalResolveOutcome = Object.freeze({
            kind: 'resolved' as const,
            candidates: Object.freeze([]),
        }) satisfies JsonValue;
        const invokeContributedAction = vi.fn<InvokeContributedAction>(async (request) => ({
            status: 'executed' as const,
            value: request.action.localId === 'github/inspect-principal'
                ? principalResolveOutcome
                : setupOutcome,
        }));
        const callerMaterialization = createPluginActionCallerMaterializationFixture(
            'happier.channels',
        );
        const actions = createPluginInvocationActionsService({
            seed: {
                plugin: { id: 'happier.channels', version: '0.0.0' },
                contribution: {
                    id: 'connections',
                    qualifiedId: 'happier.channels/actions/connections',
                },
                generation: 'channels-runtime-generation-a',
                immutableGenerationId: 'channels-generation-a',
                surface: 'plugin',
                resolveCurrentPluginMaterializationRef:
                    callerMaterialization.resolveCurrentPluginMaterializationRef,
                signal: target.signal,
                isGenerationCurrent: () => !target.signal.aborted,
            },
            actionExecutor: { execute: vi.fn() },
            invokeContributedAction,
        });
        const telegramSetupInput = Object.freeze({
            credentialRef: Object.freeze({
                service: Object.freeze({
                    pluginId: 'happier.channel.telegram',
                    localId: 'telegram-bot',
                }),
                accountId: 'telegram-account-a',
            }),
        }) satisfies JsonValue;
        const githubSetupInput = Object.freeze({
            credentialRef: Object.freeze({
                service: Object.freeze({
                    pluginId: 'happier.scm.forge.github',
                    localId: 'github-account',
                }),
                accountId: 'github-account-a',
            }),
            repository: 'happier-dev/happier',
        }) satisfies JsonValue;
        const githubPrincipalResolveInput = Object.freeze({
            v: 1,
            connectionId: 'connection-a',
            providerConnectionKey: 'github:repository:77',
            providerConfigVersion: 1,
            providerConfig: Object.freeze({
                v: 1,
                repository: Object.freeze({
                    v: 1,
                    repositoryId: '77',
                    owner: 'happier-dev',
                    name: 'happier',
                    nameWithOwner: 'happier-dev/happier',
                }),
                integrationPrincipal: Object.freeze({
                    id: '99',
                    label: 'happier-bot',
                }),
            }),
            credentialRef: githubSetupInput.credentialRef,
            endpoint: Object.freeze({
                kind: 'githubIssue',
                audience: 'shared',
                id: 'github:repository:77:issue:5:number:1',
                label: '#1 Issue title',
                parentId: '77',
                parentLabel: 'happier-dev/happier',
            }),
            query: 'octocat',
        }) satisfies JsonValue;

        await expect(actions.executeAdmittedTargetedOperation(
            telegram.operations.setup,
            telegramSetupInput,
        )).resolves.toEqual(setupOutcome);
        await expect(actions.executeAdmittedTargetedOperation(
            github.operations.setup,
            githubSetupInput,
        )).resolves.toEqual(setupOutcome);
        await expect(actions.executeAdmittedTargetedOperation(
            githubPrincipalResolve,
            githubPrincipalResolveInput,
        )).resolves.toEqual(principalResolveOutcome);

        expect(invokeContributedAction).toHaveBeenNthCalledWith(1, expect.objectContaining({
            action: {
                pluginId: 'happier.channel.telegram',
                localId: 'telegram/prepare-bot',
            },
            input: telegramSetupInput,
            admittedTargetedOperation: expect.objectContaining({
                contributorImmutableGenerationId: 'telegram-generation-a',
            }),
        }));
        expect(invokeContributedAction).toHaveBeenNthCalledWith(2, expect.objectContaining({
            action: {
                pluginId: 'happier.scm.forge.github',
                localId: 'github/prepare-repository',
            },
            input: githubSetupInput,
            admittedTargetedOperation: expect.objectContaining({
                contributorImmutableGenerationId: 'github-generation-a',
            }),
        }));
        expect(invokeContributedAction).toHaveBeenNthCalledWith(3, expect.objectContaining({
            action: {
                pluginId: 'happier.scm.forge.github',
                localId: 'github/inspect-principal',
            },
            input: githubPrincipalResolveInput,
            admittedTargetedOperation: expect.objectContaining({
                contributorImmutableGenerationId: 'github-generation-a',
            }),
        }));

        observation.dispose();
        await controller.shutdown();
    });

    it('rejects another target\'s point before reserving an observation', () => {
        const subject = createSubject();

        expect(() => subject.service.observeForSelf(
            { targetPluginId: 'acme.other', id: 'providers', protocol: { id: 'example-providers', version: 1 } },
            { onInvalidated: vi.fn() },
        )).toThrowError(expect.objectContaining({
            code: 'plugin_targeted_contributions_target_mismatch',
        }));

        expect(subject.registered()).toBe(false);
    });

    it('reserves the catalog invalidation subscription synchronously before its first complete snapshot read', async () => {
        const subject = createSubject();
        const invalidated = vi.fn();

        const observation = subject.service.observeForSelf(
            { targetPluginId: 'acme.target', id: 'providers', protocol: { id: 'example-providers', version: 1 } },
            { onInvalidated: invalidated },
        );

        expect(subject.registered()).toBe(true);
        expect(subject.read).not.toHaveBeenCalled();

        await expect(observation.readCurrent()).resolves.toEqual({
            generation: '17',
            contributions: [{ id: 'first' }],
        });
        expect(subject.read).toHaveBeenCalledOnce();
        expect(invalidated).not.toHaveBeenCalled();
    });

    it('guarantees one follow-up invalidation when a catalog replacement races an in-flight read', async () => {
        const pending = deferred<readonly Contribution[]>();
        const subject = createSubject({ read: async () => await pending.promise });
        const invalidated = vi.fn();
        const observation = subject.service.observeForSelf(
            { targetPluginId: 'acme.target', id: 'providers', protocol: { id: 'example-providers', version: 1 } },
            { onInvalidated: invalidated },
        );

        const firstRead = observation.readCurrent();
        await vi.waitFor(() => expect(subject.read).toHaveBeenCalledOnce());
        subject.invalidate();
        pending.resolve(Object.freeze([{ id: 'before-replacement' }]));

        await expect(firstRead).resolves.toEqual({
            generation: '17',
            contributions: [{ id: 'before-replacement' }],
        });
        await vi.waitFor(() => expect(invalidated).toHaveBeenCalledOnce());
    });

    it('coalesces repeated lifecycle changes into one level-triggered resync and disposes on target retirement', async () => {
        const subject = createSubject();
        const invalidated = vi.fn();
        const observation = subject.service.observeForSelf(
            { targetPluginId: 'acme.target', id: 'providers', protocol: { id: 'example-providers', version: 1 } },
            { onInvalidated: invalidated },
        );

        subject.invalidate();
        subject.invalidate();
        subject.invalidate();
        await vi.waitFor(() => expect(invalidated).toHaveBeenCalledOnce());

        await observation.readCurrent();
        subject.target.abort(new Error('target retired'));
        subject.invalidate();
        await Promise.resolve();

        expect(subject.unsubscribe).toHaveBeenCalledOnce();
        expect(invalidated).toHaveBeenCalledOnce();
        await expect(observation.readCurrent()).rejects.toMatchObject({
            code: 'plugin_generation_stale',
        });
    });

    it('projects the point-semantic descriptor and public surface handle from the exact admitted contributor', async () => {
        const target = new AbortController();
        const contributor = Object.freeze({
            pluginId: 'acme.contributor',
            contributionId: 'github',
            immutableGenerationId: 'immutable-contributor-a',
        });
        const registry = runtimeRegistry(target, vi.fn(), Object.freeze({
            target: Object.freeze({
                pluginId: 'acme.target',
                pointId: 'providers',
                immutableGenerationId: 'immutable-target-a',
            }),
            contributions: Object.freeze([Object.freeze({
                contributor,
                protocol: Object.freeze({
                    id: 'example-admitted-surface',
                    version: 1,
                }),
                descriptor: Object.freeze({ label: 'GitHub' }),
                operations: Object.freeze([]),
                surfaces: Object.freeze([Object.freeze({
                    role: 'detail',
                    inputSchema: admittedSurfaceInputSchema.jsonSchema,
                    inputValidation: admittedSurfaceInputValidation,
                    targetProtocol: admittedSurfaceTargetProtocol,
                    presentation: 'content' as const,
                    rendererChain: Object.freeze([]),
                    contributor,
                })]),
            })]),
        }));
        const controller = createPluginReloadController({
            resolveRuntimeRegistry: async () => registry,
        });
        const owner = createReloadControllerTargetedContributionsService({
            reloadController: controller,
        });
        const lease = await controller.acquireRuntimeRegistry();
        await lease.release();
        const observation = owner.bind({
            pluginId: 'acme.target',
            signal: target.signal,
            isCurrent: () => !target.signal.aborted,
        }).observeForSelf(
            admittedSurfaceTarget.contributionPoints.providers,
            { onInvalidated: vi.fn() },
        );

        await expect(observation.readCurrent()).resolves.toEqual({
            generation: 'immutable-target-a',
            contributions: [{
                contributor: {
                    pluginId: 'acme.contributor',
                    contributionId: 'github',
                    immutableGenerationId: 'immutable-contributor-a',
                },
                protocol: {
                    id: 'example-admitted-surface',
                    version: 1,
                },
                descriptor: { label: 'GitHub' },
                operations: {},
                surfaces: {
                    detail: {
                        point: {
                            pointId: 'providers',
                            protocol: {
                                id: 'example-admitted-surface',
                                version: 1,
                            },
                        },
                        contributor: {
                            pluginId: 'acme.contributor',
                            contributionId: 'github',
                            immutableGenerationId: 'immutable-contributor-a',
                        },
                        role: 'detail',
                        presentation: 'content',
                    },
                },
            }],
        });
        expect(registry.activateContributionsOnDemand).not.toHaveBeenCalled();

        observation.dispose();
        await controller.shutdown();
    });

    it('projects its received snapshot without mutating the canonical diagnostics map', async () => {
        const target = new AbortController();
        const contributor = Object.freeze({
            pluginId: 'acme.contributor',
            contributionId: 'github',
            immutableGenerationId: 'immutable-contributor-a',
        });
        const registry = runtimeRegistry(target, vi.fn(), Object.freeze({
            target: Object.freeze({
                pluginId: 'acme.target',
                pointId: 'providers',
                immutableGenerationId: 'immutable-target-a',
            }),
            contributions: Object.freeze([Object.freeze({
                contributor,
                protocol: Object.freeze({
                    id: 'example-admitted-surface',
                    version: 1,
                }),
                // The canonical registry would reject this descriptor. This
                // bypassed fixture proves the service does not become a
                // duplicate semantic owner after cold admission.
                descriptor: Object.freeze({ label: 42 }),
                operations: Object.freeze([]),
                surfaces: Object.freeze([Object.freeze({
                    role: 'detail',
                    inputSchema: admittedSurfaceInputSchema.jsonSchema,
                    inputValidation: admittedSurfaceInputValidation,
                    targetProtocol: admittedSurfaceTargetProtocol,
                    presentation: 'content' as const,
                    rendererChain: Object.freeze([]),
                    contributor,
                })]),
            })]),
        }));
        const controller = createPluginReloadController({
            resolveRuntimeRegistry: async () => registry,
        });
        const owner = createReloadControllerTargetedContributionsService({
            reloadController: controller,
        });
        const lease = await controller.acquireRuntimeRegistry();
        await lease.release();
        const observation = owner.bind({
            pluginId: 'acme.target',
            signal: target.signal,
            isCurrent: () => !target.signal.aborted,
        }).observeForSelf(
            admittedSurfaceTarget.contributionPoints.providers,
            { onInvalidated: vi.fn() },
        );

        const firstSnapshot = await observation.readCurrent();
        expect(firstSnapshot).toMatchObject({
            generation: 'immutable-target-a',
            contributions: [{ descriptor: { label: 42 } }],
        });
        expect(registry.pluginDiagnosticsByPluginId).toEqual({});

        const cleanSnapshot = Object.freeze({
            ...registry,
            readAdmittedTargetedContributions: () => Object.freeze({
                target: Object.freeze({
                    pluginId: 'acme.target',
                    pointId: 'providers',
                    immutableGenerationId: 'immutable-target-a',
                }),
                contributions: Object.freeze([]),
            }),
        });
        await controller.adoptPreparedRuntimeRegistry({
            registry: cleanSnapshot,
            changedPluginIds: ['acme.contributor'],
            durableRevision: 1,
            runningSessionDisposition: 'retainRunningSessions',
        });
        await expect(observation.readCurrent()).resolves.toEqual({
            generation: 'immutable-target-a',
            contributions: [],
        });
        expect(cleanSnapshot.pluginDiagnosticsByPluginId).toEqual({});
        expect(registry.activateContributionsOnDemand).not.toHaveBeenCalled();

        observation.dispose();
        await controller.shutdown();
    });

    it('uses one stable reload observation from empty through contributor install, update, and uninstall without retiring the target', async () => {
        const target = new AbortController();
        const retireLiveA = vi.fn();
        const contributorA = Object.freeze({
            pluginId: 'acme.contributor',
            contributionId: 'provider',
            immutableGenerationId: 'immutable-contributor-a',
        });
        const registryInitiallyEmpty = runtimeRegistry(target, retireLiveA, Object.freeze({
            target: Object.freeze({
                pluginId: 'acme.target',
                pointId: 'providers',
                immutableGenerationId: 'immutable-target-a',
            }),
            contributions: Object.freeze([]),
        }));
        const registryAfterContributorInstall = runtimeRegistry(new AbortController(), vi.fn(), Object.freeze({
            // A contributor install keeps the target generation stable and
            // arrives through the observation that was reserved while empty.
            target: Object.freeze({
                pluginId: 'acme.target',
                pointId: 'providers',
                immutableGenerationId: 'immutable-target-a',
            }),
            contributions: Object.freeze([Object.freeze({
                contributor: contributorA,
                protocol: Object.freeze({ id: 'example-providers', version: 1 }),
                operations: Object.freeze([Object.freeze({
                    role: 'connect',
                    action: Object.freeze({ pluginId: 'acme.contributor', localId: 'connect-a' }),
                    contributor: contributorA,
                    selectedActionInput: Object.freeze({ kind: 'none' as const }),
                    targetProtocol: permissiveTargetProtocol('connect'),
                })]),
                surfaces: Object.freeze([]),
            })]),
        }));
        const contributorB = Object.freeze({
            pluginId: 'acme.contributor',
            contributionId: 'provider',
            immutableGenerationId: 'immutable-contributor-b',
        });
        const registryAfterContributorUpdate = runtimeRegistry(new AbortController(), vi.fn(), Object.freeze({
            // A contributor replacement keeps the target generation stable.
            target: Object.freeze({
                pluginId: 'acme.target',
                pointId: 'providers',
                immutableGenerationId: 'immutable-target-a',
            }),
            contributions: Object.freeze([Object.freeze({
                contributor: contributorB,
                protocol: Object.freeze({ id: 'example-providers', version: 1 }),
                operations: Object.freeze([Object.freeze({
                    role: 'connect',
                    action: Object.freeze({ pluginId: 'acme.contributor', localId: 'connect-b' }),
                    contributor: contributorB,
                    selectedActionInput: Object.freeze({ kind: 'none' as const }),
                    targetProtocol: permissiveTargetProtocol('connect'),
                })]),
                surfaces: Object.freeze([]),
            })]),
        }));
        const registryAfterContributorUninstall = runtimeRegistry(
            new AbortController(),
            vi.fn(),
            Object.freeze({
                // A contributor uninstall also keeps the target generation
                // stable, but its next complete snapshot has no contribution.
                target: Object.freeze({
                    pluginId: 'acme.target',
                    pointId: 'providers',
                    immutableGenerationId: 'immutable-target-a',
                }),
                contributions: Object.freeze([]),
            }),
        );
        const controller = createPluginReloadController({
            resolveRuntimeRegistry: async () => registryInitiallyEmpty,
        });
        const subscribe = vi.spyOn(controller, 'subscribe');
        const owner = createReloadControllerTargetedContributionsService({
            reloadController: controller,
        });
        const lease = await controller.acquireRuntimeRegistry();
        await lease.release();
        const service = owner.bind({
            pluginId: 'acme.target',
            signal: target.signal,
            isCurrent: () => !target.signal.aborted,
        });
        const invalidated = vi.fn();
        const observation = service.observeForSelf(
            admittedOperationTarget.contributionPoints.providers,
            { onInvalidated: invalidated },
        );

        expect(subscribe).toHaveBeenCalledOnce();
        expect(registryInitiallyEmpty.readAdmittedTargetedContributions).not.toHaveBeenCalled();
        await expect(observation.readCurrent()).resolves.toEqual({
            generation: 'immutable-target-a',
            contributions: [],
        });
        expect(registryInitiallyEmpty.readAdmittedTargetedContributions).toHaveBeenCalledWith({
            targetPluginId: 'acme.target',
            pointId: 'providers',
            protocol: { id: 'example-providers', version: 1 },
        });
        expect(registryInitiallyEmpty.activateContributionsOnDemand).not.toHaveBeenCalled();

        await controller.adoptPreparedRuntimeRegistry({
            registry: registryAfterContributorInstall,
            changedPluginIds: ['acme.contributor'],
            durableRevision: 1,
            runningSessionDisposition: 'retainRunningSessions',
        });

        await vi.waitFor(() => expect(invalidated).toHaveBeenCalledOnce());
        expect(retireLiveA).toHaveBeenCalledOnce();
        expect(target.signal.aborted).toBe(false);
        await expect(observation.readCurrent()).resolves.toEqual({
            generation: 'immutable-target-a',
            contributions: [{
                contributor: {
                    pluginId: 'acme.contributor',
                    contributionId: 'provider',
                    immutableGenerationId: 'immutable-contributor-a',
                },
                protocol: { id: 'example-providers', version: 1 },
                operations: {
                    connect: {
                        identity: {
                            target: { pluginId: 'acme.target' },
                            point: {
                                pointId: 'providers',
                                protocol: { id: 'example-providers', version: 1 },
                            },
                            contributor: {
                                pluginId: 'acme.contributor',
                                contributionId: 'provider',
                                immutableGenerationId: 'immutable-contributor-a',
                            },
                            role: 'connect',
                        },
                    },
                },
                surfaces: {},
            }],
        });
        expect(registryAfterContributorInstall.activateContributionsOnDemand).not.toHaveBeenCalled();

        await controller.adoptPreparedRuntimeRegistry({
            registry: registryAfterContributorUpdate,
            changedPluginIds: ['acme.contributor'],
            durableRevision: 2,
            runningSessionDisposition: 'retainRunningSessions',
        });

        await vi.waitFor(() => expect(invalidated).toHaveBeenCalledTimes(2));
        expect(target.signal.aborted).toBe(false);
        await expect(observation.readCurrent()).resolves.toEqual({
            generation: 'immutable-target-a',
            contributions: [{
                contributor: {
                    pluginId: 'acme.contributor',
                    contributionId: 'provider',
                    immutableGenerationId: 'immutable-contributor-b',
                },
                protocol: { id: 'example-providers', version: 1 },
                operations: {
                    connect: {
                        identity: {
                            target: { pluginId: 'acme.target' },
                            point: {
                                pointId: 'providers',
                                protocol: { id: 'example-providers', version: 1 },
                            },
                            contributor: {
                                pluginId: 'acme.contributor',
                                contributionId: 'provider',
                                immutableGenerationId: 'immutable-contributor-b',
                            },
                            role: 'connect',
                        },
                    },
                },
                surfaces: {},
            }],
        });
        expect(registryAfterContributorUpdate.activateContributionsOnDemand).not.toHaveBeenCalled();

        await controller.adoptPreparedRuntimeRegistry({
            registry: registryAfterContributorUninstall,
            changedPluginIds: ['acme.contributor'],
            durableRevision: 3,
            runningSessionDisposition: 'retainRunningSessions',
        });

        await vi.waitFor(() => expect(invalidated).toHaveBeenCalledTimes(3));
        expect(target.signal.aborted).toBe(false);
        await expect(observation.readCurrent()).resolves.toEqual({
            generation: 'immutable-target-a',
            contributions: [],
        });
        expect(registryAfterContributorUninstall.activateContributionsOnDemand).not.toHaveBeenCalled();

        observation.dispose();
        await controller.shutdown();
    });

    it('keeps one real bundled-provider observation current through install, update, uninstall, and reinstall', async () => {
        const target = new AbortController();
        const registryInitiallyEmpty = runtimeRegistryForResolvedContributions(
            target,
            resolveRealChannelsProviderRegistry({ providerPlugins: [] }),
        );
        const registryAfterInstall = runtimeRegistryForResolvedContributions(
            target,
            resolveRealChannelsProviderRegistry(),
        );
        const registryAfterUpdate = runtimeRegistryForResolvedContributions(
            target,
            resolveRealChannelsProviderRegistry({
                providerPlugins: [
                    Object.freeze({
                        ...BUNDLED_TELEGRAM_PROVIDER,
                        immutableGenerationId: 'telegram-generation-b',
                    }),
                    Object.freeze({
                        ...BUNDLED_GITHUB_PROVIDER,
                        immutableGenerationId: 'github-generation-b',
                    }),
                ],
            }),
        );
        const registryAfterUninstall = runtimeRegistryForResolvedContributions(
            target,
            resolveRealChannelsProviderRegistry({ providerPlugins: [] }),
        );
        const registryAfterReinstall = runtimeRegistryForResolvedContributions(
            target,
            resolveRealChannelsProviderRegistry({
                providerPlugins: [
                    Object.freeze({
                        ...BUNDLED_TELEGRAM_PROVIDER,
                        immutableGenerationId: 'telegram-generation-c',
                    }),
                    Object.freeze({
                        ...BUNDLED_GITHUB_PROVIDER,
                        immutableGenerationId: 'github-generation-c',
                    }),
                ],
            }),
        );
        const controller = createPluginReloadController({
            resolveRuntimeRegistry: async () => registryInitiallyEmpty,
        });
        const owner = createReloadControllerTargetedContributionsService({
            reloadController: controller,
        });
        const lease = await controller.acquireRuntimeRegistry();
        await lease.release();
        const invalidated = vi.fn();
        const observation = owner.bind({
            pluginId: 'happier.channels',
            signal: target.signal,
            isCurrent: () => !target.signal.aborted,
        }).observeForSelf(CHANNELS_PROVIDER_POINT_REF, { onInvalidated: invalidated });
        const readContributors = async () => (await observation.readCurrent()).contributions.map(
            (contribution) => contribution.contributor,
        );

        await expect(readContributors()).resolves.toEqual([]);

        await controller.adoptPreparedRuntimeRegistry({
            registry: registryAfterInstall,
            changedPluginIds: [
                'happier.channel.telegram',
                'happier.scm.forge.github',
            ],
            durableRevision: 1,
            runningSessionDisposition: 'retainRunningSessions',
        });
        await vi.waitFor(() => expect(invalidated).toHaveBeenCalledOnce());
        expect(target.signal.aborted).toBe(false);
        await expect(readContributors()).resolves.toEqual([
            {
                pluginId: 'happier.channel.telegram',
                contributionId: 'telegram-provider',
                immutableGenerationId: 'telegram-generation-a',
            },
            {
                pluginId: 'happier.scm.forge.github',
                contributionId: 'github-repository',
                immutableGenerationId: 'github-generation-a',
            },
        ]);

        await controller.adoptPreparedRuntimeRegistry({
            registry: registryAfterUpdate,
            changedPluginIds: [
                'happier.channel.telegram',
                'happier.scm.forge.github',
            ],
            durableRevision: 2,
            runningSessionDisposition: 'retainRunningSessions',
        });
        await vi.waitFor(() => expect(invalidated).toHaveBeenCalledTimes(2));
        expect(target.signal.aborted).toBe(false);
        await expect(readContributors()).resolves.toEqual([
            {
                pluginId: 'happier.channel.telegram',
                contributionId: 'telegram-provider',
                immutableGenerationId: 'telegram-generation-b',
            },
            {
                pluginId: 'happier.scm.forge.github',
                contributionId: 'github-repository',
                immutableGenerationId: 'github-generation-b',
            },
        ]);

        await controller.adoptPreparedRuntimeRegistry({
            registry: registryAfterUninstall,
            changedPluginIds: [
                'happier.channel.telegram',
                'happier.scm.forge.github',
            ],
            durableRevision: 3,
            runningSessionDisposition: 'retainRunningSessions',
        });
        await vi.waitFor(() => expect(invalidated).toHaveBeenCalledTimes(3));
        expect(target.signal.aborted).toBe(false);
        await expect(readContributors()).resolves.toEqual([]);

        await controller.adoptPreparedRuntimeRegistry({
            registry: registryAfterReinstall,
            changedPluginIds: [
                'happier.channel.telegram',
                'happier.scm.forge.github',
            ],
            durableRevision: 4,
            runningSessionDisposition: 'retainRunningSessions',
        });
        await vi.waitFor(() => expect(invalidated).toHaveBeenCalledTimes(4));
        expect(target.signal.aborted).toBe(false);
        await expect(readContributors()).resolves.toEqual([
            {
                pluginId: 'happier.channel.telegram',
                contributionId: 'telegram-provider',
                immutableGenerationId: 'telegram-generation-c',
            },
            {
                pluginId: 'happier.scm.forge.github',
                contributionId: 'github-repository',
                immutableGenerationId: 'github-generation-c',
            },
        ]);
        expect(registryInitiallyEmpty.activateContributionsOnDemand).not.toHaveBeenCalled();
        expect(registryAfterInstall.activateContributionsOnDemand).not.toHaveBeenCalled();
        expect(registryAfterUpdate.activateContributionsOnDemand).not.toHaveBeenCalled();
        expect(registryAfterUninstall.activateContributionsOnDemand).not.toHaveBeenCalled();
        expect(registryAfterReinstall.activateContributionsOnDemand).not.toHaveBeenCalled();

        observation.dispose();
        await controller.shutdown();
    });

    it('retires the observation when the real reload controller replaces its target generation', async () => {
        const target = new AbortController();
        const registryA = runtimeRegistry(target);
        const registryB = runtimeRegistry(new AbortController());
        const controller = createPluginReloadController({
            resolveRuntimeRegistry: async () => registryA,
        });
        const owner = createReloadControllerTargetedContributionsService({
            reloadController: controller,
        });
        const lease = await controller.acquireRuntimeRegistry();
        await lease.release();
        const observation = owner.bind({
            pluginId: 'acme.target',
            signal: target.signal,
            isCurrent: () => !target.signal.aborted,
        }).observeForSelf(
            { targetPluginId: 'acme.target', id: 'providers', protocol: { id: 'example-providers', version: 1 } },
            { onInvalidated: vi.fn() },
        );

        await controller.adoptPreparedRuntimeRegistry({
            registry: registryB,
            changedPluginIds: ['acme.target'],
            durableRevision: 1,
            runningSessionDisposition: 'retainRunningSessions',
        });

        expect(target.signal.aborted).toBe(true);
        await expect(observation.readCurrent()).rejects.toMatchObject({
            code: 'plugin_generation_stale',
        });
        await controller.shutdown();
    });
});
