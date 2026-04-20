import { ExtensionManifestV2Schema } from '@happier-dev/protocol';
import type {
    ExtensionPermissionCapabilityV1,
    ExtensionManifestV2,
    ExtensionRuntimeCapabilityFamilyV1,
    ExtensionSourceSpecV1,
} from '@happier-dev/protocol';

import type { PluginCompatibilityDiagnostic } from '@/extensions/diagnostics/types';
import { readPluginManifest } from '@/extensions/manifest/read';
import type {
    ResolvedBackendContribution,
    ResolvedContributionRegistry,
    ResolvedCommandContribution,
    ResolvedLifecycleHandlerContribution,
    ResolvedProviderContribution,
    ResolvedActionContribution,
    ResolvedResourceContribution,
    ResolvedToolContribution,
    ResolvedUiDescriptorContribution,
} from '@/extensions/registry/types';

import { createPluginExtensionApiHost } from '../api/host';
import type {
    PluginExtensionApiActionRegistration,
    PluginExtensionApiBackendRegistration,
    PluginExtensionApiBackendEngineRegistration,
    PluginExtensionApiCommandRegistration,
    PluginDisposable,
    PluginExtensionApi,
    PluginExtensionApiHookRegistration,
    PluginExtensionApiLifecycleHandlerRegistration,
    PluginExtensionApiProviderRegistration,
    PluginExtensionApiResourceRegistration,
    PluginExtensionApiRuntimeAdapterRegistration,
    PluginExtensionApiToolRegistration,
    PluginExtensionApiUiDescriptorRegistration,
} from '../api/types';
import { createActivatedHandlerRegistry, type ActivatedHandlerRegistry } from '../handlers/registry';
import type { ExtensionActivationSource } from '../activationSources';
import { loadExtensionModule } from '../loadExtensionModule';
import type {
    PluginDaemonModuleNamespace,
    PluginLifecycleHandlerRequest,
    ResolvedPluginLifecycleHandler,
} from '../types';

type ActivationTarget = Readonly<{
    pluginId: string;
    manifestPath: string;
    manifestDigest: string;
    daemonEntryPath: string;
    sourceSpec?: ExtensionSourceSpecV1;
}>;

type ActivationExport = (api: PluginExtensionApi) => void | PluginDisposable | Promise<void | PluginDisposable>;

type ActivationPolicy = Readonly<{
    permissions: readonly ExtensionPermissionCapabilityV1[];
    runtimeCapabilities: readonly ExtensionRuntimeCapabilityFamilyV1[];
}>;

function readBundledActivationPolicy(params: Readonly<{
    target: ActivationTarget;
    moduleNamespace: PluginDaemonModuleNamespace;
    diagnosticsByPluginId: Record<string, PluginCompatibilityDiagnostic[]>;
}>): ActivationPolicy | null {
    const raw = (params.moduleNamespace as Record<string, unknown>).EXTENSION_MANIFEST;
    if (raw === undefined) {
        appendDiagnostic(params.diagnosticsByPluginId, params.target.pluginId, {
            code: 'plugin_manifest_semantic_invalid',
            message: `Bundled plugin '${params.target.pluginId}' is missing EXTENSION_MANIFEST export`,
        });
        return null;
    }

    const parsed = ExtensionManifestV2Schema.safeParse(raw);
    if (!parsed.success) {
        appendDiagnostic(params.diagnosticsByPluginId, params.target.pluginId, {
            code: 'plugin_manifest_semantic_invalid',
            message: `Bundled plugin '${params.target.pluginId}' has an invalid EXTENSION_MANIFEST export`,
        });
        return null;
    }

    const manifest: ExtensionManifestV2 = parsed.data;
    if (manifest.id !== params.target.pluginId) {
        appendDiagnostic(params.diagnosticsByPluginId, params.target.pluginId, {
            code: 'plugin_manifest_semantic_invalid',
            message: `Bundled plugin '${params.target.pluginId}' EXTENSION_MANIFEST id '${manifest.id}' must match the plugin id`,
        });
        return null;
    }

    return Object.freeze({
        permissions: Object.freeze(manifest.permissions.map((permission) => permission.capability)),
        runtimeCapabilities: Object.freeze([...manifest.runtime.capabilities]),
    });
}

export type ActivatedPluginRuntimeRegistry = ActivatedHandlerRegistry & Readonly<{
    generation: number;
    providers: readonly ResolvedProviderContribution[];
    backends: readonly ResolvedBackendContribution[];
    backendEnginesByBackendId: ReadonlyMap<string, Readonly<{
        pluginId: string;
        registration: PluginExtensionApiBackendEngineRegistration;
    }>>;
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
    sourceSpec?: ExtensionSourceSpecV1;
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

function collectActivationTargets(contributions: ResolvedContributionRegistry): readonly ActivationTarget[] {
    const targets = new Map<string, ActivationTarget>();
    for (const target of contributions.activationTargets) {
        addActivationTarget(targets, target);
    }
    for (const provider of contributions.providers) {
        addActivationTarget(targets, provider);
    }
    for (const backend of contributions.backends) {
        addActivationTarget(targets, backend);
    }
    for (const action of contributions.actions) {
        addActivationTarget(targets, action);
    }
    for (const tool of contributions.tools ?? []) {
        addActivationTarget(targets, tool);
    }
    for (const command of contributions.commands ?? []) {
        addActivationTarget(targets, command);
    }
    for (const hookRegistration of contributions.hookRegistrations) {
        addActivationTarget(targets, hookRegistration);
    }
    for (const lifecycleHandler of contributions.lifecycleHandlers ?? []) {
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
    sourceSpec?: ExtensionSourceSpecV1;
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
    resolver: ((target: ActivationTarget) => ExtensionActivationSource<PluginDaemonModuleNamespace> | null) | undefined,
): ExtensionActivationSource<PluginDaemonModuleNamespace> {
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
    });
    cache.set(target.manifestPath, policy);
    return { ok: true, policy };
}

function toResolvedProviderContribution(
    target: ActivationTarget,
    definition: PluginExtensionApiProviderRegistration,
): ResolvedProviderContribution {
    return {
        ...resolveContributionMetadata(target),
        id: definition.id,
        definition,
        richDefinition: {
            provenance: 'external',
            definition,
        },
    };
}

function toResolvedBackendContribution(
    target: ActivationTarget,
    definition: PluginExtensionApiBackendRegistration,
): ResolvedBackendContribution {
    return {
        ...resolveContributionMetadata(target),
        id: definition.id,
        providerId: definition.providerId,
        definition,
        richDefinition: {
            provenance: 'external',
            definition,
        },
        runtimeKind: definition.runtimeKind,
        capabilities: definition.capabilities,
        runtimeAdapters: definition.runtimeAdapters,
    };
}

function toResolvedActionContribution(
    target: ActivationTarget,
    definition: PluginExtensionApiActionRegistration,
): ResolvedActionContribution {
    const surfaces = {
        ui_button: false,
        ui_slash_command: false,
        voice_tool: false,
        voice_action_block: false,
        session_agent: false,
        mcp: false,
        cli: false,
        ...(definition.surfaces ?? {}),
    };
    if (definition.surface) {
        const surfaceKey = definition.surface as keyof typeof surfaces;
        surfaces[surfaceKey] = true;
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
            safety: definition.safety ?? 'safe',
            placements: definition.placements ? [...definition.placements] : [],
            slash: definition.slash ?? null,
            bindings: definition.bindings ?? null,
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
    definition: PluginExtensionApiToolRegistration,
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
    definition: PluginExtensionApiToolRegistration,
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
                ui_button: false,
                ui_slash_command: false,
                voice_tool: false,
                voice_action_block: false,
                session_agent: definition.surfaces?.session_agent === true,
                mcp: definition.surfaces?.mcp === true,
                cli: definition.surfaces?.cli === true,
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
    definition: PluginExtensionApiCommandRegistration,
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
    definition: PluginExtensionApiCommandRegistration,
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
                ui_button: false,
                ui_slash_command: false,
                voice_tool: false,
                voice_action_block: false,
                session_agent: false,
                mcp: false,
                cli: true,
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
    definition: PluginExtensionApiResourceRegistration,
): ResolvedResourceContribution {
    return {
        ...resolveContributionMetadata(target),
        definition,
    };
}

function toResolvedUiDescriptorContribution(
    target: ActivationTarget,
    definition: PluginExtensionApiUiDescriptorRegistration,
): ResolvedUiDescriptorContribution {
    return {
        ...resolveContributionMetadata(target),
        definition,
    };
}

function toResolvedLifecycleHandlerContribution(
    target: ActivationTarget,
    definition: PluginExtensionApiLifecycleHandlerRegistration,
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
    contributions: ResolvedContributionRegistry;
    generation: number;
    resolveActivationSource?: (target: ActivationTarget) => ExtensionActivationSource<PluginDaemonModuleNamespace> | null;
}>): Promise<ActivatedPluginRuntimeRegistry> {
    const diagnosticsByPluginId: Record<string, PluginCompatibilityDiagnostic[]> = {};
    const activationPolicyCache = new Map<string, ActivationPolicy>();
    const activatedEntries: Array<{
        pluginId: string;
        manifestPath: string;
        manifestDigest: string;
        daemonEntryPath: string;
        sourceSpec?: ExtensionSourceSpecV1;
        providers: readonly PluginExtensionApiProviderRegistration[];
        backends: readonly PluginExtensionApiBackendRegistration[];
        backendEngines: readonly PluginExtensionApiBackendEngineRegistration[];
        actions: readonly PluginExtensionApiActionRegistration[];
        tools: readonly PluginExtensionApiToolRegistration[];
        commands: readonly PluginExtensionApiCommandRegistration[];
        hooks: readonly PluginExtensionApiHookRegistration[];
        lifecycleHandlers: readonly PluginExtensionApiLifecycleHandlerRegistration[];
        resources: readonly PluginExtensionApiResourceRegistration[];
        runtimeAdapters: readonly PluginExtensionApiRuntimeAdapterRegistration[];
        uiDescriptors: readonly PluginExtensionApiUiDescriptorRegistration[];
    }> = [];
    const disposers: Array<() => Promise<void>> = [];

    for (const target of collectActivationTargets(params.contributions)) {
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
            moduleNamespace = await loadExtensionModule({
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

        const host = createPluginExtensionApiHost({
            pluginId: target.pluginId,
            runtimeCapabilities: activationSource.kind === 'bundled'
                ? bundledPolicy!.runtimeCapabilities
                : activationPolicy!.policy.runtimeCapabilities,
            permissions: activationSource.kind === 'bundled'
                ? bundledPolicy!.permissions
                : activationPolicy!.policy.permissions,
        });
        try {
            const disposable = await activationExport.activate(host.api);
            if (disposable) {
                host.addDisposable(disposable);
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
            providers: registrations.providers,
            backends: registrations.backends,
            backendEngines: registrations.backendEngines,
            actions: registrations.actions,
            tools: registrations.tools,
            commands: registrations.commands,
            hooks: registrations.hooks,
            lifecycleHandlers: registrations.lifecycleHandlers,
            resources: registrations.resources,
            runtimeAdapters: registrations.runtimeAdapters,
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
        registration: PluginExtensionApiBackendEngineRegistration;
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
    }

    return {
        generation: params.generation,
        providers: Object.freeze(
            activatedEntries.flatMap((entry) => entry.providers.map((definition) => toResolvedProviderContribution(entry, definition))),
        ),
        backends: Object.freeze(
            activatedEntries.flatMap((entry) => entry.backends.map((definition) => toResolvedBackendContribution(entry, definition))),
        ),
        backendEnginesByBackendId,
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
        runtimeAdapterHandlersByBackendId: handlerRegistry.runtimeAdapterHandlersByBackendId,
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
