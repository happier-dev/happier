import * as React from 'react';

import type { PluginProjectionEntry } from '@/agents/backendCatalog/daemonContributionRegistryProjectionAdapters';
import type { PluginProjectionDiagnostic } from '@/agents/backendCatalog/daemonContributionRegistryProjectionAdapters';
import { readProjectedAgentUiBehaviorDiagnostics } from '@/agents/registry/agentUiBehaviorProjection';
import { t } from '@/text';

import { PluginDiagnosticsSection } from '../diagnostics/PluginDiagnosticsSection';

/**
 * The author-visible half of the Agent UI behavior descriptor interpreter.
 *
 * A bundled Agent's descriptor is generated at build time behind a generator
 * test, so a malformed field fails CI. An externally installed Agent's
 * identical field is interpreted at runtime by the SAME fail-closed
 * interpreter, and the refusal simply drops the contribution — leaving the
 * author with a plugin that installs, enables, and silently does nothing.
 * Surfacing the refusal here is what makes that path diagnosable, and it does
 * so through the one canonical diagnostics renderer rather than a second one.
 *
 * Descriptors are a per-machine fact, so this reads only the machine whose
 * daemon the screen is currently bound to, and only the refusals produced by
 * THIS plugin's own descriptors.
 */
function useProjectedAgentUiBehaviorDiagnostics(
    pluginId: string,
    machineId: string | null,
): readonly Readonly<{ code: string; message: string }>[] {
    return React.useMemo(() => (
        readProjectedAgentUiBehaviorDiagnostics(machineId)
            .filter((diagnostic) => diagnostic.pluginId === pluginId)
            .map((diagnostic) => ({
                code: diagnostic.code,
                // The Agent and the descriptor path are the two facts an author
                // needs to find the declaration the interpreter refused.
                message: `${diagnostic.agentId} · ${diagnostic.path}: ${diagnostic.message}`,
            }))
    ), [pluginId, machineId]);
}

export function PluginDetailDiagnosticsSection(props: Readonly<{
    pluginId: string;
    projection: PluginProjectionEntry | null;
    registryDiagnostics: readonly PluginProjectionDiagnostic[];
    /** The machine whose daemon projection this screen is bound to. */
    machineId: string | null;
}>) {
    const diagnostics = props.projection?.diagnostics ?? [];
    const agentUiDiagnostics = useProjectedAgentUiBehaviorDiagnostics(props.pluginId, props.machineId);

    return (
        <>
            <PluginDiagnosticsSection
                title={t('settingsPlugins.diagnosticsTitle')}
                diagnostics={diagnostics}
                testIDPrefix={`settings.plugins.detail.${props.pluginId}.diagnostic`}
            />
            <PluginDiagnosticsSection
                title={t('settingsPlugins.registryDiagnosticsTitle')}
                diagnostics={props.registryDiagnostics}
                testIDPrefix={`settings.plugins.detail.${props.pluginId}.registryDiagnostic`}
            />
            <PluginDiagnosticsSection
                title={t('settingsPlugins.agentUiDiagnosticsTitle')}
                diagnostics={agentUiDiagnostics}
                testIDPrefix={`settings.plugins.detail.${props.pluginId}.agentUiDiagnostic`}
            />
        </>
    );
}
