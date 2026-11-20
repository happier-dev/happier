import * as React from 'react';
import { readDeploymentComposeServiceFacts } from './deploymentPreflightWarnings';
import { View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';
import type { DeploymentEnvironmentReadDetailV1 } from '@happier-dev/deployments';
import { MachinePrivateNetworkObservationV1Schema, type MachinePrivateNetworkObservationV1 } from '@happier-dev/protocol/plugins/contributions/accessProviders';
import { FieldItem } from '@/components/ui/forms/FieldItem';
import { FieldTextInput } from '@/components/ui/forms/FieldTextInput';
import { SelectionTiles } from '@/components/ui/forms/SelectionTiles';
import { ValueFieldSelect } from '@/components/ui/forms/ValueFieldSelect';
import { ExpandableItem } from '@/components/ui/lists/ExpandableItem';
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
import { Text } from '@/components/ui/text/Text';
import { TextLinkButton } from '@/components/ui/buttons/TextLinkButton';
import { useRouter } from '@/components/appShell/workspace/destinationRoute';
import { deploymentEnvironmentRoute } from './deploymentNavigation';
import type { VariableReferenceEnvironments } from './DeploymentVariablesPanel';
import { buildPrivateServiceExportPatch, listPrivateServiceExportServices, privateServiceExportAuthoring,
  readPrivateServiceSharingScheme, type PrivateServiceExportAuthoring, type PrivateServiceExportReach } from './privateServiceExport';

const id = 'project-deployments.environment.privateSharing';
const readPrivateNetworks = (machine: Machine | null): unknown => machine?.daemonState?.reachability?.privateNetworks;
const HAPPIER_NETWORK = 'happierNetwork';
const networkReachId = (network: MachinePrivateNetworkObservationV1): string => `network:${network.networkIdentity}`;
type ServiceExport = NonNullable<NonNullable<DeploymentEnvironmentReadDetailV1['content']['ownServer']>['serviceExports']>[number];

/** What reaches a saved export, said the same way wherever exports are listed. */
export function privateServiceExportReachLabel(entry: ServiceExport): string {
  if (entry.transport?.kind === 'iroh') return t('projects.deployments.settingsSections.privateSharingHappierNetwork');
  return entry.privateNetwork ?? t(entry.exposure === 'public' ? 'projects.deployments.databasePublic' : 'projects.deployments.databaseInternal');
}

/** Settings owns service publication authoring; Connect consumes only the saved exports. */
export function DeploymentPrivateServiceExports(props: Readonly<{
  detail: DeploymentEnvironmentReadDetailV1;
  editing: DeploymentEnvironmentEditing | null;
  /** The Project's Environments (the Variables picker's list): the others are where this service is used from. */
  environments?: VariableReferenceEnvironments;
}>) {
  const exports = props.detail.content.ownServer?.serviceExports ?? [];
  const editing = props.editing;
  const authoring = privateServiceExportAuthoring(props.detail, editing !== null);
  if (authoring.kind === 'unavailable' && authoring.reason === 'platformTarget') return null;
  const open = () => {
    if (!editing || authoring.kind !== 'ready') return;
    showDeploymentSheet({ component: PrivateServiceExportSheet,
      props: { detail: props.detail, editing, machineIds: authoring.machineIds,
        otherEnvironments: Array.from(props.environments ?? [], ([environmentId, entry]) => ({ environmentId, name: entry.name }))
          .filter(entry => entry.environmentId !== props.detail.environment.id) },
      title: t('projects.deployments.settingsSections.privateSharingAdd'), testID: `${id}.modal` });
  };
  return <ItemGroup testID={id} title={t('projects.deployments.settingsSections.privateSharingTitle')}
    surface={exports.length === 0 && authoring.kind === 'ready' ? 'none' : 'sheet'}
    description={t('projects.deployments.settingsSections.privateSharingBody')}
    action={authoring.kind === 'ready' ? <SectionActionButton testID={`${id}.add`}
      title={t('projects.deployments.settingsSections.privateSharingAdd')} onPress={open} /> : undefined}>
    {exports.map(entry => <Item key={entry.key} testID={`${id}.export:${entry.key}`} title={entry.key}
      subtitle={`${entry.service}:${entry.containerPort}`} detail={privateServiceExportReachLabel(entry)} mode="info" />)}
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
    case 'readOnly': case 'platformTarget': return null;
  }
}

type SheetInput = Readonly<{
  detail: DeploymentEnvironmentReadDetailV1;
  editing: DeploymentEnvironmentEditing;
  machineIds: readonly string[];
  otherEnvironments: ReadonlyArray<Readonly<{ environmentId: string; name: string }>>;
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
  // The port the stored Compose service declares fills Container port, as Add a domain does (D29); typed values stay.
  const storedDocument = props.detail.content.definition.kind === 'stored' ? props.detail.content.definition.document : null;
  const [compose, setCompose] = React.useState<Awaited<ReturnType<typeof readDeploymentComposeServiceFacts>> | null>(null);
  React.useEffect(() => {
    if (!storedDocument) return;
    let current = true;
    void readDeploymentComposeServiceFacts(storedDocument).then(facts => { if (current) setCompose(facts); },
      () => { /* Compose that does not parse declares no port; the field stays typed. */ });
    return () => { current = false; };
  }, [storedDocument]);
  React.useEffect(() => {
    const ports = [...new Set(compose?.containerPorts.filter(entry => entry.service === service).map(entry => entry.containerPort))];
    if (ports.length === 1) setContainerPort(currentPort => currentPort === '' ? String(ports[0]) : currentPort);
  }, [compose, service]);
  const [schemeOverride, setSchemeOverride] = React.useState('');
  const inferredScheme = readPrivateServiceSharingScheme(props.detail.content, service, Number(containerPort), compose);
  const scheme = inferredScheme ?? schemeOverride;
  const [reachId, setReachId] = React.useState<string | null>(null);
  const [address, setAddress] = React.useState<string | null>(null);
  const [hostPort, setHostPort] = React.useState('');
  const [reviewed, setReviewed] = React.useState<Readonly<{ patch: ReturnType<typeof buildPrivateServiceExportPatch>;
    hostAddress: string | null; networkName: string }> | null>(null);
  const [invalid, setInvalid] = React.useState(false);
  const [advanced, setAdvanced] = React.useState(false);
  // Happier forwarding needs no joined network; an explicitly chosen network retains its observed identity.
  const chosen = reachId ?? HAPPIER_NETWORK;
  const selectedNetwork: MachinePrivateNetworkObservationV1 | undefined = networks.find(network => networkReachId(network) === chosen);
  const happier = chosen === HAPPIER_NETWORK;
  const canShare = happier || selectedNetwork !== undefined;
  const hostAddress = selectedNetwork ? address ?? selectedNetwork.addresses[0] ?? null : null;
  const reachOptions = React.useMemo(() => {
    const happierNetwork = { id: HAPPIER_NETWORK, title: t('projects.deployments.settingsSections.privateSharingHappierNetwork'),
      subtitle: t('projects.deployments.settingsSections.privateSharingHappierNetworkBody') };
    const joined = networks.map(network => ({ id: networkReachId(network), title: network.displayName ?? network.networkIdentity!,
      subtitle: t('projects.deployments.settingsSections.privateSharingJoinedNetworkBody') }));
    return [happierNetwork, ...joined];
  }, [networks]);
  const { onClose, editing, setChrome } = props;
  const router = useRouter();
  const change = useDeploymentChangePress({ request: artifactId => { onClose(); editing.review.request(artifactId); } }, () => {
    editing.onChanged(); onClose();
  });
  const explicitHostPort = hostPort.trim();
  const automaticHostPort = happier ? t('projects.deployments.settingsSections.privateSharingHostPortAutomatic') : undefined;
  const missingHostPort = !happier && !explicitHostPort;
  const canReview = Boolean(service && key.trim() && scheme.trim() && containerPort && !missingHostPort && (happier || hostAddress));
  // Every field Review can still need sits under Advanced; the needs line says so instead of naming a hidden field.
  const missingField = canReview ? null : !key.trim() ? t('projects.deployments.settingsSections.privateSharingKey')
    : !containerPort ? t('projects.deployments.settingsSections.privateSharingPort')
    : !scheme.trim() ? t('projects.deployments.settingsSections.privateSharingScheme')
    : missingHostPort ? t('projects.deployments.settingsSections.privateSharingHostPort') : null;
  const reach = (): PrivateServiceExportReach | null => {
    if (happier) return { kind: 'happierNetwork' };
    if (!selectedNetwork?.networkIdentity || !hostAddress || !selectedNetwork.addresses.includes(hostAddress)) return null;
    return { kind: 'privateNetwork', privateNetwork: selectedNetwork.networkIdentity, hostAddress };
  };
  const review = () => {
    try { const selected = reach(); if (!selected) return;
      const patch = buildPrivateServiceExportPatch(props.detail.content, { key: key.trim(), service,
        containerPort: Number(containerPort), scheme: scheme.trim(), reach: selected,
        ...(explicitHostPort ? { hostPort: Number(explicitHostPort) } : {}) });
      setInvalid(false); setReviewed({ patch, hostAddress: selected.kind === 'privateNetwork' ? selected.hostAddress : null,
        networkName: selected.kind === 'happierNetwork' ? t('projects.deployments.settingsSections.privateSharingHappierNetwork')
          : selectedNetwork?.displayName ?? selected.privateNetwork });
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
    </> : services.length > 0 && canShare ? <RoundButton testID={`${id}.review`}
      title={t('projects.deployments.settingsSections.privateSharingReview')}
      size="normal" disabled={!canReview} onPress={review} /> : null}
  </ModalCardFooterActions>;
  React.useEffect(() => { setChrome?.({ kind: 'card', footer }); });
  React.useEffect(() => () => setChrome?.(null), [setChrome]);
  const reachTiles = <SelectionTiles<string> testIdPrefix={`${id}.reach`} density="compact" subtitleLines={0} minimumTileWidth={220}
    accessibilityLabel={t('projects.deployments.settingsSections.privateSharingWho')} options={reachOptions}
    value={happier ? HAPPIER_NETWORK : selectedNetwork ? networkReachId(selectedNetwork) : null}
    onChange={next => { if (next) { setReachId(next); setAddress(null); } }} />;
  const field = (name: 'key' | 'containerPort' | 'scheme' | 'hostPort', label: string, value: string,
    onChangeText: (value: string) => void, placeholder?: string) =>
    <FieldItem label={label}><FieldTextInput testID={`${id}.${name}`} accessibilityLabel={label} value={value}
      onChangeText={onChangeText} autoCapitalize="none" placeholder={placeholder}
      {...(name === 'containerPort' || name === 'hostPort' ? { keyboardType: 'number-pad' as const } : {})} /></FieldItem>;
  return <ListPresentationProvider value="page" pageInsets="contained"><View style={deploymentSheetStyles.body}>
    {reviewed ? <ItemGroup title={t('projects.deployments.settingsSections.privateSharingReview')}
      description={t(reviewed.hostAddress === null ? 'projects.deployments.settingsSections.privateSharingReviewBodyHappier'
        : 'projects.deployments.settingsSections.privateSharingReviewBody')}>
      <Item title={t('projects.deployments.settingsSections.privateSharingService')} detail={`${service}:${containerPort}`} mode="info" />
      <Item title={t('projects.deployments.settingsSections.privateSharingKey')} detail={key} mode="info" />
      <Item title={t('projects.deployments.settingsSections.privateSharingScheme')} detail={scheme} mode="info" />
      <Item title={t('projects.deployments.settingsSections.privateSharingWho')}
        detail={reviewed.networkName} mode="info" />
      {reviewed.hostAddress === null ? null : <Item testID={`${id}.reviewAddress`}
        title={t('projects.deployments.settingsSections.privateSharingAddress')} detail={reviewed.hostAddress} mode="info" />}
      <Item testID={`${id}.reviewHostPort`} title={t('projects.deployments.settingsSections.privateSharingHostPort')}
        detail={explicitHostPort || automaticHostPort} mode="info" />
    </ItemGroup> : <>
      {services.length === 0 ? <SurfaceStateCard size="line" kind="unavailable"
          title={t('projects.deployments.settingsSections.privateSharingInvalid')} />
        // A selected joined network can disappear; the person can choose Happier forwarding instead.
        : !canShare ? <>
          <SurfaceStateCard testID={`${id}.networkMissing`} size="line" kind="unavailable"
            title={t('projects.deployments.settingsSections.privateSharingNetworkMissing')} />
          {reachTiles}
        </> : <>
      <FieldItem label={t('projects.deployments.settingsSections.privateSharingService')}><ValueFieldSelect testID={`${id}.service`}
        label={t('projects.deployments.settingsSections.privateSharingService')} items={services.map(value => ({ id: value, title: value }))}
        selectedId={service} onSelect={value => { setService(value); setKey(value); setContainerPort(''); setSchemeOverride(''); }} fill /></FieldItem>
      {/* What is shared, then who may use it, then one sentence of what sharing does (PAGE-ACCEPT-176 R7-D1). The
          default view speaks no networking; export name, ports and scheme wait under Advanced with their values shown. */}
      <FieldItem label={t('projects.deployments.settingsSections.privateSharingWho')}>{reachTiles}</FieldItem>
      {selectedNetwork ? <FieldItem label={t('projects.deployments.settingsSections.privateSharingAddress')}><ValueFieldSelect testID={`${id}.address`}
        label={t('projects.deployments.settingsSections.privateSharingAddress')}
        items={selectedNetwork.addresses.map(value => ({ id: value, title: value }))} selectedId={hostAddress} onSelect={setAddress} fill /></FieldItem> : null}
      <Text testID={`${id}.outcome`} style={deploymentSheetStyles.lead}>
        {selectedNetwork ? t('projects.deployments.settingsSections.privateSharingOutcomeNetwork', { service,
          network: selectedNetwork.displayName ?? selectedNetwork.networkIdentity ?? '' })
          : t('projects.deployments.settingsSections.privateSharingOutcomeHappier', { service })}
        {/* Another Environment can point here only when the Project has one (the picker's own list). */}
        {props.otherEnvironments.length > 0 ? <>{' '}{t('projects.deployments.settingsSections.privateSharingWhereToUse')}</> : null}
      </Text>
      {/* The sentence leads to each Environment that can point here, at its Variables (PAGE-ACCEPT-176 R8-D2). */}
      {props.otherEnvironments.length > 0 ? <View style={styles.links}>
        {props.otherEnvironments.map(entry => <TextLinkButton key={entry.environmentId} testID={`${id}.openVariables:${entry.environmentId}`}
          size="meta" label={t('projects.deployments.settingsSections.privateSharingOpenVariables', { environment: entry.name })}
          onPress={() => { onClose(); router.push(deploymentEnvironmentRoute({ serverId: props.detail.environment.serverId,
            projectSourceId: props.detail.environment.projectSourceId, environmentId: entry.environmentId, tab: 'variables' })); }} />)}
      </View> : null}
      {happier ? null : <Text variant="meta" style={deploymentSheetStyles.lead}>
        {t('projects.deployments.settingsSections.privateSharingJoinedPortReason')}
      </Text>}
      <ExpandableItem testID={`${id}.advanced`} expanded={advanced} onExpandedChange={setAdvanced}
        header={state => <Item testID={`${id}.advanced.header`} {...state.headerProps}
          title={t('projects.deployments.domainIngressAdvanced')}
          subtitle={[key.trim(), containerPort, scheme.trim(), explicitHostPort || automaticHostPort].filter(Boolean).join(' · ') || undefined} />}>
        <View style={deploymentSheetStyles.fields}>
          {field('key', t('projects.deployments.settingsSections.privateSharingKey'), key, setKey)}
          {field('containerPort', t('projects.deployments.settingsSections.privateSharingPort'), containerPort, setContainerPort)}
          {inferredScheme === null ? field('scheme', t('projects.deployments.settingsSections.privateSharingScheme'),
            schemeOverride, setSchemeOverride) : <Item testID={`${id}.schemeFact`}
              title={t('projects.deployments.settingsSections.privateSharingScheme')} detail={inferredScheme} mode="info" />}
          {field('hostPort', t('projects.deployments.settingsSections.privateSharingHostPort'), hostPort, setHostPort, automaticHostPort)}
        </View>
      </ExpandableItem>
      {/* Review sharing says what it still needs instead of staying disabled without a reason (PAGE-ACCEPT-176 D29). */}
      {missingField ? <Text testID={`${id}.needs`} style={deploymentSheetStyles.lead}>
        {t(advanced ? 'projects.deployments.settingsSections.privateSharingNeeds'
          : 'projects.deployments.settingsSections.privateSharingNeedsAdvanced', { field: missingField })}</Text> : null}
      </>}
    </>}
    {invalid ? <SurfaceStateCard testID={`${id}.invalid`} size="line" kind="error"
      title={t('projects.deployments.settingsSections.privateSharingInvalid')} /> : null}
    {change.outcome?.kind === 'refused' ? <SurfaceStateCard testID={`${id}.refused`} size="line" kind="error"
      title={deploymentActionRefusalRemedy(change.outcome.code)} diagnosticCode={change.outcome.code} /> : null}
    {setChrome ? null : footer}
  </View></ListPresentationProvider>;
}

const styles = StyleSheet.create((theme) => ({
  links: { flexDirection: 'row', flexWrap: 'wrap', columnGap: theme.space.s16, rowGap: theme.space.s4 },
}));
