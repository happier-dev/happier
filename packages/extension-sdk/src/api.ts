import type {
    ActionDefinitionV1,
    BackendDefinitionV1,
    BackendRuntimeAdapterV1,
    HookRegistrationV1,
    ProviderDefinitionV1,
} from '@happier-dev/protocol';

import type { RegisterBackendEngineV1 } from './engine';

export type PluginDisposable = (() => void | Promise<void>) | Readonly<{
    dispose: () => void | Promise<void>;
}>;

export type PluginHookHandler = (...args: readonly unknown[]) => unknown | Promise<unknown>;

export type PluginActionSurface = 'cli' | 'mcp' | 'session_agent';

export type PluginActionHandlerRequest = Readonly<{
    actionId: string;
    pluginId: string;
    input: unknown;
    context: Readonly<{
        defaultSessionId?: string;
        surface: PluginActionSurface;
    }>;
    provenance: Readonly<{
        manifestPath?: string;
        manifestDigest?: string;
        sourceKind?: string;
    }>;
}>;

export type PluginActionHandler = (request: PluginActionHandlerRequest) => unknown | Promise<unknown>;

export type PluginLifecycleEvent = 'activated' | 'deactivating';

export type PluginLifecycleHandlerRequest = Readonly<{
    event: PluginLifecycleEvent;
    pluginId: string;
    generation: number;
    provenance: Readonly<{
        manifestPath?: string;
        manifestDigest?: string;
        sourceKind?: string;
    }>;
}>;

export type PluginLifecycleHandler = (request: PluginLifecycleHandlerRequest) => unknown | Promise<unknown>;

export type ExtensionApiHookRegistrationV1 = Readonly<{
    hookId: string;
    priority?: number;
    category?: HookRegistrationV1['category'];
    scope?: HookRegistrationV1['scope'];
    executionKind?: HookRegistrationV1['executionKind'];
    handler: PluginHookHandler;
}>;

export type ExtensionApiRuntimeAdapterRegistrationV1 = Readonly<{
    backendId: string;
    kind: BackendRuntimeAdapterV1['kind'];
    operation: BackendRuntimeAdapterV1['operation'];
    handler: PluginHookHandler;
}>;

export type ExtensionApiProviderRegistrationV1 = ProviderDefinitionV1;

export type ExtensionApiBackendRegistrationV1 = BackendDefinitionV1;

export type ExtensionApiBackendEngineRegistrationV1 = RegisterBackendEngineV1;

export type ExtensionApiActionRegistrationV1 = Readonly<{
    id: string;
    title: string;
    description?: string | null;
    safety?: ActionDefinitionV1['safety'];
    placements?: ActionDefinitionV1['placements'];
    slash?: ActionDefinitionV1['slash'];
    bindings?: ActionDefinitionV1['bindings'];
    examples?: ActionDefinitionV1['examples'];
    surfaces?: Partial<ActionDefinitionV1['surfaces']>;
    surface?: keyof ActionDefinitionV1['surfaces'];
    inputSchema?: ActionDefinitionV1['inputSchema'];
    outputSchema?: ActionDefinitionV1['outputSchema'];
    inputHints?: ActionDefinitionV1['inputHints'];
    compatibility?: ActionDefinitionV1['compatibility'];
    handler: PluginActionHandler;
}>;

export type ExtensionApiToolRegistrationV1 = Readonly<{
    id: string;
    name: string;
    title: string;
    description?: string | null;
    safety?: ActionDefinitionV1['safety'];
    surfaces?: Partial<Record<PluginActionSurface, boolean>>;
    inputSchema?: ActionDefinitionV1['inputSchema'];
    outputSchema?: ActionDefinitionV1['outputSchema'];
    inputHints?: ActionDefinitionV1['inputHints'];
    compatibility?: ActionDefinitionV1['compatibility'];
    examples?: ActionDefinitionV1['examples'];
    handler: PluginActionHandler;
}>;

export type ExtensionCommandVisibilityV1 = 'default' | 'advanced' | 'internal';

export type ExtensionApiCommandRegistrationV1 = Readonly<{
    id: string;
    command: string;
    rootHelpLabel?: string;
    rootHelpDescription?: string;
    rootHelpDetail?: string;
    allowTmux: boolean;
    visibility?: ExtensionCommandVisibilityV1;
    featureGate?: string;
    actionId?: string;
    handler: PluginActionHandler;
}>;

export type ExtensionApiResourceRegistrationV1 = Readonly<{
    kindVersion: 1;
    id: string;
    type: string;
    title?: string | null;
    path?: string | null;
    digest?: string | null;
    contentType?: string | null;
}>;

export type ExtensionApiUiDescriptorFieldV1 = Readonly<{
    id: string;
    kind: string;
    title: string;
    description?: string | null;
    order?: number;
    groupId?: string | null;
    featureGate?: string | null;
    actionId?: string | null;
    options?: readonly Readonly<{
        value: string;
        label: string;
    }>[];
}>;

export type ExtensionApiUiDescriptorRegistrationV1 = Readonly<{
    kindVersion: 1;
    id: string;
    surface: string;
    title: string;
    description?: string | null;
    order?: number;
    tone?: string | null;
    featureGate?: string | null;
    helpUrl?: string | null;
    fields: readonly ExtensionApiUiDescriptorFieldV1[];
}>;

export type ExtensionApiLifecycleHandlerRegistrationV1 = Readonly<{
    id?: string;
    event: PluginLifecycleEvent;
    priority?: number;
    handler: PluginLifecycleHandler;
}>;

export type ExtensionApiV1 = Readonly<{
    registerProvider: (registration: ExtensionApiProviderRegistrationV1) => PluginDisposable;
    registerBackend: (registration: ExtensionApiBackendRegistrationV1) => PluginDisposable;
    registerBackendEngine: (registration: ExtensionApiBackendEngineRegistrationV1) => PluginDisposable;
    registerAction: (registration: ExtensionApiActionRegistrationV1) => PluginDisposable;
    registerTool: (registration: ExtensionApiToolRegistrationV1) => PluginDisposable;
    registerCommand: (registration: ExtensionApiCommandRegistrationV1) => PluginDisposable;
    registerResource: (registration: ExtensionApiResourceRegistrationV1) => PluginDisposable;
    registerUiDescriptor: (registration: ExtensionApiUiDescriptorRegistrationV1) => PluginDisposable;
    registerHook: (registration: ExtensionApiHookRegistrationV1) => PluginDisposable;
    registerLifecycleHandler: (registration: ExtensionApiLifecycleHandlerRegistrationV1) => PluginDisposable;
    registerRuntimeAdapter: (registration: ExtensionApiRuntimeAdapterRegistrationV1) => PluginDisposable;
    registerDisposable: (disposable: PluginDisposable) => PluginDisposable;
    onDispose: (disposable: PluginDisposable) => PluginDisposable;
}>;
