import * as React from 'react';

import { PageNavigationContextActionsProvider } from '@/components/ui/layout/NavigationHeaderActions';
import { PluginMachineExecutionOriginPickerProvider } from '@/components/settings/machines/PluginMachineExecutionOriginSelector';
import { PluginSurfaceProjectionDemand } from '@/components/plugins/surfaces/PluginSurfaceProjectionDemand';
import type { ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';

/** The addressed page outlives its current loading, unavailable or rendered body. */
export function PluginPagePresentation(props: React.PropsWithChildren<Readonly<{
    pluginId: string;
    localId: string;
    accountScope: ServerAccountScope | null;
    visible?: boolean;
    demandProjection?: boolean;
    actions: React.ReactNode;
}>>) {
    return <PluginMachineExecutionOriginPickerProvider pluginId={props.pluginId} visible={props.visible}
        key={JSON.stringify([props.accountScope?.serverId, props.accountScope?.accountId, props.pluginId, props.localId])}>
        <PluginSurfaceProjectionDemand pluginId={props.pluginId} accountScope={props.accountScope}
            enabled={props.visible !== false && props.demandProjection === true} />
        <PageNavigationContextActionsProvider actions={props.actions}>{props.children}</PageNavigationContextActionsProvider>
    </PluginMachineExecutionOriginPickerProvider>;
}
