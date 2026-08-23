import {
    type PluginMachineMaterializationRefV1,
} from '@happier-dev/protocol';
import type { JsonValue } from '@happier-dev/plugin-sdk';
import type { ActionHandler } from '@happier-dev/plugin-sdk/actions';
import {
    defineProtocolJsonValue,
    defineProtocolLiteral,
    defineProtocolObject,
} from '@happier-dev/plugin-sdk/protocol';
import type { TargetedContributionPointSemanticOperation } from '@happier-dev/plugin-sdk/host/targeted-contributions';
import { describe, expect, it, vi } from 'vitest';

import { readCanonicalPluginManifest } from '@/plugins/manifest/normalize';
import type {
    ResolvedActionContribution,
    ResolvedContributionRegistry,
} from '@/plugins/projection/registry/types';
import type { PluginTargetActivationFact } from '@/plugins/runtime/lifecycle/activation/facts';
import type { ResolvedExecutablePluginRuntimeRegistry } from '@/plugins/runtime/resolveExecutablePluginRuntimeRegistry';
import { createPluginManifestV2Fixture } from '@/plugins/testkit/manifestV2Fixture';

import { executeContributedAction } from './actions/executeContributedAction';
import { buildTargetActionInvocationRegistry } from './buildTargetActionRegistry';
import { createAdmittedTargetedOperationExecutionHandle } from './services/actions';
import { createProductionPluginInvocationServiceOwners } from './services/production';
import { createUnavailablePluginServices } from './services/unavailable';

const generation = '7';

function permissiveTargetProtocol(role: string) {
    return Object.freeze({
        role,
        input: Object.freeze({ kind: 'contributorDefined' as const }),
        resultSchema: defineProtocolJsonValue(),
    });
}

type TargetRegistration = Parameters<
    typeof buildTargetActionInvocationRegistry
>[0]['targetRegistrations'][number];

type TargetActionHandler = ActionHandler;

type DemandActivationRequest = Parameters<
    ResolvedExecutablePluginRuntimeRegistry['activateContributionsOnDemand']
>[0][number];

function actionManifest(
    pluginId: string,
    localId: string,
    surfaces: readonly ('cli' | 'plugin')[],
) {
    const manifest = readCanonicalPluginManifest(createPluginManifestV2Fixture({
        id: pluginId,
        version: '1.0.0',
        hostAccess: { required: [], optional: [] },
        contributes: {
            actions: [{
                id: localId,
                title: `${pluginId} ${localId}`,
                description: 'Currentness fixture action',
                scopes: ['global'],
                surfaces,
                execution: { target: 'daemon' },
                placementBindings: ['commandPalette'],
                dangerLevel: 'safe',
            }],
        },
    }));
    if (!manifest) throw new Error(`Invalid Action fixture for '${pluginId}'`);
    return manifest;
}

function resolvedAction(params: Readonly<{
    pluginId: string;
    localId: string;
    surfaces: readonly ('cli' | 'plugin')[];
}>): ResolvedActionContribution {
    return {
        provenance: 'external',
        source: { kind: 'path' },
        pluginId: params.pluginId,
        manifestPath: `/fixtures/${params.pluginId}/plugin.json`,
        daemonEntryPath: `/fixtures/${params.pluginId}/daemon.mjs`,
        sourceSpec: {
            kind: 'path',
            locator: `/fixtures/${params.pluginId}`,
            trustPolicy: 'local_trusted',
            installPolicy: 'link',
        },
        definition: {
            kindVersion: 1,
            id: params.localId,
            title: `${params.pluginId} ${params.localId}`,
            description: null,
            safety: 'safe',
            placements: [],
            slash: null,
            bindings: null,
            examples: null,
            surfaces: {
                ui: false,
                voice: false,
                agent: false,
                mcp: false,
                cli: params.surfaces.includes('cli'),
                rpc: false,
                api: true,
                plugin: params.surfaces.includes('plugin'),
            },
            inputHints: null,
            inputSchema: {},
            scopes: ['global'],
            contributionSurfaces: params.surfaces,
            placementBindings: ['commandPalette'],
            dangerLevel: 'safe',
            execution: { target: 'daemon' },
        },
    };
}

function activationTarget(params: Readonly<{
    pluginId: string;
    manifest: ReturnType<typeof actionManifest>;
}>) {
    return {
        provenance: 'external' as const,
        source: { kind: 'path' as const },
        pluginId: params.pluginId,
        manifestPath: `/fixtures/${params.pluginId}/plugin.json`,
        daemonEntryPath: `/fixtures/${params.pluginId}/daemon.mjs`,
        sourceSpec: {
            kind: 'path' as const,
            locator: `/fixtures/${params.pluginId}`,
            trustPolicy: 'local_trusted' as const,
            installPolicy: 'link' as const,
        },
        manifest: params.manifest,
    };
}

function registry(params: Readonly<{
    actions: readonly ResolvedActionContribution[];
    activationTargets: readonly ReturnType<typeof activationTarget>[];
}>): ResolvedContributionRegistry {
    return {
        uiViewsV2: [],
        uiRenderersV2: [],
        uiTranslationsV2: [],
        agents: [],
        actions: params.actions,
        commands: [],
        tools: [],
        resources: [],
        activationTargets: params.activationTargets,
        actionsById: new Map(params.actions.map((action) => [
            `${action.pluginId}/${action.definition.id}`,
            action,
        ])),
        commandsById: new Map(),
        toolsById: new Map(),
        catalogEntriesById: {},
        agentDefinitionsById: new Map(),
        pluginDiagnosticsByPluginId: {},
    };
}

function executableRegistry(params: Readonly<{
    contributes: ResolvedContributionRegistry;
    targetActionInvocations: ReturnType<typeof buildTargetActionInvocationRegistry>;
    resolveCurrentPluginMaterializationRef: (pluginId: string) => PluginMachineMaterializationRefV1 | null;
    resolveCurrentPluginImmutableGenerationId?: (pluginId: string) => Promise<string | null>;
    activateContributionsOnDemand: ResolvedExecutablePluginRuntimeRegistry['activateContributionsOnDemand'];
}>): ResolvedExecutablePluginRuntimeRegistry {
    return {
        contributes: params.contributes,
        targetActionInvocations: params.targetActionInvocations,
        resolveCurrentPluginMaterializationRef: params.resolveCurrentPluginMaterializationRef,
        ...(params.resolveCurrentPluginImmutableGenerationId === undefined
            ? {}
            : {
                resolveCurrentPluginImmutableGenerationId:
                    params.resolveCurrentPluginImmutableGenerationId,
            }),
        hookHandlersByHookId: new Map(),
        agentRuntimesByAgentId: new Map(),
        scmHostingProvidersById: new Map(),
        pluginDiagnosticsByPluginId: {},
        activatedPluginIds: new Set(),
        activateContributionsOnDemand: params.activateContributionsOnDemand,
        createAgentInvocationServices: async () => createUnavailablePluginServices(),
        resolvePromptAssetBlocks: async () => [],
        retireConsumers: () => {},
        retainActivationRegistryComponentsExcluding: () => Object.freeze([]),
        retainPreparedActivationRegistryComponents: () => Object.freeze([]),
        dispose: async () => {},
    };
}

function activationFact(pluginId: string, localId: string): PluginTargetActivationFact {
    return {
        pluginId,
        pluginVersion: '1.0.0',
        source: 'localPath',
        generation,
        host: 'daemon',
        platform: 'darwin',
        occurredAtMs: 1,
        status: 'active',
        required: [{ family: 'actions', localId }],
        bound: [{ family: 'actions', localId }],
        diagnostics: [],
    };
}

function materialization(
    pluginId: string,
    materializationId: string,
): PluginMachineMaterializationRefV1 {
    return Object.freeze({
        pluginId,
        machineId: `machine-${pluginId.replace('acme.', '')}`,
        materializationId,
    });
}

function registration(
    pluginId: string,
    localId: string,
    value: TargetActionHandler,
): TargetRegistration {
    return {
        pluginId,
        generation,
        registration: {
            family: 'actions',
            localId,
            value,
        },
    };
}

describe('buildTargetActionInvocationRegistry caller currentness', () => {
    it('uses the immediate host-stamped caller through demand activation and withholds a stale caller result', async () => {
        const alphaManifest = actionManifest('acme.alpha', 'start', ['cli']);
        const betaManifest = actionManifest('acme.beta', 'continue', ['plugin']);
        const gammaManifest = actionManifest('acme.gamma', 'finish', ['plugin']);
        const alpha = resolvedAction({ pluginId: 'acme.alpha', localId: 'start', surfaces: ['cli'] });
        const beta = resolvedAction({ pluginId: 'acme.beta', localId: 'continue', surfaces: ['plugin'] });
        const gamma = resolvedAction({ pluginId: 'acme.gamma', localId: 'finish', surfaces: ['plugin'] });
        const alphaBefore = materialization('acme.alpha', 'alpha-before');
        const betaCurrent = materialization('acme.beta', 'beta-current');
        const gammaCurrent = materialization('acme.gamma', 'gamma-current');
        const materializations = new Map<string, PluginMachineMaterializationRefV1>([
            ['acme.alpha', alphaBefore],
            ['acme.beta', betaCurrent],
            ['acme.gamma', gammaCurrent],
        ]);
        const contributes = registry({
            actions: [alpha, beta, gamma],
            activationTargets: [
                activationTarget({ pluginId: 'acme.alpha', manifest: alphaManifest }),
                activationTarget({ pluginId: 'acme.beta', manifest: betaManifest }),
                activationTarget({ pluginId: 'acme.gamma', manifest: gammaManifest }),
            ],
        });
        const targetRegistrations: TargetRegistration[] = [];
        const targetActivationFacts: PluginTargetActivationFact[] = [];
        let betaCaller: unknown;
        let gammaCaller: unknown;
        let beginHeldBeta!: () => void;
        let releaseHeldBeta!: () => void;
        const heldBetaStarted = new Promise<void>((resolve) => {
            beginHeldBeta = resolve;
        });
        const heldBetaRelease = new Promise<void>((resolve) => {
            releaseHeldBeta = resolve;
        });
        const alphaHandler = vi.fn<TargetActionHandler>(async (input, context) => {
            await context.services.actions.execute(
                { pluginId: 'acme.beta', localId: 'continue' },
                input,
            );
            return { started: true };
        });
        const betaHandler = vi.fn<TargetActionHandler>(async (input, context) => {
            betaCaller = context.caller;
            if (input === 'hold') {
                beginHeldBeta();
                await heldBetaRelease;
                return Object.freeze({ held: true }) satisfies JsonValue;
            }
            await context.services.actions.execute(
                { pluginId: 'acme.gamma', localId: 'finish' },
                input,
            );
            return Object.freeze({ continued: true }) satisfies JsonValue;
        });
        const gammaHandler = vi.fn<TargetActionHandler>(async (_input, context) => {
            gammaCaller = context.caller;
            return { finished: true };
        });
        const handlers = new Map<string, TargetActionHandler>([
            ['acme.alpha\u0000start', alphaHandler],
            ['acme.beta\u0000continue', betaHandler],
            ['acme.gamma\u0000finish', gammaHandler],
        ]);
        let runtimeRegistry: ResolvedExecutablePluginRuntimeRegistry | null = null;
        let targetActionInvocations!: ReturnType<typeof buildTargetActionInvocationRegistry>;
        const activateContributionsOnDemand = vi.fn(async (
            requests: readonly DemandActivationRequest[],
        ) => {
            for (const request of requests) {
                const key = `${request.pluginId}\u0000${request.localId}`;
                const handler = handlers.get(key);
                if (!handler) continue;
                if (!targetRegistrations.some((entry) => (
                    entry.pluginId === request.pluginId
                    && entry.registration.family === 'actions'
                    && entry.registration.localId === request.localId
                ))) {
                    targetRegistrations.push(registration(
                        request.pluginId,
                        request.localId,
                        handler,
                    ));
                    targetActivationFacts.push(activationFact(request.pluginId, request.localId));
                }
            }
            targetActionInvocations.refresh();
            return [];
        });
        const serviceOwners = createProductionPluginInvocationServiceOwners({
            loggerSink: { write() {} },
            actionExecutor: { execute: vi.fn() },
            resolveCurrentPluginMaterializationRef: (pluginId) => (
                materializations.get(pluginId) ?? null
            ),
            invokeContributedAction: async (request) => {
                if (!runtimeRegistry) {
                    return {
                        status: 'unavailable' as const,
                        code: 'plugin_action_registry_unavailable',
                        message: 'Plugin action registry is not yet committed',
                        actionHandlerInvocation: 'notStarted' as const,
                    };
                }
                const attempt = await executeContributedAction({
                    runtimeRegistry,
                    actionId: `${request.action.pluginId}/${request.action.localId}`,
                    input: request.input,
                    ...(request.admittedTargetedOperation === undefined
                        ? {}
                        : {
                            admittedTargetedOperation: request.admittedTargetedOperation,
                        }),
                    context: {
                        surface: request.surface,
                        ...(request.originSurface ? { originSurface: request.originSurface } : {}),
                        caller: request.caller,
                        ...(request.sessionId ? { defaultSessionId: request.sessionId } : {}),
                        signal: request.signal,
                    },
                });
                if (!attempt.matched) {
                    return {
                        status: 'unavailable' as const,
                        code: 'plugin_action_handler_missing',
                        message: 'No declared contributed action matches the exact plugin reference',
                        actionHandlerInvocation: 'notStarted' as const,
                    };
                }
                return attempt.result.ok
                    ? { status: 'executed' as const, value: attempt.result.result }
                    : {
                        status: 'failed' as const,
                        code: attempt.result.errorCode,
                        message: attempt.result.error,
                        ...(attempt.result.actionHandlerInvocation === undefined
                            ? {}
                            : { actionHandlerInvocation: attempt.result.actionHandlerInvocation }),
                    };
            },
        });
        targetRegistrations.push(registration('acme.alpha', 'start', alphaHandler));
        targetActivationFacts.push(activationFact('acme.alpha', 'start'));
        targetActionInvocations = buildTargetActionInvocationRegistry({
            contributes,
            targetRegistrations,
            targetActivationFacts,
            resolveAuthorizationFacts: (action) => ({
                packageTrust: {
                    packageIdentity: action.qualifiedId,
                    reviewedPackageIdentity: action.qualifiedId,
                },
                generation: {
                    targetGeneration: action.generation,
                    desiredGeneration: action.generation,
                    appliedGeneration: action.generation,
                },
                resourceSelections: [],
                scopedGrants: [],
                operatingSystemAuthorization: [],
            }),
            resolveHostBinding: serviceOwners.resolveHostBinding,
            resolveHostPolicy: serviceOwners.resolveHostPolicy,
            createServices: serviceOwners.createServices,
            resolveCurrentPluginMaterializationRef: (pluginId) => (
                materializations.get(pluginId) ?? null
            ),
        });
        runtimeRegistry = executableRegistry({
            contributes,
            targetActionInvocations,
            resolveCurrentPluginMaterializationRef: (pluginId) => (
                materializations.get(pluginId) ?? null
            ),
            activateContributionsOnDemand,
        });
        const committedRuntimeRegistry: ResolvedExecutablePluginRuntimeRegistry = runtimeRegistry;

        await expect(executeContributedAction({
            runtimeRegistry: committedRuntimeRegistry,
            actionId: 'acme.alpha/start',
            input: 'chain',
            context: { surface: 'cli' },
        })).resolves.toEqual({
            matched: true,
            result: { ok: true, result: { started: true } },
        });

        expect(betaCaller).toEqual({
            kind: 'plugin',
            pluginId: 'acme.alpha',
            contribution: { id: 'start', qualifiedId: 'acme.alpha/actions/start' },
            materialization: alphaBefore,
            originSurface: 'cli',
        });
        expect(gammaCaller).toEqual({
            kind: 'plugin',
            pluginId: 'acme.beta',
            contribution: { id: 'continue', qualifiedId: 'acme.beta/actions/continue' },
            materialization: betaCurrent,
            originSurface: 'cli',
        });
        expect(activateContributionsOnDemand).toHaveBeenNthCalledWith(1, [{
            pluginId: 'acme.beta', family: 'actions', localId: 'continue',
        }]);
        expect(activateContributionsOnDemand).toHaveBeenNthCalledWith(2, [{
            pluginId: 'acme.gamma', family: 'actions', localId: 'finish',
        }]);

        const staleCallerAttempt = executeContributedAction({
            runtimeRegistry: committedRuntimeRegistry,
            actionId: 'acme.alpha/start',
            input: 'hold',
            context: { surface: 'cli' },
        });
        await heldBetaStarted;
        materializations.set('acme.alpha', materialization('acme.alpha', 'alpha-after'));
        releaseHeldBeta();

        // The withheld outcome is itself a canonical PluginError, so it carries
        // the same projected `retryable` and payload as any other failure.
        await expect(staleCallerAttempt).resolves.toEqual({
            matched: true,
            result: {
                ok: false,
                errorCode: 'plugin_action_caller_unavailable',
                error: 'Plugin contributed action caller materialization is no longer current',
                retryable: false,
                data: {
                    name: 'PluginError',
                    code: 'plugin_action_caller_unavailable',
                    message: 'Plugin contributed action caller materialization is no longer current',
                },
            },
        });
        expect(betaCaller).toEqual(expect.objectContaining({
            pluginId: 'acme.alpha',
            materialization: alphaBefore,
        }));
        await serviceOwners.dispose();
    });
});

type AdmittedOperation = ReturnType<
    typeof createAdmittedTargetedOperationExecutionHandle
>;

function createComposedAdmittedOperationFixture() {
    const callerManifest = actionManifest('acme.caller', 'request', ['cli']);
    const contributorManifest = actionManifest('acme.contributor', 'publish', ['plugin']);
    const callerAction = resolvedAction({
        pluginId: 'acme.caller',
        localId: 'request',
        surfaces: ['cli'],
    });
    const contributorAction = resolvedAction({
        pluginId: 'acme.contributor',
        localId: 'publish',
        surfaces: ['plugin'],
    });
    const currentImmutableGenerationIds = new Map<string, string>([
        ['acme.caller', 'immutable-caller'],
        ['acme.contributor', 'immutable-contributor-g'],
    ]);
    const materializations = new Map<string, PluginMachineMaterializationRefV1>([
        ['acme.caller', materialization('acme.caller', 'caller-current')],
        ['acme.contributor', materialization('acme.contributor', 'contributor-current')],
    ]);
    const contributes = registry({
        actions: [callerAction, contributorAction],
        activationTargets: [
            activationTarget({ pluginId: 'acme.caller', manifest: callerManifest }),
            activationTarget({ pluginId: 'acme.contributor', manifest: contributorManifest }),
        ],
    });
    let selectedOperation: AdmittedOperation | null = null;
    const callerHandler = vi.fn<TargetActionHandler>(async (input, context) => {
        if (selectedOperation === null) {
            throw new Error('Admitted operation fixture was not selected');
        }
        return await context.services.actions.executeAdmittedTargetedOperation(
            selectedOperation,
            input,
        );
    });
    const targetRegistrations: TargetRegistration[] = [
        registration('acme.caller', 'request', callerHandler),
    ];
    const targetActivationFacts: PluginTargetActivationFact[] = [
        activationFact('acme.caller', 'request'),
    ];
    let runtimeRegistry: ResolvedExecutablePluginRuntimeRegistry | null = null;
    let targetActionInvocations!: ReturnType<typeof buildTargetActionInvocationRegistry>;
    let onDemandContributorActivation: (() => void) | null = null;
    let beforeContributorHandler: (() => void | Promise<void>) | null = null;

    const activateContributionsOnDemand = vi.fn(async (
        requests: readonly DemandActivationRequest[],
    ) => {
        if (requests.some((request) => (
            request.pluginId === 'acme.contributor'
            && request.family === 'actions'
            && request.localId === 'publish'
        ))) {
            onDemandContributorActivation?.();
        }
        return [];
    });
    const serviceOwners = createProductionPluginInvocationServiceOwners({
        loggerSink: { write() {} },
        actionExecutor: { execute: vi.fn() },
        resolveCurrentPluginMaterializationRef: (pluginId: string) => (
            materializations.get(pluginId) ?? null
        ),
        invokeContributedAction: async (request) => {
            const committedRuntimeRegistry = runtimeRegistry;
            if (!committedRuntimeRegistry) {
                return {
                    status: 'unavailable' as const,
                    code: 'plugin_action_registry_unavailable',
                    message: 'Plugin action registry is not yet committed',
                    actionHandlerInvocation: 'notStarted' as const,
                };
            }
            const attempt = await executeContributedAction({
                runtimeRegistry: committedRuntimeRegistry,
                actionId: `${request.action.pluginId}/${request.action.localId}`,
                input: request.input,
                ...(request.captureExecutionOrigin
                    ? { captureExecutionOrigin: true as const }
                    : {}),
                ...(request.expectedExecutionOrigin === undefined
                    ? {}
                    : { expectedExecutionOrigin: request.expectedExecutionOrigin }),
                ...(request.admittedTargetedOperation === undefined
                    ? {}
                    : {
                        admittedTargetedOperation: request.admittedTargetedOperation,
                    }),
                context: {
                    surface: request.surface,
                    ...(request.originSurface ? { originSurface: request.originSurface } : {}),
                    caller: request.caller,
                    ...(request.sessionId ? { defaultSessionId: request.sessionId } : {}),
                    signal: request.signal,
                },
            });
            if (!attempt.matched) {
                return {
                    status: 'unavailable' as const,
                    code: 'plugin_action_handler_missing',
                    message: 'No declared contributed action matches the exact plugin reference',
                    actionHandlerInvocation: 'notStarted' as const,
                };
            }
            return attempt.result.ok
                ? {
                    status: 'executed' as const,
                    value: attempt.result.result,
                    ...(attempt.result.executionOrigin === undefined
                        ? {}
                        : { executionOrigin: attempt.result.executionOrigin }),
                }
                : {
                    status: 'failed' as const,
                    code: attempt.result.errorCode,
                    message: attempt.result.error,
                    ...(attempt.result.actionHandlerInvocation === undefined
                        ? {}
                        : { actionHandlerInvocation: attempt.result.actionHandlerInvocation }),
                };
        },
    });
    targetActionInvocations = buildTargetActionInvocationRegistry({
        contributes,
        immutableGenerationIdsByPluginId: currentImmutableGenerationIds,
        resolveCurrentPluginImmutableGenerationId: async (pluginId: string) => (
            currentImmutableGenerationIds.get(pluginId) ?? null
        ),
        targetRegistrations,
        targetActivationFacts,
        resolveAuthorizationFacts: (action) => ({
            packageTrust: {
                packageIdentity: action.qualifiedId,
                reviewedPackageIdentity: action.qualifiedId,
            },
            generation: {
                targetGeneration: action.generation,
                desiredGeneration: action.generation,
                appliedGeneration: action.generation,
            },
            resourceSelections: [],
            scopedGrants: [],
            operatingSystemAuthorization: [],
        }),
        resolveHostBinding: async (action, context) => {
            if (
                action.pluginId === 'acme.contributor'
                && action.localId === 'publish'
            ) {
                await beforeContributorHandler?.();
            }
            return await serviceOwners.resolveHostBinding(action, context);
        },
        resolveHostPolicy: serviceOwners.resolveHostPolicy,
        createServices: serviceOwners.createServices,
        resolveCurrentPluginMaterializationRef: (pluginId: string) => (
            materializations.get(pluginId) ?? null
        ),
    });
    runtimeRegistry = executableRegistry({
        contributes,
        targetActionInvocations,
        resolveCurrentPluginMaterializationRef: (pluginId) => (
            materializations.get(pluginId) ?? null
        ),
        resolveCurrentPluginImmutableGenerationId: async (pluginId: string) => (
            currentImmutableGenerationIds.get(pluginId) ?? null
        ),
        activateContributionsOnDemand,
    });

    const publishContributor = (handler: TargetActionHandler): void => {
        const next = registration('acme.contributor', 'publish', handler);
        const existingIndex = targetRegistrations.findIndex((entry) => (
            entry.pluginId === 'acme.contributor'
            && entry.registration.family === 'actions'
            && entry.registration.localId === 'publish'
        ));
        if (existingIndex === -1) {
            targetRegistrations.push(next);
            targetActivationFacts.push(activationFact('acme.contributor', 'publish'));
        } else {
            targetRegistrations.splice(existingIndex, 1, next);
        }
        targetActionInvocations.refresh();
    };

    return {
        admit(immutableGenerationId: string): AdmittedOperation {
            return createAdmittedTargetedOperationExecutionHandle({
                action: { pluginId: 'acme.contributor', localId: 'publish' },
                targetImmutableGenerationId: 'immutable-caller',
                identity: {
                    target: { pluginId: 'acme.caller' },
                    point: {
                        pointId: 'providers',
                        protocol: { id: 'acme.providers', version: 1 },
                    },
                    contributor: {
                        pluginId: 'acme.contributor',
                        contributionId: 'primary',
                        immutableGenerationId,
                    },
                    role: 'publish',
                },
                targetProtocol: permissiveTargetProtocol('publish'),
            });
        },
        invoke(operation: AdmittedOperation) {
            selectedOperation = operation;
            return executeContributedAction({
                runtimeRegistry: runtimeRegistry!,
                actionId: 'acme.caller/request',
                input: { title: 'Ready' },
                context: { surface: 'cli' },
            });
        },
        dispatchAdmittedTargetedOperation(params: Readonly<{
            contributorImmutableGenerationId: string;
            targetImmutableGenerationId: string;
            targetProtocol: TargetedContributionPointSemanticOperation;
            input: unknown;
        }>) {
            return executeContributedAction({
                runtimeRegistry: runtimeRegistry!,
                actionId: 'acme.contributor/publish',
                input: params.input,
                admittedTargetedOperation: {
                    action: { pluginId: 'acme.contributor', localId: 'publish' },
                    target: {
                        pluginId: 'acme.caller',
                        immutableGenerationId: params.targetImmutableGenerationId,
                    },
                    contributorImmutableGenerationId: params.contributorImmutableGenerationId,
                    targetProtocol: params.targetProtocol,
                },
                context: {
                    surface: 'plugin',
                    caller: {
                        kind: 'plugin',
                        pluginId: 'acme.caller',
                        contribution: {
                            id: 'request',
                            qualifiedId: 'acme.caller/actions/request',
                        },
                        materialization: materializations.get('acme.caller')!,
                    },
                },
            });
        },
        setCurrentTargetGeneration(immutableGenerationId: string): void {
            currentImmutableGenerationIds.set('acme.caller', immutableGenerationId);
        },
        setCurrentContributorGeneration(immutableGenerationId: string): void {
            currentImmutableGenerationIds.set(
                'acme.contributor',
                immutableGenerationId,
            );
        },
        setDemandContributorActivation(callback: () => void): void {
            onDemandContributorActivation = callback;
        },
        setBeforeContributorHandler(callback: () => void | Promise<void>): void {
            beforeContributorHandler = callback;
        },
        publishContributor,
        activateContributionsOnDemand,
        dispose: async () => await serviceOwners.dispose(),
    };
}

describe('admitted targeted-operation currentness through production Actions', () => {
    it('rechecks the target generation after awaited Action binding and before the contributor handler starts', async () => {
        const fixture = createComposedAdmittedOperationFixture();
        const inputSchema = defineProtocolObject({
            kind: defineProtocolLiteral('accepted'),
        }, { policy: 'additive-open/drop' });
        const resultSchema = defineProtocolObject({
            kind: defineProtocolLiteral('accepted'),
        }, { policy: 'closed' });
        const targetProtocol = Object.freeze({
            role: 'publish',
            input: Object.freeze({
                kind: 'protocolDefined' as const,
                schema: inputSchema,
            }),
            resultSchema,
        });
        const contributor = vi.fn<TargetActionHandler>(async () => ({ kind: 'accepted' }));
        fixture.publishContributor(contributor);
        fixture.setBeforeContributorHandler(() => {
            fixture.setCurrentTargetGeneration('immutable-caller-h');
        });

        try {
            await expect(fixture.dispatchAdmittedTargetedOperation({
                targetImmutableGenerationId: 'immutable-caller',
                contributorImmutableGenerationId: 'immutable-contributor-g',
                targetProtocol,
                input: { kind: 'accepted' },
            })).resolves.toMatchObject({
                matched: true,
                result: {
                    ok: false,
                    errorCode: 'plugin_action_generation_retired',
                    actionHandlerInvocation: 'notStarted',
                },
            });
            expect(contributor).not.toHaveBeenCalled();
        } finally {
            await fixture.dispose();
        }
    });

    it('validates an admitted target protocol at the canonical contributor dispatcher and fences exact target and contributor generations', async () => {
        const fixture = createComposedAdmittedOperationFixture();
        const inputSchema = defineProtocolObject({
            kind: defineProtocolLiteral('accepted'),
        }, { policy: 'additive-open/drop' });
        const resultSchema = defineProtocolObject({
            kind: defineProtocolLiteral('accepted'),
        }, { policy: 'closed' });
        const targetProtocol = Object.freeze({
            role: 'publish',
            input: Object.freeze({ kind: 'protocolDefined' as const, schema: inputSchema }),
            resultSchema,
        });
        let contributorInvocations = 0;
        const contributor = vi.fn<TargetActionHandler>(async () => {
            contributorInvocations += 1;
            if (contributorInvocations === 2) {
                fixture.setCurrentTargetGeneration('immutable-caller-h');
                return { kind: 'accepted' };
            }
            return { kind: 'unexpected' };
        });
        fixture.publishContributor(contributor);

        try {
            await expect(fixture.dispatchAdmittedTargetedOperation({
                targetImmutableGenerationId: 'immutable-caller',
                contributorImmutableGenerationId: 'immutable-contributor-g',
                targetProtocol,
                input: { kind: 'rejected' },
            })).resolves.toMatchObject({
                matched: true,
                result: {
                    ok: false,
                    errorCode: 'plugin_targeted_operation_input_invalid',
                    actionHandlerInvocation: 'notStarted',
                },
            });
            expect(contributor).not.toHaveBeenCalled();

            await expect(fixture.dispatchAdmittedTargetedOperation({
                targetImmutableGenerationId: 'immutable-caller',
                contributorImmutableGenerationId: 'immutable-contributor-g',
                targetProtocol,
                input: { kind: 'accepted', contributorOnly: true },
            })).resolves.toMatchObject({
                matched: true,
                result: {
                    ok: false,
                    errorCode: 'plugin_targeted_operation_result_invalid',
                },
            });
            expect(contributor).toHaveBeenCalledWith(
                { kind: 'accepted' },
                expect.anything(),
            );

            fixture.setCurrentTargetGeneration('immutable-caller-h');
            await expect(fixture.dispatchAdmittedTargetedOperation({
                targetImmutableGenerationId: 'immutable-caller',
                contributorImmutableGenerationId: 'immutable-contributor-g',
                targetProtocol,
                input: { kind: 'accepted' },
            })).resolves.toMatchObject({
                matched: true,
                result: {
                    ok: false,
                    errorCode: 'plugin_action_generation_retired',
                    actionHandlerInvocation: 'notStarted',
                },
            });
            expect(contributor).toHaveBeenCalledOnce();

            fixture.setCurrentTargetGeneration('immutable-caller');
            await expect(fixture.dispatchAdmittedTargetedOperation({
                targetImmutableGenerationId: 'immutable-caller',
                contributorImmutableGenerationId: 'immutable-contributor-g',
                targetProtocol,
                input: { kind: 'accepted' },
            })).resolves.toMatchObject({
                matched: true,
                result: {
                    ok: true,
                    result: { kind: 'accepted' },
                },
            });
            expect(contributor).toHaveBeenCalledTimes(2);

            fixture.setCurrentTargetGeneration('immutable-caller');
            fixture.setCurrentContributorGeneration('immutable-contributor-h');
            await expect(fixture.dispatchAdmittedTargetedOperation({
                targetImmutableGenerationId: 'immutable-caller',
                contributorImmutableGenerationId: 'immutable-contributor-g',
                targetProtocol,
                input: { kind: 'accepted' },
            })).resolves.toMatchObject({
                matched: true,
                result: {
                    ok: false,
                    errorCode: 'plugin_action_generation_retired',
                    actionHandlerInvocation: 'notStarted',
                },
            });
            expect(contributor).toHaveBeenCalledTimes(2);
        } finally {
            await fixture.dispose();
        }
    });

    it('refuses reconstructed and stale G handles before demand activation, then refuses G after activation installs H', async () => {
        const preDemandFixture = createComposedAdmittedOperationFixture();
        const originalG = preDemandFixture.admit('immutable-contributor-g');
        const spread = Object.freeze({ ...originalG });
        const reconstructed = Object.freeze({
            identity: Object.freeze({
                target: Object.freeze({ ...originalG.identity.target }),
                point: Object.freeze({
                    pointId: originalG.identity.point.pointId,
                    protocol: Object.freeze({ ...originalG.identity.point.protocol }),
                }),
                contributor: Object.freeze({ ...originalG.identity.contributor }),
                role: originalG.identity.role,
            }),
        });
        try {
            await expect(preDemandFixture.invoke(spread as never)).resolves.toMatchObject({
                matched: true,
                result: {
                    ok: false,
                    errorCode: 'plugin_admitted_targeted_operation_handle_invalid',
                },
            });
            await expect(preDemandFixture.invoke(reconstructed as never)).resolves.toMatchObject({
                matched: true,
                result: {
                    ok: false,
                    errorCode: 'plugin_admitted_targeted_operation_handle_invalid',
                },
            });
            expect(preDemandFixture.activateContributionsOnDemand).not.toHaveBeenCalled();

            preDemandFixture.setCurrentContributorGeneration('immutable-contributor-h');
            await expect(preDemandFixture.invoke(originalG)).resolves.toMatchObject({
                matched: true,
                result: {
                    ok: false,
                    errorCode: 'plugin_action_generation_retired',
                },
            });
            expect(preDemandFixture.activateContributionsOnDemand).not.toHaveBeenCalled();
        } finally {
            await preDemandFixture.dispose();
        }

        const activationFixture = createComposedAdmittedOperationFixture();
        const originalGAfterDemand = activationFixture.admit('immutable-contributor-g');
        const replacementHHandler = vi.fn<TargetActionHandler>(async () => ({ handledBy: 'H' }));
        activationFixture.setDemandContributorActivation(() => {
            activationFixture.setCurrentContributorGeneration('immutable-contributor-h');
            activationFixture.publishContributor(replacementHHandler);
        });
        try {
            await expect(activationFixture.invoke(originalGAfterDemand)).resolves.toMatchObject({
                matched: true,
                result: {
                    ok: false,
                    errorCode: 'plugin_action_generation_retired',
                },
            });
            expect(activationFixture.activateContributionsOnDemand).toHaveBeenCalledWith([{
                pluginId: 'acme.contributor',
                family: 'actions',
                localId: 'publish',
            }]);
            expect(replacementHHandler).not.toHaveBeenCalled();
        } finally {
            await activationFixture.dispose();
        }
    });

    it('preserves a known G result after its handler installs H, while a fresh H handle executes', async () => {
        const fixture = createComposedAdmittedOperationFixture();
        const originalG = fixture.admit('immutable-contributor-g');
        const freshH = fixture.admit('immutable-contributor-h');
        const replacementHHandler = vi.fn<TargetActionHandler>(async () => ({ handledBy: 'H' }));
        const originalGHandler = vi.fn<TargetActionHandler>(async () => {
            fixture.setCurrentContributorGeneration('immutable-contributor-h');
            fixture.publishContributor(replacementHHandler);
            return { handledBy: 'G' };
        });
        fixture.publishContributor(originalGHandler);
        try {
            const originalGResult = await fixture.invoke(originalG);
            expect(originalGResult).toMatchObject({
                matched: true,
                result: {
                    ok: true,
                    result: { handledBy: 'G' },
                },
            });
            expect(originalGResult).not.toHaveProperty('result.actionHandlerInvocation');
            expect(originalGHandler).toHaveBeenCalledOnce();
            expect(replacementHHandler).not.toHaveBeenCalled();

            await expect(fixture.invoke(freshH)).resolves.toMatchObject({
                matched: true,
                result: {
                    ok: true,
                    result: { handledBy: 'H' },
                },
            });
            expect(replacementHHandler).toHaveBeenCalledOnce();
        } finally {
            await fixture.dispose();
        }
    });
});
