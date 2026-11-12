import * as React from 'react';
import { View } from 'react-native';
import { createDeploymentDumpBackupSourceV1, deploymentDataTargetOperands,
  type DeploymentEnvironmentReadDetailV1 } from '@happier-dev/deployments';
import type { DeploymentPreviewDataSelectionV1 } from '@happier-dev/protocol/deployments/deploymentPreviewTemplateV1';
import type { ServerAccountScopeLifetime } from '@/sync/domains/scope/serverAccountScope';
import { StoreRegistryItemPicker } from '@/components/store/StoreKindPage';
import { useStoreAppListing, type StoreAppListingSelection } from '@/components/store/useStoreAppListing';
import { StoreMachineScopeContext } from '@/components/settings/plugins/model/useStoreMachineScope';
import { Item } from '@/components/ui/lists/Item';
import { SectionActionButton } from '@/components/ui/lists/SectionActionButton';
import { SurfaceStateCard } from '@/components/ui/surfaces/SurfaceStateCard';
import { DropdownMenu } from '@/components/ui/forms/dropdown/DropdownMenu';
import { ListPresentationProvider } from '@/components/ui/lists/listPresentation';
import { usePluginUiProjectionCurrentness } from '@/sync/domains/plugins/ui/usePluginUiProjectionCurrentness';
import { publishMachineContributionRegistryProjectionInvalidation } from '@/sync/ops/machineContributionRegistryProjectionRevision';
import { formatAsOfTime } from '@/utils/time/formatAsOfTime';
import { t } from '@/text';
import { useRouter } from '@/components/appShell/workspace/destinationRoute';
import { buildPluginsHomeRoute } from '@/components/settings/plugins/model/pluginsSurfaceRoutes';
import type { CustomModalInjectedProps } from '@/modal/types';
import { DeploymentBackupSetupSheet } from './DeploymentBackupControls';
import { DeploymentEnvironmentChooser } from './DeploymentEnvironmentCollection';
import { DeploymentTemplateMappingCorrection } from './DeploymentTemplateMappingCorrection';
import { useDeploymentEnvironmentRecord } from './useDeploymentReads';
import { useDeploymentAccountController } from './useDeploymentProject';
import { createDeploymentActions } from './deploymentActions';
import { readDeploymentActionError } from './deploymentActionOutcome';
import { deploymentActionRefusalRemedy } from './deploymentPresentation';
import { deploymentBackupCaptureChoices } from './deploymentRestore';
import { DEPLOYMENT_DATABASE_CATALOG_FILTER } from './DeploymentDatabasePage';
import { deploymentSheetStyles } from './deploymentSheet';

type Selection = Extract<DeploymentPreviewDataSelectionV1, { kind: 'template' }>;
type Props = Readonly<{
  detail: DeploymentEnvironmentReadDetailV1;
  lifetime: ServerAccountScopeLifetime; machineName: (machineId: string) => string;
  initialSelection?: Selection; onSelect: (selection: Selection) => void; testID: string;
}>;
const BACKUP_DESTINATION_SECTIONS = Object.freeze(['familiesById.backupDestinations']);

/** Mounted only by the Own press: catalog reads and capture inspection have no template-side effects. */
export function DeploymentPreviewNativeChoice(props: Props & CustomModalInjectedProps) {
  const initial = props.initialSelection?.templateRef;
  const [selection, setSelection] = React.useState<StoreAppListingSelection | null>(() => initial
    ? { sourceId: initial.sourceId, itemId: initial.itemId, version: initial.version } : null);
  const machine = { serverId: props.lifetime.scope.serverId, machineId: props.detail.environment.controllerMachineId };
  return <StoreMachineScopeContext.Provider value={machine}>
    {selection ? <NativeListing key={JSON.stringify(selection)} {...props} selection={selection}
      onChooseTemplate={() => setSelection(null)} />
      : <StoreRegistryItemPicker presented machine={machine} initialFilters={DEPLOYMENT_DATABASE_CATALOG_FILTER}
        onSelect={item => setSelection({ sourceId: item.sourceId, itemId: item.itemId, version: item.version })}
        testID={`${props.testID}.picker`} />}
  </StoreMachineScopeContext.Provider>;
}

function NativeListing(props: Props & CustomModalInjectedProps & Readonly<{
  selection: StoreAppListingSelection; onChooseTemplate: () => void;
}>) {
  const listing = useStoreAppListing({ selection: props.selection, lifetime: props.lifetime, demand: { presented: true } });
  const id = props.testID;
  if (listing.kind === 'loading') return <SurfaceStateCard testID={`${id}.loading`} size="line" kind="loading" title={t('common.loading')} />;
  if (listing.kind === 'unavailable') return <SurfaceStateCard testID={`${id}.failed`} size="line" kind="error"
    title={t('projects.deployments.addRefused')} diagnosticCode={listing.error}
    action={{ label: t('common.retry'), onPress: listing.refresh }} />;
  if (listing.kind === 'needs_review') return listing.reviewSource
    ? <DeploymentTemplateMappingCorrection source={listing.reviewSource} onReview={listing.correctMappings} testID={`${id}.mapping`} />
    : <SurfaceStateCard testID={`${id}.mapping`} size="line" kind="error" title={t('projects.deployments.addRefused')} />;
  const data = listing.app.data;
  return <ListPresentationProvider value="page" pageInsets="contained"><View style={deploymentSheetStyles.body}>
    <Item title={t('projects.deployments.settingsSections.previewEditor.nativeTemplate')} detail={listing.app.title} mode="info"
      rightElement={<SectionActionButton testID={`${id}.template.change`} title={t('common.change')} onPress={props.onChooseTemplate} />} />
    {data?.engine === 'postgres' && data.logicalBackup?.adapter === 'postgres-v1'
      ? <>
        <Item testID={`${id}.empty`} title={t('projects.deployments.settingsSections.previewEditor.nativeEmpty')}
          subtitle={t('projects.deployments.settingsSections.previewEditor.nativeEmptyBody')} mode="info"
          rightElement={<SectionActionButton testID={`${id}.empty.save`} title={t('common.save')}
            onPress={() => {
              props.onSelect({ kind: 'template', templateRef: listing.templateRef, dataExportNames: Object.keys(listing.app.exports ?? {}) });
              props.onClose();
            }} />} />
        <NativeSource {...props} templateRef={listing.templateRef} service={data.service}
          dataExportNames={Object.keys(listing.app.exports ?? {})} />
      </>
      : <SurfaceStateCard testID={`${id}.unsupported`} size="line" kind="empty"
        title={t('projects.deployments.settingsSections.previewEditor.nativeUnsupported')} />}
  </View></ListPresentationProvider>;
}

function NativeSource(props: Props & CustomModalInjectedProps & Readonly<{
  templateRef: Selection['templateRef']; service: string; dataExportNames: string[];
}>) {
  const [environmentId, setEnvironmentId] = React.useState<string | null>(() => props.initialSelection?.copyFrom?.environmentId
    ?? (props.detail.content.template?.data?.some(data => data.engine === 'postgres') ? props.detail.environment.id : null));
  const controller = useDeploymentAccountController(props.lifetime, true, { mounted: true, visible: true, focused: true });
  const source = useDeploymentEnvironmentRecord(controller, environmentId, { mounted: true, visible: true, focused: true });
  const detail = source.snapshot.value;
  const [selectedService, setSelectedService] = React.useState<string | null>(null);
  const [open, setOpen] = React.useState(false);
  const services = detail?.content.template?.data?.filter(data => data.engine === 'postgres') ?? [];
  const service = services.find(data => data.service === selectedService)?.service ?? services[0]?.service;
  const id = props.testID;
  return <>
    {controller ? <DeploymentEnvironmentChooser controller={controller} testID={`${id}.source`} title={t('projects.deployments.settingsSections.previewEditor.nativeSource')}
      eligible={() => true} selectedId={environmentId} disabled={false} onSelect={item => { setEnvironmentId(item.environment.id); setSelectedService(null); }}
      loadFailedTitle={t('projects.deployments.promotion.loadFailed')}
      emptyTitle={t('projects.deployments.settingsSections.previewEditor.nativeSourceEmpty')}
      emptyBody={t('projects.deployments.settingsSections.previewEditor.nativeSourceEmptyBody')} /> : null}
    {environmentId && source.snapshot.status === 'unavailable' ? <SurfaceStateCard testID={`${id}.source.failed`} size="line" kind="error"
      title={t('projects.deployments.promotion.loadFailed')} diagnosticCode={source.snapshot.failure?.code}
      reason={deploymentActionRefusalRemedy(source.snapshot.failure?.code ?? 'deployment_unavailable')}
      {...(source.snapshot.failure?.retryable ? { action: { label: t('common.retry'), onPress: source.refresh } } : {})} />
      : !controller || (environmentId && source.snapshot.status !== 'ready') ? <SurfaceStateCard testID={`${id}.source.record.loading`} size="line" kind="loading" title={t('common.loading')} />
      : detail && !service ? <SurfaceStateCard testID={`${id}.source.empty`} size="line" kind="empty"
        title={t('projects.deployments.settingsSections.previewEditor.nativeSourceEmptyBody')} /> : null}
    {source.snapshot.status === 'ready' && detail && service ? <>
      {services.length > 1 ? <DropdownMenu testID={`${id}.service`} open={open} onOpenChange={setOpen}
        items={services.map(data => ({ id: data.service, title: data.service }))} selectedId={service}
        onSelect={next => { setOpen(false); setSelectedService(next); }}
        itemTrigger={{ title: t('projects.deployments.settingsSections.setupService'), showSelectedSubtitle: false }} /> : null}
      <NativeCaptures key={JSON.stringify([detail.environment.id, service])} {...props} sourceDetail={detail} sourceService={service} />
    </> : null}
  </>;
}

function NativeCaptures(props: Props & CustomModalInjectedProps & Readonly<{
  templateRef: Selection['templateRef']; service: string; dataExportNames: string[];
  sourceDetail: DeploymentEnvironmentReadDetailV1; sourceService: string;
}>) {
  const target = deploymentDataTargetOperands(props.sourceDetail);
  const deploymentId = props.sourceDetail.runtimeTargetLink?.activeDeploymentId;
  const backup = props.sourceDetail.content.backup;
  const dump = backup && !('notNeeded' in backup)
    ? backup.sources.find(source => source.kind === 'dump' && source.service === props.sourceService) : undefined;
  const actions = React.useMemo(() => createDeploymentActions(props.lifetime, props.sourceDetail.environment.projectSourceId),
    [props.lifetime, props.sourceDetail.environment.projectSourceId]);
  type Choices = ReturnType<typeof deploymentBackupCaptureChoices>;
  const [state, setState] = React.useState<Readonly<{ kind: 'loading' }> | Readonly<{ kind: 'failed'; code: string }>
    | Readonly<{ kind: 'ready'; choices: Choices }>>({ kind: 'loading' });
  const [attempt, setAttempt] = React.useState(0);
  const [selected, setSelected] = React.useState<string | null>(() => props.initialSelection?.copyFrom?.environmentId === props.sourceDetail.environment.id
    ? props.initialSelection.copyFrom.snapshotId ?? null : null);
  const [open, setOpen] = React.useState(false);
  React.useEffect(() => {
    if (!target || !deploymentId || !backup || 'notNeeded' in backup || !dump) { setState({ kind: 'ready', choices: [] }); return; }
    const controller = new AbortController();
    setState({ kind: 'loading' });
    void actions.backupInventory({ ...target, deploymentId, configRevision: backup.configRevision }).then(inventory => {
      if (controller.signal.aborted || !props.lifetime.isCurrent()) return;
      setState({ kind: 'ready', choices: deploymentBackupCaptureChoices({ inventory, target, deploymentId,
        sourceId: dump.sourceId, service: props.sourceService, database: dump.sourceId }) });
    }).catch(error => {
      if (controller.signal.aborted) return;
      const outcome = readDeploymentActionError(error);
      setState({ kind: 'failed', code: outcome.kind === 'refused' ? outcome.code : 'deployment_unavailable' });
    });
    return () => controller.abort();
  }, [actions, props.sourceDetail, props.sourceService, props.lifetime, attempt]);
  const id = props.testID;
  if (state.kind === 'loading') return <SurfaceStateCard testID={`${id}.captures.loading`} size="line" kind="loading" title={t('common.loading')} />;
  if (state.kind === 'failed') return <SurfaceStateCard testID={`${id}.captures.failed`} size="line" kind="error"
    title={t('projects.deployments.promotion.loadFailed')} diagnosticCode={state.code} reason={deploymentActionRefusalRemedy(state.code)}
    action={{ label: t('common.retry'), onPress: () => setAttempt(value => value + 1) }} />;
  const choices = state.choices.filter(choice => choice.copyFrom);
  const choice = choices.find(entry => entry.snapshotId === selected);
  return <>
    {choices.length ? <DropdownMenu testID={`${id}.capture`} open={open} onOpenChange={setOpen}
      items={choices.map(entry => ({ id: entry.snapshotId, title: formatAsOfTime(entry.takenAtMs) }))} selectedId={selected}
      onSelect={next => { setOpen(false); setSelected(next); }} itemTrigger={{ title: t('projects.deployments.settingsSections.previewEditor.nativeCapture'),
        showSelectedSubtitle: false }} /> : <SurfaceStateCard testID={`${id}.captures.empty`} size="line" kind="empty"
        title={t('projects.deployments.settingsSections.previewEditor.nativeCaptureEmpty')}
        reason={t('projects.deployments.settingsSections.previewEditor.nativeCaptureEmptyBody')} />}
    {choice?.copyFrom ? <NativeDestination {...props} copyFrom={choice.copyFrom} /> : null}
  </>;
}

function NativeDestination(props: Props & CustomModalInjectedProps & Readonly<{
  templateRef: Selection['templateRef']; service: string; dataExportNames: string[]; copyFrom: NonNullable<Selection['copyFrom']>;
}>) {
  const router = useRouter();
  const projection = usePluginUiProjectionCurrentness({ serverId: props.lifetime.scope.serverId,
    machineId: props.detail.environment.controllerMachineId, sections: BACKUP_DESTINATION_SECTIONS });
  const destinations = Object.values(projection.pluginUiProjection?.backupDestinationsById ?? {});
  const destination = destinations[0];
  const sameTemplate = props.initialSelection?.templateRef.sourceId === props.templateRef.sourceId
    && props.initialSelection.templateRef.itemId === props.templateRef.itemId
    && props.initialSelection.templateRef.version === props.templateRef.version;
  const sources = React.useMemo(() => [createDeploymentDumpBackupSourceV1(props.service)], [props.service]);
  if (projection.phase === 'establishing') return <SurfaceStateCard testID={`${props.testID}.destination.loading`} size="line" kind="loading" title={t('common.loading')} />;
  if (projection.phase !== 'current' || !projection.interactionEnabled) return <SurfaceStateCard testID={`${props.testID}.destination.failed`} size="line" kind="error"
    title={t('projects.deployments.backupStatusUnavailable')} diagnosticCode={projection.unavailableReasonCode}
    action={{ label: t('common.retry'), onPress: () => publishMachineContributionRegistryProjectionInvalidation({
      serverId: props.lifetime.scope.serverId, machineId: props.detail.environment.controllerMachineId }, 'refresh') }} />;
  if (!destination) return <SurfaceStateCard testID={`${props.testID}.destination.unavailable`} size="line" kind="empty"
    title={t('projects.deployments.settingsSections.setupNoDestination')}
    action={{ label: t('projects.deployments.settingsSections.setupOpenStore'),
      onPress: () => router.push(buildPluginsHomeRoute('app', { view: 'search', query: 'backup' })) }} />;
  return <DeploymentBackupSetupSheet mode="intent" detail={props.detail} destination={destination} destinations={destinations}
    sourceChoices={sources} initialIntent={sameTemplate ? props.initialSelection?.destinationBackup : undefined} projection={projection.pluginUiProjection} lifetime={props.lifetime}
    machine={props.machineName(props.detail.environment.controllerMachineId)} testID={`${props.testID}.backup`} setChrome={props.setChrome}
    onClose={props.onClose} onIntent={destinationBackup => props.onSelect({ kind: 'template', templateRef: props.templateRef,
      dataExportNames: props.dataExportNames, copyFrom: props.copyFrom, destinationBackup })} />;
}
