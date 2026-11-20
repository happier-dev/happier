import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';
import { relayAccessProviderDescriptorsById } from '@happier-dev/cli-common/relayAccess/catalog';
import type { DeploymentDomainContentV1 } from '@happier-dev/protocol/deployments/deploymentDomainV1';
import { isRecord } from '@happier-dev/protocol/common/records';
import { readDeploymentFailureRecoveryV1 } from '@happier-dev/protocol/deployments/deploymentFailureRecoveryV1';
import { AccessProviderSelectionV1Schema } from '@happier-dev/protocol/plugins/contributions/accessProviders';
import type { QualifiedConnectedAccountRef } from '@happier-dev/protocol/connect/qualifiedConnectedAccountPersistence';
import { PluginContributionIdentityV1Schema, type PluginContributionIdentityV1 } from '@happier-dev/protocol/plugins/contributionIdentity';
import { DeploymentDomainDnsInputV1Schema } from '@happier-dev/protocol/deployments/deploymentDomainDnsV1';

import { ConnectedAccountPurposeTargetChooser } from '@/components/settings/connectedServices/account/ConnectedAccountPurposeTargetChooser';
import { PluginMark } from '@/components/settings/plugins/PluginMark';
import { EmptyState } from '@/components/ui/empty/EmptyState';
import { useFirstConnection } from './useFirstConnection';
import { FieldItem } from '@/components/ui/forms/FieldItem';
import { FieldTextInput } from '@/components/ui/forms/FieldTextInput';
import { ValueFieldSelect } from '@/components/ui/forms/ValueFieldSelect';
import { SectionActionButton } from '@/components/ui/lists/SectionActionButton';
import { SurfaceStateCard } from '@/components/ui/surfaces/SurfaceStateCard';
import { Text } from '@/components/ui/text/Text';
import { t } from '@/text';

import type { createDeploymentActions } from './deploymentActions';
import { readDeploymentActionError } from './deploymentActionOutcome';

export type DomainIngressInspection = ReturnType<typeof createDeploymentActions>['inspectPlatformTarget'];
type Selection = NonNullable<DeploymentDomainContentV1['ingress']>;
type TunnelOption = Readonly<{ label: string; selection: Selection }>;
type Zone = Readonly<{ zoneId: string; name: string }>;
export type LinkedDomainZoneContext = Readonly<{ credentialRef: QualifiedConnectedAccountRef; accountId: string }>;
type Defaults = Readonly<{ accountId?: string; connector: Readonly<{ imageRef: string; version: string }> }>;
type ZoneRead = Readonly<{ key: string; credentialKey: string; defaults?: Defaults }> & (
  | Readonly<{ kind: 'ready'; zones: readonly Zone[]; dnsRecordAction?: PluginContributionIdentityV1 }>
  | Readonly<{ kind: 'unavailable'; reason: string; remedy: string; diagnosticDetail?: string }>
);
type TunnelRead = Readonly<{ key: string }> & (
  | Readonly<{ kind: 'ready'; options: readonly TunnelOption[] }>
  | Readonly<{ kind: 'unavailable'; reason: string; remedy: string; diagnosticDetail?: string }>
);
const selectionAction = 'happier.deploy.cloudflare/actions/cloudflare-named/selections-read';
const binding = relayAccessProviderDescriptorsById.cloudflareNamed!.homeUi!.credentialBindings![0]!;
const id = 'project-deployments.environment.domains.add.ingress';

/** Read provider-owned choices only on a deliberate press. Input edits retire the old choice locally. */
export function useDeploymentDomainIngressFields(props: Readonly<{
  hostname: string;
  busy: boolean;
  inspect?: DomainIngressInspection;
  enabled: boolean;
  /** Present for Workers: use the runtime Link's credential and select only a zone. */
  linkedZone?: LinkedDomainZoneContext | null;
  /** Select DNS placement for retained provider records, without tunnel configuration. */
  dnsRecordsOnly?: boolean;
}>) {
  const [credentialRef, setCredentialRef] = React.useState<QualifiedConnectedAccountRef | null>(null);
  const [accountId, setAccountId] = React.useState('');
  const [explicitZoneId, setExplicitZoneId] = React.useState('');
  const [zoneChoice, setZoneChoice] = React.useState<string | null>(null);
  const [imageRef, setImageRef] = React.useState('');
  const [version, setVersion] = React.useState('');
  const [zones, setZones] = React.useState<ZoneRead | null>(null);
  const [tunnels, setTunnels] = React.useState<TunnelRead | null>(null);
  const [tunnelChoice, setTunnelChoice] = React.useState<string | null>(null);
  const [reading, setReading] = React.useState<'zones' | 'tunnels' | null>(null);
  const [ttl, setTtl] = React.useState('1');
  // One provider read at a time, owned by this form: Cancel, closing the form, or changing the account or tunnel
  // choice aborts it through the Action's own signal (O-DEPLOY F2). There is no timeout.
  const flight = React.useRef<AbortController | null>(null);
  const [stopped, setStopped] = React.useState<Readonly<{ kind: 'zones' | 'tunnels'; key: string }> | null>(null);
  // A fresh Account has no Cloudflare account yet: the one shared Connect flow adds the first (as platform-link).
  const firstConnection = useFirstConnection(null, props.linkedZone === undefined ? binding.service : null, setCredentialRef);
  const needsConnect = credentialRef === null && firstConnection.missing;
  const zonesOnly = props.linkedZone !== undefined || props.dnsRecordsOnly === true;
  const selectedCredential = props.linkedZone !== undefined ? props.linkedZone?.credentialRef ?? null : credentialRef;
  const selectedAccountId = props.linkedZone !== undefined ? props.linkedZone?.accountId ?? '' : accountId.trim();
  const credentialKey = JSON.stringify(selectedCredential);
  const defaults = zones?.credentialKey === credentialKey ? zones.defaults : undefined;
  const connectorOverride = imageRef.trim() || version.trim() ? {
    imageRef: imageRef.trim() || defaults?.connector.imageRef || '',
    version: version.trim() || defaults?.connector.version || '',
  } : undefined;
  const input = { credentialRef: selectedCredential, hostname: props.hostname,
    ...(selectedAccountId ? { accountId: selectedAccountId } : {}),
    ...(!zonesOnly && connectorOverride ? { connector: connectorOverride } : {}) };
  const zoneKey = JSON.stringify(input);
  const currentZones = zones?.key === zoneKey ? zones : null;
  const explicitZone = currentZones?.kind === 'unavailable' && currentZones.reason === 'zone_list_unavailable';
  const zoneId = explicitZone ? explicitZoneId.trim()
    : currentZones?.kind === 'ready' ? currentZones.zones.find(zone => zone.zoneId === zoneChoice)?.zoneId ?? '' : '';
  const tunnelKey = JSON.stringify({ ...input, zoneId });
  const currentTunnels = tunnels?.key === tunnelKey ? tunnels : null;
  const selected = currentTunnels?.kind === 'ready' && tunnelChoice !== null
    ? currentTunnels.options[Number(tunnelChoice)]?.selection : undefined;
  // A disabled Find zones says what it is waiting for, so it never reads as a read that is stuck.
  const zonesNeed = reading !== null ? null : !selectedCredential ? t('projects.deployments.editors.zonesNeedAccount')
    : !props.hostname ? t('projects.deployments.editors.zonesNeedDomain') : null;
  const stopRead = React.useCallback(() => { flight.current?.abort(); flight.current = null; }, []);
  React.useEffect(() => stopRead, [stopRead, credentialKey, tunnelChoice, props.enabled]);
  const canRead = !!props.inspect && !!selectedCredential && !!props.hostname
    && (zonesOnly || !connectorOverride || !!connectorOverride.imageRef && !!connectorOverride.version) && !props.busy && !reading;
  const inspect = async (kind: 'zones' | 'tunnels', chainedZoneId?: string): Promise<void> => {
    const readZoneId = chainedZoneId ?? zoneId;
    const readTunnelKey = JSON.stringify({ ...input, zoneId: readZoneId });
    if (!props.inspect || !chainedZoneId && !canRead || kind === 'tunnels' && !readZoneId) return;
    stopRead();
    const controller = new AbortController();
    flight.current = controller;
    setStopped(null);
    setReading(kind);
    try {
      const result = await props.inspect(zonesOnly ? 'happier.deploy.cloudflare/actions/workers-domain-zones-read' : selectionAction,
        { ...input, ...(kind === 'tunnels' ? { zoneId: readZoneId } : zonesOnly && explicitZone && explicitZoneId.trim() ? { zoneId: explicitZoneId.trim() } : {}) },
        { signal: controller.signal });
      if (controller.signal.aborted) return;
      const value: unknown = result.ok ? result.value : null;
      const supplied = isRecord(value) && isRecord(value.defaults) ? value.defaults : null;
      const resolvedDefaults: Defaults | undefined = supplied && isRecord(supplied.connector)
        && typeof supplied.connector.imageRef === 'string' && typeof supplied.connector.version === 'string'
        ? { connector: { imageRef: supplied.connector.imageRef, version: supplied.connector.version },
            ...(typeof supplied.accountId === 'string' ? { accountId: supplied.accountId } : {}) } : undefined;
      const metadata = { credentialKey, ...(resolvedDefaults ? { defaults: resolvedDefaults } : {}) };
      const reason = isRecord(value) && value.kind === 'unavailable' && typeof value.reason === 'string'
        ? value.reason : !result.ok ? result.code : 'invalid_provider_output';
      const cause = !result.ok ? result.failureCause : undefined;
      const providerStatus = isRecord(value) && typeof value.providerStatus === 'number' ? value.providerStatus : cause?.httpStatus;
      const diagnosticDetail = providerStatus ? `HTTP ${providerStatus}`
        : cause ? `${cause.phase}: ${cause.errorCode ?? cause.errorClass}` : undefined;
      const unavailable = { kind: 'unavailable' as const, reason,
        remedy: readDeploymentFailureRecoveryV1(reason, result.ok ? value : result.details).remedy,
        ...(diagnosticDetail ? { diagnosticDetail } : {}) };
      if (kind === 'zones') {
        const rows = isRecord(value) && value.kind === 'ready' && Array.isArray(value.zones) ? value.zones : null;
        if (rows && rows.every((zone): zone is Zone => isRecord(zone) && typeof zone.zoneId === 'string' && typeof zone.name === 'string')) {
          const dnsAction = PluginContributionIdentityV1Schema.safeParse(isRecord(value) ? value.dnsRecordAction : undefined);
          setZones({ key: zoneKey, ...metadata, kind: 'ready', zones: rows,
            ...(dnsAction.success ? { dnsRecordAction: dnsAction.data } : {}) });
          // The zone the hostname sits in is the choice; the person picks only when it is not one zone.
          const matched = rows.length === 1 ? rows[0]! : matchingZone(rows, props.hostname);
          setZoneChoice(matched?.zoneId ?? null);
          setTunnels(null);
          setTunnelChoice(null);
          // One press finds the zone and the tunnels in it (TUNNEL-LIVE-1119 "pick the tunnel, the domain, the app").
          if (matched && !zonesOnly) {
            if (flight.current === controller) flight.current = null;
            void inspect('tunnels', matched.zoneId);
            return;
          }
        } else {
          setZones({ key: zoneKey, ...metadata, ...unavailable });
          setZoneChoice(null);
        }
        setTunnels(null);
        setTunnelChoice(null);
      } else {
        const rows = isRecord(value) && value.kind === 'ready' && Array.isArray(value.options) ? value.options : null;
        const options: TunnelOption[] = [];
        let valid = rows !== null;
        for (const row of rows ?? []) {
          if (!isRecord(row) || typeof row.label !== 'string') { valid = false; break; }
          const parsed = AccessProviderSelectionV1Schema.safeParse(row.selection);
          if (!parsed.success) { valid = false; break; }
          options.push({ label: row.label, selection: parsed.data });
        }
        // The provider's own create choice (a tunnel Happier creates and manages) follows the existing ones.
        const create = isRecord(value) && isRecord(value.createOption) && typeof value.createOption.label === 'string'
          ? AccessProviderSelectionV1Schema.safeParse(value.createOption.selection) : null;
        if (valid && create?.success && isRecord(value) && isRecord(value.createOption)) {
          options.push({ label: t('projects.deployments.domainIngressCreateTunnel', { name: String(value.createOption.label) }),
            selection: create.data });
        }
        setTunnels(valid ? { key: readTunnelKey, kind: 'ready', options } : { key: readTunnelKey, ...unavailable });
        setTunnelChoice(valid && options.length === 1 ? '0' : null);
      }
    } catch (error) {
      // A read this form stopped settles as stopped (Retry is offered), never as a provider refusal.
      if (controller.signal.aborted) return;
      const failure = readDeploymentActionError(error);
      const reason = failure.kind === 'refused' ? failure.code : 'unknown_error';
      const unavailable = { kind: 'unavailable' as const, reason,
        remedy: readDeploymentFailureRecoveryV1(reason, failure.kind === 'refused' ? failure.failure?.details : undefined).remedy };
      if (kind === 'zones') {
        setZones({ key: zoneKey, credentialKey, ...unavailable });
        setZoneChoice(null);
      } else {
        setTunnels({ key: readTunnelKey, ...unavailable });
        setTunnelChoice(null);
      }
    } finally {
      if (flight.current === controller) flight.current = null;
      setReading(current => (flight.current === null ? null : current));
    }
  };
  const cancelRead = (kind: 'zones' | 'tunnels') => {
    stopRead();
    setReading(null);
    if (kind === 'zones') setZones(current => current?.kind === 'unavailable' ? null : current);
    else setTunnels(current => current?.kind === 'unavailable' ? null : current);
    setStopped({ kind, key: kind === 'zones' ? zoneKey : tunnelKey });
  };
  /** The loading row with a visible Cancel, then a stopped row with Retry: the shared state-line pattern. */
  const readState = (kind: 'zones' | 'tunnels') => reading === kind ? (
    <SurfaceStateCard testID={`${id}.${kind}.loading`} size="line" kind="loading"
      title={kind === 'zones' ? t('projects.deployments.editors.zonesFinding') : t('projects.deployments.domainIngressRead')}
      action={{ label: t('common.cancel'), testID: `${id}.${kind}.cancel`, onPress: () => cancelRead(kind) }} />
  ) : stopped?.kind === kind && stopped.key === (kind === 'zones' ? zoneKey : tunnelKey) ? (
    <SurfaceStateCard testID={`${id}.${kind}.stopped`} size="line" kind="warning"
      title={t('projects.deployments.editors.readStopped')}
      action={{ label: t('common.retry'), testID: `${id}.${kind}.retry`, onPress: () => { void inspect(kind); } }} />
  ) : null;
  const selectedZone = currentZones?.kind === 'ready' ? currentZones.zones.find(zone => zone.zoneId === zoneId) : undefined;
  const dns = DeploymentDomainDnsInputV1Schema.shape.dns.safeParse(props.dnsRecordsOnly && selectedZone && currentZones?.kind === 'ready'
    ? { action: currentZones.dnsRecordAction, credentialRef: selectedCredential, zoneId: selectedZone.zoneId, ttl: Number(ttl) } : undefined);
  // The connector's overrides (Cloudflare Account ID, image, version) have defaults: the form shows them in its one
  // Advanced section rather than a second Advanced here (round 10, TUNNEL-LIVE-1119 friction list).
  const advancedFields = props.enabled && !zonesOnly && props.linkedZone === undefined ? <>
      <FieldItem label={t('projects.deployments.domainIngressAccountId')}>
        <FieldTextInput testID={`${id}.accountId`} value={accountId || defaults?.accountId || ''} onChangeText={setAccountId}
          accessibilityLabel={t('projects.deployments.domainIngressAccountId')} autoCapitalize="none" editable={!props.busy} monospace />
      </FieldItem>
      <FieldItem label={t('projects.deployments.domainIngressImage')} supportingText={t('projects.deployments.domainIngressConnectorHint')}>
        <FieldTextInput testID={`${id}.imageRef`} value={imageRef || defaults?.connector.imageRef || ''} onChangeText={setImageRef}
          accessibilityLabel={t('projects.deployments.domainIngressImage')} autoCapitalize="none" editable={!props.busy} monospace />
      </FieldItem>
      <FieldItem label={t('projects.deployments.domainIngressVersion')}>
        <FieldTextInput testID={`${id}.version`} value={version || defaults?.connector.version || ''} onChangeText={setVersion}
          accessibilityLabel={t('projects.deployments.domainIngressVersion')} autoCapitalize="none" editable={!props.busy} monospace />
      </FieldItem>
  </> : null;
  return { advancedFields, selection: props.enabled ? selected : undefined, zone: props.enabled && zonesOnly ? selectedZone : undefined,
    dns: props.enabled && dns.success ? dns.data : undefined, fields: props.enabled ? (
    <View style={styles.fields}>
      {props.linkedZone === undefined ? <>
      {needsConnect ? <EmptyState testID={`${id}.connect`} layout="centered"
        icon={<PluginMark title="Cloudflare" pluginId={binding.service.pluginId} />}
        title={t('projects.deployments.editors.domainConnectTitle')}
        subtitle={t('projects.deployments.editors.domainConnectBody')}
        primaryAction={{ label: t('projects.deployments.editors.domainConnectAction'), onPress: firstConnection.connect,
          testID: `${id}.connect.add` }} /> : <ConnectedAccountPurposeTargetChooser
        testID={`${id}.account`}
        localizedTextPluginId={binding.service.pluginId}
        declaration={{ purpose: props.dnsRecordsOnly ? 'deploy.manage' : binding.purpose, service: binding.service, required: true }}
        value={credentialRef ? { kind: 'account', account: credentialRef } : null}
        onChange={target => setCredentialRef(target?.kind === 'account' ? target.account : null)}
        accountsOnly
        disabled={props.busy}
      />}
      </> : null}
      {props.dnsRecordsOnly ? <FieldItem label={t('projects.deployments.domainDnsTtl')}>
        <FieldTextInput testID={`${id}.ttl`} value={ttl} onChangeText={setTtl}
          accessibilityLabel={t('projects.deployments.domainDnsTtl')} keyboardType="number-pad" editable={!props.busy} />
      </FieldItem> : null}
      {/* A search, not a refresh glyph: a disabled refresh arrow reads as a stuck spinner (JOURNEY-OPUS-88 F2). */}
      <SectionActionButton testID={`${id}.zones.read`} title={t('projects.deployments.domainIngressReadZones')}
        icon="magnifying-glass" onPress={() => { void inspect('zones'); }} disabled={!canRead} loading={reading === 'zones'} />
      {zonesNeed ? (
        <Text testID={`${id}.zones.needs`} variant="meta" style={styles.needs}>{zonesNeed}</Text>
      ) : null}
      {readState('zones')}
      {currentZones?.kind === 'ready' ? (
        <FieldItem label={t('projects.deployments.domainIngressZone')}>
          <ValueFieldSelect testID={`${id}.zone`} label={t('projects.deployments.domainIngressZone')}
            items={currentZones.zones.map(zone => ({ id: zone.zoneId, title: zone.name }))} selectedId={zoneId || null}
            onSelect={setZoneChoice} placeholder={t('projects.deployments.domainIngressChooseZone')}
            disabled={props.busy || currentZones.zones.length === 0} />
          {currentZones.zones.length === 0 ? <Text>{t('projects.deployments.domainIngressZonesEmpty')}</Text> : null}
        </FieldItem>
      ) : explicitZone ? (
        <FieldItem label={t('projects.deployments.domainIngressZoneId')} supportingText={currentZones.remedy}>
          <FieldTextInput testID={`${id}.zoneId`} value={explicitZoneId} onChangeText={setExplicitZoneId}
            accessibilityLabel={t('projects.deployments.domainIngressZoneId')} autoCapitalize="none" editable={!props.busy} monospace />
        </FieldItem>
      ) : currentZones?.kind === 'unavailable' && reading !== 'zones' ? <SurfaceStateCard testID={`${id}.zones.error`} size="line" kind="error"
        title={currentZones.remedy} diagnosticCode={currentZones.reason} diagnosticDetail={currentZones.diagnosticDetail}
        action={{ label: t('common.retry'), testID: `${id}.zones.retry`, onPress: () => { void inspect('zones'); } }} /> : null}
      {!zonesOnly && zoneId ? (
        <SectionActionButton testID={`${id}.read`} title={t('projects.deployments.domainIngressRead')}
          icon="arrow-clockwise" onPress={() => { void inspect('tunnels'); }} disabled={!canRead} loading={reading === 'tunnels'} />
      ) : null}
      {!zonesOnly && zoneId ? readState('tunnels') : null}
      {!zonesOnly && currentTunnels?.kind === 'ready' ? (
        <FieldItem label={t('projects.deployments.domainIngressTunnel')}>
          <ValueFieldSelect testID={`${id}.tunnel`} label={t('projects.deployments.domainIngressTunnel')}
            items={currentTunnels.options.map((option, index) => ({ id: String(index), title: option.label }))}
            selectedId={tunnelChoice} onSelect={setTunnelChoice} placeholder={t('projects.deployments.domainIngressChoose')}
            disabled={props.busy || currentTunnels.options.length === 0} />
          {currentTunnels.options.length === 0 ? <Text>{t('projects.deployments.domainIngressEmpty')}</Text> : null}
        </FieldItem>
      ) : !zonesOnly && currentTunnels?.kind === 'unavailable' && reading !== 'tunnels' ? <SurfaceStateCard testID={`${id}.tunnels.error`} size="line" kind="error"
        title={currentTunnels.remedy} diagnosticCode={currentTunnels.reason} diagnosticDetail={currentTunnels.diagnosticDetail}
        action={{ label: t('common.retry'), testID: `${id}.tunnels.retry`, onPress: () => { void inspect('tunnels'); } }} /> : null}
    </View>
  ) : null };
}

/** The longest zone the hostname is, or sits under; none when the hostname names no listed zone. */
function matchingZone(zones: readonly Zone[], hostname: string): Zone | undefined {
  const host = hostname.toLowerCase();
  return zones.filter(zone => host === zone.name.toLowerCase() || host.endsWith(`.${zone.name.toLowerCase()}`))
    .sort((a, b) => b.name.length - a.name.length)[0];
}

const styles = StyleSheet.create(theme => ({
  fields: { gap: theme.space.s12 },
  needs: { color: theme.colors.text.secondary, textAlign: 'center' },
}));
