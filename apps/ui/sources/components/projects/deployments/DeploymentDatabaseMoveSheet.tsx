import * as React from 'react';
import { View } from 'react-native';
import { useRouter } from 'expo-router';
import type { DeploymentEnvironmentCollectionV1 } from '@happier-dev/deployments/contracts/v1';
import { deploymentBackupTargetOperands, deploymentDataTargetOperands, isDeploymentDatabaseMoveCandidateV1, type DeploymentEnvironmentReadDetailV1 } from '@happier-dev/deployments';
import { RoundButton } from '@/components/ui/buttons/RoundButton';
import { CodeBlockView } from '@/components/ui/code/blocks/CodeBlockView';
import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { ListPresentationProvider } from '@/components/ui/lists/listPresentation';
import { SurfaceStateCard } from '@/components/ui/surfaces/SurfaceStateCard';
import { Text } from '@/components/ui/text/Text';
import { ModalCardFooterActions } from '@/modal/components/card/ModalCardFooterActions';
import type { CustomModalInjectedProps } from '@/modal/types';
import { t } from '@/text';
import { DeploymentEnvironmentChooser } from './DeploymentEnvironmentCollection';
import type { DeploymentReviewHandle } from './DeploymentEnvironmentDetail';
import type { ServerAccountScopeLifetime } from '@/sync/domains/scope/serverAccountScope';
import { createWorkflowRunRoute } from '@/sync/domains/workflows/workflowRunRoute';
import { readDeploymentActionError } from './deploymentActionOutcome';
import type { createDeploymentActions } from './deploymentActions';
import { deploymentActionRefusalRemedy } from './deploymentPresentation';
import { deploymentDatabaseMoveDestination, deploymentDatabaseMoveManagedRefusal } from './deploymentRestore';
import { useDeploymentPlatformTargetTitles } from './DeploymentPlatformTargetSheet';
import { deploymentSheetStyles, showDeploymentSheet } from './deploymentSheet';
import { DEPLOYMENT_DATABASE_CATALOG_FILTER, deploymentEnvironmentRoute } from './deploymentNavigation';
import { buildPluginsHomeRoute } from '@/components/settings/plugins/model/pluginsSurfaceRoutes';
import { useDeploymentEnvironmentRecord } from './useDeploymentReads';
import { useDeploymentAccountController } from './useDeploymentProject';
import { useServerScopedMachineLabel } from '@/sync/store/hooks';
import { authorDatabaseMoveCutoverPatch } from './databaseMoveCutover';
import { prepareDatabaseMoveWriters } from './databaseMoveWriters';
import { useDeploymentMoveWorkflow } from './useDeploymentMoveWorkflow';
import { WorkflowStartRefusal } from '@/components/workflows/run/WorkflowStartRefusal';
import { storedComposeDocumentText } from './storedComposeDocumentText';

type MoveInput = Extract<Parameters<ReturnType<typeof useDeploymentMoveWorkflow>['run']>[0], { kind: 'stateful' }>;
type Writers = Extract<ReturnType<typeof prepareDatabaseMoveWriters>, { kind: 'ready' }>;
type Prepared = Extract<ReturnType<typeof authorDatabaseMoveCutoverPatch>, { kind: 'ready' }>;
type Actions = ReturnType<typeof createDeploymentActions>;
type Detail = DeploymentEnvironmentReadDetailV1;
type Data = NonNullable<NonNullable<Detail['content']['template']>['data']>[number];
type Input = Readonly<{
  source: Detail;
  data: Data;
  actions: Actions;
  backupTarget: Parameters<Actions['runBackup']>[0] | null;
  review: DeploymentReviewHandle;
  lifetime: ServerAccountScopeLifetime;
}>;

export function deploymentDatabaseMoveReview(input: Omit<Input, 'backupTarget'>, fromStatefulRefusal = false): (() => void) | null {
  const { source, data } = input;
  if (!source.environment.capabilities.manage || data.engine !== 'postgres') return null;
  const backup = source.content.backup;
  const backupTarget = backup && 'configRevision' in backup ? deploymentBackupTargetOperands(source, backup) : null;
  if (!backupTarget && !(fromStatefulRefusal && (source.runtimeTargetLink?.members.length ?? 0) > 1)) return null;
  return () => showDeploymentSheet({ component: DeploymentDatabaseMoveSheet, props: { ...input, backupTarget },
    title: t('projects.deployments.databaseMoveTitle'), testID: 'project-deployments.move.modal', closeOnBackdrop: false });
}

function DeploymentDatabaseMoveSheet(props: Input & CustomModalInjectedProps) {
  const router = useRouter();
  const controller = useDeploymentAccountController(props.lifetime, true, { mounted: true, visible: true, focused: true });
  const [selectedId, setSelectedId] = React.useState<string | null>(null);
  const selected = useDeploymentEnvironmentRecord(controller, selectedId, { mounted: true, visible: true, focused: true });
  const destination = selected.snapshot.value;
  const [candidate, setCandidate] = React.useState<{ detail: Detail; supported: boolean } | null>(null);
  React.useEffect(() => {
    if (!destination) return;
    let active = true;
    void isDeploymentDatabaseMoveCandidateV1(destination.content, destination.runtimeTargetLink).then(supported => {
      if (active) setCandidate({ detail: destination, supported });
    });
    return () => { active = false; };
  }, [destination]);
  const checked = candidate && candidate.detail === destination ? candidate.supported : undefined;
  const destinationDecision = destination && checked !== undefined
    ? deploymentDatabaseMoveDestination({ ...destination, databaseMoveCandidate: checked }) : null;
  const selection = destinationDecision?.kind === 'ready' ? destinationDecision.selection : null;
  const destinationRefusal = destinationDecision?.kind === 'unavailable' ? destinationDecision.reason : undefined;
  const prerequisite = destinationRefusal === 'backup_required'
    ? { section: 'backups' as const, label: t('projects.deployments.settingsSections.setupTitle'),
      testID: 'project-deployments.move.destination.setUpBackups' }
    : selected.snapshot.status === 'ready' && destination && checked !== undefined && !destinationDecision ? { section: 'sharing' as const, label: t('projects.deployments.databaseShare'),
      testID: 'project-deployments.move.destination.share' } : null;
  const [busy, setBusy] = React.useState(false);
  const [refusal, setRefusal] = React.useState<Readonly<{ code: string; variable?: string }> | null>(null);
  const select = React.useCallback((row: DeploymentEnvironmentCollectionV1['items'][number]) => {
    setSelectedId(row.environment.id); setRefusal(null);
  }, []);
  // A managed destination is refused by the same Move destination owner before it is chosen, so its row says why
  // where it is listed; the chosen row shows its own read working instead of a line that resizes the sheet.
  const providerTitle = useDeploymentPlatformTargetTitles(props.lifetime, true);
  const selectedReading = selectedId !== null && selected.snapshot.status !== 'unavailable' && checked === undefined;
  const rowStatus = (row: DeploymentEnvironmentCollectionV1['items'][number]) => {
    const managed = row.managedDataTargetLink;
    if (managed && deploymentDatabaseMoveManagedRefusal([managed])) {
      const provider = managed.source.kind === 'plugin' ? providerTitle(managed.source) : null;
      return { unavailable: provider ? t('projects.deployments.databaseMoveManaged', { provider })
        : t('projects.deployments.databaseMoveManagedUnnamed') };
    }
    return selectedReading && row.environment.id === selectedId ? { working: true as const } : null;
  };
  const reviewDestination = async () => {
    if (busy || !destination || !selection) return;
    setBusy(true); setRefusal(null);
    try {
      const sourceTarget = props.backupTarget;
      const destinationTarget = deploymentDataTargetOperands(destination);
      const controllerMachineId = props.source.environment.controllerMachineId;
      const destinationDeploymentId = destination.runtimeTargetLink?.activeDeploymentId;
      if (!sourceTarget || !destinationTarget || !controllerMachineId || !destinationDeploymentId) {
        setRefusal({ code: 'machine_unavailable' }); return;
      }
      const configuration = props.source.content.backup;
      const dump = configuration && 'configRevision' in configuration
        ? configuration.sources.find(source => source.kind === 'dump' && source.service === props.data.service) : undefined;
      if (!dump) { setRefusal({ code: 'backup_required' }); return; }
      const prepared = authorDatabaseMoveCutoverPatch(props.source.content, { ...selection, sourceService: props.data.service });
      if (prepared.kind !== 'ready') { setRefusal({ code: prepared.reason, ...('variable' in prepared ? { variable: prepared.variable } : {}) }); return; }
      const inventory = await props.actions.readMoveServices({ machineId: sourceTarget.machineId,
        environmentId: props.source.environment.id });
      const writers = prepareDatabaseMoveWriters(props.source.content, props.source.environment.id, props.data.service,
        [{ machineId: sourceTarget.machineId, installationId: sourceTarget.installationId,
          deploymentId: sourceTarget.deploymentId, result: inventory }]);
      if (writers.kind !== 'ready') { setRefusal({ code: writers.reason }); return; }
      const serverId = props.lifetime.scope.serverId;
      const primary = prepared.patch.definition.primaryService;
      const composeService = primary && writers.runningServices.includes(primary) ? primary : writers.runningServices[0]!;
      const environment = props.source.environment;
      const input: MoveInput = { kind: 'stateful', serverId,
        writers: writers.writers.map(({ machineId, serviceId, expectedGeneration }) => ({ machineId, serviceId, expectedGeneration })),
        backupTarget: { ...sourceTarget, serverId }, sourceId: dump.sourceId,
        origin: { environmentId: environment.id, targetLinkId: sourceTarget.targetLinkId },
        // Cross-Environment restore reads the source capture receipt; destination health names its own receipt.
        restoreTarget: { ...destinationTarget, serverId, deploymentId: sourceTarget.deploymentId,
          destination: { kind: 'database', service: selection.sourceService, database: selection.database } },
        cutover: { serverId, environmentId: environment.id, expectedRevision: environment.revision,
          contentArtifactId: environment.contentArtifactId, contentHeaderVersion: environment.contentHeaderVersion,
          contentBodyVersion: environment.contentBodyVersion, patch: prepared.patch },
        deploy: { serverId, environmentId: environment.id, targetLinkId: sourceTarget.targetLinkId, services: writers.runningServices },
        health: { environmentId: destination.environment.id, machineId: destinationTarget.machineId,
          installationId: destinationTarget.installationId, targetLinkId: destinationTarget.targetLinkId,
          deploymentId: destinationDeploymentId, composeService: selection.sourceService },
        appHealth: { environmentId: environment.id, machineId: sourceTarget.machineId,
          installationId: sourceTarget.installationId, targetLinkId: sourceTarget.targetLinkId, composeService },
      };
      props.onClose();
      showDeploymentSheet({ component: DeploymentDatabaseMoveCutoverSheet,
        props: { prepared, writers, input, lifetime: props.lifetime, projectSourceId: environment.projectSourceId,
          controllerMachineId, name: destination.content.name, sourceService: props.data.service,
          title: `${props.source.content.name} · ${t('projects.deployments.databaseMoveTitle')}` },
        title: t('projects.deployments.databaseMoveReview'), testID: 'project-deployments.move.review.modal', closeOnBackdrop: false });
    } catch (error) {
      const outcome = readDeploymentActionError(error);
      if (outcome.kind === 'approval') { props.onClose(); props.review.request(outcome.artifactId); }
      else if (outcome.kind === 'refused') setRefusal({ code: outcome.code });
    } finally { setBusy(false); }
  };
  // Only a destination refused after its read speaks, directly under its row: what is wrong, and what to do, per reason.
  const selectedNotice = selectedId && !selection && !selectedReading ? <SurfaceStateCard testID={`project-deployments.move.destination.${
    selected.snapshot.status === 'ready' ? 'unavailable' : 'failed'}`} size="line"
    kind={selected.snapshot.status === 'ready' ? 'unavailable' : 'error'}
    title={selected.snapshot.status === 'unavailable' ? t('projects.deployments.databaseMoveReadFailed')
      : destinationRefusal === 'unsupported' ? t('projects.deployments.databaseMoveUnsupported')
      : destinationRefusal === 'backup_required' ? t('projects.deployments.databaseMoveBackupsRequired')
      : t('projects.deployments.databaseMoveSelectionUnavailable')}
    diagnosticCode={destinationRefusal ?? selected.snapshot.failure?.code}
    reason={selected.snapshot.status === 'unavailable'
      ? deploymentActionRefusalRemedy(selected.snapshot.failure?.code ?? 'deployment_unavailable')
      : destinationRefusal === 'unsupported' ? t('projects.deployments.databaseMoveUnsupportedRemedy') : undefined}
    // A prerequisite leads to where it is met in the destination's own Settings: Backups (PAGE-ACCEPT-176 D23), or
    // Sharing for a database not yet on a private network.
    {...(prerequisite && destination ? { action: {
      label: prerequisite.label,
      testID: prerequisite.testID,
      onPress: () => {
        props.onClose();
        router.push(deploymentEnvironmentRoute({ serverId: destination.environment.serverId,
          projectSourceId: destination.environment.projectSourceId, environmentId: destination.environment.id,
          tab: 'settings', section: prerequisite.section }) as never);
      },
    } } : {})} /> : null;
  const footer = <ModalCardFooterActions cancel={{ onPress: props.onClose, disabled: busy }}>
    <RoundButton testID="project-deployments.move.copy" size="normal" title={t('projects.deployments.databaseMoveReview')}
      disabled={busy || !selection || !props.backupTarget} loading={busy} onPress={() => { void reviewDestination(); }} />
  </ModalCardFooterActions>;
  const { setChrome } = props;
  React.useEffect(() => { setChrome?.({ kind: 'card', footer }); });
  React.useEffect(() => () => setChrome?.(null), [setChrome]);
  return <ListPresentationProvider value="page" pageInsets="contained">
    <View testID="project-deployments.move" style={deploymentSheetStyles.body}>
      <Text style={deploymentSheetStyles.lead}>{t('projects.deployments.databaseMoveLead')}</Text>
      {!props.backupTarget ? <SurfaceStateCard testID="project-deployments.move.source.servers" size="line" kind="unavailable"
        title={t('projects.deployments.databaseAvailabilityOneServer')}
        reason={t('projects.deployments.databaseAvailabilityDetail')}
        action={{ label: t('projects.deployments.sectionServersBuild'), onPress: () => {
          const environment = props.source.environment;
          props.onClose();
          router.push(deploymentEnvironmentRoute({ serverId: environment.serverId, projectSourceId: environment.projectSourceId,
            environmentId: environment.id, tab: 'settings', section: 'servers-build' }) as never);
        } }} /> : null}
      <DeploymentEnvironmentChooser controller={controller} testID="project-deployments.move.destination" includeDatabaseMoveCandidates
        title={t('projects.deployments.databaseMoveDestination')} selectedId={selectedId} onSelect={select} disabled={busy}
        lifetime={props.lifetime} rowStatus={rowStatus} selectedNotice={selectedNotice}
        eligible={row => row.environment.id !== props.source.environment.id && row.environment.capabilities.manage
          && row.databaseMoveCandidate === true}
        loadFailedTitle={t('projects.deployments.promotion.loadFailed')}
        emptyTitle={t('projects.deployments.databaseMoveEmptyTitle')} emptyBody={t('projects.deployments.databaseMoveEmptyBody')}
        // No destination yet leads to Store's databases at Account scope: the new one may run on any Machine (D23).
        emptyAction={{ label: t('projects.deployments.addOpenStore'), onPress: () => {
          props.onClose();
          router.push(buildPluginsHomeRoute('app', { view: 'kind', kind: 'app', filters: DEPLOYMENT_DATABASE_CATALOG_FILTER }) as never);
        } }} />
      {refusal ? <SurfaceStateCard testID="project-deployments.move.refused" size="line" kind="error"
        title={t('projects.deployments.databaseMoveUnavailable')} diagnosticCode={refusal.code} reason={refusal.variable ?? (refusal.code === 'writer_review_required' ? t('projects.deployments.move.writerReviewRequired')
          : refusal.code === 'noRunningWriter' ? t('projects.deployments.move.noRunningWriter')
          : refusal.code === 'no_connected_services' ? t('projects.deployments.move.noConnectedServices') : deploymentActionRefusalRemedy(refusal.code))} /> : null}
      {setChrome ? null : footer}
    </View>
  </ListPresentationProvider>;
}

/** What one authored variable becomes: the destination's address, port or password, added to this app. */
function moveVariableChange(binding: Prepared['patch']['bindings']['set'][number], destination: string): string {
  const source = binding.source;
  if (source.kind === 'reference' && source.component === 'host') return t('projects.deployments.databaseMoveVariableHost', { environment: destination });
  if (source.kind === 'reference' && source.component === 'port') return t('projects.deployments.databaseMoveVariablePort', { environment: destination });
  return t('projects.deployments.databaseMoveVariablePassword', { environment: destination });
}

/** A running writer reads as its Compose service on its Machine, never as the runtime's internal ids. */
function MoveWriterItem(props: Readonly<{ serverId: string; writer: Writers['writers'][number] }>) {
  const machine = useServerScopedMachineLabel(props.serverId, props.writer.machineId);
  return <Item testID={`project-deployments.move.writer:${props.writer.serviceId}`} title={props.writer.composeService}
    {...(machine ? { detail: machine } : {})} mode="info" />;
}

function DeploymentDatabaseMoveCutoverSheet(props: Readonly<{ prepared: Prepared; writers: Writers; input: MoveInput;
  lifetime: ServerAccountScopeLifetime; projectSourceId: string; controllerMachineId: string;
  name: string; sourceService: string; title: string }> & CustomModalInjectedProps) {
  const router = useRouter();
  const move = useDeploymentMoveWorkflow(props.lifetime, props.projectSourceId, props.input.cutover.environmentId);
  const [starting, setStarting] = React.useState(false);
  const busy = starting || move.pending;
  const confirm = async () => {
    if (busy) return;
    setStarting(true);
    try {
      const accepted = await move.run(props.input, props.title, props.controllerMachineId);
      if (accepted) {
        props.onClose();
        router.push(createWorkflowRunRoute(accepted.run.id, props.lifetime.scope.serverId) as never);
      }
    } finally { setStarting(false); }
  };
  const footer = <ModalCardFooterActions cancel={{ onPress: props.onClose, disabled: busy }}>
    <RoundButton testID="project-deployments.move.save" size="normal" title={t('projects.deployments.move.run')} loading={busy}
      disabled={busy} onPress={() => { void confirm(); }} />
  </ModalCardFooterActions>;
  const { setChrome } = props;
  React.useEffect(() => { setChrome?.({ kind: 'card', footer }); });
  React.useEffect(() => () => setChrome?.(null), [setChrome]);
  return <ListPresentationProvider value="page" pageInsets="contained">
    <View testID="project-deployments.move.review" style={deploymentSheetStyles.body}>
      <Text style={deploymentSheetStyles.lead}>{t('projects.deployments.move.dataReviewLead')}</Text>
      <WorkflowStartRefusal refusal={move.refusal} testID="project-deployments.move.review.refused" />
      <ItemGroup title={t('projects.deployments.move.writers')}>
        {props.writers.writers.map(writer => <MoveWriterItem key={`${writer.machineId}:${writer.serviceId}`}
          serverId={props.lifetime.scope.serverId} writer={writer} />)}
        {props.writers.stopped.map(service => <Item key={`${service.machineId}:${service.serviceId}`}
          testID={`project-deployments.move.stopped:${service.serviceId}`} title={service.composeService}
          detail={t('projects.deployments.move.stopped')} mode="info" />)}
      </ItemGroup>
      {/* Consequences lead (design review 2): what leaves the app is its own fact, never a line under Destination that reads as the destination losing it. */}
      <ItemGroup title={t('projects.deployments.databaseMoveRemovedService')}>
        <Item testID="project-deployments.move.removed" title={props.sourceService}
          subtitle={t('projects.deployments.databaseMoveRemovedServiceKept')} mode="info" />
      </ItemGroup>
      <ItemGroup title={t('projects.deployments.databaseMoveDestination')}>
        <Item title={props.name} mode="info" />
      </ItemGroup>
      {/* Each variable says what it becomes: every one is added and reads its value from the destination. */}
      <ItemGroup title={t('projects.deployments.databaseMoveBindings')}>
        {props.prepared.patch.bindings.set.map(binding => <Item key={binding.name} testID={`project-deployments.move.variable:${binding.name}`}
          title={binding.name} subtitle={moveVariableChange(binding, props.name)} mode="info" />)}
      </ItemGroup>
      <ItemGroup title={t('projects.deployments.databaseMoveDefinition')}>
        <CodeBlockView code={storedComposeDocumentText(props.prepared.patch.definition.document)} language="yaml" showCopyButton showHeaderRow={false} />
      </ItemGroup>
      {setChrome ? null : footer}
    </View>
  </ListPresentationProvider>;
}
