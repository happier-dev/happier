import * as React from 'react';
import { View } from 'react-native';
import { PluginServiceListFieldResourceResultV1Schema, type AdmittedPluginListFilterFieldV1 } from '@happier-dev/plugin-sdk/ui';
import type { PluginUiResourceSnapshot } from '@happier-dev/plugin-ui/hostApi';
import { createPluginMountedResourceDemand } from '@/components/plugins/surfaces/pluginMountedResourceDemand';
import { PluginContextualResourceState, PluginContextualResourceStoreProvider, type PluginContextualResourceBinding } from '@/components/plugins/surfaces/PluginContextualResourceStoreProvider';
import { resolvePluginContextualResourceBinding } from '@/components/plugins/surfaces/pluginResourceBinding';
import { readPluginSurfaceResourceReference } from '@/components/plugins/surfaces/pluginSurfaceResourceRead';
import { readPluginUiResourceProjection, type PluginUiProjectionModel } from '@/sync/domains/plugins/ui/projection';
import { usePluginUiProjectionCurrentness } from '@/sync/domains/plugins/ui/usePluginUiProjectionCurrentness';
import { slicePluginSections } from '@/sync/domains/plugins/ui/projectionSections';
import type { ActiveServerAccountScopeLifetime } from '@/sync/domains/scope/activeServerAccountScope';
import { useLayoutPresentationActive } from '@/components/ui/presentation/PluginSurfaceFocusEligibility';
import { SurfaceFreshnessLine } from '@/components/ui/surfaces/SurfaceFreshnessLine';
import { t } from '@/text';
import { projectServiceColumnResourceValues, type ServiceColumnValue } from './serviceColumnResourceValues';
export type { ServiceColumnValue } from './serviceColumnResourceValues';

type Resource = Readonly<{ pluginId: string; localId: string }>;
export type ServiceColumnDemand = Readonly<{ key: string; environmentId: string; collectorMachineId: string | null;
  field: AdmittedPluginListFilterFieldV1; resource: Resource; includeTrend: boolean }>;
type Owner = ReturnType<typeof createPluginMountedResourceDemand<ServiceColumnDemand, ServiceColumnValue>>;
const DemandContext = React.createContext<Owner | null>(null);

/** Cells register only while the Collection actually mounts their selected field. */
export function useServiceColumnValue(input: Readonly<{ environmentId: string; collectorMachineId: string | null;
  pluginId: string; field: AdmittedPluginListFilterFieldV1; includeTrend?: boolean }>): ServiceColumnValue | null {
  const owner = React.useContext(DemandContext);
  const includeTrend = input.includeTrend ?? true;
  const source = input.field.declaration.source;
  const resource = 'resource' in source ? readPluginSurfaceResourceReference(input.pluginId, source.resource) : null;
  const key = JSON.stringify([input.field.id, input.collectorMachineId, input.environmentId, includeTrend]);
  const resourceKey = resource ? JSON.stringify(resource) : null;
  React.useEffect(() => {
    if (!owner || !resource) return;
    return owner.mount(key, { key, environmentId: input.environmentId, collectorMachineId: input.collectorMachineId,
      field: input.field, resource, includeTrend });
  }, [owner, key, resourceKey, input.field, includeTrend]);
  const subscribe = React.useCallback((listener: () => void) => owner?.subscribe(key, listener) ?? (() => {}), [owner, key]);
  const read = React.useCallback(() => owner?.read(key) ?? null, [owner, key]);
  return React.useSyncExternalStore(subscribe, read, read);
}

export function ServiceColumnResources(props: Readonly<{ projection: PluginUiProjectionModel | null;
  lifetime: ActiveServerAccountScopeLifetime | null; children: React.ReactNode }>) {
  const owner = React.useMemo(() => createPluginMountedResourceDemand<ServiceColumnDemand, ServiceColumnValue>(), [props.lifetime]);
  const revision = React.useSyncExternalStore(owner.subscribeDemand, owner.getRevision, owner.getRevision);
  const groups = React.useMemo(() => {
    const groups = new Map<string, { machineId: string | null; demands: ServiceColumnDemand[] }>();
    for (const demand of owner.demands()) {
      const declaration = readPluginUiResourceProjection(props.projection?.resourcesById, demand.resource);
      const machineId = declaration?.execution?.target === 'account' ? null : demand.collectorMachineId;
      const key = JSON.stringify([demand.resource, machineId]);
      const group = groups.get(key) ?? { machineId, demands: [] };
      group.demands.push(demand);
      groups.set(key, group);
    }
    return groups;
  }, [owner, props.projection, revision]);
  return <PluginContextualResourceStoreProvider>
    <DemandContext.Provider value={owner}>
      {props.lifetime && [...groups].map(([key, group]) => <ServiceColumnGroup key={key} owner={owner} {...group}
        projection={props.projection} lifetime={props.lifetime!} />)}
      {props.children}
    </DemandContext.Provider>
  </PluginContextualResourceStoreProvider>;
}

function ServiceColumnGroup(props: Readonly<{ owner: Owner; demands: readonly ServiceColumnDemand[];
  machineId: string | null; projection: PluginUiProjectionModel | null; lifetime: ActiveServerAccountScopeLifetime }>) {
  const first = props.demands[0]!;
  const presented = useLayoutPresentationActive();
  const declared = readPluginUiResourceProjection(props.projection?.resourcesById, first.resource);
  const account = declared?.execution?.target === 'account';
  const [reloadRevision, reload] = React.useReducer((revision: number) => revision + 1, 0);
  const sections = React.useMemo(() => slicePluginSections(['resourcesById'], first.resource.pluginId), [first.resource.pluginId]);
  // Global declarations name the column. The existing per-Machine owner admits the actual collector's executable Resource.
  const current = usePluginUiProjectionCurrentness({ serverId: props.lifetime.scope.serverId,
    machineId: props.machineId, enabled: props.machineId !== null,
    load: presented, sections, reloadRevision });
  const projection = account ? props.projection : current.pluginUiProjection;
  const declaration = readPluginUiResourceProjection(projection?.resourcesById, first.resource);
  const environmentIds = [...new Set(props.demands.map(demand => demand.environmentId))].sort();
  const trendRequested = props.demands.some(demand => demand.includeTrend);
  const context = { kind: 'surface' as const, mountInstanceKey: `services:${JSON.stringify([first.resource, props.machineId])}`,
    launchInput: { entity: 'service', serverId: props.lifetime.scope.serverId, environmentIds,
      ...(trendRequested ? {} : { includeTrend: false }) } };
  const binding = declaration && resolvePluginContextualResourceBinding({ projection, accountLifetime: props.lifetime,
    machineId: props.machineId, serverId: props.lifetime.scope.serverId, requireReadAuthority: true,
    isCurrent: () => account || current.interactionEnabled }, declaration, context);
  if (binding) return <ServiceColumnResourceBatch owner={props.owner} demands={props.demands} binding={binding} resource={first.resource} />;
  // The currentness owner withdrew this collector. Retained figures stay readable with one explanation for the source.
  const reading = current.phase === 'establishing';
  const retained = props.demands.some(demand => props.owner.read(demand.key)?.value != null);
  if (!props.machineId || reading && !retained) return null;
  return <SurfaceFreshnessLine busy={reading} reason={reading ? t('common.loading') : t('common.unavailable')}
    {...(reading ? {} : { action: { label: t('common.retry'), onPress: reload } })} />;
}

/** One already-admitted collector group; transport and push lifetime stay in the incumbent contextual store. */
export function ServiceColumnResourceBatch(props: Readonly<{ owner: Owner; demands: readonly ServiceColumnDemand[];
  binding: PluginContextualResourceBinding; resource: Resource }>) {
  return <PluginContextualResourceState binding={props.binding} resource={props.resource}>
    {(snapshot, controls) => <ServiceColumnResourcePublication {...props} snapshot={snapshot} refresh={controls.refresh} />}
  </PluginContextualResourceState>;
}

function ServiceColumnResourcePublication(props: Readonly<{ owner: Owner; demands: readonly ServiceColumnDemand[];
  resource: Resource; snapshot: PluginUiResourceSnapshot | null; refresh: () => Promise<unknown> }>) {
  React.useEffect(() => {
    let input: unknown;
    if (props.snapshot?.value?.contentType === 'application/json') {
      try { input = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(props.snapshot.value.bytes)); } catch { input = undefined; }
    }
    const parsed = PluginServiceListFieldResourceResultV1Schema.safeParse(input);
    if (!parsed.success) return;
    const rows = parsed.data.items;
    const fields = new Map<string, ReadonlyMap<string, ServiceColumnValue>>();
    for (const demand of props.demands) {
      let values = fields.get(demand.field.id);
      if (!values) { values = projectServiceColumnResourceValues(demand.field, rows); fields.set(demand.field.id, values); }
      props.owner.publish(demand.key, values.get(demand.environmentId) ?? { value: null });
    }
  }, [props.owner, props.demands, props.snapshot]);
  return props.snapshot?.error || props.snapshot?.freshness === 'stale' ? <View><SurfaceFreshnessLine
    testID={`services.columns.${props.resource.pluginId}.${props.resource.localId}.${props.demands[0]?.collectorMachineId ?? 'account'}.freshness`}
    reason={props.snapshot?.error?.message ?? t('common.unavailable')}
    action={{ label: t('common.retry'), onPress: () => { void props.refresh(); } }} /></View> : null;
}
