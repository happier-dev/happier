import { dirname } from 'node:path';

import { autoRegisterAcpBackend } from '@happier-dev/plugin-sdk/acp';
import { PluginManifestV2Schema } from '@happier-dev/protocol';
import type {
    PluginPermissionCapabilityV1,
    PluginManifestV2,
    PluginRuntimeCapabilityFamilyV1,
    PluginSourceSpecV1,
} from '@happier-dev/protocol';

import type { PluginCompatibilityDiagnostic } from '@/plugins/validation/diagnostics/types';
import { readPluginManifest } from '@/plugins/manifest/read';
import type {
    ResolvedContributionRegistry,
    ResolvedCommandContribution,
    ResolvedLifecycleHandlerContribution,
    ResolvedActionContribution,
    ResolvedResourceContribution,
    ResolvedToolContribution,
    ResolvedUiDescriptorContribution,
} from '@/plugins/projection/registry/types';

import { createPluginApiHost } from '../api/host';
import type {
    PluginApiActionRegistration,
    PluginApiBackendEngineRegistration,
    PluginApiCommandRegistration,
    PluginDisposable,
    PluginApi,
    PluginApiHookRegistration,
    PluginApiLifecycleHandlerRegistration,
    PluginApiNotificationCategoryRegistration,
    PluginApiNotificationChannelRegistration,
    PluginApiRequestInterceptorRegistration,
    PluginApiResourceRegistration,
    PluginApiScmHostingProviderRegistration,
    PluginApiToolRegistration,
    PluginApiUiDescriptorRegistration,
} from '../api/types';
import { createActivatedHandlerRegistry, type ActivatedHandlerRegistry } from '../handlers/registry';
import type { PluginActivationSource } from '../activationSources';
import { loadPluginModule } from '../loadPluginModule';
import type {
    PluginDaemonModuleNamespace,
    PluginHookHandler,
    PluginLifecycleHandlerRequest,
    ResolvedPluginLifecycleHandler,
} from '../types';

type ActivationTarget = Readonly<{
    pluginId: string;
    manifestPath: string;
    manifestDigest: string;
    daemonEntryPath: string;
    sourceSpec?: PluginSourceSpecV1;
}>;

type ActivationExport = (api: PluginApi) => void | PluginDisposable | Promise<void | PluginDisposable>;

type ActivationPolicy = Readonly<{
    permissions: readonly PluginPermissionCapabilityV1[];
    runtimeCapabilities: readonly PluginRuntimeCapabilityFamilyV1[];
    declaredBackendIds: readonly string[];
    declaredNotificationCategoryIds: readonly string[];
    declaredNotificationChannelIds: readonly string[];
    declaredScmHostingProviderIds: readonly string[];
}>;

function readBundledActivationPolicy(params: Readonly<{
    target: ActivationTarget;
    moduleNamespace: PluginDaemonModuleNamespace;
    diagnosticsByPluginId: Record<string, PluginCompatibilityDiagnostic[]>;
}>): ActivationPolicy | null {
    const raw = (params.moduleNamespace as Record<string, unknown>).PLUGIN_MANIFEST;
    if (raw === undefined) {
        appendDiagnostic(params.diagnosticsByPluginId, params.target.pluginId, {
            code: 'plugin_manifest_semantic_invalid',
            message: `Bundled plugin '${params.target.pluginId}' is missing PLUGIN_MANIFEST export`,
        });
        return null;
    }

    const parsed = PluginManifestV2Schema.safeParse(raw);
    if (!parsed.success) {
        appendDiagnostic(params.diagnosticsByPluginId, params.target.pluginId, {
            code: 'plugin_manifest_semantic_invalid',
            message: `Bundled plugin '${params.target.pluginId}' has an invalid PLUGIN_MANIFEST export`,
        });
        return null;
    }

    const manifest: PluginManifestV2 = parsed.data;
    if (manifest.id !== params.target.pluginId) {
        appendDiagnostic(params.diagnosticsByPluginId, params.target.pluginId, {
            code: 'plugin_manifest_semantic_invalid',
            message: `Bundled plugin '${params.target.pluginId}' PLUGIN_MANIFEST id '${manifest.id}' must match the plugin id`,
        });
        return null;
    }

    return Object.freeze({
        permissions: Object.freeze(manifest.capabilities.permissions.map((permission) => permission.capability)),
        runtimeCapabilities: Object.freeze([...manifest.runtime.capabilities]),
        declaredBackendIds: readDeclaredBackendIds(manifest.contributes),
        declaredNotificationCategoryIds: readDeclaredContributionIds(manifest.contributes, 'notifications'),
        declaredNotificationChannelIds: readDeclaredContributionIds(manifest.contributes, 'notificationChannels'),
        declaredScmHostingProviderIds: readDeclaredContributionIds(manifest.contributes, 'scmHostingProviders'),
    });
}

export type ActivatedPluginRuntimeRegistry = ActivatedHandlerRegistry & Readonly<{
    generation: number;
    backendEnginesByBackendId: ReadonlyMap<string, Readonly<{
        pluginId: string;
        registration: PluginApiBackendEngineRegistration;
    }>>;
    notificationCategoriesById: ReadonlyMap<string, Readonly<{
        pluginId: string;
        registration: PluginApiNotificationCategoryRegistration;
    }>>;
    notificationChannelsById: ReadonlyMap<string, Readonly<{
        pluginId: string;
        registration: PluginApiNotificationChannelRegistration;
    }>>;
    scmHostingProvidersById: ReadonlyMap<string, Readonly<{
        pluginId: string;
        registration: PluginApiScmHostingProviderRegistration;
    }>>;
    requestInterceptors: readonly Readonly<{
        pluginId: string;
        registration: PluginApiRequestInterceptorRegistration;
    }>[];
    networkAllowedPluginIds: ReadonlySet<string>;
    eventSubscriptionPermissionsByPluginId: ReadonlyMap<string, ReadonlySet<PluginPermissionCapabilityV1>>;
    runtimeCoreHandlersByBackendId: ReadonlyMap<string, ReadonlyMap<string, PluginHookHandler>>;
    actions: readonly ResolvedActionContribution[];
    tools: readonly ResolvedToolContribution[];
    commands: readonly ResolvedCommandContribution[];
    resources: readonly ResolvedResourceContribution[];
    uiDescriptors: readonly ResolvedUiDescriptorContribution[];
    lifecycleHandlers: readonly ResolvedLifecycleHandlerContribution[];
    pluginDiagnosticsByPluginId: Readonly<Record<string, readonly PluginCompatibilityDiagnostic[]>>;
    dispose: () => Promise<void>;
}>;

function appendDiagnostic(
    diagnosticsByPluginId: Record<string, PluginCompatibilityDiagnostic[]>,
    pluginId: string,
    diagnostic: PluginCompatibilityDiagnostic,
): void {
    const existing = diagnosticsByPluginId[pluginId];
    if (existing) {
        existing.push(diagnostic);
        return;
    }
    diagnosticsByPluginId[pluginId] = [diagnostic];
}

function appendDiagnostics(
    diagnosticsByPluginId: Record<string, PluginCompatibilityDiagnostic[]>,
    pluginId: string,
    diagnostics: readonly PluginCompatibilityDiagnostic[],
): void {
    for (const diagnostic of diagnostics) {
        appendDiagnostic(diagnosticsByPluginId, pluginId, diagnostic);
    }
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return Boolean(value) && typeof value === 'object';
}

function readDeclaredBackendIds(value: unknown): readonly string[] {
    return readDeclaredContributionIds(value, 'backends');
}

function readDeclaredContributionIds(value: unknown, key: string): readonly string[] {
    if (!isRecord(value) || !Array.isArray(value[key])) {
        return Object.freeze([]);
    }
    return Object.freeze(value[key].flatMap((definition) => {
        if (!isRecord(definition)) {
            return [];
        }
        const id = typeof definition.id === 'string' ? definition.id.trim() : '';
        return id.length > 0 ? [id] : [];
    }));
}

function resolveActivationExport(moduleNamespace: PluginDaemonModuleNamespace): Readonly<
    | { status: 'found'; activate: ActivationExport }
    | { status: 'missing' }
    | { status: 'invalid' }
> {
    if (typeof moduleNamespace.activate === 'function') {
        return { status: 'found', activate: moduleNamespace.activate as ActivationExport };
    }

    if (typeof moduleNamespace.default === 'function') {
        return { status: 'found', activate: moduleNamespace.default as ActivationExport };
    }

    if (isRecord(moduleNamespace.default) && typeof moduleNamespace.default.activate === 'function') {
        return { status: 'found', activate: moduleNamespace.default.activate as ActivationExport };
    }

    if (
        moduleNamespace.activate !== undefined
        || (isRecord(moduleNamespace.default) && moduleNamespace.default.activate !== undefined)
    ) {
        return { status: 'invalid' };
    }

    return { status: 'missing' };
}

function addActivationTarget(targets: Map<string, ActivationTarget>, raw: Readonly<{
    pluginId?: string;
    manifestPath?: string;
    manifestDigest?: string;
    daemonEntryPath?: string | null;
    sourceSpec?: PluginSourceSpecV1;
}>): void {
    if (!raw.pluginId || !raw.manifestPath || !raw.manifestDigest || !raw.daemonEntryPath) {
        return;
    }
    const key = `${raw.pluginId}::${raw.daemonEntryPath}`;
    if (targets.has(key)) {
        return;
    }
    targets.set(key, {
        pluginId: raw.pluginId,
        manifestPath: raw.manifestPath,
        manifestDigest: raw.manifestDigest,
        daemonEntryPath: raw.daemonEntryPath,
        sourceSpec: raw.sourceSpec,
    });
}

function collectActivationTargets(contributes: ResolvedContributionRegistry): readonly ActivationTarget[] {
    const targets = new Map<string, ActivationTarget>();
    for (const target of contributes.activationTargets) {
        addActivationTarget(targets, target);
    }
    for (const provider of contributes.providers) {
        addActivationTarget(targets, provider);
    }
    for (const backend of contributes.backends) {
        addActivationTarget(targets, backend);
    }
    for (const action of contributes.actions) {
        addActivationTarget(targets, action);
    }
    for (const tool of contributes.tools ?? []) {
        addActivationTarget(targets, tool);
    }
    for (const command of contributes.commands ?? []) {
        addActivationTarget(targets, command);
    }
    for (const hookRegistration of contributes.hookRegistrations) {
        addActivationTarget(targets, hookRegistration);
    }
    for (const lifecycleHandler of contributes.lifecycleHandlers ?? []) {
        addActivationTarget(targets, lifecycleHandler);
    }
    return Object.freeze([...targets.values()]);
}

function freezeDiagnostics(
    diagnosticsByPluginId: Record<string, PluginCompatibilityDiagnostic[]>,
): Readonly<Record<string, readonly PluginCompatibilityDiagnostic[]>> {
    return Object.freeze(
        Object.fromEntries(
            Object.entries(diagnosticsByPluginId).map(([pluginId, diagnostics]) => [
                pluginId,
                Object.freeze([...diagnostics]),
            ]),
        ) as Record<string, readonly PluginCompatibilityDiagnostic[]>,
    );
}

function resolveContributionMetadata(target: ActivationTarget): Readonly<{
    provenance: 'external';
    source: Readonly<{ kind: 'path' | 'archive' | 'marketplace' | 'package' }>;
    pluginId: string;
    manifestPath: string;
    manifestDigest: string;
    daemonEntryPath: string;
    sourceSpec?: PluginSourceSpecV1;
}> {
    return {
        provenance: 'external',
        source: { kind: target.sourceSpec?.kind ?? 'path' },
        pluginId: target.pluginId,
        manifestPath: target.manifestPath,
        manifestDigest: target.manifestDigest,
        daemonEntryPath: target.daemonEntryPath,
        ...(target.sourceSpec ? { sourceSpec: target.sourceSpec } : {}),
    };
}

function mapDaemonModuleLoadErrorToDiagnostic(error: unknown): PluginCompatibilityDiagnostic {
    const errorCode = error instanceof Error ? String((error as Error & { code?: string }).code ?? '') : '';
    return {
        code:
            errorCode === 'PLUGIN_DAEMON_TRUST_APPROVAL_REQUIRED'
                ? 'plugin_trust_approval_required'
                : errorCode === 'PLUGIN_DAEMON_TRUST_UNTRUSTED'
                    ? 'plugin_untrusted'
                    : errorCode === 'PLUGIN_DAEMON_ENTRY_MISSING'
                        ? 'plugin_source_missing'
                        : errorCode === 'PLUGIN_DAEMON_ENTRY_KIND_UNSUPPORTED'
                            ? 'plugin_source_kind_unsupported'
                            : 'plugin_daemon_module_load_failed',
        message: error instanceof Error ? error.message : 'Failed to load plugin daemon module',
    };
}

function resolveActivationSource(
    target: ActivationTarget,
    resolver: ((target: ActivationTarget) => PluginActivationSource<PluginDaemonModuleNamespace> | null) | undefined,
): PluginActivationSource<PluginDaemonModuleNamespace> {
    const resolved = resolver?.(target) ?? null;
    if (resolved) {
        return resolved;
    }

    return {
        kind: 'file_backed',
        entryPath: target.daemonEntryPath,
        trustPolicy: target.sourceSpec?.trustPolicy,
    };
}

function resolveAutoAcpPluginRoot(target: ActivationTarget, activationSource: PluginActivationSource<PluginDaemonModuleNamespace>): string | null {
    if (activationSource.kind !== 'file_backed') {
        return null;
    }
    if (target.sourceSpec?.kind === 'path' && target.sourceSpec.locator.trim().length > 0) {
        return target.sourceSpec.locator;
    }
    return dirname(dirname(target.manifestPath));
}

async function resolveActivationPolicy(
    target: ActivationTarget,
    cache: Map<string, ActivationPolicy>,
): Promise<
    | Readonly<{ ok: true; policy: ActivationPolicy }>
    | Readonly<{ ok: false; diagnostics: readonly PluginCompatibilityDiagnostic[] }>
> {
    const cached = cache.get(target.manifestPath);
    if (cached) {
        return { ok: true, policy: cached };
    }

    const manifestResult = await readPluginManifest({
        manifestPath: target.manifestPath,
    });
    if (!manifestResult.ok) {
        return {
            ok: false,
            diagnostics: manifestResult.diagnostics,
        };
    }

    const policy: ActivationPolicy = Object.freeze({
        permissions: Object.freeze(manifestResult.manifest.permissions.map((permission) => permission.capability)),
        runtimeCapabilities: Object.freeze([...manifestResult.manifest.runtime.capabilities]),
        declaredBackendIds: readDeclaredBackendIds(manifestResult.manifest.contributes),
        declaredNotificationCategoryIds: readDeclaredContributionIds(manifestResult.manifest.contributes, 'notifications'),
        declaredNotificationChannelIds: readDeclaredContributionIds(manifestResult.manifest.contributes, 'notificationChannels'),
        declaredScmHostingProviderIds: readDeclaredContributionIds(manifestResult.manifest.contributes, 'scmHostingProviders'),
    });
    cache.set(target.manifestPath, policy);
    return { ok: true, policy };
}

function toResolvedActionContribution(
    target: ActivationTarget,
    definition: PluginApiActionRegistration,
): ResolvedActionContribution {
    const declaredSurfaces = new Set(definition.surfaces ?? []);
    const surfaces = {
        ui: declaredSurfaces.has('settings')
            || declaredSurfaces.has('agentSettings')
            || declaredSurfaces.has('backendSettings')
            || declaredSurfaces.has('sessionMenu')
            || declaredSurfaces.has('executionRunMenu')
            || declaredSurfaces.has('commandPalette'),
        voice: false,
        session_agent: declaredSurfaces.has('agentTool'),
        mcp: false,
        cli: declaredSurfaces.has('cli'),
        rpc: false,
        sdk: false,
    };
    if (definition.surface) {
        if (definition.surface === 'cli') {
            surfaces.cli = true;
        } else if (definition.surface === 'agentTool') {
            surfaces.session_agent = true;
        } else {
            surfaces.ui = true;
        }
    }

    const normalizedDescription = typeof definition.description === 'string'
        ? definition.description.trim()
        : '';

    return {
        ...resolveContributionMetadata(target),
        definition: {
            kindVersion: 1,
            id: definition.id,
            title: definition.title,
            description: normalizedDescription.length > 0 ? normalizedDescription : null,
            safety: definition.safety === 'safe' || definition.safety === undefined ? 'safe' : 'danger',
            placements: [],
            slash: null,
            bindings: null,
            examples: definition.examples ?? null,
            surfaces,
            inputHints: definition.inputHints ?? null,
            inputSchema: definition.inputSchema ?? {},
            ...(definition.outputSchema ? { outputSchema: definition.outputSchema } : {}),
            ...(definition.compatibility ? { compatibility: definition.compatibility } : {}),
        },
    };
}

function toResolvedToolContribution(
    target: ActivationTarget,
    definition: PluginApiToolRegistration,
): ResolvedToolContribution {
    const normalizedDescription = typeof definition.description === 'string'
        ? definition.description.trim()
        : '';
    const surfaces = {
        cli: definition.surfaces?.cli === true,
        mcp: definition.surfaces?.mcp === true,
        session_agent: definition.surfaces?.session_agent === true,
    };

    return {
        ...resolveContributionMetadata(target),
        definition: {
            kindVersion: 1,
            id: definition.id,
            name: definition.name,
            title: definition.title,
            description: normalizedDescription.length > 0 ? normalizedDescription : null,
            safety: definition.safety ?? 'safe',
            surfaces,
            inputSchema: definition.inputSchema ?? {},
            ...(definition.outputSchema ? { outputSchema: definition.outputSchema } : {}),
            ...(definition.inputHints ? { inputHints: definition.inputHints } : {}),
            ...(definition.compatibility ? { compatibility: definition.compatibility } : {}),
            ...(definition.examples ? { examples: definition.examples } : {}),
            actionId: definition.id,
        },
    };
}

function toSyntheticActionContributionFromTool(
    target: ActivationTarget,
    definition: PluginApiToolRegistration,
): ResolvedActionContribution {
    return {
        ...resolveContributionMetadata(target),
        definition: {
            kindVersion: 1,
            id: definition.id,
            title: definition.title,
            description: typeof definition.description === 'string' && definition.description.trim().length > 0
                ? definition.description.trim()
                : null,
            safety: definition.safety ?? 'safe',
            placements: [],
            slash: null,
            bindings: {
                mcpToolName: definition.name,
            },
            examples: definition.examples ?? null,
            surfaces: {
                ui: false,
                voice: false,
                session_agent: definition.surfaces?.session_agent === true,
                mcp: definition.surfaces?.mcp === true,
                cli: definition.surfaces?.cli === true,
                rpc: false,
                sdk: false,
            },
            inputHints: definition.inputHints ?? null,
            inputSchema: definition.inputSchema ?? {},
            ...(definition.outputSchema ? { outputSchema: definition.outputSchema } : {}),
            ...(definition.compatibility ? { compatibility: definition.compatibility } : {}),
        },
    };
}

function toResolvedCommandContribution(
    target: ActivationTarget,
    definition: PluginApiCommandRegistration,
): ResolvedCommandContribution {
    return {
        ...resolveContributionMetadata(target),
        definition: {
            kindVersion: 1,
            id: definition.id,
            command: definition.command,
            ...(definition.rootHelpLabel ? { rootHelpLabel: definition.rootHelpLabel } : {}),
            ...(definition.rootHelpDescription ? { rootHelpDescription: definition.rootHelpDescription } : {}),
            ...(definition.rootHelpDetail ? { rootHelpDetail: definition.rootHelpDetail } : {}),
            allowTmux: definition.allowTmux,
            ...(definition.visibility ? { visibility: definition.visibility } : {}),
            ...(definition.featureGate ? { featureGate: definition.featureGate } : {}),
            actionId: definition.actionId ?? definition.id,
        },
    };
}

function toSyntheticActionContributionFromCommand(
    target: ActivationTarget,
    definition: PluginApiCommandRegistration,
): ResolvedActionContribution {
    return {
        ...resolveContributionMetadata(target),
        definition: {
            kindVersion: 1,
            id: definition.actionId ?? definition.id,
            title: definition.rootHelpLabel ?? definition.command,
            description: definition.rootHelpDescription ?? null,
            safety: 'safe',
            placements: [],
            slash: null,
            bindings: null,
            examples: null,
            surfaces: {
                ui: false,
                voice: false,
                session_agent: false,
                mcp: false,
                cli: true,
                rpc: false,
                sdk: false,
            },
            inputHints: null,
            inputSchema: {
                type: 'object',
                properties: {
                    argv: {
                        type: 'array',
                    },
                    rawArgv: {
                        type: 'array',
                    },
                },
                additionalProperties: true,
            },
        },
    };
}

function toResolvedResourceContribution(
    target: ActivationTarget,
    definition: PluginApiResourceRegistration,
): ResolvedResourceContribution {
    return {
        ...resolveContributionMetadata(target),
        definition,
    };
}

function toResolvedUiDescriptorContribution(
    target: ActivationTarget,
    definition: PluginApiUiDescriptorRegistration,
): ResolvedUiDescriptorContribution {
    return {
        ...resolveContributionMetadata(target),
        definition: {
            kindVersion: definition.kindVersion,
            id: definition.id,
            surface: definition.surface,
            title: definition.title,
            description: definition.description,
            ...(typeof definition.order === 'number' ? { order: definition.order } : {}),
            ...(definition.tone !== undefined ? { tone: definition.tone } : {}),
            ...(definition.featureGate !== undefined ? { featureGate: definition.featureGate } : {}),
            ...(definition.helpUrl !== undefined ? { helpUrl: definition.helpUrl } : {}),
            fields: Object.freeze(definition.fields.map((field) => Object.freeze({
                id: field.id,
                kind: field.type,
                title: field.title,
                description: field.description,
                ...(typeof field.order === 'number' ? { order: field.order } : {}),
                ...(field.groupId !== undefined ? { groupId: field.groupId } : {}),
                ...(field.featureGate !== undefined ? { featureGate: field.featureGate } : {}),
                ...(field.actionId !== undefined ? { actionId: field.actionId } : {}),
                options: Object.freeze((field.options ?? []).map((option) => Object.freeze({
                    value: option.value,
                    label: option.label,
                }))),
            }))),
        },
    };
}

function toResolvedLifecycleHandlerContribution(
    target: ActivationTarget,
    definition: PluginApiLifecycleHandlerRegistration,
    index: number,
): ResolvedLifecycleHandlerContribution {
    return {
        ...resolveContributionMetadata(target),
        definition: {
            kindVersion: 1,
            id: definition.id?.trim().length ? definition.id.trim() : `${target.pluginId}:${definition.event}:${index}`,
            event: definition.event,
            priority: definition.priority ?? 0,
        },
    };
}

async function dispatchLifecycleHandlers(params: Readonly<{
    diagnosticsByPluginId: Record<string, PluginCompatibilityDiagnostic[]>;
    event: PluginLifecycleHandlerRequest['event'];
    generation: number;
    handlers: readonly ResolvedPluginLifecycleHandler[];
}>): Promise<void> {
    for (const handler of params.handlers) {
        try {
            await handler.handler({
                event: params.event,
                pluginId: handler.pluginId,
                generation: params.generation,
                provenance: {
                    manifestPath: handler.manifestPath,
                    manifestDigest: handler.manifestDigest,
                    sourceKind: 'path',
                },
            });
        } catch (error) {
            appendDiagnostic(params.diagnosticsByPluginId, handler.pluginId, {
                code: 'plugin_activation_failed',
                message: error instanceof Error
                    ? error.message
                    : `Plugin lifecycle handler '${handler.registrationId}' failed`,
            });
        }
    }
}

export async function activatePluginRuntimeRegistry(params: Readonly<{
    contributes: ResolvedContributionRegistry;
    generation: number;
    resolveActivationSource?: (target: ActivationTarget) => PluginActivationSource<PluginDaemonModuleNamespace> | null;
}>): Promise<ActivatedPluginRuntimeRegistry> {
    const diagnosticsByPluginId: Record<string, PluginCompatibilityDiagnostic[]> = {};
    const activationPolicyCache = new Map<string, ActivationPolicy>();
    const activatedEntries: Array<{
        pluginId: string;
        manifestPath: string;
        manifestDigest: string;
        daemonEntryPath: string;
        sourceSpec?: PluginSourceSpecV1;
        backendEngines: readonly PluginApiBackendEngineRegistration[];
        actions: readonly PluginApiActionRegistration[];
        tools: readonly PluginApiToolRegistration[];
        commands: readonly PluginApiCommandRegistration[];
        notificationCategories: readonly PluginApiNotificationCategoryRegistration[];
        notificationChannels: readonly PluginApiNotificationChannelRegistration[];
        scmHostingProviders: readonly PluginApiScmHostingProviderRegistration[];
        requestInterceptors: readonly PluginApiRequestInterceptorRegistration[];
        permissions: readonly PluginPermissionCapabilityV1[];
        hooks: readonly PluginApiHookRegistration[];
        lifecycleHandlers: readonly PluginApiLifecycleHandlerRegistration[];
        resources: readonly PluginApiResourceRegistration[];
        uiDescriptors: readonly PluginApiUiDescriptorRegistration[];
    }> = [];
    const disposers: Array<() => Promise<void>> = [];

    for (const target of collectActivationTargets(params.contributes)) {
        diagnosticsByPluginId[target.pluginId] = diagnosticsByPluginId[target.pluginId] ?? [];

        const activationSource = resolveActivationSource(target, params.resolveActivationSource);
        const activationPolicy = activationSource.kind === 'bundled'
            ? null
            : await resolveActivationPolicy(target, activationPolicyCache);
        if (activationPolicy && !activationPolicy.ok) {
            appendDiagnostics(diagnosticsByPluginId, target.pluginId, activationPolicy.diagnostics);
            continue;
        }

        let moduleNamespace: PluginDaemonModuleNamespace;
        try {
            moduleNamespace = await loadPluginModule({
                source: activationSource,
                cacheKey: `${target.manifestDigest}:generation:${params.generation}`,
            }) as PluginDaemonModuleNamespace;
        } catch (error) {
            appendDiagnostic(diagnosticsByPluginId, target.pluginId, mapDaemonModuleLoadErrorToDiagnostic(error));
            continue;
        }

        const activationExport = resolveActivationExport(moduleNamespace);
        if (activationExport.status === 'missing') {
            continue;
        }
        if (activationExport.status === 'invalid') {
            appendDiagnostic(diagnosticsByPluginId, target.pluginId, {
                code: 'plugin_manifest_semantic_invalid',
                message: `Plugin '${target.pluginId}' activation export is not a function`,
            });
            continue;
        }

        const bundledPolicy = activationSource.kind === 'bundled'
            ? readBundledActivationPolicy({
                target,
                moduleNamespace,
                diagnosticsByPluginId,
            })
            : null;
        if (activationSource.kind === 'bundled' && !bundledPolicy) {
            continue;
        }

        const host = createPluginApiHost({
            pluginId: target.pluginId,
            runtimeCapabilities: activationSource.kind === 'bundled'
                ? bundledPolicy!.runtimeCapabilities
                : activationPolicy!.policy.runtimeCapabilities,
            permissions: activationSource.kind === 'bundled'
                ? bundledPolicy!.permissions
                : activationPolicy!.policy.permissions,
            declaredBackendIds: activationSource.kind === 'bundled'
                ? bundledPolicy!.declaredBackendIds
                : activationPolicy!.policy.declaredBackendIds,
            declaredNotificationCategoryIds: activationSource.kind === 'bundled'
                ? bundledPolicy!.declaredNotificationCategoryIds
                : activationPolicy!.policy.declaredNotificationCategoryIds,
            declaredNotificationChannelIds: activationSource.kind === 'bundled'
                ? bundledPolicy!.declaredNotificationChannelIds
                : activationPolicy!.policy.declaredNotificationChannelIds,
            declaredScmHostingProviderIds: activationSource.kind === 'bundled'
                ? bundledPolicy!.declaredScmHostingProviderIds
                : activationPolicy!.policy.declaredScmHostingProviderIds,
        });
        try {
            const disposable = await activationExport.activate(host.api);
            if (disposable) {
                host.addDisposable(disposable);
            }
            const autoAcpPluginRoot = resolveAutoAcpPluginRoot(target, activationSource);
            if (autoAcpPluginRoot) {
                await autoRegisterAcpBackend(autoAcpPluginRoot, host.api);
            }
        } catch (error) {
            appendDiagnostics(diagnosticsByPluginId, target.pluginId, host.registrations().diagnostics);
            await host.dispose();
            appendDiagnostic(diagnosticsByPluginId, target.pluginId, {
                code: 'plugin_activation_failed',
                message: error instanceof Error ? error.message : `Failed to activate plugin '${target.pluginId}'`,
            });
            continue;
        }

        disposers.push(host.dispose);
        const registrations = host.registrations();
        appendDiagnostics(diagnosticsByPluginId, target.pluginId, registrations.diagnostics);
        activatedEntries.push({
            pluginId: target.pluginId,
            manifestPath: target.manifestPath,
            manifestDigest: target.manifestDigest,
            daemonEntryPath: target.daemonEntryPath,
            sourceSpec: target.sourceSpec,
            backendEngines: registrations.backendEngines,
            actions: registrations.actions,
            tools: registrations.tools,
            commands: registrations.commands,
            notificationCategories: registrations.notificationCategories,
            notificationChannels: registrations.notificationChannels,
            scmHostingProviders: registrations.scmHostingProviders,
            requestInterceptors: registrations.requestInterceptors,
            permissions: activationSource.kind === 'bundled'
                ? bundledPolicy!.permissions
                : activationPolicy!.policy.permissions,
            hooks: registrations.hooks,
            lifecycleHandlers: registrations.lifecycleHandlers,
            resources: registrations.resources,
            uiDescriptors: registrations.uiDescriptors,
        });
    }

    const handlerRegistry = createActivatedHandlerRegistry({
        entries: activatedEntries,
    });
    await dispatchLifecycleHandlers({
        diagnosticsByPluginId,
        event: 'activated',
        generation: params.generation,
        handlers: handlerRegistry.lifecycleHandlersByEvent.get('activated') ?? [],
    });
    let disposed = false;
    const backendEnginesByBackendId = new Map<string, Readonly<{
        pluginId: string;
        registration: PluginApiBackendEngineRegistration;
    }>>();
    const notificationCategoriesById = new Map<string, Readonly<{
        pluginId: string;
        registration: PluginApiNotificationCategoryRegistration;
    }>>();
    const notificationChannelsById = new Map<string, Readonly<{
        pluginId: string;
        registration: PluginApiNotificationChannelRegistration;
    }>>();
    const scmHostingProvidersById = new Map<string, Readonly<{
        pluginId: string;
        registration: PluginApiScmHostingProviderRegistration;
    }>>();
    for (const entry of activatedEntries) {
        for (const registration of entry.backendEngines) {
            const existing = backendEnginesByBackendId.get(registration.backendId) ?? null;
            if (existing) {
                appendDiagnostic(diagnosticsByPluginId, entry.pluginId, {
                    code: 'plugin_backend_engine_duplicate_backend_id',
                    message: `Plugin '${entry.pluginId}' registered a backend engine for '${registration.backendId}', but it is already registered by plugin '${existing.pluginId}'`,
                });
                appendDiagnostic(diagnosticsByPluginId, existing.pluginId, {
                    code: 'plugin_backend_engine_duplicate_backend_id',
                    message: `Plugin '${existing.pluginId}' registered a backend engine for '${registration.backendId}', but it is also registered by plugin '${entry.pluginId}'`,
                });
                continue;
            }

            backendEnginesByBackendId.set(registration.backendId, Object.freeze({ pluginId: entry.pluginId, registration }));
        }
        for (const registration of entry.notificationCategories) {
            const existing = notificationCategoriesById.get(registration.id) ?? null;
            if (existing) {
                appendDiagnostic(diagnosticsByPluginId, entry.pluginId, {
                    code: 'plugin_notification_category_duplicate_id',
                    message: `Plugin '${entry.pluginId}' registered notification category '${registration.id}', but it is already registered by plugin '${existing.pluginId}'`,
                });
                appendDiagnostic(diagnosticsByPluginId, existing.pluginId, {
                    code: 'plugin_notification_category_duplicate_id',
                    message: `Plugin '${existing.pluginId}' registered notification category '${registration.id}', but it is also registered by plugin '${entry.pluginId}'`,
                });
                continue;
            }

            notificationCategoriesById.set(registration.id, Object.freeze({ pluginId: entry.pluginId, registration }));
        }
        for (const registration of entry.notificationChannels) {
            const existing = notificationChannelsById.get(registration.id) ?? null;
            if (existing) {
                appendDiagnostic(diagnosticsByPluginId, entry.pluginId, {
                    code: 'plugin_notification_channel_duplicate_id',
                    message: `Plugin '${entry.pluginId}' registered notification channel '${registration.id}', but it is already registered by plugin '${existing.pluginId}'`,
                });
                appendDiagnostic(diagnosticsByPluginId, existing.pluginId, {
                    code: 'plugin_notification_channel_duplicate_id',
                    message: `Plugin '${existing.pluginId}' registered notification channel '${registration.id}', but it is also registered by plugin '${entry.pluginId}'`,
                });
                continue;
            }

            notificationChannelsById.set(registration.id, Object.freeze({ pluginId: entry.pluginId, registration }));
        }
        for (const registration of entry.scmHostingProviders) {
            const existing = scmHostingProvidersById.get(registration.id) ?? null;
            if (existing) {
                appendDiagnostic(diagnosticsByPluginId, entry.pluginId, {
                    code: 'plugin_scm_hosting_provider_duplicate_id',
                    message: `Plugin '${entry.pluginId}' registered SCM hosting provider '${registration.id}', but it is already registered by plugin '${existing.pluginId}'`,
                });
                appendDiagnostic(diagnosticsByPluginId, existing.pluginId, {
                    code: 'plugin_scm_hosting_provider_duplicate_id',
                    message: `Plugin '${existing.pluginId}' registered SCM hosting provider '${registration.id}', but it is also registered by plugin '${entry.pluginId}'`,
                });
                continue;
            }

            scmHostingProvidersById.set(registration.id, Object.freeze({ pluginId: entry.pluginId, registration }));
        }
    }

    return {
        generation: params.generation,
        backendEnginesByBackendId,
        notificationCategoriesById,
        notificationChannelsById,
        scmHostingProvidersById,
        requestInterceptors: Object.freeze(activatedEntries.flatMap((entry) => entry.requestInterceptors.map((registration) => Object.freeze({
            pluginId: entry.pluginId,
            registration,
        })))),
        networkAllowedPluginIds: new Set(activatedEntries.flatMap((entry) => (
            entry.permissions.includes('network') ? [entry.pluginId] : []
        ))),
        eventSubscriptionPermissionsByPluginId: new Map(activatedEntries.map((entry) => [
            entry.pluginId,
            new Set(entry.permissions),
        ])),
        runtimeCoreHandlersByBackendId: new Map(),
        actions: Object.freeze(
            activatedEntries.flatMap((entry) => [
                ...entry.actions.map((definition) => toResolvedActionContribution(entry, definition)),
                ...entry.tools.map((definition) => toSyntheticActionContributionFromTool(entry, definition)),
                ...entry.commands.map((definition) => toSyntheticActionContributionFromCommand(entry, definition)),
            ]),
        ),
        tools: Object.freeze(
            activatedEntries.flatMap((entry) => entry.tools.map((definition) => toResolvedToolContribution(entry, definition))),
        ),
        commands: Object.freeze(
            activatedEntries.flatMap((entry) => entry.commands.map((definition) => toResolvedCommandContribution(entry, definition))),
        ),
        resources: Object.freeze(
            activatedEntries.flatMap((entry) => entry.resources.map((definition) => toResolvedResourceContribution(entry, definition))),
        ),
        uiDescriptors: Object.freeze(
            activatedEntries.flatMap((entry) => entry.uiDescriptors.map((definition) => toResolvedUiDescriptorContribution(entry, definition))),
        ),
        lifecycleHandlers: Object.freeze(
            activatedEntries.flatMap((entry) => entry.lifecycleHandlers.map(
                (definition, index) => toResolvedLifecycleHandlerContribution(entry, definition, index),
            )),
        ),
        actionHandlersByActionId: handlerRegistry.actionHandlersByActionId,
        hookHandlersByHookId: handlerRegistry.hookHandlersByHookId,
        lifecycleHandlersByEvent: handlerRegistry.lifecycleHandlersByEvent,
        pluginDiagnosticsByPluginId: freezeDiagnostics(diagnosticsByPluginId),
        async dispose() {
            if (disposed) {
                return;
            }
            disposed = true;
            await dispatchLifecycleHandlers({
                diagnosticsByPluginId,
                event: 'deactivating',
                generation: params.generation,
                handlers: handlerRegistry.lifecycleHandlersByEvent.get('deactivating') ?? [],
            });
            for (const dispose of [...disposers].reverse()) {
                await dispose();
            }
        },
    };
}
