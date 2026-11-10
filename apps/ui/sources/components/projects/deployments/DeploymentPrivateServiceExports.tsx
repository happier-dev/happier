import * as React from 'react';
import { View } from 'react-native';
import type { DeploymentEnvironmentReadDetailV1 } from '@happier-dev/deployments';
import { MachinePrivateNetworkObservationV1Schema, type MachinePrivateNetworkObservationV1 } from '@happier-dev/protocol/plugins/contributions/accessProviders';
import { FieldItem } from '@/components/ui/forms/FieldItem';
import { FieldTextInput } from '@/components/ui/forms/FieldTextInput';
import { ValueFieldSelect } from '@/components/ui/forms/ValueFieldSelect';
import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { SectionActionButton } from '@/components/ui/lists/SectionActionButton';
import { ListPresentationProvider } from '@/components/ui/lists/listPresentation';
import { RoundButton } from '@/components/ui/buttons/RoundButton';
import { SurfaceStateCard } from '@/components/ui/surfaces/SurfaceStateCard';
import { ModalCardFooterActions } from '@/modal/components/card/ModalCardFooterActions';
import type { CustomModalInjectedProps } from '@/modal/types';
import type { Machine } from '@/sync/domains/state/storageTypes';
import { useServerScopedMachine } from '@/sync/store/hooks';
import { t } from '@/text';
import type { DeploymentEnvironmentEditing } from './DeploymentEnvironmentSettingsPanel';
import { useDeploymentChangePress } from './deploymentActionOutcome';
import { deploymentActionRefusalRemedy } from './deploymentPresentation';
import { deploymentSheetStyles, showDeploymentSheet } from './deploymentSheet';
import { buildPrivateServiceExportPatch, listPrivateServiceExportServices, privateServiceExportAuthoring,
  type PrivateServiceExportAuthoring } from './privateServiceExport';

const id = 'project-deployments.environment.privateSharing';
const readPrivateNetworks = (machine: Machine | null): unknown => machine?.daemonState?.reachability?.privateNetworks;

/** Settings owns service publication authoring; Connect consumes only the saved exports. */
export function DeploymentPrivateServiceExports(props: Readonly<{
  detail: DeploymentEnvironmentReadDetailV1;
  editing: DeploymentEnvironmentEditing | null;
}>) {
  const exports = props.detail.content.ownServer?.serviceExports ?? [];
  const editing = props.editing;
  const authoring = privateServiceExportAuthoring(props.detail, editing !== null);
  const open = () => {
    if (!editing || authoring.kind !== 'ready') return;
    showDeploymentSheet({ component: PrivateServiceExportSheet,
      props: { detail: props.detail, editing, machineIds: authoring.machineIds },
      title: t('projects.deployments.settingsSections.privateSharingAdd'), testID: `${id}.modal` });
  };
  return <ItemGroup testID={id} title={t('projects.deployments.settingsSections.privateSharingTitle')}
    description={t('projects.deployments.settingsSections.privateSharingBody')}
    action={authoring.kind === 'ready' ? <SectionActionButton testID={`${id}.add`}
      title={t('projects.deployments.settingsSections.privateSharingAdd')} onPress={open} /> : undefined}>
    {exports.map(entry => <Item key={entry.key} testID={`${id}.export:${entry.key}`} title={entry.key}
      subtitle={`${entry.service}:${entry.containerPort}`} detail={entry.privateNetwork ?? t(entry.exposure === 'public'
        ? 'projects.deployments.databasePublic' : 'projects.deployments.databaseInternal')} mode="info" />)}
    {authoring.kind === 'unavailable' && privateServiceExportUnavailableReason(authoring.reason)
      ? <Item testID={`${id}.${authoring.reason}`} title={privateServiceExportUnavailableReason(authoring.reason)!} mode="info" /> : null}
  </ItemGroup>;
}

/**
 * Why this Environment cannot share a service from Settings, and what to do instead, said once for every surface that
 * consumes `privateServiceExportAuthoring` (Settings › Private sharing, the Database page). A viewer who cannot edit
 * gets no reason: there is nothing for them to do.
 */
export function privateServiceExportUnavailableReason(
  reason: Extract<PrivateServiceExportAuthoring, { kind: 'unavailable' }>['reason'],
): string | null {
  switch (reason) {
    case 'repository': return t('projects.deployments.settingsSections.privateSharingRepository');
    case 'unsupported': return t('projects.deployments.settingsSections.privateSharingUnsupported');
    case 'machineMissing': return t('projects.deployments.settingsSections.privateSharingNetworkMissing');
    case 'multipleMachines': return t('projects.deployments.settingsSections.privateSharingMultipleMachines');
    case 'readOnly': return null;
  }
}

type SheetInput = Readonly<{
  detail: DeploymentEnvironmentReadDetailV1;
  editing: DeploymentEnvironmentEditing;
  machineIds: readonly string[];
}>;

function PrivateServiceExportSheet(props: SheetInput & CustomModalInjectedProps) {
  const rawNetworks = useServerScopedMachine(props.editing.serverId, props.machineIds[0] ?? null, readPrivateNetworks);
  const networks = React.useMemo(() => !Array.isArray(rawNetworks) ? [] : rawNetworks.flatMap(value => {
    const parsed = MachinePrivateNetworkObservationV1Schema.safeParse(value);
    return parsed.success && parsed.data.state === 'ready' && parsed.data.networkIdentity && parsed.data.addresses.length > 0
      ? [parsed.data] : [];
  }), [rawNetworks]);
  const services = React.useMemo(() => listPrivateServiceExportServices(props.detail.content), [props.detail.content]);
  const [service, setService] = React.useState(services[0] ?? '');
  const [key, setKey] = React.useState(services[0] ?? '');
  const [containerPort, setContainerPort] = React.useState('');
  const [scheme, setScheme] = React.useState('');
  const [networkIdentity, setNetworkIdentity] = React.useState<string | null>(null);
  const [address, setAddress] = React.useState<string | null>(null);
  const [hostPort, setHostPort] = React.useState('');
  const [reviewed, setReviewed] = React.useState<Readonly<{ patch: ReturnType<typeof buildPrivateServiceExportPatch>;
    hostAddress: string; networkName: string }> | null>(null);
  const [invalid, setInvalid] = React.useState(false);
  const selectedNetwork: MachinePrivateNetworkObservationV1 | undefined = networkIdentity === null ? networks[0]
    : networks.find(network => network.networkIdentity === networkIdentity);
  const hostAddress = address ?? selectedNetwork?.addresses[0] ?? null;
  const { onClose, editing, setChrome } = props;
  const change = useDeploymentChangePress({ request: artifactId => { onClose(); editing.review.request(artifactId); } }, () => {
    editing.onChanged(); onClose();
  });
  const canReview = Boolean(service && key.trim() && scheme.trim() && containerPort && hostPort && selectedNetwork && hostAddress);
  const prepare = () => {
    if (!selectedNetwork?.networkIdentity || !hostAddress || !selectedNetwork.addresses.includes(hostAddress)) return null;
    return buildPrivateServiceExportPatch(props.detail.content, { key: key.trim(), service,
      containerPort: Number(containerPort), scheme: scheme.trim(), privateNetwork: selectedNetwork.networkIdentity,
      hostAddress, hostPort: Number(hostPort) });
  };
  const review = () => {
    try { const patch = prepare(); if (!patch || !hostAddress || !selectedNetwork?.networkIdentity) return;
      setInvalid(false); setReviewed({ patch, hostAddress, networkName: selectedNetwork.displayName ?? selectedNetwork.networkIdentity });
    } catch { setInvalid(true); }
  };
  const save = () => {
    void change.press(async () => {
      if (!reviewed) return { ok: false, error: 'invalid_parameters' };
      return editing.actions.updateEnvironment(props.detail.environment, reviewed.patch);
    });
  };
  const footer = <ModalCardFooterActions cancel={{ onPress: onClose, disabled: change.running }}>
    {reviewed ? <>
      <RoundButton testID={`${id}.edit`} title={t('common.back')} size="normal" display="inverted"
        disabled={change.running} onPress={() => setReviewed(null)} />
      <RoundButton testID={`${id}.save`} title={t('common.save')} size="normal" disabled={change.running}
        loading={change.running} onPress={save} />
    </> : networks.length > 0 && services.length > 0 ? <RoundButton testID={`${id}.review`}
      title={t('projects.deployments.settingsSections.privateSharingReview')}
      size="normal" disabled={!canReview} onPress={review} /> : null}
  </ModalCardFooterActions>;
  React.useEffect(() => { setChrome?.({ kind: 'card', footer }); });
  React.useEffect(() => () => setChrome?.(null), [setChrome]);
  const field = (name: 'key' | 'containerPort' | 'scheme' | 'hostPort', label: string, value: string, onChangeText: (value: string) => void) =>
    <FieldItem label={label}><FieldTextInput testID={`${id}.${name}`} accessibilityLabel={label} value={value}
      onChangeText={onChangeText} autoCapitalize="none" autoCorrect={false}
      {...(name === 'containerPort' || name === 'hostPort' ? { keyboardType: 'number-pad' as const } : {})} /></FieldItem>;
  return <ListPresentationProvider value="page" pageInsets="contained"><View style={deploymentSheetStyles.body}>
    {reviewed ? <ItemGroup title={t('projects.deployments.settingsSections.privateSharingReview')}
      description={t('projects.deployments.settingsSections.privateSharingReviewBody')}>
      <Item title={t('projects.deployments.settingsSections.privateSharingService')} detail={`${service}:${containerPort}`} mode="info" />
      <Item title={t('projects.deployments.settingsSections.privateSharingKey')} detail={key} mode="info" />
      <Item title={t('projects.deployments.settingsSections.privateSharingScheme')} detail={scheme} mode="info" />
      <Item title={t('projects.deployments.settingsSections.privateSharingNetwork')}
        detail={reviewed.networkName} mode="info" />
      <Item testID={`${id}.reviewAddress`} title={t('projects.deployments.settingsSections.privateSharingAddress')}
        detail={reviewed.hostAddress} mode="info" />
      <Item testID={`${id}.reviewHostPort`} title={t('projects.deployments.settingsSections.privateSharingHostPort')}
        detail={hostPort} mode="info" />
    </ItemGroup> : <>
      {networks.length === 0 ? <SurfaceStateCard testID={`${id}.networkMissing`} size="line" kind="unavailable"
        title={t('projects.deployments.settingsSections.privateSharingNetworkMissing')} />
        : services.length === 0 ? <SurfaceStateCard size="line" kind="unavailable"
          title={t('projects.deployments.settingsSections.privateSharingInvalid')} /> : <>
      <FieldItem label={t('projects.deployments.settingsSections.privateSharingService')}><ValueFieldSelect testID={`${id}.service`}
        label={t('projects.deployments.settingsSections.privateSharingService')} items={services.map(value => ({ id: value, title: value }))}
        selectedId={service} onSelect={value => { setService(value); setKey(value); }} fill /></FieldItem>
      {field('key', t('projects.deployments.settingsSections.privateSharingKey'), key, setKey)}
      {field('containerPort', t('projects.deployments.settingsSections.privateSharingPort'), containerPort, setContainerPort)}
      {field('scheme', t('projects.deployments.settingsSections.privateSharingScheme'), scheme, setScheme)}
        <FieldItem label={t('projects.deployments.settingsSections.privateSharingNetwork')}><ValueFieldSelect testID={`${id}.network`}
          label={t('projects.deployments.settingsSections.privateSharingNetwork')}
          items={networks.map(network => ({ id: network.networkIdentity!, title: network.displayName ?? network.networkIdentity! }))}
          selectedId={selectedNetwork?.networkIdentity ?? null} onSelect={value => { setNetworkIdentity(value); setAddress(null); }} fill /></FieldItem>
        <FieldItem label={t('projects.deployments.settingsSections.privateSharingAddress')}><ValueFieldSelect testID={`${id}.address`}
          label={t('projects.deployments.settingsSections.privateSharingAddress')}
          items={(selectedNetwork?.addresses ?? []).map(value => ({ id: value, title: value }))} selectedId={hostAddress} onSelect={setAddress} fill /></FieldItem>
      {field('hostPort', t('projects.deployments.settingsSections.privateSharingHostPort'), hostPort, setHostPort)}
      </>}
    </>}
    {invalid ? <SurfaceStateCard testID={`${id}.invalid`} size="line" kind="error"
      title={t('projects.deployments.settingsSections.privateSharingInvalid')} /> : null}
    {change.outcome?.kind === 'refused' ? <SurfaceStateCard testID={`${id}.refused`} size="line" kind="error"
      title={deploymentActionRefusalRemedy(change.outcome.code)} diagnosticCode={change.outcome.code} /> : null}
    {setChrome ? null : footer}
  </View></ListPresentationProvider>;
}
