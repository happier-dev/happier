import * as React from 'react';

import { useAppShellPluginUiProjection } from '@/components/appShell/plugins/AppShellPluginUiProjection';
import { PluginPageContent } from '@/components/plugins/pages/PluginPageContent';
import { buildPluginMachinePageRoutePath } from '@/components/plugins/pages/pluginPageRoute';
import { PageContentColumn } from '@/components/ui/lists/PageContentColumn';
import { SurfaceStateSizeProvider } from '@/components/ui/surfaces/surfaceStateSize';
import { useDeviceType } from '@/utils/platform/responsive';

import type { MachinePageTabBodyProps } from './machinePageTabQuery';
import { useMachinePagePluginPages } from './useMachinePagePluginCatalog';

/**
 * One plugin Machine page under the Machine page's header and tabs (plan 30 §3.7). The shared page owner mounts it
 * with this Machine as its addressed target; a page the catalog does not (or no longer) lists shows that owner's
 * loading or unavailable state in place.
 */
export function MachinePluginPageTab(props: MachinePageTabBodyProps) {
    const params = props.params.id === 'plugin' ? props.params : null;
    const pages = useMachinePagePluginPages();
    const phone = useDeviceType() === 'phone';
    const projection = useAppShellPluginUiProjection();
    const pluginId = params?.pluginId ?? '';
    const localId = params?.localId ?? '';
    const page = pages.find(candidate => candidate.pluginId === pluginId && candidate.localId === localId) ?? null;
    const { serverId, machineId } = props;
    const routePathFor = React.useCallback((subPath: string) => buildPluginMachinePageRoutePath({
        serverId, machineId, pluginId, localId, subPath,
    }), [serverId, machineId, pluginId, localId]);
    if (!params) return null;
    // The tab body is the Machine page's content area: the page stands in the Machine page's column (one edge with
    // its header, tabs and core tabs), and its unsized states take the page step (the phone step on a phone).
    return (
        <PageContentColumn testID="machine-plugin-page-column">
            <SurfaceStateSizeProvider size={phone ? 'phone' : 'page'}>
                <PluginPageContent pluginId={pluginId} localId={localId} subPath={params.pluginPath ?? ''}
                    page={page} projection={projection} routePathFor={routePathFor} />
            </SurfaceStateSizeProvider>
        </PageContentColumn>
    );
}
