import type { PluginCompatibilityDiagnostic, PluginDiagnosticCode } from '@/plugins/validation/diagnostics/types';
import type { ResolvedExecutablePluginRuntimeRegistry } from '../resolveExecutablePluginRuntimeRegistry';
import { isPluginAdmissionExclusion } from '@/plugins/projection/registry/normalize/admission';

const BLOCKING_PLUGIN_RELOAD_DIAGNOSTIC_CODES: ReadonlySet<PluginDiagnosticCode> = new Set([
    'plugin_activation_failed',
    'plugin_daemon_module_load_failed',
    'plugin_source_missing',
    'plugin_source_kind_unsupported',
    'plugin_trust_approval_required',
    'plugin_untrusted',
]);

export function collectBlockingPluginReloadDiagnostics(
    registry: ResolvedExecutablePluginRuntimeRegistry,
    scopedPluginIds: readonly string[],
): readonly Readonly<{ pluginId: string; diagnostics: readonly PluginCompatibilityDiagnostic[] }>[] {
    return scopedPluginIds.flatMap((pluginId) => {
        const diagnostics = (registry.pluginDiagnosticsByPluginId[pluginId] ?? [])
            .filter(diagnostic => BLOCKING_PLUGIN_RELOAD_DIAGNOSTIC_CODES.has(diagnostic.code)
                || isPluginAdmissionExclusion(diagnostic));
        return diagnostics.length > 0 ? [{ pluginId, diagnostics }] : [];
    });
}

export function hasBlockingPluginReloadDiagnostic(
    registry: ResolvedExecutablePluginRuntimeRegistry,
    scopedPluginIds: readonly string[],
): boolean {
    return collectBlockingPluginReloadDiagnostics(registry, scopedPluginIds).length > 0;
}
