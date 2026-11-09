import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';
import { relayAccessProviderDescriptorsById } from '@happier-dev/cli-common/relayAccess/catalog';
import type { DeploymentDomainContentV1 } from '@happier-dev/deployment-protocol/v1';
import { isRecord } from '@happier-dev/protocol/common/records';
import { readDeploymentFailureRecoveryV1 } from '@happier-dev/protocol/deployments/deploymentFailureRecoveryV1';
import { AccessProviderSelectionV1Schema } from '@happier-dev/protocol/plugins/contributions/accessProviders';
import type { QualifiedConnectedAccountRef } from '@happier-dev/protocol/connect/qualifiedConnectedAccountPersistence';

import { ConnectedAccountPurposeTargetChooser } from '@/components/settings/connectedServices/account/ConnectedAccountPurposeTargetChooser';
import { FieldItem } from '@/components/ui/forms/FieldItem';
import { FieldTextInput } from '@/components/ui/forms/FieldTextInput';
import { ValueFieldSelect } from '@/components/ui/forms/ValueFieldSelect';
import { ExpandableItem } from '@/components/ui/lists/ExpandableItem';
import { Item } from '@/components/ui/lists/Item';
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
type Defaults = Readonly<{ accountId?: string; connector: Readonly<{ imageRef: string; version: string }> }>;
type ZoneRead = Readonly<{ key: string; credentialKey: string; defaults?: Defaults }> & (
  | Readonly<{ kind: 'ready'; zones: readonly Zone[] }>
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
  const [advanced, setAdvanced] = React.useState(false);
  // One provider read at a time, owned by this form: Cancel, closing the form, or changing the account or tunnel
  // choice aborts it through the Action's own signal (O-DEPLOY F2). There is no timeout.
  const flight = React.useRef<AbortController | null>(null);
  const [stopped, setStopped] = React.useState<Readonly<{ kind: 'zones' | 'tunnels'; key: string }> | null>(null);
  const credentialKey = JSON.stringify(credentialRef);
  const defaults = zones?.credentialKey === credentialKey ? zones.defaults : undefined;
  const connectorOverride = imageRef.trim() || version.trim() ? {
    imageRef: imageRef.trim() || defaults?.connector.imageRef || '',
    version: version.trim() || defaults?.connector.version || '',
  } : undefined;
  const input = { credentialRef, hostname: props.hostname,
    ...(accountId.trim() ? { accountId: accountId.trim() } : {}),
    ...(connectorOverride ? { connector: connectorOverride } : {}) };
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
  const zonesNeed = reading !== null ? null : !credentialRef ? t('projects.deployments.editors.zonesNeedAccount')
    : !props.hostname ? t('projects.deployments.editors.zonesNeedDomain') : null;
  const stopRead = React.useCallback(() => { flight.current?.abort(); flight.current = null; }, []);
  React.useEffect(() => stopRead, [stopRead, credentialKey, tunnelChoice, props.enabled]);
  const canRead = !!props.inspect && !!credentialRef && !!props.hostname
    && (!connectorOverride || !!connectorOverride.imageRef && !!connectorOverride.version) && !props.busy && !reading;
  const inspect = async (kind: 'zones' | 'tunnels') => {
    if (!canRead || !props.inspect || kind === 'tunnels' && !zoneId) return;
    stopRead();
    const controller = new AbortController();
    flight.current = controller;
    setStopped(null);
    setReading(kind);
    try {
      const result = await props.inspect(selectionAction, { ...input, ...(kind === 'tunnels' ? { zoneId } : {}) },
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
          setZones({ key: zoneKey, ...metadata, kind: 'ready', zones: rows });
          setZoneChoice(rows.length === 1 ? rows[0]!.zoneId : null);
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
        setTunnels(valid ? { key: tunnelKey, kind: 'ready', options } : { key: tunnelKey, ...unavailable });
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
        setTunnels({ key: tunnelKey, ...unavailable });
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
  return { selection: props.enabled ? selected : undefined, fields: props.enabled ? (
    <View style={styles.fields}>
      <ConnectedAccountPurposeTargetChooser
        testID={`${id}.account`}
        localizedTextPluginId={binding.service.pluginId}
        declaration={{ purpose: binding.purpose, service: binding.service, required: true }}
        value={credentialRef ? { kind: 'account', account: credentialRef } : null}
        onChange={target => setCredentialRef(target?.kind === 'account' ? target.account : null)}
        accountsOnly
        disabled={props.busy}
      />
      <ExpandableItem testID={`${id}.advanced`} expanded={advanced} onExpandedChange={setAdvanced}
        header={state => <Item testID={`${id}.advanced.header`} {...state.headerProps}
          title={t('projects.deployments.domainIngressAdvanced')} />}
      >
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
      </ExpandableItem>
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
      {zoneId ? (
        <SectionActionButton testID={`${id}.read`} title={t('projects.deployments.domainIngressRead')}
          icon="arrow-clockwise" onPress={() => { void inspect('tunnels'); }} disabled={!canRead} loading={reading === 'tunnels'} />
      ) : null}
      {zoneId ? readState('tunnels') : null}
      {currentTunnels?.kind === 'ready' ? (
        <FieldItem label={t('projects.deployments.domainIngressTunnel')}>
          <ValueFieldSelect testID={`${id}.tunnel`} label={t('projects.deployments.domainIngressTunnel')}
            items={currentTunnels.options.map((option, index) => ({ id: String(index), title: option.label }))}
            selectedId={tunnelChoice} onSelect={setTunnelChoice} placeholder={t('projects.deployments.domainIngressChoose')}
            disabled={props.busy || currentTunnels.options.length === 0} />
          {currentTunnels.options.length === 0 ? <Text>{t('projects.deployments.domainIngressEmpty')}</Text> : null}
        </FieldItem>
      ) : currentTunnels?.kind === 'unavailable' && reading !== 'tunnels' ? <SurfaceStateCard testID={`${id}.tunnels.error`} size="line" kind="error"
        title={currentTunnels.remedy} diagnosticCode={currentTunnels.reason} diagnosticDetail={currentTunnels.diagnosticDetail}
        action={{ label: t('common.retry'), testID: `${id}.tunnels.retry`, onPress: () => { void inspect('tunnels'); } }} /> : null}
    </View>
  ) : null };
}

const styles = StyleSheet.create(theme => ({
  fields: { gap: theme.space.s12 },
  needs: { color: theme.colors.text.secondary, textAlign: 'center' },
}));
