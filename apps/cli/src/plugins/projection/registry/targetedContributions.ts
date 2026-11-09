import { resolveAdmittedTargetedContributions as resolvePortableAdmittedTargetedContributions } from '@happier-dev/cli-common/plugins/registration';
import type { ResolvedPluginContributionPointDeclaration, ResolvedTargetedPluginContributionDeclaration, ResolvedActionContribution, ResolvedUiRendererV2Contribution, AdmittedTargetedContributionSnapshot } from './types';
import type { PluginCompatibilityDiagnostic } from '@/plugins/validation/diagnostics/types';
import type { PluginRuntimeOccurrenceId } from '@/plugins/runtime/runtimeSlots';
export { dropTargetedContributionAdmissionDiagnostics } from '@happier-dev/cli-common/plugins/registration';

/** Preserve the CLI's branded occurrence type over the shared admission owner. */
export function resolveAdmittedTargetedContributions(params: Readonly<{
    pluginContributionPoints: readonly ResolvedPluginContributionPointDeclaration[];
    targetedPluginContributions: readonly ResolvedTargetedPluginContributionDeclaration[];
    actions: readonly ResolvedActionContribution[];
    uiRenderersV2: readonly ResolvedUiRendererV2Contribution[];
    occurrenceIdsByPluginId: Readonly<Record<string, PluginRuntimeOccurrenceId>>;
}>): Readonly<{
    diagnosticsByPluginId: Readonly<Record<string, readonly PluginCompatibilityDiagnostic[]>>;
    read(request: Readonly<{ targetPluginId: string; pointId: string; protocol: Readonly<{ id: string; version: number }> }>): AdmittedTargetedContributionSnapshot | null;
}> {
    // All occurrences in the result originate unchanged from the branded input map.
    return resolvePortableAdmittedTargetedContributions(params) as ReturnType<typeof resolveAdmittedTargetedContributions>;
}
