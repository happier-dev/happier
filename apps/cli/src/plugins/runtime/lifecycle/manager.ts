import { dirname, isAbsolute } from 'node:path';

import { autoRegisterAcpBackend } from '@happier-dev/plugin-sdk/acp';
import { PluginManifestV2Schema } from '@happier-dev/protocol';
import type {
    PluginPermissionDeclarationV1,
    PluginPermissionCapabilityV1,
    ParsedPluginManifestV2,
    ParsedPluginEventContributionV1,
    PluginRequestInterceptorContributionV1,
    PluginRuntimeCapabilityFamilyV1,
    PluginSourceSpecV1,
    PluginSystemToolContributionV1,
} from '@happier-dev/protocol';

import type { PluginCompatibilityDiagnostic } from '../../validation/diagnostics/types';
import { readPluginManifest } from '../../manifest/read';
import type {
    ResolvedContributionRegistry,
    ResolvedCommandContribution,
    ResolvedLifecycleHandlerContribution,
    ResolvedActionContribution,
    ResolvedContributionProvenance,
    ResolvedContributionSource,
    ResolvedToolContribution,
} from '../../projection/registry/types';

import { createPluginApiHost } from '../api/host';
import type {
    PluginApiActionRegistration,
    PluginApiBackendEngineRegistration,
    PluginApiCommandRegistration,
    PluginDisposable,
    PluginApi,
    PluginApiHostLifecycleHandlerDeclaration,
    PluginApiHookRegistration,
    PluginApiLifecycleHandlerRegistration,
    PluginApiMcpDiscoveryProviderRegistration,
    PluginApiMcpServerRegistration,
    PluginApiNotificationCategoryRegistration,
    PluginApiNotificationChannelRegistration,
    PluginApiRequestInterceptorRegistration,
    PluginApiScmBackendRegistration,
    PluginApiScmHostingProviderRegistration,
    PluginApiToolRegistration,
} from '../api/types';
import { createActivatedHandlerRegistry, type ActivatedHandlerRegistry } from '../handlers/registry';
import type { PluginActivationSource } from '../activationSources';
import { loadPluginModule } from '../loadPluginModule';
import {
    loadTrustedOptionalPermissionDeclarations,
    type ResolveTrustedOptionalPluginPermissionGrants,
} from '../permissions/grants';
import { createPluginDisposableRegistry } from './disposables';
import type {
    PluginDaemonModuleNamespace,
    PluginHookHandler,
    PluginLifecycleHandlerRequest,
    ResolvedPluginLifecycleHandler,
} from '../types';

type ActivationTarget = Readonly<{
    provenance: ResolvedContributionProvenance;
    source: ResolvedContributionSource;
    pluginId: string;
    manifestPath: string;
    manifestDigest: string;
    daemonEntryPath: string;
    sourceSpec?: PluginSourceSpecV1;
}>;

type ActivationExport = (api: PluginApi) => void | PluginDisposable | Promise<void | PluginDisposable>;

type ActivationPolicy = Readonly<{
    permissions: readonly PluginPermissionCapabilityV1[];
    permissionDeclarations: readonly PluginPermissionDeclarationV1[];
    optionalPermissionDeclarations: readonly PluginPermissionDeclarationV1[];
    runtimeCapabilities: readonly PluginRuntimeCapabilityFamilyV1[];
    declaredBackendIds: readonly string[];
    declaredActionIds: readonly string[];
    declaredToolIds: readonly string[];
    declaredCommandIds: readonly string[];
    declaredHookIds: readonly string[];
    declaredLifecycleHandlerIds: readonly string[];
    declaredLifecycleHandlers: readonly PluginApiHostLifecycleHandlerDeclaration[];
    declaredNotificationCategoryIds: readonly string[];
    declaredNotificationChannelIds: readonly string[];
    declaredEventIds: readonly string[];
    declaredEventDeclarations: readonly ParsedPluginEventContributionV1[];
    declaredScmHostingProviderIds: readonly string[];
    declaredScmBackendIds: readonly string[];
    declaredRequestInterceptorIds: readonly string[];
    declaredMcpServerIds: readonly string[];
    declaredMcpDiscoveryProviderIds: readonly string[];
    declaredRequestInterceptors: readonly PluginRequestInterceptorContributionV1[];
    systemTools: readonly PluginSystemToolContributionV1[];
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

    const manifest: ParsedPluginManifestV2 = parsed.data;
    if (manifest.id !== params.target.pluginId) {
        appendDiagnostic(params.diagnosticsByPluginId, params.target.pluginId, {
            code: 'plugin_manifest_semantic_invalid',
            message: `Bundled plugin '${params.target.pluginId}' PLUGIN_MANIFEST id '${manifest.id}' must match the plugin id`,
        });
        return null;
    }

    return Object.freeze({
        permissions: Object.freeze(manifest.capabilities.permissions.map((permission) => permission.capability)),
        permissionDeclarations: Object.freeze([...manifest.capabilities.permissions]),
        optionalPermissionDeclarations: Object.freeze([...manifest.capabilities.optionalPermissions]),
        runtimeCapabilities: Object.freeze([...manifest.runtime.capabilities]),
        declaredBackendIds: readDeclaredBackendIds(manifest.contributes),
        declaredActionIds: readDeclaredContributionIds(manifest.contributes, 'actions'),
        declaredToolIds: readDeclaredContributionIds(manifest.contributes, 'tools'),
        declaredCommandIds: readDeclaredContributionIds(manifest.contributes, 'commands'),
        declaredHookIds: readDeclaredContributionIds(manifest.contributes, 'hooks'),
        declaredLifecycleHandlerIds: readDeclaredContributionIds(manifest.contributes, 'lifecycleHandlers'),
        declaredLifecycleHandlers: readDeclaredLifecycleHandlers(manifest.id, manifest.contributes),
        declaredNotificationCategoryIds: readDeclaredContributionIds(manifest.contributes, 'notifications'),
        declaredNotificationChannelIds: readDeclaredContributionIds(manifest.contributes, 'notificationChannels'),
        declaredEventIds: readDeclaredContributionIds(manifest.contributes, 'events'),
        declaredEventDeclarations: readDeclaredEventContributions(manifest.contributes),
        declaredScmHostingProviderIds: readDeclaredContributionIds(manifest.contributes, 'scmHostingProviders'),
        declaredScmBackendIds: readDeclaredContributionIds(manifest.contributes, 'scmBackends'),
        declaredRequestInterceptorIds: readDeclaredContributionIds(manifest.contributes, 'requestInterceptors'),
        declaredMcpServerIds: readDeclaredNestedContributionIds(manifest.contributes, 'mcp', 'servers'),
        declaredMcpDiscoveryProviderIds: readDeclaredNestedContributionIds(manifest.contributes, 'mcp', 'discoveryProviders'),
        declaredRequestInterceptors: readDeclaredRequestInterceptorContributions(manifest.contributes),
        systemTools: readDeclaredSystemToolContributions(manifest.contributes),
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
    scmBackendsById: ReadonlyMap<string, Readonly<{
        pluginId: string;
        registration: PluginApiScmBackendRegistration;
    }>>;
    scmBackendRegistrations: readonly Readonly<{
        pluginId: string;
        registration: PluginApiScmBackendRegistration;
    }>[];
    requestInterceptors: readonly Readonly<{
        pluginId: string;
        contribution: PluginRequestInterceptorContributionV1;
        registration: PluginApiRequestInterceptorRegistration;
    }>[];
    mcpServers: readonly Readonly<{
        pluginId: string;
        registration: PluginApiMcpServerRegistration;
    }>[];
    mcpDiscoveryProviders: readonly Readonly<{
        pluginId: string;
        registration: PluginApiMcpDiscoveryProviderRegistration;
    }>[];
    networkAllowedPluginIds: ReadonlySet<string>;
    networkAllowedUrlOriginsByPluginId: ReadonlyMap<string, ReadonlySet<string>>;
    processSpawnAllowedPathsByPluginId: ReadonlyMap<string, ReadonlySet<string>>;
    systemToolDefinitionsByPluginId: ReadonlyMap<string, readonly PluginSystemToolContributionV1[]>;
    envAllowedNamesByPluginId: ReadonlyMap<string, ReadonlySet<string>>;
    filesystemReadAllowedPathsByPluginId: ReadonlyMap<string, ReadonlySet<string>>;
    filesystemWriteAllowedPathsByPluginId: ReadonlyMap<string, ReadonlySet<string>>;
    permissionsByPluginId: ReadonlyMap<string, ReadonlySet<PluginPermissionCapabilityV1>>;
    permissionDeclarationsByPluginId: ReadonlyMap<string, readonly PluginPermissionDeclarationV1[]>;
    requiredPermissionsByPluginId: ReadonlyMap<string, ReadonlySet<PluginPermissionCapabilityV1>>;
    requiredPermissionDeclarationsByPluginId: ReadonlyMap<string, readonly PluginPermissionDeclarationV1[]>;
    optionalPermissionDeclarationsByPluginId: ReadonlyMap<string, readonly PluginPermissionDeclarationV1[]>;
    trustedOptionalPermissionsByPluginId: ReadonlyMap<string, ReadonlySet<PluginPermissionCapabilityV1>>;
    trustedOptionalPermissionDeclarationsByPluginId: ReadonlyMap<string, readonly PluginPermissionDeclarationV1[]>;
    runtimeCapabilitiesByPluginId: ReadonlyMap<string, ReadonlySet<string>>;
    eventDeclarationsByPluginId: ReadonlyMap<string, readonly ParsedPluginEventContributionV1[]>;
    eventSubscriptionPermissionsByPluginId: ReadonlyMap<string, ReadonlySet<PluginPermissionCapabilityV1>>;
    runtimeCoreHandlersByBackendId: ReadonlyMap<string, ReadonlyMap<string, PluginHookHandler>>;
    actions: readonly ResolvedActionContribution[];
    tools: readonly ResolvedToolContribution[];
    commands: readonly ResolvedCommandContribution[];
    lifecycleHandlers: readonly ResolvedLifecycleHandlerContribution[];
    pluginDiagnosticsByPluginId: Readonly<Record<string, readonly PluginCompatibilityDiagnostic[]>>;
    addRuntimeDisposable: (pluginId: string, disposable: PluginDisposable) => PluginDisposable;
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

function readDeclaredEventContributions(value: unknown): readonly ParsedPluginEventContributionV1[] {
    if (!isRecord(value) || !Array.isArray(value.events)) {
        return Object.freeze([]);
    }
    return Object.freeze(value.events.flatMap((definition) => {
        if (!isRecord(definition)) {
            return [];
        }
        const id = typeof definition.id === 'string' ? definition.id.trim() : '';
        return id.length > 0 ? [definition as ParsedPluginEventContributionV1] : [];
    }));
}

function readDeclaredNestedContributionIds(value: unknown, parentKey: string, childKey: string): readonly string[] {
    if (!isRecord(value) || !isRecord(value[parentKey])) {
        return Object.freeze([]);
    }
    return readDeclaredContributionIds(value[parentKey], childKey);
}

function readDeclaredRequestInterceptorContributions(value: unknown): readonly PluginRequestInterceptorContributionV1[] {
    if (!isRecord(value) || !Array.isArray(value.requestInterceptors)) {
        return Object.freeze([]);
    }
    return Object.freeze(value.requestInterceptors as PluginRequestInterceptorContributionV1[]);
}

function readDeclaredSystemToolContributions(value: unknown): readonly PluginSystemToolContributionV1[] {
    if (!isRecord(value) || !Array.isArray(value.systemTools)) {
        return Object.freeze([]);
    }
    return Object.freeze(value.systemTools as PluginSystemToolContributionV1[]);
}

function readDeclaredLifecycleHandlers(pluginId: string, value: unknown): readonly PluginApiHostLifecycleHandlerDeclaration[] {
    if (!isRecord(value) || !Array.isArray(value.lifecycleHandlers)) {
        return Object.freeze([]);
    }
    return Object.freeze(value.lifecycleHandlers.flatMap((definition, index) => {
        if (!isRecord(definition) || (definition.event !== 'activated' && definition.event !== 'deactivating')) {
            return [];
        }
        const id = typeof definition.id === 'string' && definition.id.trim().length > 0
            ? definition.id.trim()
            : null;
        const canonicalId = id ?? `${pluginId}:${definition.event}:${index}`;
        return [
            Object.freeze({
                ...(id ? { id } : {}),
                canonicalId,
                event: definition.event,
            }),
        ];
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
    provenance?: ResolvedContributionProvenance;
    source?: ResolvedContributionSource;
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
        provenance: raw.provenance ?? 'external',
        source: raw.source ?? { kind: raw.sourceSpec?.kind ?? 'path' },
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

function normalizeNetworkPermissionOrigin(scope: string | undefined): string | null {
    if (!scope || scope.trim().length === 0) {
        return null;
    }
    if (scope.trim() === '*') {
        return '*';
    }
    try {
        return new URL(scope.trim()).origin;
    } catch {
        return null;
    }
}

function normalizeProcessSpawnPermissionPath(scope: string | undefined): string | null {
    if (!scope || scope.trim().length === 0) {
        return null;
    }
    const normalized = scope.trim();
    return isAbsolute(normalized) ? normalized : null;
}

function normalizeEnvPermissionName(scope: string | undefined): string | null {
    const normalized = scope?.trim() ?? '';
    if (!/^[A-Z_][A-Z0-9_]*$/.test(normalized)) {
        return null;
    }
    return normalized;
}

function normalizeFilesystemPermissionPath(scope: string | undefined): string | null {
    const normalized = scope?.trim() ?? '';
    if (normalized.length === 0 || normalized === '*') {
        return '';
    }
    return isAbsolute(normalized) ? null : normalized;
}

function collectOptionalScopedPermissionMap(
    entries: readonly Readonly<{
        pluginId: string;
        permissionDeclarations: readonly PluginPermissionDeclarationV1[];
    }>[],
    capability: PluginPermissionCapabilityV1,
    normalizeScope: (scope: string | undefined) => string | null,
): ReadonlyMap<string, ReadonlySet<string>> {
    const byPluginId = new Map<string, ReadonlySet<string>>();
    for (const entry of entries) {
        const scopes = entry.permissionDeclarations
            .filter((permission) => permission.capability === capability)
            .flatMap((permission) => {
                const normalized = normalizeScope(permission.scope);
                return normalized === null ? [] : [normalized];
            });
        if (scopes.length > 0) {
            byPluginId.set(entry.pluginId, new Set(scopes));
        }
    }
    return byPluginId;
}

function collectScopedPermissionMap(
    entries: readonly Readonly<{
        pluginId: string;
        permissionDeclarations: readonly PluginPermissionDeclarationV1[];
    }>[],
    capability: PluginPermissionCapabilityV1,
    normalizeScope: (scope: string | undefined) => string | null,
): ReadonlyMap<string, ReadonlySet<string>> {
    const byPluginId = new Map<string, ReadonlySet<string>>();
    for (const entry of entries) {
        const scopes = entry.permissionDeclarations
            .filter((permission) => permission.capability === capability)
            .flatMap((permission) => {
                const normalized = normalizeScope(permission.scope);
                return normalized ? [normalized] : [];
            });
        if (scopes.length > 0) {
            byPluginId.set(entry.pluginId, new Set(scopes));
        }
    }
    return byPluginId;
}

function resolveContributionMetadata(target: ActivationTarget): Readonly<{
    provenance: ResolvedContributionProvenance;
    source: ResolvedContributionSource;
    pluginId: string;
    manifestPath: string;
    manifestDigest: string;
    daemonEntryPath: string;
    sourceSpec?: PluginSourceSpecV1;
}> {
    return {
        provenance: target.provenance,
        source: target.source,
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
        permissionDeclarations: Object.freeze([...manifestResult.manifest.permissions]),
        optionalPermissionDeclarations: Object.freeze([...(manifestResult.manifest.optionalPermissions ?? [])]),
        runtimeCapabilities: Object.freeze([...manifestResult.manifest.runtime.capabilities]),
        declaredBackendIds: readDeclaredBackendIds(manifestResult.manifest.contributes),
        declaredActionIds: readDeclaredContributionIds(manifestResult.manifest.contributes, 'actions'),
        declaredToolIds: readDeclaredContributionIds(manifestResult.manifest.contributes, 'tools'),
        declaredCommandIds: readDeclaredContributionIds(manifestResult.manifest.contributes, 'commands'),
        declaredHookIds: readDeclaredContributionIds(manifestResult.manifest.contributes, 'hooks'),
        declaredLifecycleHandlerIds: readDeclaredContributionIds(manifestResult.manifest.contributes, 'lifecycleHandlers'),
        declaredLifecycleHandlers: readDeclaredLifecycleHandlers(manifestResult.manifest.id, manifestResult.manifest.contributes),
        declaredNotificationCategoryIds: readDeclaredContributionIds(manifestResult.manifest.contributes, 'notifications'),
        declaredNotificationChannelIds: readDeclaredContributionIds(manifestResult.manifest.contributes, 'notificationChannels'),
        declaredEventIds: readDeclaredContributionIds(manifestResult.manifest.contributes, 'events'),
        declaredEventDeclarations: readDeclaredEventContributions(manifestResult.manifest.contributes),
        declaredScmHostingProviderIds: readDeclaredContributionIds(manifestResult.manifest.contributes, 'scmHostingProviders'),
        declaredScmBackendIds: readDeclaredContributionIds(manifestResult.manifest.contributes, 'scmBackends'),
        declaredRequestInterceptorIds: readDeclaredContributionIds(manifestResult.manifest.contributes, 'requestInterceptors'),
        declaredMcpServerIds: readDeclaredNestedContributionIds(manifestResult.manifest.contributes, 'mcp', 'servers'),
        declaredMcpDiscoveryProviderIds: readDeclaredNestedContributionIds(manifestResult.manifest.contributes, 'mcp', 'discoveryProviders'),
        declaredRequestInterceptors: readDeclaredRequestInterceptorContributions(manifestResult.manifest.contributes),
        systemTools: readDeclaredSystemToolContributions(manifestResult.manifest.contributes),
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
                    sourceKind: handler.sourceKind ?? 'path',
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
    pluginIds?: readonly string[];
    resolveActivationSource?: (target: ActivationTarget) => PluginActivationSource<PluginDaemonModuleNamespace> | null;
    resolveTrustedOptionalPermissionGrants?: ResolveTrustedOptionalPluginPermissionGrants;
}>): Promise<ActivatedPluginRuntimeRegistry> {
    const diagnosticsByPluginId: Record<string, PluginCompatibilityDiagnostic[]> = {};
    const allowedPluginIds = params.pluginIds ? new Set(params.pluginIds) : null;
    const activationPolicyCache = new Map<string, ActivationPolicy>();
    const activatedEntries: Array<{
        pluginId: string;
        provenance: ResolvedContributionProvenance;
        source: ResolvedContributionSource;
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
        scmBackends: readonly PluginApiScmBackendRegistration[];
        requestInterceptors: readonly PluginApiRequestInterceptorRegistration[];
        requestInterceptorContributions: readonly PluginRequestInterceptorContributionV1[];
        mcpServers: readonly PluginApiMcpServerRegistration[];
        mcpDiscoveryProviders: readonly PluginApiMcpDiscoveryProviderRegistration[];
        permissions: readonly PluginPermissionCapabilityV1[];
        permissionDeclarations: readonly PluginPermissionDeclarationV1[];
        requiredPermissions: readonly PluginPermissionCapabilityV1[];
        requiredPermissionDeclarations: readonly PluginPermissionDeclarationV1[];
        optionalPermissionDeclarations: readonly PluginPermissionDeclarationV1[];
        trustedOptionalPermissions: readonly PluginPermissionCapabilityV1[];
        trustedOptionalPermissionDeclarations: readonly PluginPermissionDeclarationV1[];
        runtimeCapabilities: readonly string[];
        systemTools: readonly PluginSystemToolContributionV1[];
        declaredEventIds: readonly string[];
        declaredEventDeclarations: readonly ParsedPluginEventContributionV1[];
        hooks: readonly PluginApiHookRegistration[];
        lifecycleHandlers: readonly PluginApiLifecycleHandlerRegistration[];
    }> = [];
    const disposers: Array<() => Promise<void>> = [];
    const runtimeDisposableRegistriesByPluginId = new Map<string, ReturnType<typeof createPluginDisposableRegistry>>();

    for (const target of collectActivationTargets(params.contributes)) {
        if (allowedPluginIds && !allowedPluginIds.has(target.pluginId)) {
            continue;
        }
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

        const requiredPermissionDeclarations = activationSource.kind === 'bundled'
            ? bundledPolicy!.permissionDeclarations
            : activationPolicy!.policy.permissionDeclarations;
        const requiredPermissions = Object.freeze(
            requiredPermissionDeclarations.map((permission) => permission.capability),
        );
        const optionalPermissionDeclarations = activationSource.kind === 'bundled'
            ? bundledPolicy!.optionalPermissionDeclarations
            : activationPolicy!.policy.optionalPermissionDeclarations;
        const trustedOptionalPermissionDeclarations = await loadTrustedOptionalPermissionDeclarations({
            pluginId: target.pluginId,
            manifestPath: target.manifestPath,
            manifestDigest: target.manifestDigest,
            requiredPermissions: requiredPermissionDeclarations,
            optionalPermissions: optionalPermissionDeclarations,
            provenance: target.provenance,
            ...(target.sourceSpec ? { sourceSpec: target.sourceSpec } : {}),
            resolveTrustedOptionalPermissionGrants: params.resolveTrustedOptionalPermissionGrants,
        });
        const trustedOptionalPermissions = Object.freeze(
            trustedOptionalPermissionDeclarations.map((permission) => permission.capability),
        );
        const activePermissionDeclarations = Object.freeze([
            ...requiredPermissionDeclarations,
            ...trustedOptionalPermissionDeclarations,
        ]);
        const activePermissions = Object.freeze(
            Array.from(new Set(activePermissionDeclarations.map((permission) => permission.capability))),
        );

        const host = createPluginApiHost({
            pluginId: target.pluginId,
            runtimeCapabilities: activationSource.kind === 'bundled'
                ? bundledPolicy!.runtimeCapabilities
                : activationPolicy!.policy.runtimeCapabilities,
            permissions: activePermissions,
            declaredBackendIds: activationSource.kind === 'bundled'
                ? bundledPolicy!.declaredBackendIds
                : activationPolicy!.policy.declaredBackendIds,
            declaredActionIds: activationSource.kind === 'bundled'
                ? bundledPolicy!.declaredActionIds
                : activationPolicy!.policy.declaredActionIds,
            declaredToolIds: activationSource.kind === 'bundled'
                ? bundledPolicy!.declaredToolIds
                : activationPolicy!.policy.declaredToolIds,
            declaredCommandIds: activationSource.kind === 'bundled'
                ? bundledPolicy!.declaredCommandIds
                : activationPolicy!.policy.declaredCommandIds,
            declaredHookIds: activationSource.kind === 'bundled'
                ? bundledPolicy!.declaredHookIds
                : activationPolicy!.policy.declaredHookIds,
            declaredLifecycleHandlerIds: activationSource.kind === 'bundled'
                ? bundledPolicy!.declaredLifecycleHandlerIds
                : activationPolicy!.policy.declaredLifecycleHandlerIds,
            declaredLifecycleHandlers: activationSource.kind === 'bundled'
                ? bundledPolicy!.declaredLifecycleHandlers
                : activationPolicy!.policy.declaredLifecycleHandlers,
            declaredNotificationCategoryIds: activationSource.kind === 'bundled'
                ? bundledPolicy!.declaredNotificationCategoryIds
                : activationPolicy!.policy.declaredNotificationCategoryIds,
        declaredNotificationChannelIds: activationSource.kind === 'bundled'
            ? bundledPolicy!.declaredNotificationChannelIds
            : activationPolicy!.policy.declaredNotificationChannelIds,
            declaredScmHostingProviderIds: activationSource.kind === 'bundled'
                ? bundledPolicy!.declaredScmHostingProviderIds
                : activationPolicy!.policy.declaredScmHostingProviderIds,
            declaredScmBackendIds: activationSource.kind === 'bundled'
                ? bundledPolicy!.declaredScmBackendIds
                : activationPolicy!.policy.declaredScmBackendIds,
            declaredRequestInterceptorIds: activationSource.kind === 'bundled'
                ? bundledPolicy!.declaredRequestInterceptorIds
                : activationPolicy!.policy.declaredRequestInterceptorIds,
            declaredMcpServerIds: activationSource.kind === 'bundled'
                ? bundledPolicy!.declaredMcpServerIds
                : activationPolicy!.policy.declaredMcpServerIds,
            declaredMcpDiscoveryProviderIds: activationSource.kind === 'bundled'
                ? bundledPolicy!.declaredMcpDiscoveryProviderIds
                : activationPolicy!.policy.declaredMcpDiscoveryProviderIds,
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
            provenance: target.provenance,
            source: target.source,
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
            scmBackends: registrations.scmBackends,
            requestInterceptors: registrations.requestInterceptors,
            requestInterceptorContributions: activationSource.kind === 'bundled'
                ? bundledPolicy!.declaredRequestInterceptors
                : activationPolicy!.policy.declaredRequestInterceptors,
            mcpServers: registrations.mcpServers,
            mcpDiscoveryProviders: registrations.mcpDiscoveryProviders,
            permissions: activePermissions,
            permissionDeclarations: activePermissionDeclarations,
            requiredPermissions,
            requiredPermissionDeclarations,
            optionalPermissionDeclarations,
            trustedOptionalPermissions,
            trustedOptionalPermissionDeclarations,
            runtimeCapabilities: activationSource.kind === 'bundled'
                ? bundledPolicy!.runtimeCapabilities
                : activationPolicy!.policy.runtimeCapabilities,
            systemTools: activationSource.kind === 'bundled'
                ? bundledPolicy!.systemTools
                : activationPolicy!.policy.systemTools,
            declaredEventIds: activationSource.kind === 'bundled'
                ? bundledPolicy!.declaredEventIds
                : activationPolicy!.policy.declaredEventIds,
            declaredEventDeclarations: activationSource.kind === 'bundled'
                ? bundledPolicy!.declaredEventDeclarations
                : activationPolicy!.policy.declaredEventDeclarations,
            hooks: registrations.hooks,
            lifecycleHandlers: registrations.lifecycleHandlers,
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
    const scmBackendsById = new Map<string, Readonly<{
        pluginId: string;
        registration: PluginApiScmBackendRegistration;
    }>>();
    const scmBackendRegistrations: Readonly<{
        pluginId: string;
        registration: PluginApiScmBackendRegistration;
    }>[] = [];
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
        for (const registration of entry.scmBackends) {
            const ownerScopedRegistration = Object.freeze({ pluginId: entry.pluginId, registration });
            scmBackendRegistrations.push(ownerScopedRegistration);
            const existing = scmBackendsById.get(registration.id) ?? null;
            if (existing) {
                appendDiagnostic(diagnosticsByPluginId, entry.pluginId, {
                    code: 'plugin_scm_backend_duplicate_id',
                    message: `Plugin '${entry.pluginId}' registered SCM backend '${registration.id}', but it is already registered by plugin '${existing.pluginId}'`,
                });
                appendDiagnostic(diagnosticsByPluginId, existing.pluginId, {
                    code: 'plugin_scm_backend_duplicate_id',
                    message: `Plugin '${existing.pluginId}' registered SCM backend '${registration.id}', but it is also registered by plugin '${entry.pluginId}'`,
                });
                continue;
            }

            scmBackendsById.set(registration.id, ownerScopedRegistration);
        }
    }
    const networkAllowedUrlOriginsByPluginId = collectScopedPermissionMap(
        activatedEntries,
        'network',
        normalizeNetworkPermissionOrigin,
    );
    const processSpawnAllowedPathsByPluginId = collectScopedPermissionMap(
        activatedEntries,
        'process.spawn',
        normalizeProcessSpawnPermissionPath,
    );
    const envAllowedNamesByPluginId = collectScopedPermissionMap(
        activatedEntries,
        'env',
        normalizeEnvPermissionName,
    );
    const filesystemReadAllowedPathsByPluginId = collectOptionalScopedPermissionMap(
        activatedEntries,
        'filesystem.read',
        normalizeFilesystemPermissionPath,
    );
    const filesystemWriteAllowedPathsByPluginId = collectOptionalScopedPermissionMap(
        activatedEntries,
        'filesystem.write',
        normalizeFilesystemPermissionPath,
    );
    const addRuntimeDisposable = (pluginId: string, disposable: PluginDisposable): PluginDisposable => {
        const registry = runtimeDisposableRegistriesByPluginId.get(pluginId) ?? createPluginDisposableRegistry();
        runtimeDisposableRegistriesByPluginId.set(pluginId, registry);
        return registry.add(disposable);
    };

    return {
        generation: params.generation,
        backendEnginesByBackendId,
        notificationCategoriesById,
        notificationChannelsById,
        scmHostingProvidersById,
        scmBackendsById,
        scmBackendRegistrations: Object.freeze(scmBackendRegistrations),
        requestInterceptors: Object.freeze(activatedEntries.flatMap((entry) => {
            const contributionsById = new Map(entry.requestInterceptorContributions.map((contribution) => [contribution.id, contribution]));
            return entry.requestInterceptors.flatMap((registration) => {
                const contribution = contributionsById.get(registration.id);
                if (!contribution) {
                    return [];
                }
                return [Object.freeze({
                    pluginId: entry.pluginId,
                    contribution,
                    registration,
                })];
            });
        })),
        mcpServers: Object.freeze(activatedEntries.flatMap((entry) => entry.mcpServers.map((registration) => Object.freeze({
            pluginId: entry.pluginId,
            registration,
        })))),
        mcpDiscoveryProviders: Object.freeze(activatedEntries.flatMap((entry) => entry.mcpDiscoveryProviders.map((registration) => Object.freeze({
            pluginId: entry.pluginId,
            registration,
        })))),
        networkAllowedPluginIds: new Set(activatedEntries.flatMap((entry) => (
            entry.permissions.includes('network') ? [entry.pluginId] : []
        ))),
        networkAllowedUrlOriginsByPluginId,
        processSpawnAllowedPathsByPluginId,
        systemToolDefinitionsByPluginId: new Map(activatedEntries.map((entry) => [
            entry.pluginId,
            Object.freeze([...entry.systemTools]),
        ])),
        envAllowedNamesByPluginId,
        filesystemReadAllowedPathsByPluginId,
        filesystemWriteAllowedPathsByPluginId,
        permissionsByPluginId: new Map(activatedEntries.map((entry) => [
            entry.pluginId,
            new Set(entry.permissions),
        ])),
        permissionDeclarationsByPluginId: new Map(activatedEntries.map((entry) => [
            entry.pluginId,
            Object.freeze([...entry.permissionDeclarations]),
        ])),
        requiredPermissionsByPluginId: new Map(activatedEntries.map((entry) => [
            entry.pluginId,
            new Set(entry.requiredPermissions),
        ])),
        requiredPermissionDeclarationsByPluginId: new Map(activatedEntries.map((entry) => [
            entry.pluginId,
            Object.freeze([...entry.requiredPermissionDeclarations]),
        ])),
        optionalPermissionDeclarationsByPluginId: new Map(activatedEntries.map((entry) => [
            entry.pluginId,
            Object.freeze([...entry.optionalPermissionDeclarations]),
        ])),
        trustedOptionalPermissionsByPluginId: new Map(activatedEntries.map((entry) => [
            entry.pluginId,
            new Set(entry.trustedOptionalPermissions),
        ])),
        trustedOptionalPermissionDeclarationsByPluginId: new Map(activatedEntries.map((entry) => [
            entry.pluginId,
            Object.freeze([...entry.trustedOptionalPermissionDeclarations]),
        ])),
        runtimeCapabilitiesByPluginId: new Map(activatedEntries.map((entry) => [
            entry.pluginId,
            new Set(entry.runtimeCapabilities),
        ])),
        eventDeclarationsByPluginId: new Map(activatedEntries.map((entry) => [
            entry.pluginId,
            Object.freeze([...entry.declaredEventDeclarations]),
        ])),
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
        lifecycleHandlers: Object.freeze(
            activatedEntries.flatMap((entry) => entry.lifecycleHandlers.map(
                (definition, index) => toResolvedLifecycleHandlerContribution(entry, definition, index),
            )),
        ),
        actionHandlersByActionId: handlerRegistry.actionHandlersByActionId,
        hookHandlersByHookId: handlerRegistry.hookHandlersByHookId,
        lifecycleHandlersByEvent: handlerRegistry.lifecycleHandlersByEvent,
        pluginDiagnosticsByPluginId: freezeDiagnostics(diagnosticsByPluginId),
        addRuntimeDisposable,
        async dispose() {
            if (disposed) {
                return;
            }
            disposed = true;
            for (const registry of [...runtimeDisposableRegistriesByPluginId.values()].reverse()) {
                await registry.dispose();
            }
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
