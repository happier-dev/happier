import * as React from 'react';
import { Platform, View } from 'react-native';
import { useUnistyles } from 'react-native-unistyles';
import {
    PluginDeclarativeDocumentV1Schema, PluginDeclarativeNodeV2Schema,
    type PluginDeclarativeDataNodeV1, type PluginDeclarativeDocumentV1, type JsonValue,
} from '@happier-dev/protocol';
import type { PluginUiResourceSnapshot } from '@happier-dev/plugin-ui/hostApi';
import { PluginContextualResourceState, PluginContextualResourceStoreProvider, type PluginContextualResourceBinding } from '@/components/plugins/surfaces/PluginContextualResourceStoreProvider';
import { projectDeclarativeDataResourceSnapshot, resolveDeclarativeDataResourceBinding,
    type DeclarativeDataSourceProjection } from '@/components/plugins/surfaces/declarativeDataSource';
import { projectPluginUiTheme } from '@/components/plugins/surfaces/pluginUiThemeProjection';
import { readDeclarativeText, renderDeclarativeNode, type DeclarativeNodeRenderContext } from '@/components/plugins/shared/declarativeNodes';
import { resolveMinimumInteractiveTargetSize } from '@/components/ui/interactiveTargetSize';
import { ItemLoadStateRows } from '@/components/ui/lists/ItemLoadStateRows';
import { SurfaceFreshnessLine } from '@/components/ui/surfaces/SurfaceFreshnessLine';
import { resolvePluginSurfaceStatePresentation } from '@/sync/domains/surfaces/copy/resolveReasonCopy';
import { t } from '@/text';
import type { PluginUiProjectionCurrentness } from '@/sync/domains/plugins/ui/usePluginUiProjectionCurrentness';
import { readPluginUiContributionOrigin } from '@/sync/domains/plugins/ui/projectionUnion';
import type { ActiveServerAccountScopeLifetime } from '@/sync/domains/scope/activeServerAccountScope';
import { randomUUID } from '@/platform/randomUUID';
import { WidgetSnapshotCaptureContext } from './definitions/widgetSnapshotCapture';
import { UnavailableInstalledWidget } from './InstalledWidgetSurface';

export type DeclarativeWidgetDocumentProps = Readonly<{
    document: PluginDeclarativeDocumentV1;
    input: Readonly<Record<string, JsonValue>>;
    runtime: PluginUiProjectionCurrentness;
    accountLifetime: ActiveServerAccountScopeLifetime;
    sessionId?: string;
    enabled?: boolean;
    /** From the actual input/target owner; loss of read authority removes retained bytes. */
    isCurrent: () => boolean;
    testID: string;
}>;

/** Exact declaration/realm admission; authored schemas never select transport authority. */
export function resolveDeclarativeWidgetResourceBinding(props: DeclarativeWidgetDocumentProps, node: PluginDeclarativeDataNodeV1,
    mountInstanceKey: string): PluginContextualResourceBinding | null {
    return resolveDeclarativeDataResourceBinding({ projection: props.runtime.pluginUiProjection, input: props.input,
        machineId: props.runtime.machineId, serverId: props.runtime.serverId, accountLifetime: props.accountLifetime,
        sessionId: props.sessionId, isCurrent: props.isCurrent }, node, mountInstanceKey);
}

/** What one live data node knows about its retained content, for the document's one freshness line. */
type DataNodeFreshness = Readonly<{
    state: 'fresh' | 'refreshing' | 'stale' | 'failed';
    reasonCode?: string;
    /** When this mount first saw the shown bytes current; absent when it never did. */
    asOf?: number;
    /** The frozen node on screen and its read identity, for an explicit Post a snapshot. */
    shown: PluginDeclarativeDataNodeV1;
    digest?: string;
    refresh: () => Promise<void>;
}>;

/**
 * The document's freshness facts, one entry per live data node. A small external store, so a node
 * reporting a refresh re-renders only the line, never the retained content beside it.
 */
function createDataFreshnessStore() {
    let reports = new Map<string, DataNodeFreshness>();
    const listeners = new Set<() => void>();
    const emit = () => { for (const listener of listeners) listener(); };
    return {
        report(key: string, value: DataNodeFreshness | null) {
            const next = new Map(reports);
            if (value) next.set(key, value); else next.delete(key);
            reports = next;
            emit();
        },
        subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
        getSnapshot: () => reports,
    };
}
type DataFreshnessStore = ReturnType<typeof createDataFreshnessStore>;
const DataFreshnessContext = React.createContext<DataFreshnessStore | null>(null);

function freshnessOf(projected: DeclarativeDataSourceProjection): DataNodeFreshness['state'] {
    if (projected.pending === 'refresh') return 'refreshing';
    if (projected.errorCode) return 'failed';
    return projected.freshness === 'stale' ? 'stale' : 'fresh';
}

/**
 * Last good content stays at full strength under its header while it refreshes, while its machine is
 * away and after a failed read (lab ST): the node keeps its component identity, and the document says
 * as of when, why, and offers one Retry. Content whose read authority is gone is never shown.
 */
function RetainedDataNode(props: Readonly<{
    reportKey: string;
    node: PluginDeclarativeDataNodeV1;
    projected: DeclarativeDataSourceProjection;
    refresh: () => Promise<void>;
    context: DeclarativeNodeRenderContext;
}>): React.ReactElement | null {
    const store = React.useContext(DataFreshnessContext);
    const seen = React.useRef<Readonly<{ digest: string | undefined; at: number }> | null>(null);
    const state = freshnessOf(props.projected);
    const digest = props.projected.digest;
    if (state === 'fresh' && seen.current?.digest !== digest) seen.current = { digest, at: Date.now() };
    const asOf = seen.current?.digest === digest ? seen.current?.at : undefined;
    const reasonCode = props.projected.errorCode;
    const refresh = props.refresh;
    const shown = props.node;
    React.useEffect(() => {
        store?.report(props.reportKey, { state, shown, ...(digest ? { digest } : {}), ...(reasonCode ? { reasonCode } : {}),
            ...(asOf !== undefined ? { asOf } : {}), refresh });
    }, [store, props.reportKey, state, shown, digest, reasonCode, asOf, refresh]);
    React.useEffect(() => () => store?.report(props.reportKey, null), [store, props.reportKey]);
    return <>{renderDeclarativeNode(props.node, { ...props.context, renderDataNode: undefined }, props.reportKey)}</>;
}

/** Retain a validated presentation only while the exact read still discloses bytes. */
function ProjectedResourceDataNode(props: Readonly<{
    node: PluginDeclarativeDataNodeV1;
    snapshot: PluginUiResourceSnapshot | null;
    isCurrent: boolean;
    refresh: () => Promise<void>;
    context: DeclarativeNodeRenderContext;
    reportKey: string;
    testID: string;
}>): React.ReactElement {
    const lastGood = React.useRef<DeclarativeDataSourceProjection | null>(null);
    const projected = projectDeclarativeDataResourceSnapshot(props.node, props.snapshot, props.isCurrent, lastGood.current);
    // No bytes means the Resource owner withdrew them (or has not admitted a
    // first read). Keeping a typed model then would bypass its authority.
    lastGood.current = projected.node ? projected : null;
    if (projected.node) return <RetainedDataNode reportKey={props.reportKey} node={projected.node} projected={projected}
        refresh={props.refresh} context={props.context} />;
    if (projected.pending === 'initial' && !projected.errorCode) return <ItemLoadStateRows testID={`${props.testID}-data-loading`}
        state={{ kind: 'loading' }} rows={3} lines={2} shape="list" />;
    return <UnavailableInstalledWidget testID={`${props.testID}-data`} unresolved={{ state: 'unavailable',
        reasonCode: projected.errorCode ?? 'widget_data_source_unavailable' }} />;
}

function ResourceDataNode(props: DeclarativeWidgetDocumentProps & Readonly<{
    node: PluginDeclarativeDataNodeV1; context: DeclarativeNodeRenderContext; mountInstanceKey: string; reportKey: string;
}>): React.ReactElement {
    const binding = resolveDeclarativeWidgetResourceBinding(props, props.node, props.mountInstanceKey);
    if (!binding || props.node.data.kind !== 'resource') return <UnavailableInstalledWidget
        testID={`${props.testID}-data`} unresolved={{ state: 'unavailable', reasonCode: 'widget_data_source_unavailable' }} />;
    const source = props.node.data.resource;
    const declaration = Object.values(props.runtime.pluginUiProjection?.resourcesById ?? {})
        .find(row => row.pluginId === source.pluginId && row.id === source.localId);
    const origin = readPluginUiContributionOrigin(declaration);
    const readEnabled = origin ? origin.phase === 'current' && origin.interactionEnabled
        : props.runtime.phase === 'current' && props.runtime.interactionEnabled;
    // Bind validated LKG to the same Account, occurrence, realm, exact target,
    // inputs and authored projection. A different read starts without its data.
    const dataIdentity = JSON.stringify([binding.accountLifetime.scope, binding.pluginId, binding.machineId,
        binding.serverId, binding.expectedCallerOccurrenceId, binding.context, props.node]);
    return <PluginContextualResourceState binding={binding} resource={props.node.data.resource} isCurrent={props.isCurrent}
        active={props.enabled !== false && readEnabled}>
        {(snapshot, controls) => <ProjectedResourceDataNode key={dataIdentity} node={props.node} snapshot={snapshot}
            isCurrent={props.accountLifetime.isCurrent() && props.isCurrent()} refresh={controls.refresh}
            context={props.context} reportKey={props.reportKey} testID={props.testID} />}
    </PluginContextualResourceState>;
}

/** One line for the whole document: the oldest retained content, its cause and one Retry for every failed read. */
function DataFreshnessLine(props: Readonly<{ testID: string }>): React.ReactElement | null {
    const store = React.useContext(DataFreshnessContext)!;
    const reports = React.useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
    const all = [...reports.values()];
    const failed = all.filter(report => report.state === 'failed');
    const stale = all.filter(report => report.state === 'stale');
    const affected = failed.length > 0 ? failed : stale;
    if (affected.length === 0) return null;
    const busy = all.some(report => report.state === 'refreshing');
    const presentation = resolvePluginSurfaceStatePresentation({ state: failed.length > 0 ? 'failedRetry' : 'stale',
        reasonCode: affected.find(report => report.reasonCode)?.reasonCode ?? null, hasRetainedContent: true });
    const times = affected.map(report => report.asOf).filter((at): at is number => at !== undefined);
    return <SurfaceFreshnessLine testID={`${props.testID}-freshness`} busy={busy}
        tone={failed.length > 0 ? 'warning' : 'neutral'}
        reason={presentation.contentNotice?.reason ?? presentation.contentNotice?.title ?? t('widgetDefinition.notCurrent')}
        {...(times.length > 0 ? { asOf: Math.min(...times) } : {})}
        action={{ label: t('common.retry'), onPress: () => Promise.all(affected.map(report => report.refresh())) }} />;
}

/** The same source shell accepts Account Artifacts and deliberately copied shared definitions. */
export function DeclarativeWidgetDocument(props: DeclarativeWidgetDocumentProps): React.ReactElement {
    const { theme } = useUnistyles();
    const presentationTheme = React.useMemo(() => projectPluginUiTheme(theme), [theme]);
    const [mountInstanceKey] = React.useState(randomUUID);
    const parsed = React.useMemo(() => PluginDeclarativeDocumentV1Schema.safeParse(props.document), [props.document]);
    const context: DeclarativeNodeRenderContext = { colors: theme.colors, presentationTheme,
        minimumTouchTarget: resolveMinimumInteractiveTargetSize(Platform.OS), localize: readDeclarativeText,
        markdownProfile: 'widget', resolveAction: () => null, renderField: () => null, renderCollectionList: () => null };
    const [freshness] = React.useState(createDataFreshnessStore);
    // Post a snapshot reads exactly what this document shows, only when the person asks for it.
    const snapshotSlot = React.useContext(WidgetSnapshotCaptureContext);
    const document = parsed.success ? parsed.data : null;
    React.useEffect(() => (snapshotSlot && document ? snapshotSlot.register({
        read: () => {
            const reports = [...freshness.getSnapshot()];
            return { document, frozenByPath: new Map(reports.map(([path, report]) => [path, report.shown])),
                digests: reports.flatMap(([, report]) => (report.digest ? [report.digest] : [])),
                current: reports.every(([, report]) => report.state === 'fresh'),
                refresh: () => Promise.all(reports.map(([, report]) => report.refresh())) };
        },
        subscribe: freshness.subscribe,
    }) : undefined), [document, freshness, snapshotSlot]);
    const renderDataNode = (value: Readonly<Record<string, unknown>>, path: string): React.ReactNode => {
        const { path: _path, order: _order, ...authored } = value;
        const node = PluginDeclarativeNodeV2Schema.safeParse(authored);
        if (!node.success || !('data' in node.data)) return null;
        return node.data.data.kind === 'value' ? renderDeclarativeNode(node.data, context, path)
            : <ResourceDataNode key={path} reportKey={path} {...props} node={node.data} context={context} mountInstanceKey={mountInstanceKey} />;
    };
    return <PluginContextualResourceStoreProvider><DataFreshnessContext.Provider value={freshness}><View testID={props.testID}>
        {parsed.success ? renderDeclarativeNode(parsed.data.root, { ...context, renderDataNode }) : null}
        <DataFreshnessLine testID={props.testID} />
    </View></DataFreshnessContext.Provider></PluginContextualResourceStoreProvider>;
}
