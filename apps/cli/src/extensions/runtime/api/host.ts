import type { ExtensionPermissionCapabilityV1 } from '@happier-dev/protocol';
import type {
    PluginExtensionApiBackendRegistration,
    PluginExtensionApiBackendEngineRegistration,
    PluginDisposable,
    PluginExtensionApi,
    PluginExtensionApiActionRegistration,
    PluginExtensionApiCommandRegistration,
    PluginExtensionApiHostPolicy,
    PluginExtensionApiHookRegistration,
    PluginExtensionApiLifecycleHandlerRegistration,
    PluginExtensionApiProviderRegistration,
    PluginExtensionApiResourceRegistration,
    PluginExtensionApiRegistrations,
    PluginExtensionApiRuntimeAdapterRegistration,
    PluginExtensionApiToolRegistration,
    PluginExtensionApiUiDescriptorRegistration,
} from './types';
import type { PluginCompatibilityDiagnostic } from '@/extensions/diagnostics/types';
import { createPluginDisposableRegistry } from '../lifecycle/disposables';

const NOOP_DISPOSABLE: PluginDisposable = () => undefined;

function formatPluginLabel(pluginId: string | undefined): string {
    return pluginId?.trim().length ? `Plugin '${pluginId}'` : 'Plugin activation';
}

export function createPluginExtensionApiHost(policy?: PluginExtensionApiHostPolicy): Readonly<{
    api: PluginExtensionApi;
    registrations: () => PluginExtensionApiRegistrations;
    addDisposable: (disposable: PluginDisposable) => PluginDisposable;
    dispose: () => Promise<void>;
}> {
    const providers: PluginExtensionApiProviderRegistration[] = [];
    const backends: PluginExtensionApiBackendRegistration[] = [];
    const backendEngines: PluginExtensionApiBackendEngineRegistration[] = [];
    const actions: PluginExtensionApiActionRegistration[] = [];
    const tools: PluginExtensionApiToolRegistration[] = [];
    const commands: PluginExtensionApiCommandRegistration[] = [];
    const resources: PluginExtensionApiResourceRegistration[] = [];
    const uiDescriptors: PluginExtensionApiUiDescriptorRegistration[] = [];
    const hooks: PluginExtensionApiHookRegistration[] = [];
    const lifecycleHandlers: PluginExtensionApiLifecycleHandlerRegistration[] = [];
    const runtimeAdapters: PluginExtensionApiRuntimeAdapterRegistration[] = [];
    const diagnostics: PluginCompatibilityDiagnostic[] = [];
    const disposableRegistry = createPluginDisposableRegistry();
    const allowedRuntimeCapabilities = policy?.runtimeCapabilities
        ? new Set(policy.runtimeCapabilities)
        : null;
    const declaredPermissions = policy?.permissions
        ? new Set(policy.permissions)
        : null;

    function addDisposable(disposable: PluginDisposable): PluginDisposable {
        return disposableRegistry.add(disposable);
    }

    function appendDiagnostic(diagnostic: PluginCompatibilityDiagnostic): PluginDisposable {
        diagnostics.push(diagnostic);
        return NOOP_DISPOSABLE;
    }

    function isRegistrationAllowed(params: Readonly<{
        family: 'providers' | 'backends' | 'actions' | 'tools' | 'commands' | 'resources' | 'uiDescriptors' | 'hooks' | 'lifecycle';
        methodName: string;
        requiredPermission?: ExtensionPermissionCapabilityV1;
    }>): PluginDisposable | null {
        const pluginLabel = formatPluginLabel(policy?.pluginId);
        if (allowedRuntimeCapabilities && !allowedRuntimeCapabilities.has(params.family)) {
            return appendDiagnostic({
                code: 'plugin_runtime_capability_missing',
                message: `${pluginLabel} cannot call ${params.methodName} without declaring runtime capability '${params.family}'`,
            });
        }
        if (params.requiredPermission && declaredPermissions && !declaredPermissions.has(params.requiredPermission)) {
            return appendDiagnostic({
                code: 'plugin_permission_missing',
                message: `${pluginLabel} cannot call ${params.methodName} without declaring permission '${params.requiredPermission}'`,
            });
        }
        return null;
    }

    const api: PluginExtensionApi = Object.freeze({
        registerProvider(registration) {
            const blocked = isRegistrationAllowed({
                family: 'providers',
                methodName: 'registerProvider',
            });
            if (blocked) {
                return blocked;
            }
            providers.push(registration);
            return addDisposable(() => {
                const index = providers.indexOf(registration);
                if (index >= 0) {
                    providers.splice(index, 1);
                }
            });
        },
        registerBackend(registration) {
            const blocked = isRegistrationAllowed({
                family: 'backends',
                methodName: 'registerBackend',
            });
            if (blocked) {
                return blocked;
            }
            backends.push(registration);
            return addDisposable(() => {
                const index = backends.indexOf(registration);
                if (index >= 0) {
                    backends.splice(index, 1);
                }
            });
        },
        registerBackendEngine(registration) {
            const blocked = isRegistrationAllowed({
                family: 'backends',
                methodName: 'registerBackendEngine',
            });
            if (blocked) {
                return blocked;
            }
            backendEngines.push(registration);
            return addDisposable(() => {
                const index = backendEngines.indexOf(registration);
                if (index >= 0) {
                    backendEngines.splice(index, 1);
                }
            });
        },
        registerAction(registration) {
            const blocked = isRegistrationAllowed({
                family: 'actions',
                methodName: 'registerAction',
                requiredPermission: 'actions.register',
            });
            if (blocked) {
                return blocked;
            }
            actions.push(registration);
            return addDisposable(() => {
                const index = actions.indexOf(registration);
                if (index >= 0) {
                    actions.splice(index, 1);
                }
            });
        },
        registerTool(registration) {
            const blocked = isRegistrationAllowed({
                family: 'tools',
                methodName: 'registerTool',
                requiredPermission: 'tools.register',
            });
            if (blocked) {
                return blocked;
            }
            tools.push(registration);
            return addDisposable(() => {
                const index = tools.indexOf(registration);
                if (index >= 0) {
                    tools.splice(index, 1);
                }
            });
        },
        registerCommand(registration) {
            const blocked = isRegistrationAllowed({
                family: 'commands',
                methodName: 'registerCommand',
                requiredPermission: 'commands.register',
            });
            if (blocked) {
                return blocked;
            }
            commands.push(registration);
            return addDisposable(() => {
                const index = commands.indexOf(registration);
                if (index >= 0) {
                    commands.splice(index, 1);
                }
            });
        },
        registerResource(registration) {
            const blocked = isRegistrationAllowed({
                family: 'resources',
                methodName: 'registerResource',
                requiredPermission: 'resources.register',
            });
            if (blocked) {
                return blocked;
            }
            resources.push(registration);
            return addDisposable(() => {
                const index = resources.indexOf(registration);
                if (index >= 0) {
                    resources.splice(index, 1);
                }
            });
        },
        registerUiDescriptor(registration) {
            const blocked = isRegistrationAllowed({
                family: 'uiDescriptors',
                methodName: 'registerUiDescriptor',
                requiredPermission: 'ui.descriptors',
            });
            if (blocked) {
                return blocked;
            }
            uiDescriptors.push(registration);
            return addDisposable(() => {
                const index = uiDescriptors.indexOf(registration);
                if (index >= 0) {
                    uiDescriptors.splice(index, 1);
                }
            });
        },
        registerHook(registration) {
            const blocked = isRegistrationAllowed({
                family: 'hooks',
                methodName: 'registerHook',
                requiredPermission: 'hooks.register',
            });
            if (blocked) {
                return blocked;
            }
            hooks.push(registration);
            return addDisposable(() => {
                const index = hooks.indexOf(registration);
                if (index >= 0) {
                    hooks.splice(index, 1);
                }
            });
        },
        registerLifecycleHandler(registration) {
            const blocked = isRegistrationAllowed({
                family: 'lifecycle',
                methodName: 'registerLifecycleHandler',
            });
            if (blocked) {
                return blocked;
            }
            lifecycleHandlers.push(registration);
            return addDisposable(() => {
                const index = lifecycleHandlers.indexOf(registration);
                if (index >= 0) {
                    lifecycleHandlers.splice(index, 1);
                }
            });
        },
        registerRuntimeAdapter(registration) {
            const blocked = isRegistrationAllowed({
                family: 'backends',
                methodName: 'registerRuntimeAdapter',
            });
            if (blocked) {
                return blocked;
            }
            runtimeAdapters.push(registration);
            return addDisposable(() => {
                const index = runtimeAdapters.indexOf(registration);
                if (index >= 0) {
                    runtimeAdapters.splice(index, 1);
                }
            });
        },
        registerDisposable(disposable) {
            return addDisposable(disposable);
        },
        onDispose(disposable) {
            return addDisposable(disposable);
        },
    });

    return {
        api,
        addDisposable,
        registrations: () => Object.freeze({
            providers: Object.freeze([...providers]),
            backends: Object.freeze([...backends]),
            backendEngines: Object.freeze([...backendEngines]),
            actions: Object.freeze([...actions]),
            tools: Object.freeze([...tools]),
            commands: Object.freeze([...commands]),
            resources: Object.freeze([...resources]),
            uiDescriptors: Object.freeze([...uiDescriptors]),
            hooks: Object.freeze([...hooks]),
            lifecycleHandlers: Object.freeze([...lifecycleHandlers]),
            runtimeAdapters: Object.freeze([...runtimeAdapters]),
            disposables: disposableRegistry.entries(),
            diagnostics: Object.freeze([...diagnostics]),
        }),
        dispose: disposableRegistry.dispose,
    };
}
