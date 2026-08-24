import type { PluginApi } from '../activation.js';
import type { DefinedPlugin } from '../definePlugin.js';
import type { PluginContributionLocalId, JsonValue } from '../identity.js';
import type {
    MessageActionAvailableSnapshotV1,
    PluginInvocationSurface,
    PluginMachineMaterializationRefV1,
} from '../invocation.js';
import type { PresentationService } from '../interactions.js';
import type { AdmittedTargetedOperationExecutionHandle } from '../actions/service.js';
import type { PluginTestkitManifest } from '../manifest.js';
import type { PluginServices } from '../services/index.js';
import type {
    TargetedContributionPointRef,
    TargetedContributionSnapshot,
} from '../services/targetedContributions.js';

/**
 * One target-local fixture selection. The contributor testkit supplies only
 * fixture membership; the testkit itself resolves its current generation,
 * declared Action binding, and opaque execution capability.
 */
export type PluginTestkitAdmittedTargetedOperationRequest<
    TContribution = unknown,
    TRole extends string = string,
> = Readonly<{
    point: TargetedContributionPointRef<TContribution>;
    contributor: Readonly<{
        testkit: PluginTestkit;
        contributionId: PluginContributionLocalId;
    }>;
    role: TRole;
}>;

/**
 * Retains the exact operation contract when a point's admitted entry exposes
 * one, while deliberately falling back to the opaque generic handle for an
 * untyped fixture point.
 */
export type PluginTestkitAdmittedTargetedOperation<
    TContribution = unknown,
    TRole extends string = string,
> = TContribution extends Readonly<{ operations: infer TOperations }>
    ? TRole extends keyof TOperations
        ? Extract<NonNullable<TOperations[TRole]>, AdmittedTargetedOperationExecutionHandle>
        : never
    : AdmittedTargetedOperationExecutionHandle<JsonValue, JsonValue | void, TRole>;

/**
 * Public testkit registrations are derived from the published activation ABI,
 * not the host's raw registration map.
 */
export type PluginTestkitRegistrationByFamily = Readonly<{
    actions: Parameters<PluginApi['actions']['register']>[1];
    agents: Readonly<{
        factory?: Parameters<PluginApi['agents']['register']>[1];
        providerBinding?: NonNullable<NonNullable<
            Parameters<PluginApi['agents']['register']>[2]
        >['providerBinding']>;
        sessionRunnerFactory?: NonNullable<NonNullable<
            Parameters<PluginApi['agents']['register']>[2]
        >['sessionRunnerFactory']>;
        daemonSpawnHooks?: NonNullable<NonNullable<
            Parameters<PluginApi['agents']['register']>[2]
        >['daemonSpawnHooks']>;
        externalSessions?: Parameters<PluginApi['agents']['registerExternalSessions']>[1];
        externalSessionHooks?: Parameters<PluginApi['agents']['registerExternalSessionHooks']>[1];
        externalSessionObservation?: Parameters<
            PluginApi['agents']['registerExternalSessionObservation']
        >[1];
        externalSessionTakeover?: Parameters<
            PluginApi['agents']['registerExternalSessionTakeover']
        >[1];
    }>;
    hooks: Parameters<PluginApi['hooks']['register']>[1];
    events: Parameters<PluginApi['events']['register']>[1];
    notificationChannels: Parameters<PluginApi['notifications']['registerChannel']>[1];
    connectedAccountDescriptors: Parameters<PluginApi['connectedAccounts']['register']>[1];
    providers: Readonly<{
        managedRuntime?: Parameters<PluginApi['providers']['register']>[1];
        catalogParsers?: Readonly<Record<
            string,
            Parameters<PluginApi['providers']['registerCatalogParser']>[2]
        >>;
    }>;
    scmHostingProviders: Parameters<PluginApi['scm']['registerHostingProvider']>[1];
    scmBackends: Parameters<PluginApi['scm']['registerBackend']>[1];
    requestInterceptors: Parameters<PluginApi['interceptors']['register']>[1];
    'mcp.servers': Parameters<PluginApi['mcp']['registerServer']>[1];
    'mcp.discoverySources': Parameters<PluginApi['mcp']['registerDiscoverySource']>[1];
    voiceProviders: Parameters<PluginApi['voiceProviders']['register']>[1];
    backgroundServices: Parameters<PluginApi['backgroundServices']['register']>[1];
    promptAssets: Parameters<PluginApi['resources']['registerPromptAssetAdapter']>[1];
    resources: Parameters<PluginApi['resources']['registerDynamicResource']>[1];
    composerReferences: Parameters<
        PluginApi['composerReferences']['register']
    >[1];
    composerAttachments: Parameters<
        PluginApi['composerAttachments']['register']
    >[1];
}>;

export type PluginTestServicesFixture = Readonly<{
    [K in Exclude<keyof PluginServices, 'availability'>]?: PluginServices[K];
}>;

export type PluginTestkitOptions = Readonly<{
    /**
     * Testkits accept either a cold author manifest, a canonical normalized
     * manifest, or that normalized manifest narrowed to the contribution
     * families exercised by the test.
     */
    manifest: PluginTestkitManifest;
    /**
     * The compiled activation half of the one public author path. Authors pass
     * the `definePlugin(...)` result; the raw module shape is host-internal.
     */
    module: Pick<DefinedPlugin, 'activate'>;
    /**
     * Explicit contributed-Action targets resolved by this synthetic host.
     * The testkit stamps caller provenance from its own current materialization;
     * targets only provide the exact registered Action handler to dispatch.
     * The host derives a target execution origin from that target's private
     * current-materialization resolver; callers cannot configure the origin.
     */
    actionTargets?: readonly PluginTestkit[];
    /**
     * Contributor testkits used only to derive a structural targeted-
     * contribution fixture from their parsed manifests and current synthetic
     * generations. This is not production catalog or cold-admission input.
     */
    targetedContributionContributors?: readonly PluginTestkit[];
    /**
     * Host-owned lookup for this testkit's current materialization. The resolver
     * is evaluated only when this plugin invokes a contributed Action, never
     * supplied through Action input or public invocation options.
     */
    resolveCurrentPluginMaterializationRef?(): PluginMachineMaterializationRefV1 | null;
    services?: PluginTestServicesFixture;
    presentation?: PresentationService;
}>;

export type PluginTestkitInvokeActionOptions = Readonly<{
    surface?: PluginInvocationSurface;
    sessionId?: string;
    /**
     * Test-only host-stamped context for a whole-message Action invocation.
     * This is not Action input and is not available during `activate()`; it is
     * supplied only to the registered handler's invocation context.
     */
    messageAction?: MessageActionAvailableSnapshotV1;
    signal?: AbortSignal;
    services?: PluginTestServicesFixture;
    presentation?: PresentationService;
}>;

export type PluginTestkitRegistration = Readonly<{
    family: keyof PluginTestkitRegistrationByFamily;
    localId: PluginContributionLocalId;
}>;

export interface PluginTestkit {
    registrations(): readonly PluginTestkitRegistration[];
    registration<F extends keyof PluginTestkitRegistrationByFamily>(
        family: F,
        localId: PluginContributionLocalId,
    ): PluginTestkitRegistrationByFamily[F] | undefined;
    invokeAction(
        localId: PluginContributionLocalId,
        input: JsonValue,
        options?: PluginTestkitInvokeActionOptions,
    ): Promise<JsonValue | null>;
    /**
     * Returns this testkit's current structural fixture for one exact target
     * point. The snapshot is derived from parsed target/contributor
     * declarations and current synthetic generations; it does not perform
     * production CLI cold admission, diagnostics, or semantic projection.
     */
    readTargetedContributionFixture<TContribution>(
        point: TargetedContributionPointRef<TContribution>,
    ): TargetedContributionSnapshot<TContribution>;
    /**
     * Selects one original, host-issued operation from this target testkit's
     * currently admitted structural fixture. Callers cannot supply an Action,
     * generation, or executable-handle evidence; copied descriptive handles
     * remain invalid at the Action service boundary.
     */
    issueAdmittedTargetedOperation<
        TContribution,
        TRole extends string,
    >(
        request: PluginTestkitAdmittedTargetedOperationRequest<TContribution, TRole>,
    ): PluginTestkitAdmittedTargetedOperation<TContribution, TRole>;
    dispose(): Promise<void>;
}
