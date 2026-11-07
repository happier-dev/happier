import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';
import { relayAccessProviderDescriptorsById } from '@happier-dev/cli-common/relayAccess/catalog';
import type { DeploymentDomainContentV1 } from '@happier-dev/deployment-protocol/v1';
import { isRecord } from '@happier-dev/protocol/common/records';
import { AccessProviderSelectionV1Schema } from '@happier-dev/protocol/plugins/contributions/accessProviders';
import type { QualifiedConnectedAccountRef } from '@happier-dev/protocol/connect/qualifiedConnectedAccountPersistence';

import { ConnectedAccountPurposeTargetChooser } from '@/components/settings/connectedServices/account/ConnectedAccountPurposeTargetChooser';
import { FieldItem } from '@/components/ui/forms/FieldItem';
import { FieldTextInput } from '@/components/ui/forms/FieldTextInput';
import { ValueFieldSelect } from '@/components/ui/forms/ValueFieldSelect';
import { SectionActionButton } from '@/components/ui/lists/SectionActionButton';
import { Text } from '@/components/ui/text/Text';
import { t } from '@/text';

import type { createDeploymentActions } from './deploymentActions';

export type DomainIngressInspection = ReturnType<typeof createDeploymentActions>['inspectPlatformTarget'];
type Selection = NonNullable<DeploymentDomainContentV1['ingress']>;
type TunnelOption = Readonly<{ label: string; selection: Selection }>;
type Zone = Readonly<{ zoneId: string; name: string }>;
type ZoneRead = Readonly<{ key: string }> & (
  | Readonly<{ kind: 'ready'; zones: readonly Zone[] }>
  | Readonly<{ kind: 'unavailable'; reason: string }>
);
type TunnelRead = Readonly<{ key: string }> & (
  | Readonly<{ kind: 'ready'; options: readonly TunnelOption[] }>
  | Readonly<{ kind: 'unavailable'; reason: string }>
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
  const input = { credentialRef, accountId: accountId.trim(), hostname: props.hostname,
    connector: { imageRef: imageRef.trim(), version: version.trim() } };
  const zoneKey = JSON.stringify(input);
  const currentZones = zones?.key === zoneKey ? zones : null;
  const explicitZone = currentZones?.kind === 'unavailable' && currentZones.reason === 'zone_list_unavailable';
  const zoneId = explicitZone ? explicitZoneId.trim()
    : currentZones?.kind === 'ready' ? currentZones.zones.find(zone => zone.zoneId === zoneChoice)?.zoneId ?? '' : '';
  const tunnelKey = JSON.stringify({ ...input, zoneId });
  const currentTunnels = tunnels?.key === tunnelKey ? tunnels : null;
  const selected = currentTunnels?.kind === 'ready' && tunnelChoice !== null
    ? currentTunnels.options[Number(tunnelChoice)]?.selection : undefined;
  const canRead = !!props.inspect && !!credentialRef && !!input.accountId && !!props.hostname
    && !!input.connector.imageRef && !!input.connector.version && !props.busy && !reading;
  const inspect = async (kind: 'zones' | 'tunnels') => {
    if (!canRead || !props.inspect || kind === 'tunnels' && !zoneId) return;
    setReading(kind);
    try {
      const result = await props.inspect(selectionAction, { ...input, ...(kind === 'tunnels' ? { zoneId } : {}) });
      const value: unknown = result.ok ? result.value : null;
      const reason = isRecord(value) && value.kind === 'unavailable' && typeof value.reason === 'string'
        ? value.reason : !result.ok ? result.code : 'invalid_provider_output';
      if (kind === 'zones') {
        const rows = isRecord(value) && value.kind === 'ready' && Array.isArray(value.zones) ? value.zones : null;
        if (rows && rows.every((zone): zone is Zone => isRecord(zone) && typeof zone.zoneId === 'string' && typeof zone.name === 'string')) {
          setZones({ key: zoneKey, kind: 'ready', zones: rows });
          setZoneChoice(rows.length === 1 ? rows[0]!.zoneId : null);
        } else {
          setZones({ key: zoneKey, kind: 'unavailable', reason });
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
        setTunnels(valid ? { key: tunnelKey, kind: 'ready', options } : { key: tunnelKey, kind: 'unavailable', reason });
        setTunnelChoice(valid && options.length === 1 ? '0' : null);
      }
    } catch {
      if (kind === 'zones') {
        setZones({ key: zoneKey, kind: 'unavailable', reason: 'provider_unavailable' });
        setZoneChoice(null);
      } else {
        setTunnels({ key: tunnelKey, kind: 'unavailable', reason: 'provider_unavailable' });
        setTunnelChoice(null);
      }
    } finally { setReading(null); }
  };
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
      <FieldItem label={t('projects.deployments.domainIngressAccountId')}>
        <FieldTextInput testID={`${id}.accountId`} value={accountId} onChangeText={setAccountId}
          accessibilityLabel={t('projects.deployments.domainIngressAccountId')} autoCapitalize="none" editable={!props.busy} monospace />
      </FieldItem>
      <FieldItem label={t('projects.deployments.domainIngressImage')} supportingText={t('projects.deployments.domainIngressConnectorHint')}>
        <FieldTextInput testID={`${id}.imageRef`} value={imageRef} onChangeText={setImageRef}
          accessibilityLabel={t('projects.deployments.domainIngressImage')} autoCapitalize="none" editable={!props.busy} monospace />
      </FieldItem>
      <FieldItem label={t('projects.deployments.domainIngressVersion')}>
        <FieldTextInput testID={`${id}.version`} value={version} onChangeText={setVersion}
          accessibilityLabel={t('projects.deployments.domainIngressVersion')} autoCapitalize="none" editable={!props.busy} monospace />
      </FieldItem>
      <SectionActionButton testID={`${id}.zones.read`} title={t('projects.deployments.domainIngressReadZones')}
        icon="arrow-clockwise" onPress={() => { void inspect('zones'); }} disabled={!canRead} loading={reading === 'zones'} />
      {currentZones?.kind === 'ready' ? (
        <FieldItem label={t('projects.deployments.domainIngressZone')}>
          <ValueFieldSelect testID={`${id}.zone`} label={t('projects.deployments.domainIngressZone')}
            items={currentZones.zones.map(zone => ({ id: zone.zoneId, title: zone.name }))} selectedId={zoneId || null}
            onSelect={setZoneChoice} placeholder={t('projects.deployments.domainIngressChooseZone')}
            disabled={props.busy || currentZones.zones.length === 0} />
          {currentZones.zones.length === 0 ? <Text>{t('projects.deployments.domainIngressZonesEmpty')}</Text> : null}
        </FieldItem>
      ) : explicitZone ? (
        <FieldItem label={t('projects.deployments.domainIngressZoneId')} supportingText={t('projects.deployments.domainIngressZoneHint')}>
          <FieldTextInput testID={`${id}.zoneId`} value={explicitZoneId} onChangeText={setExplicitZoneId}
            accessibilityLabel={t('projects.deployments.domainIngressZoneId')} autoCapitalize="none" editable={!props.busy} monospace />
        </FieldItem>
      ) : currentZones?.kind === 'unavailable' ? <Text accessibilityRole="alert">{t('projects.deployments.domainIngressZonesUnavailable')}</Text> : null}
      {zoneId ? (
        <SectionActionButton testID={`${id}.read`} title={t('projects.deployments.domainIngressRead')}
          icon="arrow-clockwise" onPress={() => { void inspect('tunnels'); }} disabled={!canRead} loading={reading === 'tunnels'} />
      ) : null}
      {currentTunnels?.kind === 'ready' ? (
        <FieldItem label={t('projects.deployments.domainIngressTunnel')}>
          <ValueFieldSelect testID={`${id}.tunnel`} label={t('projects.deployments.domainIngressTunnel')}
            items={currentTunnels.options.map((option, index) => ({ id: String(index), title: option.label }))}
            selectedId={tunnelChoice} onSelect={setTunnelChoice} placeholder={t('projects.deployments.domainIngressChoose')}
            disabled={props.busy || currentTunnels.options.length === 0} />
          {currentTunnels.options.length === 0 ? <Text>{t('projects.deployments.domainIngressEmpty')}</Text> : null}
        </FieldItem>
      ) : currentTunnels?.kind === 'unavailable' ? <Text accessibilityRole="alert">{t('projects.deployments.domainIngressUnavailable')}</Text> : null}
    </View>
  ) : null };
}

const styles = StyleSheet.create(theme => ({ fields: { gap: theme.space.s12 } }));
