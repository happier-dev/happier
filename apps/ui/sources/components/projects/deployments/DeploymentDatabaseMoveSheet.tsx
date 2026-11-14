import * as React from 'react';
import { View } from 'react-native';
import type { DeploymentEnvironmentCollectionV1 } from '@happier-dev/deployment-protocol/v1';
import type { DeploymentEnvironmentReadDetailV1, DeploymentReadControllerV1 } from '@happier-dev/deployments';
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
import { showDeploymentRestoreSheet } from './DeploymentRestoreSheet';
import { readDeploymentActionError, useDeploymentChangePress } from './deploymentActionOutcome';
import type { createDeploymentActions } from './deploymentActions';
import { deploymentActionRefusalRemedy } from './deploymentPresentation';
import { deploymentDatabaseMoveDestination, deploymentRestoreOperands } from './deploymentRestore';
import { deploymentSheetStyles, showDeploymentSheet } from './deploymentSheet';
import { useDeploymentEnvironmentRecord } from './useDeploymentReads';

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
  machine: string;
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
  const [code, setCode] = React.useState<string | null>(null);
  const select = React.useCallback((row: DeploymentEnvironmentCollectionV1['items'][number]) => {
    setSelectedId(row.environment.id); setCode(null);
  }, []);
  const copy = async () => {
    if (busy || !destination || !selection) return;
    setBusy(true); setCode(null);
    try {
      const backed = await props.actions.runBackup(props.backupTarget);
      if (backed.kind !== 'verified') { setCode(backed.kind); return; }
      const configuration = props.source.content.backup;
      const dump = configuration && 'configRevision' in configuration
        ? configuration.sources.find(source => source.kind === 'dump' && source.service === props.data.service) : undefined;
      const manifest = backed.manifests.find(entry => entry.sourceId === dump?.sourceId);
      if (!manifest) { setCode('backup_required'); return; }
      const backup = { deploymentId: props.backupTarget.deploymentId, restoreBackupId: manifest.snapshot.snapshotId,
        takenAtMs: Date.parse(manifest.snapshot.time), service: selection.sourceService, database: selection.database, versionLabel: null };
      const operands = deploymentRestoreOperands(props.source, backup, { detail: destination, service: selection.sourceService,
        database: selection.database, backupOperationId: backed.operationId });
      if (!operands) { setCode('machine_unavailable'); return; }
      props.onClose();
      showDeploymentRestoreSheet({ name: destination.content.name, machine: props.machine, backup, operands,
        restore: props.actions.restore, onApproval: props.review.request,
        continuation: { title: t('projects.deployments.databaseMoveReview'), onContinue: restored => {
          const prepared = props.actions.prepareDatabaseMoveCutover(props.source.environment, props.source.content,
            { ...selection, sourceService: props.data.service }, restored);
          showDeploymentSheet({ component: DeploymentDatabaseMoveCutoverSheet,
            props: { prepared, review: props.review, name: destination.content.name, sourceService: props.data.service },
            title: t('projects.deployments.databaseMoveReview'), testID: 'project-deployments.move.review.modal' });
        } },
      });
    } catch (error) {
      const outcome = readDeploymentActionError(error);
      if (outcome.kind === 'approval') { props.onClose(); props.review.request(outcome.artifactId); }
      else if (outcome.kind === 'refused') setCode(outcome.code);
    } finally { setBusy(false); }
  };
  const footer = <ModalCardFooterActions cancel={{ onPress: props.onClose, disabled: busy }}>
    <RoundButton testID="project-deployments.move.copy" size="normal" title={t('projects.deployments.databaseMoveCopy')}
      disabled={busy || !selection} loading={busy} onPress={() => { void copy(); }} />
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
      {code ? <SurfaceStateCard testID="project-deployments.move.refused" size="line" kind="error"
        title={t('projects.deployments.restoreRefused')} diagnosticCode={code} reason={deploymentActionRefusalRemedy(code)} /> : null}
      {setChrome ? null : footer}
    </View>
  </ListPresentationProvider>;
}

type Prepared = ReturnType<Actions['prepareDatabaseMoveCutover']>;
function DeploymentDatabaseMoveCutoverSheet(props: Readonly<{ prepared: Prepared; review: DeploymentReviewHandle;
  name: string; sourceService: string }> & CustomModalInjectedProps) {
  const [done, setDone] = React.useState(false);
  const press = useDeploymentChangePress({ request: artifactId => { props.onClose(); props.review.request(artifactId); } }, () => setDone(true));
  const prepared = props.prepared;
  const footer = done || prepared.kind !== 'ready' ? <ModalCardFooterActions>
    <RoundButton size="normal" title={t('common.done')} onPress={props.onClose} />
  </ModalCardFooterActions> : <ModalCardFooterActions cancel={{ onPress: props.onClose, disabled: press.running }}>
    <RoundButton testID="project-deployments.move.save" size="normal" title={t('common.save')} loading={press.running}
      disabled={press.running} onPress={() => { void press.press(() => prepared.save()); }} />
  </ModalCardFooterActions>;
  const { setChrome } = props;
  React.useEffect(() => { setChrome?.({ kind: 'card', footer }); });
  React.useEffect(() => () => setChrome?.(null), [setChrome]);
  return <ListPresentationProvider value="page" pageInsets="contained">
    <View testID="project-deployments.move.review" style={deploymentSheetStyles.body}>
      {done ? <SurfaceStateCard testID="project-deployments.move.saved" size="details" kind="success" title={t('projects.deployments.databaseMoveDone')} />
        : prepared.kind !== 'ready' ? <SurfaceStateCard size="line" kind="unavailable" title={t('projects.deployments.databaseMoveUnavailable')}
          diagnosticCode={prepared.reason} reason={'variable' in prepared ? prepared.variable : undefined} /> : <>
          <Text style={deploymentSheetStyles.lead}>{t('projects.deployments.databaseMoveReviewLead')}</Text>
          <ItemGroup title={t('projects.deployments.databaseMoveDestination')}>
            <Item title={props.name} mode="info" />
            <Item title={t('projects.deployments.databaseMoveRemovedService')} detail={props.sourceService} mode="info" />
          </ItemGroup>
          <ItemGroup title={t('projects.deployments.databaseMoveBindings')}>
            {prepared.patch.bindings?.set.map(binding => <Item key={binding.name} title={binding.name} mode="info" />)}
          </ItemGroup>
          <ItemGroup title={t('projects.deployments.databaseMoveDefinition')}>
            <CodeBlockView code={prepared.patch.definition?.document ?? ''} language="yaml" showCopyButton showHeaderRow={false} wrap />
          </ItemGroup>
          {press.outcome?.kind === 'refused' ? <SurfaceStateCard size="line" kind="error" title={t('projects.deployments.databaseMoveUnavailable')}
            diagnosticCode={press.outcome.code} reason={deploymentActionRefusalRemedy(press.outcome.code)} /> : null}
        </>}
      {setChrome ? null : footer}
    </View>
  </ListPresentationProvider>;
}
