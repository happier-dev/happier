import type { ActionHandler } from '../actions/service.js';
import type {
    AgentExternalSessionObservationContribution,
    AgentExternalSessionsContribution,
    HookHandler,
    PluginEventHandler,
    PluginMcpDiscoveryHandler,
    PluginMcpServerRuntime,
    PluginNotificationSender,
    PluginRequestInterceptor,
    BackendRuntime,
    ComposerAttachmentRuntime,
    ComposerReferenceRuntime,
    HostingProviderRuntime,
} from '../activation.js';
import type {
    AgentProviderBindingAdapter,
    AgentDaemonSpawnHooks,
    AgentRuntimeFactory,
    AgentSessionRunnerFactoryLocatorV1,
} from '../agentRuntime/index.js';
import type { BackgroundServiceRunner } from '../backgroundServices.js';
import type { AgentExternalSessionHooksContribution } from '../externalSessionHooks.js';
import type { PromptAssetAdapter } from '../resources.js';
import type { PluginDynamicResourceRuntime } from '../services/resources.js';
import type { PluginConnectedAccountRuntime } from '../services/index.js';
import type { AgentExternalSessionTakeoverContribution } from '../sessions/externalSessionTakeover.js';
import type {
    ManagedProviderRuntime,
    ProviderCatalogParser,
} from '../managed-services/contract.js';
import type { VoiceProvidersRegistrationApi } from '../voice/projections.js';

/**
 * A committed Action registration has no independently callable realm. The
 * target-owning dispatcher first proves daemon versus client currentness, then
 * adapts this opaque capture to the corresponding public ActionHandler.
 */
type CapturedActionHandler = (input: never, context: never) => ReturnType<ActionHandler>;

/**
 * Canonical value map for every manifest-backed runtime registration family.
 * Host registration and the public testing projection both derive from this
 * owner; adding a second hand-maintained family map is a correctness bug.
 */
export interface PluginRegistrationValueByFamily {
    actions: CapturedActionHandler;
    agents: Readonly<{
        factory?: AgentRuntimeFactory;
        providerBinding?: AgentProviderBindingAdapter;
        sessionRunnerFactory?: AgentSessionRunnerFactoryLocatorV1;
        daemonSpawnHooks?: AgentDaemonSpawnHooks;
        externalSessions?: AgentExternalSessionsContribution;
        externalSessionHooks?: AgentExternalSessionHooksContribution;
        externalSessionObservation?: AgentExternalSessionObservationContribution;
        externalSessionTakeover?: AgentExternalSessionTakeoverContribution;
    }>;
    hooks: HookHandler;
    events: PluginEventHandler;
    notificationChannels: PluginNotificationSender;
    connectedAccountDescriptors: PluginConnectedAccountRuntime;
    /**
     * The Provider family registers separately-declared fields for one Provider
     * id: its managed runtime, and the catalog wire formats it contributes.
     */
    providers: Readonly<{
        managedRuntime?: ManagedProviderRuntime;
        catalogParsers?: Readonly<Record<string, ProviderCatalogParser>>;
    }>;
    scmHostingProviders: HostingProviderRuntime;
    scmBackends: BackendRuntime;
    'mcp.servers': PluginMcpServerRuntime;
    'mcp.discoverySources': PluginMcpDiscoveryHandler;
    requestInterceptors: PluginRequestInterceptor;
    voiceProviders: Parameters<VoiceProvidersRegistrationApi['register']>[1];
    backgroundServices: BackgroundServiceRunner;
    promptAssets: PromptAssetAdapter;
    /**
     * The dynamic arm of the discriminated `resources` contribution family
     * (§3.6.1). Packaged resources are package bytes and deliberately have no
     * entry here: only a family carrying a real runtime callback needs exact
     * registration (§8.1).
     */
    resources: PluginDynamicResourceRuntime;
    composerReferences: ComposerReferenceRuntime;
    composerAttachments: ComposerAttachmentRuntime;
}

export type PluginAgentRuntimeRegistration = PluginRegistrationValueByFamily['agents'];

export type PluginRegistrationFamily = keyof PluginRegistrationValueByFamily;

type PluginRuntimeRegistrationFor<TFamily extends PluginRegistrationFamily> = Readonly<{
    family: TFamily;
    localId: string;
    value: PluginRegistrationValueByFamily[TFamily];
}>;

export type PluginRuntimeRegistration = {
    [TFamily in PluginRegistrationFamily]: PluginRuntimeRegistrationFor<TFamily>;
}[PluginRegistrationFamily];
