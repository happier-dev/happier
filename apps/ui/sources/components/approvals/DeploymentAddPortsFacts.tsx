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
 * definition without evaluating it, and the managed services already on a declared literal port of the Machine it
 * runs on. A match is a possible clash, never a promised refusal; no match is never Machine-wide clearance, and the
 * confirmation stays where it is.
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
      {props.serverId && props.machineId && declared.query.ports.length > 0 ? (
        <DeclaredPortMatches serverId={props.serverId} machineId={props.machineId} query={declared.query} testID={props.testID} />
      ) : null}
    </>
  );
}

/** The one selected services read for the declared literal ports; mounted only while the review shows a selector. */
function DeclaredPortMatches(props: Readonly<{
  serverId: string;
  machineId: string;
  query: DeploymentDeclaredAddInputs['query'];
  testID: string;
}>) {
  const list = useMachineServicesList({ serverId: props.serverId, machineId: props.machineId, active: true, preflight: props.query });
  const machine = useServerScopedMachineLabel(props.serverId, props.machineId) ?? t('projects.deployments.aMachine');
  if (list.rows && list.rows.length > 0) {
    return (
      <AttentionBanner testID={`${props.testID}.clash`} tone="warning"
        title={t('projects.deployments.addPortsClash', { machine })}
        description={t('projects.deployments.addPortsClashBody')}
        points={list.rows.map((row) => row.port ? [row.name, ' · ', { code: String(row.port) }] : [row.name])} />
    );
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

/** A port exactly as declared: short forms verbatim, long forms as `[address:]published:target[/protocol]`. */
function formatDeclaredPort(port: DeclaredPort): string {
  if (typeof port === 'string' || typeof port === 'number') return String(port);
  const mapping = [port.bindAddress, port.published, port.target].filter((part) => part !== null).join(':');
  return port.protocol ? `${mapping}/${port.protocol}` : mapping;
}
