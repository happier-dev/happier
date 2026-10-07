import * as React from 'react';
import { View, type LayoutChangeEvent } from 'react-native';
import { WidgetPresentationProvider, useWidgetPresentation } from '@happier-dev/plugin-ui';
import type { JsonValue } from '@happier-dev/protocol';
import { getWidgetSizeFootprintV1, normalizeWidgetSizeForSurfaceV1, readBuiltinWidgetDescriptorV1, type WidgetSizeV1, type WidgetInstanceV1, type WidgetSurfaceRefV1 } from '@happier-dev/protocol/widgets';

import { ConfiguredInstalledWidgetSurface, ConfiguredWidgetRefusal, UnavailableInstalledWidget } from '@/components/widgets/InstalledWidgetSurface';
import { BuiltinWidgetBody } from '@/components/sessions/companion/glances/BuiltinWidgetBody';
import { describeAuthoredWidgetDefinitionV1, readWidgetDescriptor, type WidgetCandidate } from '@/components/widgets/widgetCatalog';
import { DeclarativeWidgetDocument } from '@/components/widgets/DeclarativeWidgetDocument';
import type { PluginUiProjectionCurrentness } from '@/sync/domains/plugins/ui/usePluginUiProjectionCurrentness';
import type { WidgetPresentation } from '@/sync/domains/plugins/ui/widgetContract';
import { useConfiguredWidgetTarget } from '@/sync/domains/widgets/useConfiguredWidgetTarget';
import type { WidgetInputRepairOutcome } from '@/sync/domains/widgets/widgetBinding';
import { useWidgetDefinition } from '@/sync/domains/widgets/useWidgetDefinition';
import { useWidgetInstanceDescriptor } from './useWidgetInstanceDescriptor';
import { captureActiveServerAccountScopeLifetime } from '@/sync/domains/scope/activeServerAccountScope';
import { storage, useActiveServerAccountScope } from '@/sync/domains/state/storage';

/** Placement supplies context and presentation, never executable target facts. */
export type WidgetSurfaceProps = Readonly<{
    scope: WidgetSurfaceRefV1;
    providedContext: Readonly<Record<string, readonly JsonValue[]>>;
    descriptor: WidgetCandidate | null;
    instance: WidgetInstanceV1;
    appRuntime: PluginUiProjectionCurrentness;
    presentation: WidgetPresentation;
    size?: WidgetSizeV1;
    recordRevision: string;
    enabled?: boolean;
    /** Admitted navigation content; no widget body or Resource subscription is mounted. */
    reference?: React.ReactNode;
    onRepairInputs?: (outcome: WidgetInputRepairOutcome) => void;
    onManagePlugin?: () => void;
    onIntrinsicHeightChange?: (height: number) => void;
    testID: string;
}>;

function InstalledInstanceBody(props: WidgetSurfaceProps & Readonly<{ descriptor: WidgetCandidate }>): React.ReactElement {
    const resolution = useConfiguredWidgetTarget(props);
    const definition = props.instance.definition;
    if (definition.kind === 'builtin') {
        if (resolution.status !== 'ready') return <ConfiguredWidgetRefusal resolution={resolution} testID={props.testID} onRepairInputs={props.onRepairInputs} onManagePlugin={props.onManagePlugin} />;
        if (props.reference !== undefined) return <>{props.reference}</>;
        const descriptor = readBuiltinWidgetDescriptorV1(definition);
        if (descriptor && resolution.target.kind === 'session' && resolution.target.session) return <BuiltinWidgetBody
            id={descriptor.definition.id} session={resolution.target.session} serverId={props.scope.serverId} testID={props.testID} />;
    }
    if (definition.kind !== 'installed') {
        return <UnavailableInstalledWidget unresolved={{ state: 'unavailable', reasonCode: 'widget_type_unavailable' }} testID={props.testID} />;
    }
    return <ConfiguredInstalledWidgetSurface
        resolution={resolution}
        source={{ kind: 'installedSurface', surface: definition.surface }}
        recordRevision={props.recordRevision}
        presentation={props.presentation}
        onManagePlugin={props.onManagePlugin}
        onRepairInputs={props.onRepairInputs}
        onIntrinsicHeightChange={props.onIntrinsicHeightChange}
        reference={props.reference}
        testID={props.testID}
    />;
}

function AuthoredReadyBody(props: WidgetSurfaceProps & Readonly<{ descriptor: WidgetCandidate }>): React.ReactElement {
    const resolution = useConfiguredWidgetTarget(props);
    const latest = React.useRef(resolution);
    latest.current = resolution;
    const viewer = useActiveServerAccountScope();
    const lifetime = React.useMemo(() => captureActiveServerAccountScopeLifetime(), [viewer]);
    const definition = props.descriptor.authoredDefinition!;
    const isCurrent = React.useCallback(() => {
        if (latest.current !== resolution || resolution.status !== 'ready' || !lifetime?.isCurrent()) return false;
        if (resolution.target.kind !== 'session') return true;
        const session = storage.getState().sessions[resolution.target.sessionId];
        return session?.serverId === props.scope.serverId && session.access?.capabilities.readTranscript === true;
    }, [resolution, lifetime, props.scope.serverId]);
    if (resolution.status !== 'ready') return <ConfiguredWidgetRefusal resolution={resolution} testID={props.testID} onRepairInputs={props.onRepairInputs} onManagePlugin={props.onManagePlugin} />;
    if (!lifetime) return <UnavailableInstalledWidget unresolved={{ state: 'unavailable', reasonCode: 'widget_scope_unavailable' }} testID={props.testID} />;
    if (definition.body.kind === 'declarative' && props.reference !== undefined) return <>{props.reference}</>;
    if (definition.body.kind === 'declarative') return <DeclarativeWidgetDocument document={definition.body.document}
        input={resolution.input} runtime={resolution.runtime} accountLifetime={lifetime} isCurrent={isCurrent}
        sessionId={resolution.target.kind === 'session' ? resolution.target.sessionId : undefined} enabled={props.enabled} testID={props.testID} />;
    return <ConfiguredInstalledWidgetSurface resolution={resolution} source={{ kind: 'installedSurface', surface: definition.body.surface }}
        recordRevision={props.recordRevision} presentation={props.presentation} onManagePlugin={props.onManagePlugin}
        onRepairInputs={props.onRepairInputs} onIntrinsicHeightChange={props.onIntrinsicHeightChange} reference={props.reference} testID={props.testID} />;
}

function AuthoredInstanceBody(props: WidgetSurfaceProps): React.ReactElement {
    const opened = useWidgetDefinition(props.scope, props.instance.definition, props.enabled !== false);
    const definition = opened.definition;
    const reference = props.instance.definition;
    if (!definition || (reference.kind !== 'artifact' && reference.kind !== 'inline')) return <UnavailableInstalledWidget
        unresolved={{ state: opened.state === 'loading' ? 'loading' : 'unavailable', reasonCode: opened.reasonCode ?? 'widget_type_unavailable' }} testID={props.testID} />;
    const installed = definition.body.kind === 'installed' ? readWidgetDescriptor(props.appRuntime.pluginUiProjection, definition.body) : null;
    const descriptor = describeAuthoredWidgetDefinitionV1(definition, reference, installed);
    return <AuthoredReadyBody {...props} descriptor={descriptor} />;
}

/** One mounted instance body shared by Home, Board and Companion; hosts retain their frame. */
function WidgetSurfaceBody(props: WidgetSurfaceProps): React.ReactElement {
    if (props.instance.definition.kind === 'artifact' || props.instance.definition.kind === 'inline') return <AuthoredInstanceBody {...props} />;
    if (!props.descriptor) {
        const establishing = props.instance.definition.kind === 'installed' && props.appRuntime.phase === 'establishing';
        if (establishing) return <UnavailableInstalledWidget
            unresolved={{ state: 'loading', reasonCode: 'widget_projection_establishing' }} testID={props.testID} />;
        return <ConfiguredWidgetRefusal resolution={{ status: 'unavailable', reasonCode: 'widget_type_unavailable', repair: { kind: 'type_unavailable' } }}
            testID={props.testID} onManagePlugin={props.onManagePlugin} />;
    }
    return <InstalledInstanceBody {...props} descriptor={props.descriptor} />;
}

/** One measured body box for all renderers. Reflow is presentation and never persists a size. */
export function WidgetSurface(props: WidgetSurfaceProps): React.ReactElement {
    const inherited = useWidgetPresentation();
    const descriptor = useWidgetInstanceDescriptor(props.scope, props.instance, props.descriptor);
    const [geometry, setGeometry] = React.useState<Readonly<{ width: number; height: number }>>();
    const onLayout = React.useCallback((event: LayoutChangeEvent) => {
        const { width, height } = event.nativeEvent.layout;
        if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) return;
        setGeometry(previous => previous?.width === width && previous.height === height ? previous : { width, height });
    }, []);
    const size = inherited ? undefined : normalizeWidgetSizeForSurfaceV1(props.scope.owner.kind, props.size, descriptor?.sizeDeclaration);
    const footprint = size ? getWidgetSizeFootprintV1(props.scope.owner.kind, size) : undefined;
    // A framed body consumes its one viewport owner unchanged (especially Board's native width×height).
    // Only an unframed preview measures here; neither path turns measured pixels into saved intent.
    const value = React.useMemo(() => inherited ?? (size && footprint ? { size, footprint, ...(geometry ? { geometry } : {}) } : undefined),
        [inherited, size, footprint, geometry]);
    const body = <View testID={`${props.testID}.geometry`} onLayout={inherited ? undefined : onLayout} style={{ minWidth: 0 }}>
        <WidgetSurfaceBody {...props} />
    </View>;
    return inherited ? body : <WidgetPresentationProvider value={value}>{body}</WidgetPresentationProvider>;
}
