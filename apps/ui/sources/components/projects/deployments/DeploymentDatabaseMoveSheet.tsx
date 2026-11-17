import * as React from 'react';
import { View } from 'react-native';
import { useRouter } from 'expo-router';
import type { DeploymentEnvironmentCollectionV1 } from '@happier-dev/deployment-protocol/v1';
import { deploymentDataTargetOperands, type DeploymentEnvironmentReadDetailV1, type DeploymentReadControllerV1 } from '@happier-dev/deployments';
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
import { deploymentDatabaseMoveDestination } from './deploymentRestore';
import { deploymentSheetStyles, showDeploymentSheet } from './deploymentSheet';
import { useDeploymentEnvironmentRecord } from './useDeploymentReads';
import { authorDatabaseMoveCutoverPatch } from './databaseMoveCutover';
import { prepareDatabaseMoveWriters } from './databaseMoveWriters';
import { useDeploymentMoveWorkflow } from './useDeploymentMoveWorkflow';

type MoveInput = Extract<Parameters<ReturnType<typeof useDeploymentMoveWorkflow>['run']>[0], { kind: 'stateful' }>;
type Writers = Extract<ReturnType<typeof prepareDatabaseMoveWriters>, { kind: 'ready' }>;
type Prepared = Extract<ReturnType<typeof authorDatabaseMoveCutoverPatch>, { kind: 'ready' }>;
type Actions = ReturnType<typeof createDeploymentActions>;
type Detail = DeploymentEnvironmentReadDetailV1;
type Data = NonNullable<NonNullable<Detail['content']['template']>['data']>[number];
type Input = Readonly<{
  controller: DeploymentReadControllerV1;
  source: Detail;
  data: Data;
  actions: Actions;
  backupTarget: Parameters<Actions['runBackup']>[0];
  review: DeploymentReviewHandle;
  lifetime: ServerAccountScopeLifetime;
}>;

export function showDeploymentDatabaseMoveSheet(input: Input): void {
  showDeploymentSheet({ component: DeploymentDatabaseMoveSheet, props: input,
    title: t('projects.deployments.databaseMoveTitle'), testID: 'project-deployments.move.modal', closeOnBackdrop: false });
}

function DeploymentDatabaseMoveSheet(props: Input & CustomModalInjectedProps) {
  const [selectedId, setSelectedId] = React.useState<string | null>(null);
  const selected = useDeploymentEnvironmentRecord(props.controller, selectedId, { mounted: true, visible: true, focused: true });
  const destination = selected.snapshot.value;
  const destinationDecision = deploymentDatabaseMoveDestination(destination);
  const selection = destinationDecision?.kind === 'ready' ? destinationDecision.selection : null;
  const destinationRefusal = destinationDecision?.kind === 'unavailable' ? destinationDecision.reason : undefined;
  const [busy, setBusy] = React.useState(false);
  const [refusal, setRefusal] = React.useState<Readonly<{ code: string; variable?: string }> | null>(null);
  const select = React.useCallback((row: DeploymentEnvironmentCollectionV1['items'][number]) => {
    setSelectedId(row.environment.id); setRefusal(null);
  }, []);
  const reviewDestination = async () => {
    if (busy || !destination || !selection) return;
    setBusy(true); setRefusal(null);
    try {
      const sourceTarget = deploymentDataTargetOperands(props.source);
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
          deploymentId: props.backupTarget.deploymentId, result: inventory }]);
      if (writers.kind !== 'ready') { setRefusal({ code: writers.reason }); return; }
      const serverId = props.lifetime.scope.serverId;
      const primary = prepared.patch.definition.primaryService;
      const composeService = primary && writers.runningServices.includes(primary) ? primary : writers.runningServices[0]!;
      const environment = props.source.environment;
      const input: MoveInput = { kind: 'stateful', serverId, writers: writers.writers,
        backupTarget: { ...props.backupTarget, serverId }, sourceId: dump.sourceId,
        origin: { environmentId: environment.id, targetLinkId: sourceTarget.targetLinkId },
        // Cross-Environment restore reads the source capture receipt; destination health names its own receipt.
        restoreTarget: { ...destinationTarget, serverId, deploymentId: props.backupTarget.deploymentId,
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
  const footer = <ModalCardFooterActions cancel={{ onPress: props.onClose, disabled: busy }}>
    <RoundButton testID="project-deployments.move.copy" size="normal" title={t('projects.deployments.databaseMoveReview')}
      disabled={busy || !selection} loading={busy} onPress={() => { void reviewDestination(); }} />
  </ModalCardFooterActions>;
  const { setChrome } = props;
  React.useEffect(() => { setChrome?.({ kind: 'card', footer }); });
  React.useEffect(() => () => setChrome?.(null), [setChrome]);
  return <ListPresentationProvider value="page" pageInsets="contained">
    <View testID="project-deployments.move" style={deploymentSheetStyles.body}>
      <Text style={deploymentSheetStyles.lead}>{t('projects.deployments.databaseMoveLead')}</Text>
      <DeploymentEnvironmentChooser controller={props.controller} testID="project-deployments.move.destination"
        title={t('projects.deployments.databaseMoveDestination')} selectedId={selectedId} onSelect={select} disabled={busy}
        eligible={row => row.environment.id !== props.source.environment.id && row.environment.capabilities.manage}
        loadFailedTitle={t('projects.deployments.promotion.loadFailed')}
        emptyTitle={t('projects.deployments.databaseMoveEmptyTitle')} emptyBody={t('projects.deployments.databaseMoveEmptyBody')} />
      {selectedId && !selection ? <SurfaceStateCard testID={`project-deployments.move.destination.${selected.snapshot.status === 'ready'
        ? 'unavailable' : selected.snapshot.status === 'unavailable' ? 'failed' : 'loading'}`} size="line"
        kind={selected.snapshot.status === 'ready' ? 'unavailable' : selected.snapshot.status === 'unavailable' ? 'error' : 'loading'}
        title={selected.snapshot.status === 'ready' || selected.snapshot.status === 'unavailable'
          ? destinationRefusal === 'unsupported' ? t('common.unavailable') : destinationRefusal === 'backup_required'
            ? t('projects.deployments.databaseMoveBackupsRequired') : t('projects.deployments.databaseMoveSelectionUnavailable')
          : t('projects.deployments.loading')}
        diagnosticCode={destinationRefusal ?? selected.snapshot.failure?.code}
        reason={destinationRefusal === 'unsupported' ? deploymentActionRefusalRemedy(destinationRefusal) : undefined} /> : null}
      {refusal ? <SurfaceStateCard testID="project-deployments.move.refused" size="line" kind="error"
        title={t('projects.deployments.databaseMoveUnavailable')} diagnosticCode={refusal.code} reason={refusal.variable ?? (refusal.code === 'writer_review_required' ? t('projects.deployments.move.writerReviewRequired')
          : refusal.code === 'noRunningWriter' ? t('projects.deployments.move.noRunningWriter') : deploymentActionRefusalRemedy(refusal.code))} /> : null}
      {setChrome ? null : footer}
    </View>
  </ListPresentationProvider>;
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
      <ItemGroup title={t('projects.deployments.move.writers')}>
        {props.writers.writers.map(writer => <Item key={`${writer.machineId}:${writer.serviceId}`}
          testID={`project-deployments.move.writer:${writer.serviceId}`} title={writer.serviceId} detail={writer.machineId} mode="info" />)}
        {props.writers.stopped.map(service => <Item key={`${service.machineId}:${service.serviceId}`}
          testID={`project-deployments.move.stopped:${service.serviceId}`} title={service.composeService}
          detail={t('projects.deployments.move.stopped')} mode="info" />)}
      </ItemGroup>
      <ItemGroup title={t('projects.deployments.databaseMoveDestination')}>
        <Item title={props.name} mode="info" />
        <Item title={t('projects.deployments.databaseMoveRemovedService')} detail={props.sourceService} mode="info" />
      </ItemGroup>
      <ItemGroup title={t('projects.deployments.databaseMoveBindings')}>
        {props.prepared.patch.bindings.set.map(binding => <Item key={binding.name} title={binding.name} mode="info" />)}
      </ItemGroup>
      <ItemGroup title={t('projects.deployments.databaseMoveDefinition')}>
        <CodeBlockView code={props.prepared.patch.definition.document} language="yaml" showCopyButton showHeaderRow={false} wrap />
      </ItemGroup>
      {setChrome ? null : footer}
    </View>
  </ListPresentationProvider>;
}
