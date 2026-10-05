import * as React from 'react';
import type { WidgetInstanceV1 } from '@happier-dev/protocol/widgets';

import { useAppShellPluginUiProjection } from '@/components/appShell/plugins/AppShellPluginUiProjection';
import { UnavailableInstalledWidget } from '@/components/widgets/InstalledWidgetSurface';
import { WidgetSurface } from '@/components/widgets/surface/WidgetSurface';
import { useWidgetInstanceBindingLabel } from '@/components/widgets/surface/useWidgetInstanceBindingLabel';
import { useWidgetInstanceDescriptor } from '@/components/widgets/surface/useWidgetInstanceDescriptor';
import { readWidgetDescriptor } from '@/components/widgets/widgetCatalog';
import { WidgetFrame, type WidgetFrameStyle } from '@/components/widgets/frame/WidgetFrame';
import { useActiveServerAccountScope } from '@/sync/domains/state/storage';
import type { Session } from '@/sync/domains/state/storageTypes';
import type { SessionCompanionInstanceView } from '../SessionCompanionItemFrame';
import { stableJsonStringify } from '@/utils/json/stableJsonStringify';

/** The Companion retains its one frame; the universal body binds the exact configured target. */
export function PluginGlance(props: Readonly<{
    instance: WidgetInstanceV1;
    sessionId: string;
    session: Session;
    serverId: string | null;
    frameStyle: WidgetFrameStyle;
    menu?: React.ReactNode;
    /** This copy's rename field (in its title's place) and the card's repair line. */
    instanceView?: SessionCompanionInstanceView;
    measurementOnly: boolean;
    testID: string;
}>) {
    const runtime = useAppShellPluginUiProjection();
    const viewerScope = useActiveServerAccountScope();
    const definition = props.instance.definition;
    const installed = React.useMemo(() => readWidgetDescriptor(runtime.pluginUiProjection, definition), [runtime.pluginUiProjection, definition]);
    const descriptor = useWidgetInstanceDescriptor(viewerScope?.serverId === props.serverId ? viewerScope : null, props.instance, installed);
    // A copy is named by what it is bound to ("Fix settings modal remount"), in the source slot (lab dbind X).
    const bindingLabel = useWidgetInstanceBindingLabel(props.instance, descriptor);
    return <WidgetFrame
        testID={props.testID} frameStyle={props.frameStyle} placement="companion"
        mark={descriptor?.icon ?? 'puzzle-piece'}
        title={props.instanceView?.titleEditor ?? props.instance.displayName ?? descriptor?.title ?? (definition.kind === 'installed' ? definition.surface.localId : props.instance.id)}
        source={bindingLabel ?? descriptor?.pluginName ?? (definition.kind === 'installed' ? definition.surface.pluginId : undefined)}
        menu={props.menu}
        body={{ kind: 'content', children: props.measurementOnly ? null : viewerScope && viewerScope.serverId === props.serverId
            ? <WidgetSurface testID={props.testID + '.surface'}
                scope={{ ...viewerScope, owner: { kind: 'companion', sessionId: props.sessionId } }}
                providedContext={{ session: [{ serverId: viewerScope.serverId, sessionId: props.sessionId }] }}
                instance={props.instance} descriptor={descriptor} appRuntime={runtime} presentation="content"
                recordRevision={stableJsonStringify(props.instance)}
                {...(props.instanceView?.onRepairInputs ? { onRepairInputs: props.instanceView.onRepairInputs } : {})} />
            : <UnavailableInstalledWidget unresolved={{ state: 'unavailable', reasonCode: 'widget_viewer_scope_mismatch' }} testID={props.testID + '.surface'} /> }}
    />;
}
