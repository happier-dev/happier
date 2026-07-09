import { getPluginHookDefinitionV1, isHookHandlerTargetV1 } from '@happier-dev/protocol';
import type { PluginCompatibilityDiagnostic } from '@/plugins/validation/diagnostics/types';
import type { ResolvedContributionRegistry, ResolvedHookRegistration } from '@/plugins/projection/registry/types';

import type { PluginActivationSource } from './activationSources';
import { loadPluginModule } from './loadPluginModule';
import type { PluginDaemonModuleNamespace, PluginHookHandler, ResolvedPluginHookHandler, ResolvedPluginHookHandlerRegistry } from './types';

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

function ensureDiagnosticBucket(
    diagnosticsByPluginId: Record<string, PluginCompatibilityDiagnostic[]>,
    pluginId: string,
): PluginCompatibilityDiagnostic[] {
    const existing = diagnosticsByPluginId[pluginId];
    if (existing) {
        return existing;
    }

    const created: PluginCompatibilityDiagnostic[] = [];
    diagnosticsByPluginId[pluginId] = created;
    return created;
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null;
}

function resolvePluginHookHandlerExport(
    moduleNamespace: PluginDaemonModuleNamespace,
    exportName?: string,
): Readonly<
    | { status: 'found'; handler: PluginHookHandler }
    | { status: 'missing' }
    | { status: 'invalid' }
> {
    if (exportName) {
        const directExport = moduleNamespace[exportName];
        if (typeof directExport === 'function') {
            return { status: 'found', handler: directExport as PluginHookHandler };
        }
        if (directExport !== undefined) {
            return { status: 'invalid' };
        }

        const defaultExport = moduleNamespace.default;
        if (isRecord(defaultExport)) {
            const nestedExport = defaultExport[exportName];
            if (typeof nestedExport === 'function') {
                return { status: 'found', handler: nestedExport as PluginHookHandler };
            }
            if (nestedExport !== undefined) {
                return { status: 'invalid' };
            }
        }

        return { status: 'missing' };
    }

    if (typeof moduleNamespace.default === 'function') {
        return { status: 'found', handler: moduleNamespace.default as PluginHookHandler };
    }

    return moduleNamespace.default === undefined ? { status: 'missing' } : { status: 'invalid' };
}

export async function resolvePluginHookHandlerRegistry(params: Readonly<{
    registry?: ResolvedContributionRegistry;
    hookRegistrations?: readonly ResolvedHookRegistration[];
    generation?: number;
    pluginIds?: readonly string[];
    resolveActivationSource?: (
        registration: ResolvedHookRegistration,
    ) => PluginActivationSource<PluginDaemonModuleNamespace> | null;
}>): Promise<ResolvedPluginHookHandlerRegistry> {
    const handlersByHookIdMutable = new Map<string, ResolvedPluginHookHandler[]>();
    const diagnosticsByPluginId: Record<string, PluginCompatibilityDiagnostic[]> = {};
    const hookRegistrations = params.registry?.hookRegistrations ?? params.hookRegistrations ?? [];
    const allowedPluginIds = params.pluginIds ? new Set(params.pluginIds) : null;
    let registrationIndex = 0;

    for (const registration of hookRegistrations) {
        if (allowedPluginIds && !allowedPluginIds.has(registration.pluginId)) {
            continue;
        }

        const currentRegistrationIndex = registrationIndex++;
        ensureDiagnosticBucket(diagnosticsByPluginId, registration.pluginId);

        if (!getPluginHookDefinitionV1(registration.definition.id)) {
            appendDiagnostic(diagnosticsByPluginId, registration.pluginId, {
                code: 'plugin_manifest_semantic_invalid',
                message: `Plugin hook '${registration.definition.id}' is not in the final public hook catalog`,
            });
            continue;
        }

        if (!isHookHandlerTargetV1(registration.definition.handler.target)) {
            const handlerTarget = typeof registration.definition.handler.target === 'string'
                ? registration.definition.handler.target
                : 'unknown';
            appendDiagnostic(diagnosticsByPluginId, registration.pluginId, {
                code: 'plugin_manifest_semantic_invalid',
                message: `Plugin hook '${registration.definition.id}' uses unsupported handler target '${handlerTarget}'`,
            });
            continue;
        }

        if (!registration.daemonEntryPath) {
            appendDiagnostic(diagnosticsByPluginId, registration.pluginId, {
                code: 'plugin_manifest_semantic_invalid',
                message: `Plugin hook '${registration.definition.id}' requires a daemon entry target`,
            });
            continue;
        }

        let moduleNamespace: PluginDaemonModuleNamespace;
        try {
            const source = params.resolveActivationSource?.(registration) ?? {
                kind: 'file_backed' as const,
                entryPath: registration.daemonEntryPath,
                devEntryPath: registration.devDaemonEntryPath,
                trustPolicy: registration.sourceSpec.trustPolicy,
            };
            moduleNamespace = await loadPluginModule({
                source,
                cacheKey: `${registration.manifestDigest}:generation:${params.generation ?? 0}`,
            }) as PluginDaemonModuleNamespace;
        } catch (error) {
            const errorCode = error instanceof Error ? String((error as Error & { code?: string }).code ?? '') : '';
            appendDiagnostic(diagnosticsByPluginId, registration.pluginId, {
                code:
                    errorCode === 'PLUGIN_DAEMON_TRUST_APPROVAL_REQUIRED'
                        ? 'plugin_trust_approval_required'
                        : errorCode === 'PLUGIN_DAEMON_TRUST_UNTRUSTED'
                            ? 'plugin_untrusted'
                            :
                    errorCode === 'PLUGIN_DAEMON_ENTRY_MISSING'
                        ? 'plugin_source_missing'
                        : errorCode === 'PLUGIN_DAEMON_ENTRY_KIND_UNSUPPORTED'
                            ? 'plugin_source_kind_unsupported'
                            : 'plugin_daemon_module_load_failed',
                message: error instanceof Error ? error.message : `Failed to load daemon module for plugin '${registration.pluginId}'`,
            });
            continue;
        }

        const resolvedExport = resolvePluginHookHandlerExport(
            moduleNamespace,
            registration.definition.handler.exportName,
        );
        if (resolvedExport.status === 'missing') {
            appendDiagnostic(diagnosticsByPluginId, registration.pluginId, {
                code: 'plugin_hook_handler_missing',
                message: `Plugin hook '${registration.definition.id}' could not resolve export '${registration.definition.handler.exportName ?? 'default'}' from '${registration.daemonEntryPath}'`,
            });
            continue;
        }
        if (resolvedExport.status === 'invalid') {
            appendDiagnostic(diagnosticsByPluginId, registration.pluginId, {
                code: 'plugin_hook_handler_invalid',
                message: `Plugin hook '${registration.definition.id}' resolved export '${registration.definition.handler.exportName ?? 'default'}' from '${registration.daemonEntryPath}' but it is not a function`,
            });
            continue;
        }

        const existingHandlers = handlersByHookIdMutable.get(registration.definition.id);
        const resolvedHandler: ResolvedPluginHookHandler = {
            pluginId: registration.pluginId,
            hookId: registration.definition.id,
            priority: registration.definition.priority ?? 0,
            registrationIndex: currentRegistrationIndex,
            manifestPath: registration.manifestPath,
            manifestDigest: registration.manifestDigest,
            daemonEntryPath: registration.daemonEntryPath,
            exportName: registration.definition.handler.exportName ?? 'default',
            registration,
            handler: resolvedExport.handler,
        };
        if (existingHandlers) {
            existingHandlers.push(resolvedHandler);
            continue;
        }
        handlersByHookIdMutable.set(registration.definition.id, [resolvedHandler]);
    }

    const handlersByHookId = new Map<string, readonly ResolvedPluginHookHandler[]>();
    for (const [hookId, handlers] of handlersByHookIdMutable.entries()) {
        const orderedHandlers = [...handlers].sort((left, right) => {
            if (right.priority !== left.priority) {
                return left.priority - right.priority;
            }
            if (left.pluginId !== right.pluginId) {
                return left.pluginId.localeCompare(right.pluginId);
            }
            if (left.registrationIndex !== right.registrationIndex) {
                return left.registrationIndex - right.registrationIndex;
            }
            if (left.manifestPath !== right.manifestPath) {
                return left.manifestPath.localeCompare(right.manifestPath);
            }
            if (left.exportName !== right.exportName) {
                return left.exportName.localeCompare(right.exportName);
            }
            return left.daemonEntryPath.localeCompare(right.daemonEntryPath);
        });
        handlersByHookId.set(hookId, Object.freeze(orderedHandlers));
    }

    const frozenDiagnosticsByPluginId = Object.freeze(
        Object.fromEntries(
            Object.entries(diagnosticsByPluginId).map(([pluginId, diagnostics]) => [
                pluginId,
                Object.freeze([...diagnostics]),
            ]),
        ) as Record<string, readonly PluginCompatibilityDiagnostic[]>,
    );

    return {
        handlersByHookId,
        diagnosticsByPluginId: frozenDiagnosticsByPluginId,
    };
}
