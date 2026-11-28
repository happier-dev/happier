import * as React from 'react';

import { useMachineServicesList } from '@/components/machines/services/useMachineServicesList';
import {
  readDeploymentAddDeclaredInputs,
  type DeploymentDeclaredAddInputs,
} from '@/components/projects/deployments/deploymentPreflightWarnings';
import { AttentionBanner } from '@/components/ui/lists/AttentionBanner';
import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { SurfaceStateCard } from '@/components/ui/surfaces/SurfaceStateCard';
import { useServerScopedMachineLabel } from '@/sync/store/hooks';
import { t } from '@/text';

type DeclaredPort = DeploymentDeclaredAddInputs['services'][number]['ports'][number];

/**
 * What an app being added declares about its ports and names (SOS-GAP-PREFLIGHT #4), read from the reviewed
 * definition without evaluating it, and matches in the target Machine's retained managed services inventory.
 */
export function DeploymentAddPortsFacts(props: Readonly<{
  document: string;
  services: readonly string[];
  serverId: string | null;
  machineId: string | null;
  testID: string;
}>) {
  const { document, services } = props;
  const [declared, setDeclared] = React.useState<DeploymentDeclaredAddInputs | null>(null);
  const servicesKey = services.join('\n');
  React.useEffect(() => {
    let current = true;
    // A definition that does not parse keeps the Add's own invalid_request recovery; this section says nothing.
    readDeploymentAddDeclaredInputs(document, servicesKey ? servicesKey.split('\n') : []).then(
      (next) => { if (current) setDeclared(next); },
      () => { if (current) setDeclared(null); },
    );
    return () => { current = false; };
  }, [document, servicesKey]);
  const rows = declared?.services.filter((service) => service.ports.length > 0 || service.name !== null) ?? [];
  if (!declared || rows.length === 0) return null;
  return (
    <>
      <ItemGroup testID={props.testID} title={t('projects.deployments.addPortsTitle')}
        description={t('projects.deployments.addPortsUnresolved')}>
        {rows.map((service) => (
          <Item key={service.service} mode="info" title={service.name ? `${service.service} · ${service.name}` : service.service}
            subtitle={service.ports.map(formatDeclaredPort).join(', ') || undefined} />
        ))}
      </ItemGroup>
      {props.serverId && props.machineId && (declared.query.ports.length > 0 || declared.query.displayNames?.length) ? (
        <DeclaredServiceMatches serverId={props.serverId} machineId={props.machineId} query={declared.query} testID={props.testID} />
      ) : null}
    </>
  );
}

/** The one selected services read for the declared names and ports. */
function DeclaredServiceMatches(props: Readonly<{
  serverId: string;
  machineId: string;
  query: DeploymentDeclaredAddInputs['query'];
  testID: string;
}>) {
  const list = useMachineServicesList({ serverId: props.serverId, machineId: props.machineId, active: true, preflight: props.query });
  const machine = useServerScopedMachineLabel(props.serverId, props.machineId) ?? t('projects.deployments.aMachine');
  if (list.rows && list.rows.length > 0) {
    return <DeploymentAddServiceMatches machine={machine} names={Boolean(props.query.displayNames?.length)}
      rows={list.rows} testID={`${props.testID}.clash`} />;
  }
  if (list.unavailable || list.error) {
    return (
      <SurfaceStateCard testID={`${props.testID}.unavailable`} kind="unavailable" size="line"
        title={t('projects.deployments.addPortsUnavailable', { machine })}
        diagnosticCode={list.unavailable ?? list.error?.code}
        action={{ label: t('common.retry'), onPress: () => { void list.refresh(); } }} />
    );
  }
  return null;
}

export function DeploymentAddServiceMatches(props: Readonly<{ machine: string; names: boolean;
  rows: readonly Readonly<{ name: string; port?: number | null }>[]; testID: string }>) {
  return <AttentionBanner testID={props.testID} tone="warning"
    title={props.names ? t('projects.deployments.addNameOrPortClash', { machine: props.machine })
      : t('projects.deployments.addPortsClash', { machine: props.machine })}
    description={props.names ? t('projects.deployments.addNameOrPortClashBody') : t('projects.deployments.addPortsClashBody')}
    points={props.rows.map((row) => row.port ? [row.name, ' · ', { code: String(row.port) }] : [row.name])} />;
}

/** A port exactly as declared: short forms verbatim, long forms as `[address:]published:target[/protocol]`. */
function formatDeclaredPort(port: DeclaredPort): string {
  if (typeof port === 'string' || typeof port === 'number') return String(port);
  const mapping = [port.bindAddress, port.published, port.target].filter((part) => part !== null).join(':');
  return port.protocol ? `${mapping}/${port.protocol}` : mapping;
}
