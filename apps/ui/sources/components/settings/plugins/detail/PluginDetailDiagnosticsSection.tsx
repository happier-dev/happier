import * as React from 'react';

import type { PluginProjectionEntry } from '@/agents/backendCatalog/daemonContributionRegistryProjectionAdapters';
import type { PluginProjectionDiagnostic } from '@/agents/backendCatalog/daemonContributionRegistryProjectionAdapters';
import { t } from '@/text';

import { PluginDiagnosticsSection } from '../diagnostics/PluginDiagnosticsSection';

export function PluginDetailDiagnosticsSection(props: Readonly<{
    pluginId: string;
    projection: PluginProjectionEntry | null;
    registryDiagnostics: readonly PluginProjectionDiagnostic[];
}>) {
    const diagnostics = props.projection?.diagnostics ?? [];

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
        </>
    );
}
