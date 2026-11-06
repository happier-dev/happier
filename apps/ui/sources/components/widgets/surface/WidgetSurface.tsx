import * as React from 'react';
import { WidgetFrameDemandContext, WidgetFrameInstanceIdContext } from '@/components/widgets/frame/widgetFrameDemand';
import { View, type LayoutChangeEvent } from 'react-native';
import { WidgetPresentationProvider, useWidgetPresentation } from '@happier-dev/plugin-ui';
import type { JsonValue } from '@happier-dev/protocol';
import { getWidgetSizeFootprintV1, normalizeWidgetSizeForSurfaceV1, readBuiltinWidgetDescriptorV1, type WidgetDefinitionV1, type WidgetInputBindingsV1, type WidgetSizeV1, type WidgetInstanceV1, type WidgetSurfaceRefV1 } from '@happier-dev/protocol/widgets';
import { readWidgetDefinitionNetworkOverrideV1 } from '@happier-dev/protocol/widgets/widgetDefinitionV1';

import { ConfiguredInstalledWidgetSurface, ConfiguredWidgetRefusal, UnavailableInstalledWidget } from '@/components/widgets/InstalledWidgetSurface';
import { BuiltinWidgetBody } from '@/components/sessions/companion/glances/BuiltinWidgetBody';
import { describeAuthoredWidgetDefinitionV1, readWidgetDescriptor, type WidgetCandidate } from '@/components/widgets/widgetCatalog';
import { DeclarativeWidgetDocument } from '@/components/widgets/DeclarativeWidgetDocument';
import { WidgetMachineNoticeBoundary } from './WidgetMachineNotice';
import type { PluginUiProjectionCurrentness } from '@/sync/domains/plugins/ui/usePluginUiProjectionCurrentness';
import type { WidgetPresentation } from '@/sync/domains/plugins/ui/widgetContract';
import { useConfiguredWidgetTarget } from '@/sync/domains/widgets/useConfiguredWidgetTarget';
import type { WidgetInputRepairOutcome } from '@/sync/domains/widgets/widgetBinding';
import { useWidgetDefinition, type MountedWidgetDefinitionV1 } from '@/sync/domains/widgets/useWidgetDefinition';
import { useWidgetInstanceDescriptor } from './useWidgetInstanceDescriptor';
import { storage, useActiveServerAccountScopeLifetime } from '@/sync/domains/state/storage';
import type { ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';
import { HostedHtmlSurfaceAdapter } from '@/components/ui/surfaces/hostedHtml/HostedHtmlSurfaceAdapter';
import { useSessionCallerHostedHtmlRuntime } from '@/components/ui/surfaces/hostedHtml/useSessionCallerHostedHtmlRuntime';
import type { ConfiguredWidgetTargetResolution } from '@/sync/domains/widgets/widgetBinding';
import { sameStrictJsonValue } from '@happier-dev/protocol/json/strictJsonValue';
import { isPublicProfileWidgetSurfaceV1 } from '@happier-dev/protocol/widgets';
import { PluginSurfaceProjectionDemand } from '@/components/plugins/surfaces/PluginSurfaceProjectionDemand';
import { PublicProfileWidgetSurface } from '@/components/settings/account/publicProfile/PublicProfileWidgetSurface';

/** Placement supplies context and presentation, never executable target facts. */
export type WidgetSurfaceProps = Readonly<{
    scope: WidgetSurfaceRefV1;
    /** Captured only by the layout host after its actual Artifact read admits this viewer. */
    admittedViewer?: ServerAccountScope;
    /** Exact containing document admission, supplied by its canonical layout host. */
    isCurrent?: () => boolean;
    /** Factual pending document observation, independent from effect admission. */
    isReadPending?: () => boolean;
    providedContext: Readonly<Record<string, readonly JsonValue[]>>;
    /** Value composition only; providedContext retains the host's admitted read facts. */
    groupBindings?: WidgetInputBindingsV1;
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
    /** The frame observes this body's exact definition read; it never starts another read for its title. */
    onDefinitionRead?: (state: MountedWidgetDefinitionV1['state']) => void;
    testID: string;
}>;

function InstalledInstanceBody(props: WidgetSurfaceProps & Readonly<{ descriptor: WidgetCandidate }>): React.ReactElement {
    const resolution = useConfiguredWidgetTarget(props);
    useReportBindingDemand(resolution.status);
    const definition = props.instance.definition;
    if (definition.kind === 'builtin') {
        if (resolution.status !== 'ready') return <ConfiguredWidgetRefusal resolution={resolution} testID={props.testID} onRepairInputs={props.onRepairInputs} onManagePlugin={props.onManagePlugin} />;
        if (props.reference !== undefined) return <>{props.reference}</>;
        const descriptor = readBuiltinWidgetDescriptorV1(definition);
        if (descriptor) return <BuiltinWidgetBody id={descriptor.definition.id} target={resolution.target}
            input={resolution.input} serverId={props.scope.serverId} testID={props.testID} />;
    }
    if (definition.kind !== 'installed') {
        return <UnavailableInstalledWidget unresolved={{ state: 'unavailable', reasonCode: 'widget_type_unavailable' }} testID={props.testID} />;
    }
    return <ConfiguredInstalledWidgetSurface
        resolution={resolution}
        isCurrent={props.isCurrent}
        source={{ kind: 'installedSurface', surface: definition.surface }}
        guestNetworkOverride={props.instance.networkOverride}
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
    useReportBindingDemand(resolution.status);
    const latest = React.useRef(resolution);
    latest.current = resolution;
    const lifetime = useActiveServerAccountScopeLifetime();
    const definition = props.descriptor.authoredDefinition!;
    const isCurrent = React.useCallback(() => {
        if (latest.current !== resolution || resolution.status !== 'ready' || !lifetime?.isCurrent() || props.isCurrent?.() === false) return false;
        if (resolution.target.kind !== 'session') return true;
        const session = storage.getState().sessions[resolution.target.sessionId];
        return session?.serverId === props.scope.serverId && session.access?.capabilities.readTranscript === true;
    }, [resolution, lifetime, props.scope.serverId, props.isCurrent]);
    if (resolution.status !== 'ready') return <ConfiguredWidgetRefusal resolution={resolution} testID={props.testID} onRepairInputs={props.onRepairInputs} onManagePlugin={props.onManagePlugin} />;
    if (!lifetime) return <UnavailableInstalledWidget unresolved={{ state: 'unavailable', reasonCode: 'widget_scope_unavailable' }} testID={props.testID} />;
    if (definition.body.kind !== 'installed' && props.reference !== undefined) return <>{props.reference}</>;
    switch (definition.body.kind) {
        case 'builtin': return isCurrent() ? <BuiltinWidgetBody id={definition.body.id} target={resolution.target}
            input={resolution.input} serverId={props.scope.serverId} testID={props.testID} /> : <UnavailableInstalledWidget
            unresolved={{ state: 'unavailable', reasonCode: 'widget_scope_unavailable' }} testID={props.testID} />;
        case 'declarative': return <DeclarativeWidgetDocument document={definition.body.document}
            input={resolution.input} runtime={resolution.runtime} accountLifetime={lifetime} isCurrent={isCurrent}
            sessionId={resolution.target.kind === 'session' ? resolution.target.sessionId : undefined} enabled={props.enabled} testID={props.testID} />;
        case 'html': return <AuthoredHtmlBody {...props} definition={definition} body={definition.body} resolution={resolution} isCurrent={isCurrent} />;
        case 'installed': return <ConfiguredInstalledWidgetSurface resolution={resolution} isCurrent={isCurrent} source={{ kind: 'installedSurface', surface: definition.body.surface }}
            guestNetworkOverride={props.instance.networkOverride ?? readWidgetDefinitionNetworkOverrideV1(definition)}
            presentation={props.presentation} onManagePlugin={props.onManagePlugin}
            onRepairInputs={props.onRepairInputs} onIntrinsicHeightChange={props.onIntrinsicHeightChange} reference={props.reference} testID={props.testID} />;
    }
}

function useReportBindingDemand(status: ConfiguredWidgetTargetResolution['status']) {
    const demand = React.useContext(WidgetFrameDemandContext);
    const id = React.useContext(WidgetFrameInstanceIdContext);
    React.useLayoutEffect(() => id === null ? undefined : demand?.refuse(id, status !== 'ready' && status !== 'loading'), [demand, id, status]);
}

/** An authored copy borrows only its destination viewer's current authority. */
function AuthoredHtmlBody(props: WidgetSurfaceProps & Readonly<{
    definition: WidgetDefinitionV1;
    body: Extract<WidgetDefinitionV1['body'], { kind: 'html' }>;
    resolution: Extract<ConfiguredWidgetTargetResolution, { status: 'ready' }>;
    isCurrent: () => boolean;
}>): React.ReactElement {
    const sessionId = props.resolution.target.kind === 'session' ? props.resolution.target.sessionId : undefined;
    const runtime = useSessionCallerHostedHtmlRuntime(props.scope.serverId, sessionId, props.resolution.runtime, props.isCurrent);
    const network = React.useMemo(() => props.instance.networkOverride ?? readWidgetDefinitionNetworkOverrideV1(props.definition),
        [props.instance.networkOverride, props.definition]);
    const requestedCapabilities = React.useMemo(() => network === undefined ? props.body.requestedCapabilities : {
        ...props.body.requestedCapabilities, network: network.network, networkOrigins: network.networkOrigins,
    }, [props.body.requestedCapabilities, network]);
    if (!runtime || !props.isCurrent()) return <UnavailableInstalledWidget
        unresolved={{ state: 'unavailable', reasonCode: 'widget_scope_unavailable' }} testID={props.testID} />;
    return <HostedHtmlSurfaceAdapter sessionId={sessionId} title={props.definition.name} recordRevision={props.recordRevision}
        approvalSubject={`widget:${props.definition.id}:${props.instance.id}`} source={props.body.source}
        requestedCapabilities={requestedCapabilities} input={props.resolution.input}
        target={props.resolution.target.kind === 'workspace'
            ? { kind: 'project', projectId: props.resolution.target.checkout.id }
            : props.resolution.target.kind === 'session'
                ? { kind: 'session', sessionId: props.resolution.target.sessionId }
                : { kind: 'app' }} runtime={runtime}
        onIntrinsicHeightChange={props.onIntrinsicHeightChange} testID={props.testID} />;
}

function AuthoredInstanceBody(props: WidgetSurfaceProps): React.ReactElement {
    const opened = useWidgetDefinition(props.scope, props.instance.definition, props.enabled !== false, props.admittedViewer);
    React.useEffect(() => {
        props.onDefinitionRead?.(opened.state);
    }, [props.onDefinitionRead, opened.state]);
    const definition = opened.definition;
    const reference = props.instance.definition;
    if (!definition || (reference.kind !== 'artifact' && reference.kind !== 'inline')) return <UnavailableInstalledWidget reasonKind="widget"
        unresolved={{ state: opened.state === 'loading' ? 'loading' : 'unavailable', reasonCode: opened.reasonCode ?? 'widget_type_unavailable' }} testID={props.testID} />;
    const installed = definition.body.kind === 'installed' ? readWidgetDescriptor(props.appRuntime.pluginUiProjection, definition.body) : null;
    const descriptor = describeAuthoredWidgetDefinitionV1(definition, reference, installed);
    return <>
        {definition.body.kind === 'installed' ? <PluginSurfaceProjectionDemand pluginId={definition.body.surface.pluginId}
            accountScope={props.appRuntime.accountLifetime?.scope ?? null}
            enabled={props.enabled !== false && props.isCurrent?.() !== false} /> : null}
        <AuthoredReadyBody {...props} descriptor={descriptor} />
    </>;
}

/** One mounted instance body shared by Home, Board and Companion; hosts retain their frame. */
function WidgetSurfaceBody(props: WidgetSurfaceProps): React.ReactElement {
    const builtin = props.instance.definition.kind === 'builtin';
    const current = props.isCurrent?.() !== false;
    const pending = !current && props.isReadPending?.() === true;
    const nativeBody = builtin && props.descriptor ? <InstalledInstanceBody {...props} descriptor={props.descriptor} /> : null;
    // Preserve the committed subtree, including its Resource subscription and
    // admitted input, while the containing layout is reread. This is mounted
    // presentation continuity, not admission for a new body or target.
    const admitted = React.useRef<Readonly<{ scope: WidgetSurfaceRefV1; instanceId: string; body: React.ReactElement }> | null>(null);
    const retainedBody = admitted.current?.instanceId === props.instance.id && sameStrictJsonValue(admitted.current.scope, props.scope)
        ? admitted.current.body : null;
    React.useLayoutEffect(() => {
        if (current && nativeBody) admitted.current = { scope: props.scope, instanceId: props.instance.id, body: nativeBody };
        else if (!builtin || !pending || !retainedBody) admitted.current = null;
    });
    if (builtin && !current) {
        if (pending && retainedBody) return retainedBody;
        return <UnavailableInstalledWidget reasonKind="widget"
            unresolved={{ state: pending ? 'loading' : 'unavailable', reasonCode: 'widget_scope_unavailable' }} testID={props.testID} />;
    }
    if (props.instance.definition.kind === 'artifact' || props.instance.definition.kind === 'inline') return <AuthoredInstanceBody {...props} />;
    if (!props.descriptor) {
        const establishing = props.instance.definition.kind === 'installed' && props.appRuntime.phase === 'establishing';
        if (establishing) return <UnavailableInstalledWidget
            unresolved={{ state: 'loading', reasonCode: 'widget_projection_establishing' }} testID={props.testID} />;
        if (props.instance.definition.kind === 'installed' && props.appRuntime.unavailableReasonCode) return <UnavailableInstalledWidget
            unresolved={{ state: 'unavailable', reasonCode: props.appRuntime.unavailableReasonCode }} testID={props.testID} />;
        return <ConfiguredWidgetRefusal resolution={{ status: 'unavailable', reasonCode: 'widget_type_unavailable', repair: { kind: 'type_unavailable' } }}
            testID={props.testID} onManagePlugin={props.onManagePlugin} />;
    }
    return nativeBody ?? <InstalledInstanceBody {...props} descriptor={props.descriptor} />;
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
    // It fills the frame's body room, so a state that replaces the body can sit balanced in it.
    const body = <View testID={`${props.testID}.geometry`} onLayout={inherited ? undefined : onLayout} style={{ minWidth: 0, flexGrow: 1 }}>
        {!isPublicProfileWidgetSurfaceV1(props.scope) && props.instance.definition.kind === 'installed' ? <PluginSurfaceProjectionDemand
            pluginId={props.instance.definition.surface.pluginId} accountScope={props.appRuntime.accountLifetime?.scope ?? null}
            enabled={props.enabled !== false && props.isCurrent?.() !== false} /> : null}
        <WidgetMachineNoticeBoundary testID={props.testID}>
            {isPublicProfileWidgetSurfaceV1(props.scope) ? <PublicProfileWidgetSurface instance={props.instance} descriptor={descriptor}
                size={props.size} testID={props.testID} /> : <WidgetSurfaceBody {...props} />}
        </WidgetMachineNoticeBoundary>
    </View>;
    return inherited ? body : <WidgetPresentationProvider value={value}>{body}</WidgetPresentationProvider>;
}
