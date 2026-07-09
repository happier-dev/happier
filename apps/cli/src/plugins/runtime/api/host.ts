import {
    getPluginHookDefinitionV1,
    type PluginActionContributionV2,
    type PluginHookIdV1,
    type PluginPermissionCapabilityV1,
} from '@happier-dev/protocol';
import type { PluginApiHookRegistrationV1 } from '@happier-dev/plugin-sdk';
import type {
    PluginApiAgentRuntimeRegistration,
    PluginDisposable,
    PluginApi,
    PluginApiActionRegistration,
    PluginApiCommandRegistration,
    PluginApiDaemonAuthBridgeRegistration,
    PluginApiHostPolicy,
    PluginApiHookRegistration,
    PluginApiLifecycleHandlerRegistration,
    PluginApiMcpDiscoveryProviderRegistration,
    PluginApiMcpServerRegistration,
    PluginApiNotificationCategoryRegistration,
    PluginApiNotificationChannelRegistration,
    PluginApiRequestInterceptorRegistration,
    PluginApiRegistrations,
    PluginApiScmBackendRegistration,
    PluginApiScmHostingProviderRegistration,
    PluginApiToolRegistration,
} from './types';
import type { PluginCompatibilityDiagnostic } from '@/plugins/validation/diagnostics/types';
import { createPluginDisposableRegistry } from '../lifecycle/disposables';
import {
    assertMcpRuntimeRegistrationSecretFree,
    assertMcpRuntimeServerRegistrationSafe,
} from './mcpSafety';
import { isPluginApiScmBackendRegistration } from './scmBackends';
import { isPluginApiScmHostingProviderRegistration } from './scmHostingProviders';

const NOOP_DISPOSABLE: PluginDisposable = () => undefined;

function isRecord(value: unknown): value is Record<string, unknown> {
    return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

const REQUEST_INTERCEPTOR_MANIFEST_OWNED_REGISTRATION_KEYS = new Set([
    'consent',
    'enabledByDefault',
    'failOpen',
    'order',
    'priority',
    'proxy',
    'proxyOrigin',
    'scope',
    'scopes',
    'target',
    'targets',
    'urlOrigins',
]);

const ACTION_STALE_REGISTRATION_METADATA_KEYS = new Set([
    'title',
    'description',
    'scopes',
    'surfaces',
    'placement',
    'inputSchema',
    'resultSchema',
    'availability',
    'dangerLevel',
    'confirmation',
    'surface',
    'safety',
    'outputSchema',
    'inputHints',
    'compatibility',
    'examples',
]);

const TOOL_MANIFEST_OWNED_REGISTRATION_KEYS = new Set([
    'name',
    'title',
    'description',
    'safety',
    'surfaces',
    'inputSchema',
    'outputSchema',
    'inputHints',
    'compatibility',
    'examples',
]);

const COMMAND_MANIFEST_OWNED_REGISTRATION_KEYS = new Set([
    'command',
    'rootHelpLabel',
    'rootHelpDescription',
    'rootHelpDetail',
    'allowTmux',
    'visibility',
    'featureGate',
]);

function hasOwn(value: object, key: string): boolean {
    return Object.prototype.hasOwnProperty.call(value, key);
}

function stableNormalize(value: unknown): unknown {
    if (Array.isArray(value)) {
        return value.map(stableNormalize);
    }
    if (!isRecord(value)) {
        return value;
    }
    return Object.fromEntries(
        Object.keys(value)
            .sort()
            .map((key) => [key, stableNormalize(value[key])]),
    );
}

function stableJson(value: unknown): string {
    return JSON.stringify(stableNormalize(value));
}

function normalizeComparableArray(value: readonly unknown[] | undefined): readonly unknown[] | undefined {
    return value ? Object.freeze([...value].sort((left, right) => String(left).localeCompare(String(right)))) : undefined;
}

function readManifestActionMetadataDrift(params: Readonly<{
    registration: PluginApiActionRegistration;
    declaration: PluginActionContributionV2;
}>): readonly string[] {
    const drift: string[] = [];
    const registration = params.registration as unknown as Record<string, unknown>;
    for (const key of ACTION_STALE_REGISTRATION_METADATA_KEYS) {
        if (hasOwn(registration, key)) {
            drift.push(key);
        }
    }

    const compare = (key: keyof PluginActionContributionV2, actual: unknown, expected: unknown) => {
        if (hasOwn(registration, key) && stableJson(actual) !== stableJson(expected)) {
            drift.push(String(key));
        }
    };

    compare('title', registration.title, params.declaration.title);
    compare('description', registration.description ?? null, params.declaration.description ?? null);
    compare('scopes', normalizeComparableArray(registration.scopes as readonly unknown[] | undefined), normalizeComparableArray(params.declaration.scopes));
    compare('surfaces', normalizeComparableArray(registration.surfaces as readonly unknown[] | undefined), normalizeComparableArray(params.declaration.surfaces));
    compare('placement', registration.placement, params.declaration.placement);
    compare('inputSchema', registration.inputSchema, params.declaration.inputSchema);
    compare('resultSchema', registration.resultSchema, params.declaration.resultSchema);
    compare('availability', registration.availability, params.declaration.availability);
    compare('dangerLevel', registration.dangerLevel, params.declaration.dangerLevel);
    compare('confirmation', registration.confirmation, params.declaration.confirmation);

    return Object.freeze([...new Set(drift)]);
}

function formatPluginLabel(pluginId: string | undefined): string {
    return pluginId?.trim().length ? `Plugin '${pluginId}'` : 'Plugin activation';
}

function normalizeOptionalRegistrationId(value: string | undefined): string | null {
    const normalized = value?.trim() ?? '';
    return normalized.length > 0 ? normalized : null;
}

function isRequestInterceptorRegistration(value: unknown): value is PluginApiRequestInterceptorRegistration {
    return isRecord(value)
        && typeof value.id === 'string'
        && value.id.trim().length > 0
        && typeof value.handle === 'function';
}

function getRequestInterceptorManifestOwnedRegistrationKeys(value: PluginApiRequestInterceptorRegistration): readonly string[] {
    return Object.keys(value).filter((key) => REQUEST_INTERCEPTOR_MANIFEST_OWNED_REGISTRATION_KEYS.has(key));
}

function getManifestOwnedRegistrationKeys(value: object, keys: ReadonlySet<string>): readonly string[] {
    return Object.keys(value).filter((key) => keys.has(key));
}

function storeHookRegistration<THookId extends PluginHookIdV1>(
    registration: PluginApiHookRegistrationV1<THookId>,
): PluginApiHookRegistration {
    // The host stores an existential hook registration while registerHook preserves the caller's hook-id-specific handler type.
    return registration as unknown as PluginApiHookRegistration;
}

export function createPluginApiHost(policy?: PluginApiHostPolicy): Readonly<{
    api: PluginApi;
    registrations: () => PluginApiRegistrations;
    addDisposable: (disposable: PluginDisposable) => PluginDisposable;
    dispose: () => Promise<void>;
}> {
    const agentRuntimes: PluginApiAgentRuntimeRegistration[] = [];
    const daemonAuthBridges: PluginApiDaemonAuthBridgeRegistration[] = [];
    const actions: PluginApiActionRegistration[] = [];
    const tools: PluginApiToolRegistration[] = [];
    const commands: PluginApiCommandRegistration[] = [];
    const notificationCategories: PluginApiNotificationCategoryRegistration[] = [];
    const notificationChannels: PluginApiNotificationChannelRegistration[] = [];
    const scmHostingProviders: PluginApiScmHostingProviderRegistration[] = [];
    const scmBackends: PluginApiScmBackendRegistration[] = [];
    const mcpServers: PluginApiMcpServerRegistration[] = [];
    const mcpDiscoveryProviders: PluginApiMcpDiscoveryProviderRegistration[] = [];
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
    const declaredAgentIds = policy?.declaredAgentIds
        ? new Set(policy.declaredAgentIds)
        : null;
    const declaredActionIds = policy?.declaredActionIds
        ? new Set(policy.declaredActionIds)
        : null;
    const declaredActionsById = policy?.declaredActions
        ? new Map(policy.declaredActions.map((definition) => [definition.id, definition]))
        : null;
    const declaredToolIds = policy?.declaredToolIds
        ? new Set(policy.declaredToolIds)
        : null;
    const declaredCommandIds = policy?.declaredCommandIds
        ? new Set(policy.declaredCommandIds)
        : null;
    const declaredHookIds = policy?.declaredHookIds
        ? new Set(policy.declaredHookIds)
        : null;
    const declaredLifecycleHandlerIds = policy?.declaredLifecycleHandlerIds
        ? new Set(policy.declaredLifecycleHandlerIds)
        : null;
    const declaredLifecycleHandlers = policy?.declaredLifecycleHandlers
        ? Object.freeze([...policy.declaredLifecycleHandlers])
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
    const declaredScmBackendIds = policy?.declaredScmBackendIds
        ? new Set(policy.declaredScmBackendIds)
        : null;
    const declaredRequestInterceptorIds = policy?.declaredRequestInterceptorIds
        ? new Set(policy.declaredRequestInterceptorIds)
        : null;
    const declaredMcpServerIds = policy?.declaredMcpServerIds
        ? new Set(policy.declaredMcpServerIds)
        : null;
    const declaredMcpDiscoveryProviderIds = policy?.declaredMcpDiscoveryProviderIds
        ? new Set(policy.declaredMcpDiscoveryProviderIds)
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
        registerAgentRuntime(registration) {
            const blocked = isRegistrationAllowed({
                family: 'agents',
                methodName: 'registerAgentRuntime',
            });
            if (blocked) {
                return blocked;
            }
            if (declaredAgentIds && !declaredAgentIds.has(registration.agentId)) {
                appendDiagnostic({
                    code: 'plugin_agent_runtime_undeclared_agent_id',
                    message: `${formatPluginLabel(policy?.pluginId)} cannot register agent runtime '${registration.agentId}' because it is not a manifest-declared agent id`,
                });
                throw new Error(`${formatPluginLabel(policy?.pluginId)} cannot register agent runtime '${registration.agentId}' because it is not a manifest-declared agent id`);
            }
            agentRuntimes.push(registration);
            return addDisposable(() => {
                const index = agentRuntimes.indexOf(registration);
                if (index >= 0) {
                    agentRuntimes.splice(index, 1);
                }
            });
        },
        registerDaemonAuthBridge(registration) {
            const serviceId = registration.serviceId.trim();
            if (!serviceId) {
                appendDiagnostic({
                    code: 'plugin_daemon_auth_bridge_invalid_service_id',
                    message: `${formatPluginLabel(policy?.pluginId)} cannot register daemon auth bridge with an empty service id`,
                });
                throw new Error(`${formatPluginLabel(policy?.pluginId)} cannot register daemon auth bridge with an empty service id`);
            }
            if (daemonAuthBridges.some((entry) => entry.serviceId === serviceId)) {
                appendDiagnostic({
                    code: 'plugin_daemon_auth_bridge_duplicate_service_id',
                    message: `${formatPluginLabel(policy?.pluginId)} registered duplicate daemon auth bridge for service '${serviceId}'`,
                });
                throw new Error(`${formatPluginLabel(policy?.pluginId)} registered duplicate daemon auth bridge for service '${serviceId}'`);
            }
            const storedRegistration = Object.freeze({
                ...registration,
                serviceId,
            });
            daemonAuthBridges.push(storedRegistration);
            return addDisposable(() => {
                const index = daemonAuthBridges.indexOf(storedRegistration);
                if (index >= 0) {
                    daemonAuthBridges.splice(index, 1);
                }
            });
        },
        registerAction(registration) {
            const blocked = isRegistrationAllowed({
                family: 'actions',
                methodName: 'registerAction',
            });
            if (blocked) {
                return blocked;
            }
            if (declaredActionIds && !declaredActionIds.has(registration.id)) {
                appendDiagnostic({
                    code: 'plugin_action_undeclared_id',
                    message: `${formatPluginLabel(policy?.pluginId)} cannot register action '${registration.id}' because it is not a manifest-declared action id`,
                });
                throw new Error(`${formatPluginLabel(policy?.pluginId)} cannot register action '${registration.id}' because it is not a manifest-declared action id`);
            }
            if (actions.some((entry) => entry.id === registration.id)) {
                appendDiagnostic({
                    code: 'plugin_action_duplicate_id',
                    message: `${formatPluginLabel(policy?.pluginId)} registered duplicate action handler '${registration.id}'`,
                });
                throw new Error(`${formatPluginLabel(policy?.pluginId)} registered duplicate action handler '${registration.id}'`);
            }
            const declaredAction = declaredActionsById?.get(registration.id) ?? null;
            if (declaredActionsById && !declaredAction) {
                appendDiagnostic({
                    code: 'plugin_action_undeclared_id',
                    message: `${formatPluginLabel(policy?.pluginId)} cannot register action '${registration.id}' because it is not a manifest-declared action id`,
                });
                throw new Error(`${formatPluginLabel(policy?.pluginId)} cannot register action '${registration.id}' because it is not a manifest-declared action id`);
            }
            if (declaredAction) {
                const drift = readManifestActionMetadataDrift({ registration, declaration: declaredAction });
                if (drift.length > 0) {
                    appendDiagnostic({
                        code: 'plugin_action_metadata_drift',
                        message: `${formatPluginLabel(policy?.pluginId)} registerAction metadata for '${registration.id}' does not match the manifest action metadata: ${drift.join(', ')}`,
                    });
                    throw new Error(`${formatPluginLabel(policy?.pluginId)} registerAction metadata for '${registration.id}' does not match the manifest action metadata`);
                }
            }
            const manifestOwnedKeys = getManifestOwnedRegistrationKeys(registration, ACTION_STALE_REGISTRATION_METADATA_KEYS);
            if (manifestOwnedKeys.length > 0) {
                appendDiagnostic({
                    code: 'plugin_action_manifest_fields_redeclared',
                    message: `${formatPluginLabel(policy?.pluginId)} cannot redeclare manifest-owned action metadata at runtime: ${manifestOwnedKeys.join(', ')}`,
                });
                throw new Error(`${formatPluginLabel(policy?.pluginId)} cannot redeclare manifest-owned action metadata at runtime`);
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
            });
            if (blocked) {
                return blocked;
            }
            if (declaredToolIds && !declaredToolIds.has(registration.id)) {
                appendDiagnostic({
                    code: 'plugin_tool_undeclared_id',
                    message: `${formatPluginLabel(policy?.pluginId)} cannot register tool '${registration.id}' because it is not a manifest-declared tool id`,
                });
                throw new Error(`${formatPluginLabel(policy?.pluginId)} cannot register tool '${registration.id}' because it is not a manifest-declared tool id`);
            }
            const manifestOwnedKeys = getManifestOwnedRegistrationKeys(registration, TOOL_MANIFEST_OWNED_REGISTRATION_KEYS);
            if (manifestOwnedKeys.length > 0) {
                appendDiagnostic({
                    code: 'plugin_tool_manifest_fields_redeclared',
                    message: `${formatPluginLabel(policy?.pluginId)} cannot redeclare manifest-owned tool metadata at runtime: ${manifestOwnedKeys.join(', ')}`,
                });
                throw new Error(`${formatPluginLabel(policy?.pluginId)} cannot redeclare manifest-owned tool metadata at runtime`);
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
            });
            if (blocked) {
                return blocked;
            }
            if (declaredCommandIds && !declaredCommandIds.has(registration.id)) {
                appendDiagnostic({
                    code: 'plugin_command_undeclared_id',
                    message: `${formatPluginLabel(policy?.pluginId)} cannot register command '${registration.id}' because it is not a manifest-declared command id`,
                });
                throw new Error(`${formatPluginLabel(policy?.pluginId)} cannot register command '${registration.id}' because it is not a manifest-declared command id`);
            }
            const manifestOwnedKeys = getManifestOwnedRegistrationKeys(registration, COMMAND_MANIFEST_OWNED_REGISTRATION_KEYS);
            if (manifestOwnedKeys.length > 0) {
                appendDiagnostic({
                    code: 'plugin_command_manifest_fields_redeclared',
                    message: `${formatPluginLabel(policy?.pluginId)} cannot redeclare manifest-owned command metadata at runtime: ${manifestOwnedKeys.join(', ')}`,
                });
                throw new Error(`${formatPluginLabel(policy?.pluginId)} cannot redeclare manifest-owned command metadata at runtime`);
            }
            commands.push(registration);
            return addDisposable(() => {
                const index = commands.indexOf(registration);
                if (index >= 0) {
                    commands.splice(index, 1);
                }
            });
        },
        registerNotificationCategory(registration) {
            const blocked = isRegistrationAllowed({
                family: 'notifications',
                methodName: 'registerNotificationCategory',
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
        registerScmBackend(registration) {
            const blocked = isRegistrationAllowed({
                family: 'scmBackends',
                methodName: 'registerScmBackend',
            });
            if (blocked) {
                return blocked;
            }
            if (!isPluginApiScmBackendRegistration(registration)) {
                appendDiagnostic({
                    code: 'plugin_scm_backend_invalid_registration',
                    message: `${formatPluginLabel(policy?.pluginId)} provided an invalid SCM backend registration`,
                });
                throw new Error(`${formatPluginLabel(policy?.pluginId)} provided an invalid SCM backend registration`);
            }
            if (declaredScmBackendIds && !declaredScmBackendIds.has(registration.id)) {
                appendDiagnostic({
                    code: 'plugin_scm_backend_undeclared_id',
                    message: `${formatPluginLabel(policy?.pluginId)} cannot register SCM backend '${registration.id}' because it is not a manifest-declared SCM backend id`,
                });
                throw new Error(`${formatPluginLabel(policy?.pluginId)} cannot register SCM backend '${registration.id}' because it is not a manifest-declared SCM backend id`);
            }
            if (scmBackends.some((entry) => entry.id === registration.id)) {
                appendDiagnostic({
                    code: 'plugin_scm_backend_duplicate_id',
                    message: `${formatPluginLabel(policy?.pluginId)} registered duplicate SCM backend '${registration.id}'`,
                });
                throw new Error(`Duplicate SCM backend '${registration.id}'`);
            }
            scmBackends.push(registration);
            return addDisposable(() => {
                const index = scmBackends.indexOf(registration);
                if (index >= 0) {
                    scmBackends.splice(index, 1);
                }
            });
        },
        registerMcpServer(registration) {
            const blocked = isRegistrationAllowed({
                family: 'mcp',
                methodName: 'registerMcpServer',
            });
            if (blocked) {
                return blocked;
            }
            assertMcpRuntimeServerRegistrationSafe(registration);
            if (declaredMcpServerIds && !declaredMcpServerIds.has(registration.id)) {
                appendDiagnostic({
                    code: 'plugin_mcp_server_undeclared_id',
                    message: `${formatPluginLabel(policy?.pluginId)} cannot register MCP server '${registration.id}' because it is not declared by its manifest`,
                });
                throw new Error(`${formatPluginLabel(policy?.pluginId)} cannot register MCP server '${registration.id}' because it is not declared by its manifest`);
            }
            if (mcpServers.some((entry) => entry.id === registration.id || entry.name === registration.name)) {
                appendDiagnostic({
                    code: 'plugin_manifest_semantic_invalid',
                    message: `${formatPluginLabel(policy?.pluginId)} registered duplicate MCP server '${registration.id}'`,
                });
                throw new Error(`Duplicate MCP server '${registration.id}'`);
            }
            mcpServers.push(registration);
            return addDisposable(() => {
                const index = mcpServers.indexOf(registration);
                if (index >= 0) {
                    mcpServers.splice(index, 1);
                }
            });
        },
        registerMcpDiscoveryProvider(registration) {
            const blocked = isRegistrationAllowed({
                family: 'mcp',
                methodName: 'registerMcpDiscoveryProvider',
            });
            if (blocked) {
                return blocked;
            }
            assertMcpRuntimeRegistrationSecretFree(registration);
            if (declaredMcpDiscoveryProviderIds && !declaredMcpDiscoveryProviderIds.has(registration.id)) {
                appendDiagnostic({
                    code: 'plugin_mcp_discovery_provider_undeclared_id',
                    message: `${formatPluginLabel(policy?.pluginId)} cannot register MCP discovery provider '${registration.id}' because it is not declared by its manifest`,
                });
                throw new Error(`${formatPluginLabel(policy?.pluginId)} cannot register MCP discovery provider '${registration.id}' because it is not declared by its manifest`);
            }
            if (mcpDiscoveryProviders.some((entry) => entry.id === registration.id)) {
                appendDiagnostic({
                    code: 'plugin_manifest_semantic_invalid',
                    message: `${formatPluginLabel(policy?.pluginId)} registered duplicate MCP discovery provider '${registration.id}'`,
                });
                throw new Error(`Duplicate MCP discovery provider '${registration.id}'`);
            }
            mcpDiscoveryProviders.push(registration);
            return addDisposable(() => {
                const index = mcpDiscoveryProviders.indexOf(registration);
                if (index >= 0) {
                    mcpDiscoveryProviders.splice(index, 1);
                }
            });
        },
        registerRequestInterceptor(registration) {
            const blocked = isRegistrationAllowed({
                methodName: 'registerRequestInterceptor',
                requiredPermission: 'network.intercept',
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
            const manifestOwnedKeys = getRequestInterceptorManifestOwnedRegistrationKeys(registration);
            if (manifestOwnedKeys.length > 0) {
                appendDiagnostic({
                    code: 'plugin_request_interceptor_manifest_fields_redeclared',
                    message: `${formatPluginLabel(policy?.pluginId)} cannot redeclare manifest-owned request interceptor fields at runtime: ${manifestOwnedKeys.join(', ')}`,
                });
                throw new Error(`${formatPluginLabel(policy?.pluginId)} cannot redeclare manifest-owned request interceptor fields at runtime`);
            }
            if (declaredRequestInterceptorIds && !declaredRequestInterceptorIds.has(registration.id)) {
                appendDiagnostic({
                    code: 'plugin_request_interceptor_undeclared_id',
                    message: `${formatPluginLabel(policy?.pluginId)} cannot register request interceptor '${registration.id}' because it is not a manifest-declared request interceptor id`,
                });
                throw new Error(`${formatPluginLabel(policy?.pluginId)} cannot register request interceptor '${registration.id}' because it is not a manifest-declared request interceptor id`);
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
            });
            if (blocked) {
                return blocked;
            }
            if (declaredHookIds && !declaredHookIds.has(registration.hookId)) {
                appendDiagnostic({
                    code: 'plugin_hook_undeclared_id',
                    message: `${formatPluginLabel(policy?.pluginId)} cannot register hook '${registration.hookId}' because it is not a manifest-declared hook id`,
                });
                throw new Error(`${formatPluginLabel(policy?.pluginId)} cannot register hook '${registration.hookId}' because it is not a manifest-declared hook id`);
            }
            if (!getPluginHookDefinitionV1(registration.hookId)) {
                appendDiagnostic({
                    code: 'plugin_hook_unsupported_id',
                    message: `${formatPluginLabel(policy?.pluginId)} cannot register unsupported hook id '${registration.hookId}'`,
                });
                throw new Error(`${formatPluginLabel(policy?.pluginId)} cannot register unsupported hook id '${registration.hookId}'`);
            }
            const storedRegistration = storeHookRegistration(registration);
            hooks.push(storedRegistration);
            return addDisposable(() => {
                const index = hooks.indexOf(storedRegistration);
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
            const registrationId = normalizeOptionalRegistrationId(registration.id);
            if (registrationId === null) {
                appendDiagnostic({
                    code: 'plugin_lifecycle_handler_undeclared_id',
                    message: `${formatPluginLabel(policy?.pluginId)} cannot register lifecycle handler '<missing>' because lifecycle handler registrations must declare a stable lifecycle handler id`,
                });
                throw new Error(`${formatPluginLabel(policy?.pluginId)} cannot register lifecycle handler '<missing>' because lifecycle handler registrations must declare a stable lifecycle handler id`);
            }
            const isDeclaredLifecycleHandler = declaredLifecycleHandlers
                ? declaredLifecycleHandlers.some((declaration) => (
                    declaration.event === registration.event && declaration.id === registrationId
                ))
                : declaredLifecycleHandlerIds === null || declaredLifecycleHandlerIds.has(registrationId);
            if (!isDeclaredLifecycleHandler) {
                appendDiagnostic({
                    code: 'plugin_lifecycle_handler_undeclared_id',
                    message: `${formatPluginLabel(policy?.pluginId)} cannot register lifecycle handler '${registrationId ?? '<missing>'}' because it is not a manifest-declared lifecycle handler id`,
                });
                throw new Error(`${formatPluginLabel(policy?.pluginId)} cannot register lifecycle handler '${registrationId ?? '<missing>'}' because it is not a manifest-declared lifecycle handler id`);
            }
            lifecycleHandlers.push(registration);
            return addDisposable(() => {
                const index = lifecycleHandlers.indexOf(registration);
                if (index >= 0) {
                    lifecycleHandlers.splice(index, 1);
                }
            });
        },
        onDispose(disposable) {
            return addDisposable(disposable);
        },
    });

    return {
        api,
        addDisposable,
        registrations: () => Object.freeze({
            agentRuntimes: Object.freeze([...agentRuntimes]),
            daemonAuthBridges: Object.freeze([...daemonAuthBridges]),
            actions: Object.freeze([...actions]),
            tools: Object.freeze([...tools]),
            commands: Object.freeze([...commands]),
            notificationCategories: Object.freeze([...notificationCategories]),
            notificationChannels: Object.freeze([...notificationChannels]),
            scmHostingProviders: Object.freeze([...scmHostingProviders]),
            scmBackends: Object.freeze([...scmBackends]),
            mcpServers: Object.freeze([...mcpServers]),
            mcpDiscoveryProviders: Object.freeze([...mcpDiscoveryProviders]),
            requestInterceptors: Object.freeze([...requestInterceptors]),
            hooks: Object.freeze([...hooks]),
            lifecycleHandlers: Object.freeze([...lifecycleHandlers]),
            disposables: disposableRegistry.entries(),
            diagnostics: Object.freeze([...diagnostics]),
        }),
        dispose: disposableRegistry.dispose,
    };
}
