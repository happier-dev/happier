import type { PluginPermissionCapabilityV1 } from '@happier-dev/protocol';
import type {
    PluginApiBackendEngineRegistration,
    PluginDisposable,
    PluginApi,
    PluginApiActionRegistration,
    PluginApiCommandRegistration,
    PluginApiHostPolicy,
    PluginApiHookRegistration,
    PluginApiLifecycleHandlerRegistration,
    PluginApiNotificationCategoryRegistration,
    PluginApiNotificationChannelRegistration,
    PluginApiRequestInterceptorRegistration,
    PluginApiResourceRegistration,
    PluginApiRegistrations,
    PluginApiScmHostingProviderRegistration,
    PluginApiToolRegistration,
    PluginApiUiDescriptorRegistration,
} from './types';
import type { PluginCompatibilityDiagnostic } from '@/plugins/validation/diagnostics/types';
import { createPluginDisposableRegistry } from '../lifecycle/disposables';
import { isPluginApiScmHostingProviderRegistration } from './scmHostingProviders';

const NOOP_DISPOSABLE: PluginDisposable = () => undefined;

function isRecord(value: unknown): value is Record<string, unknown> {
    return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function formatPluginLabel(pluginId: string | undefined): string {
    return pluginId?.trim().length ? `Plugin '${pluginId}'` : 'Plugin activation';
}

function isRequestInterceptorRegistration(value: unknown): value is PluginApiRequestInterceptorRegistration {
    return isRecord(value)
        && typeof value.id === 'string'
        && value.id.trim().length > 0
        && (value.priority === undefined || typeof value.priority === 'number')
        && typeof value.intercept === 'function';
}

export function createPluginApiHost(policy?: PluginApiHostPolicy): Readonly<{
    api: PluginApi;
    registrations: () => PluginApiRegistrations;
    addDisposable: (disposable: PluginDisposable) => PluginDisposable;
    dispose: () => Promise<void>;
}> {
    const backendEngines: PluginApiBackendEngineRegistration[] = [];
    const actions: PluginApiActionRegistration[] = [];
    const tools: PluginApiToolRegistration[] = [];
    const commands: PluginApiCommandRegistration[] = [];
    const resources: PluginApiResourceRegistration[] = [];
    const uiDescriptors: PluginApiUiDescriptorRegistration[] = [];
    const notificationCategories: PluginApiNotificationCategoryRegistration[] = [];
    const notificationChannels: PluginApiNotificationChannelRegistration[] = [];
    const scmHostingProviders: PluginApiScmHostingProviderRegistration[] = [];
    const requestInterceptors: PluginApiRequestInterceptorRegistration[] = [];
    const hooks: PluginApiHookRegistration[] = [];
    const lifecycleHandlers: PluginApiLifecycleHandlerRegistration[] = [];
    const diagnostics: PluginCompatibilityDiagnostic[] = [];
    const disposableRegistry = createPluginDisposableRegistry();
    const allowedRuntimeCapabilities = policy?.runtimeCapabilities
        ? new Set(policy.runtimeCapabilities)
        : null;
    const declaredPermissions = policy?.permissions
        ? new Set(policy.permissions)
        : null;
    const declaredBackendIds = policy?.declaredBackendIds
        ? new Set(policy.declaredBackendIds)
        : null;
    const declaredNotificationCategoryIds = policy?.declaredNotificationCategoryIds
        ? new Set(policy.declaredNotificationCategoryIds)
        : null;
    const declaredNotificationChannelIds = policy?.declaredNotificationChannelIds
        ? new Set(policy.declaredNotificationChannelIds)
        : null;
    const declaredScmHostingProviderIds = policy?.declaredScmHostingProviderIds
        ? new Set(policy.declaredScmHostingProviderIds)
        : null;

    function addDisposable(disposable: PluginDisposable): PluginDisposable {
        return disposableRegistry.add(disposable);
    }

    function appendDiagnostic(diagnostic: PluginCompatibilityDiagnostic): PluginDisposable {
        diagnostics.push(diagnostic);
        return NOOP_DISPOSABLE;
    }

    function isRegistrationAllowed(params: Readonly<{
        family?: string;
        methodName: string;
        requiredPermission?: PluginPermissionCapabilityV1;
    }>): PluginDisposable | null {
        const pluginLabel = formatPluginLabel(policy?.pluginId);
        if (params.family && allowedRuntimeCapabilities && !allowedRuntimeCapabilities.has(params.family)) {
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

    const siblingRegisterMethods = Object.fromEntries(
        Object.entries(policy?.registerMethods ?? {}).map(([methodName, descriptor]) => [
            methodName,
            (registration: unknown): PluginDisposable => {
                const blocked = isRegistrationAllowed({
                    family: descriptor.family,
                    methodName,
                    requiredPermission: descriptor.requiredPermission,
                });
                if (blocked) {
                    return blocked;
                }
                return descriptor.register(registration, {
                    pluginId: policy?.pluginId,
                    addDisposable,
                    appendDiagnostic,
                });
            },
        ]),
    );

    const api: PluginApi = Object.freeze({
        ...siblingRegisterMethods,
        registerBackendEngine(registration) {
            const blocked = isRegistrationAllowed({
                family: 'backends',
                methodName: 'registerBackendEngine',
            });
            if (blocked) {
                return blocked;
            }
            if (declaredBackendIds && !declaredBackendIds.has(registration.backendId)) {
                appendDiagnostic({
                    code: 'plugin_backend_engine_undeclared_backend_id',
                    message: `${formatPluginLabel(policy?.pluginId)} cannot register backend engine '${registration.backendId}' because it is not a manifest-declared backend id`,
                });
                throw new Error(`${formatPluginLabel(policy?.pluginId)} cannot register backend engine '${registration.backendId}' because it is not a manifest-declared backend id`);
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
        registerNotificationCategory(registration) {
            const blocked = isRegistrationAllowed({
                family: 'notifications',
                methodName: 'registerNotificationCategory',
                requiredPermission: 'notifications.register',
            });
            if (blocked) {
                return blocked;
            }
            if (declaredNotificationCategoryIds && !declaredNotificationCategoryIds.has(registration.id)) {
                appendDiagnostic({
                    code: 'plugin_notification_category_undeclared_id',
                    message: `${formatPluginLabel(policy?.pluginId)} cannot register notification category '${registration.id}' because it is not a manifest-declared notification category id`,
                });
                throw new Error(`${formatPluginLabel(policy?.pluginId)} cannot register notification category '${registration.id}' because it is not a manifest-declared notification category id`);
            }
            if (notificationCategories.some((entry) => entry.id === registration.id)) {
                appendDiagnostic({
                    code: 'plugin_notification_category_duplicate_id',
                    message: `${formatPluginLabel(policy?.pluginId)} registered duplicate notification category '${registration.id}'`,
                });
                throw new Error(`Duplicate notification category '${registration.id}'`);
            }
            notificationCategories.push(registration);
            return addDisposable(() => {
                const index = notificationCategories.indexOf(registration);
                if (index >= 0) {
                    notificationCategories.splice(index, 1);
                }
            });
        },
        registerNotificationChannel(registration) {
            const blocked = isRegistrationAllowed({
                family: 'notifications',
                methodName: 'registerNotificationChannel',
                requiredPermission: 'notifications.register',
            });
            if (blocked) {
                return blocked;
            }
            if (declaredNotificationChannelIds && !declaredNotificationChannelIds.has(registration.id)) {
                appendDiagnostic({
                    code: 'plugin_notification_channel_undeclared_id',
                    message: `${formatPluginLabel(policy?.pluginId)} cannot register notification channel '${registration.id}' because it is not a manifest-declared notification channel id`,
                });
                throw new Error(`${formatPluginLabel(policy?.pluginId)} cannot register notification channel '${registration.id}' because it is not a manifest-declared notification channel id`);
            }
            if (notificationChannels.some((entry) => entry.id === registration.id)) {
                appendDiagnostic({
                    code: 'plugin_notification_channel_duplicate_id',
                    message: `${formatPluginLabel(policy?.pluginId)} registered duplicate notification channel '${registration.id}'`,
                });
                throw new Error(`Duplicate notification channel '${registration.id}'`);
            }
            notificationChannels.push(registration);
            return addDisposable(() => {
                const index = notificationChannels.indexOf(registration);
                if (index >= 0) {
                    notificationChannels.splice(index, 1);
                }
            });
        },
        registerScmHostingProvider(registration) {
            const blocked = isRegistrationAllowed({
                family: 'scmHostingProviders',
                methodName: 'registerScmHostingProvider',
            });
            if (blocked) {
                return blocked;
            }
            if (!isPluginApiScmHostingProviderRegistration(registration)) {
                appendDiagnostic({
                    code: 'plugin_scm_hosting_provider_invalid_registration',
                    message: `${formatPluginLabel(policy?.pluginId)} provided an invalid SCM hosting provider registration`,
                });
                throw new Error(`${formatPluginLabel(policy?.pluginId)} provided an invalid SCM hosting provider registration`);
            }
            if (declaredScmHostingProviderIds && !declaredScmHostingProviderIds.has(registration.id)) {
                appendDiagnostic({
                    code: 'plugin_scm_hosting_provider_undeclared_id',
                    message: `${formatPluginLabel(policy?.pluginId)} cannot register SCM hosting provider '${registration.id}' because it is not a manifest-declared SCM hosting provider id`,
                });
                throw new Error(`${formatPluginLabel(policy?.pluginId)} cannot register SCM hosting provider '${registration.id}' because it is not a manifest-declared SCM hosting provider id`);
            }
            if (scmHostingProviders.some((entry) => entry.id === registration.id)) {
                appendDiagnostic({
                    code: 'plugin_scm_hosting_provider_duplicate_id',
                    message: `${formatPluginLabel(policy?.pluginId)} registered duplicate SCM hosting provider '${registration.id}'`,
                });
                throw new Error(`Duplicate SCM hosting provider '${registration.id}'`);
            }
            scmHostingProviders.push(registration);
            return addDisposable(() => {
                const index = scmHostingProviders.indexOf(registration);
                if (index >= 0) {
                    scmHostingProviders.splice(index, 1);
                }
            });
        },
        registerRequestInterceptor(registration) {
            const blocked = isRegistrationAllowed({
                methodName: 'registerRequestInterceptor',
                requiredPermission: 'network',
            });
            if (blocked) {
                return blocked;
            }
            if (!isRequestInterceptorRegistration(registration)) {
                appendDiagnostic({
                    code: 'plugin_request_interceptor_invalid_registration',
                    message: `${formatPluginLabel(policy?.pluginId)} provided an invalid request interceptor registration`,
                });
                throw new Error(`${formatPluginLabel(policy?.pluginId)} provided an invalid request interceptor registration`);
            }
            if (requestInterceptors.some((entry) => entry.id === registration.id)) {
                appendDiagnostic({
                    code: 'plugin_request_interceptor_duplicate_id',
                    message: `${formatPluginLabel(policy?.pluginId)} registered duplicate request interceptor '${registration.id}'`,
                });
                throw new Error(`Duplicate request interceptor '${registration.id}'`);
            }
            requestInterceptors.push(registration);
            return addDisposable(() => {
                const index = requestInterceptors.indexOf(registration);
                if (index >= 0) {
                    requestInterceptors.splice(index, 1);
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
            backendEngines: Object.freeze([...backendEngines]),
            actions: Object.freeze([...actions]),
            tools: Object.freeze([...tools]),
            commands: Object.freeze([...commands]),
            resources: Object.freeze([...resources]),
            uiDescriptors: Object.freeze([...uiDescriptors]),
            notificationCategories: Object.freeze([...notificationCategories]),
            notificationChannels: Object.freeze([...notificationChannels]),
            scmHostingProviders: Object.freeze([...scmHostingProviders]),
            requestInterceptors: Object.freeze([...requestInterceptors]),
            hooks: Object.freeze([...hooks]),
            lifecycleHandlers: Object.freeze([...lifecycleHandlers]),
            disposables: disposableRegistry.entries(),
            diagnostics: Object.freeze([...diagnostics]),
        }),
        dispose: disposableRegistry.dispose,
    };
}
