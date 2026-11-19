import * as React from 'react';
import { View } from 'react-native';
import type { DeploymentEnvironmentDestinationV1, DeploymentEnvironmentReadDetailV1 } from '@happier-dev/deployments';
import type { CustomModalInjectedProps } from '@/modal/types';
import type { ServerAccountScopeLifetime } from '@/sync/domains/scope/serverAccountScope';
import type { RegistryCatalogItemSummary } from '@/registries/registryBrandMark';
import { describeRegistrySourceFailure } from '@/registries/describeRegistrySourceStatus';
import { useStoreAppListing } from '@/components/store/useStoreAppListing';
import { buildCatalogAppTemplateBindings } from '@/sync/ops/actions/deploymentPublishActions';
import { ModalCardFooterActions } from '@/modal/components/card/ModalCardFooterActions';
import { RoundButton } from '@/components/ui/buttons/RoundButton';
import { DiffViewer } from '@/components/ui/code/diff/DiffViewer';
import { requestOpenExternalUrl } from '@/utils/url/requestOpenExternalUrl';
import type { DeploymentTemplateInstantiationReviewV1 } from '@happier-dev/protocol/deployments/deploymentTemplateInstantiationV1';
import { ListPresentationProvider } from '@/components/ui/lists/listPresentation';
import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { SurfaceStateCard } from '@/components/ui/surfaces/SurfaceStateCard';
import { Text } from '@/components/ui/text/Text';
import { RegistrySourcesView } from '@/registries/RegistrySourcesView';
import { randomUUID } from '@/platform/randomUUID';
import { t } from '@/text';
import { readDeploymentRefusalRecoveryV1, type DeploymentFailureRecoveryDestinationV1 } from '@happier-dev/protocol/deployments/deploymentFailureRecoveryV1';
import type { DeploymentReviewHandle } from './DeploymentEnvironmentDetail';
import { deploymentSheetStyles, showDeploymentSheet } from './deploymentSheet';
import { deploymentActionRefusalRemedy } from './deploymentPresentation';
import { deploymentPartialRecoveryTab, readDeploymentActionError, useDeploymentChangePress } from './deploymentActionOutcome';
import { DeploymentPartialProgress } from './DeploymentPartialProgress';
import { createDeploymentActions } from './deploymentActions';
import { sameStrictJsonValue } from '@happier-dev/protocol/json/strictJsonValue';
import { DeploymentTemplateChoices, type DeploymentTemplateChoicesValue } from './DeploymentTemplateChoices';
import { projectDeploymentTemplateDomainChoices } from './DeploymentTemplateDomainRows';
import { DeploymentTemplateMappingCorrection } from './DeploymentTemplateMappingCorrection';

type Detail = DeploymentEnvironmentReadDetailV1;

type AddOperands = Omit<Parameters<ReturnType<typeof createDeploymentActions>['instantiateTemplate']>[0],
  'mode' | 'templateRef' | 'bindings' | 'generatedSecretAudience'>;
type Preflight = (
  | Readonly<{ status: 'checking' }>
  | Readonly<{ status: 'ready'; shortOn: readonly ('memoryBytes' | 'freeDiskBytes')[]; firstRun: boolean; document?: string;
      publicFiles?: readonly Readonly<{ path: string; content: string }>[]; generatedSecrets: number;
      repositoryChange?: DeploymentTemplateInstantiationReviewV1['repositoryChange'] }>
  | Readonly<{ status: 'failed'; code: string }>) & Readonly<{ connectToServices?: readonly string[] }>;

export function DeploymentAddReview(props: Readonly<{
  item: RegistryCatalogItemSummary;
  detail: Detail;
  lifetime: ServerAccountScopeLifetime;
  review: DeploymentReviewHandle;
  machine: string;
  operands: AddOperands;
  update?: boolean;
  onBack: () => void;
  onClose: () => void;
  onOpenRecovery?: (destination: DeploymentFailureRecoveryDestinationV1) => void;
  onManageSource?: () => void;
  onNavigate?: (destination: DeploymentEnvironmentDestinationV1) => void;
  setChrome: CustomModalInjectedProps['setChrome'];
}>) {
  const read = useStoreAppListing({ selection: props.item, lifetime: props.lifetime, demand: { presented: true } });
  const templateRef = read.kind === 'ready' ? read.templateRef : null;
  const needsReview = read.kind === 'needs_review';
  const app = read.kind === 'ready' ? read.app : null;
  const [choices, setChoices] = React.useState<DeploymentTemplateChoicesValue>({});
  const [reviewedChoices, setReviewedChoices] = React.useState<DeploymentTemplateChoicesValue>({});
  const domainChoices = React.useMemo(() => app && !props.update
    ? projectDeploymentTemplateDomainChoices(app.domains, Object.fromEntries(
      choices.domainBindings?.map(binding => [binding.templateDomainId, binding.hostname]) ?? []))
    : undefined, [app, choices.domainBindings, props.update]);
  const invalidDomain = Boolean(domainChoices?.invalidKeys.size);
  const choicesChanged = !sameStrictJsonValue(choices, reviewedChoices);
  const reviewChoices = () => {
    if (invalidDomain) return;
    const normalized = choices.domainBindings && domainChoices ? { ...choices, domainBindings: domainChoices.bindings } : { ...choices };
    setChoices(normalized);
    setReviewedChoices(normalized);
  };
  const operands = app ? { ...props.operands, ...reviewedChoices,
    ...(read.kind === 'ready' && read.appMappingCorrection ? { appMappingCorrection: read.appMappingCorrection } : {}),
    ...(props.update ? { bindings: reviewedChoices.bindings ?? [] } : buildCatalogAppTemplateBindings(app, reviewedChoices.bindings)) } : null;
  const actions = React.useMemo(() => createDeploymentActions(props.lifetime, props.detail.environment.projectSourceId),
    [props.lifetime, props.detail.environment.projectSourceId]);
  const [preflight, setPreflight] = React.useState<Preflight>({ status: 'checking' });
  const [added, setAdded] = React.useState(false);
  const [pullRequestUrl, setPullRequestUrl] = React.useState<string | null>(null);
  const refKey = templateRef ? JSON.stringify(templateRef) : null;
  const operandsKey = JSON.stringify(operands);
  // The review's preview is the preflight: one read per chosen template, never repeated on its own.
  React.useEffect(() => {
    if (!templateRef || !operands) return;
    let live = true;
    setPreflight(previous => ({ status: 'checking', connectToServices: previous.connectToServices }));
    actions.instantiateTemplate({ ...operands, mode: 'preview', templateRef }).then((result) => {
      if (!live) return;
      if (result.kind !== 'preview') { setPreflight(previous => ({ status: 'failed', code: 'invalid_response', connectToServices: previous.connectToServices })); return; }
      setPreflight({ status: 'ready', firstRun: result.review.firstRunSetup === true, document: result.review.document,
        connectToServices: result.review.connectToServices ?? [], publicFiles: result.review.publicFiles, generatedSecrets: result.review.generatedSecrets.length, repositoryChange: result.review.repositoryChange,
        shortOn: (result.review.capacity ?? []).filter((entry) => entry.state === 'shortfall').map((entry) => entry.resource) });
    }, (error) => {
      if (!live) return;
      const outcome = readDeploymentActionError(error);
      setPreflight(previous => ({ status: 'failed', code: outcome.kind === 'refused' ? outcome.code : 'unknown_error', connectToServices: previous.connectToServices }));
    });
    return () => { live = false; };
    // The serialized ref and operands are the preview's identity.
  }, [actions, refKey, operandsKey, reviewedChoices]);
  const press = useDeploymentChangePress({ request: (artifactId) => { props.onClose(); props.review.request(artifactId); } },
    () => setAdded(true));
  const refusalCode = press.outcome?.kind === 'refused' ? press.outcome.code
    : preflight.status === 'failed' ? preflight.code : null;
  const partial = press.outcome?.kind === 'refused' ? press.outcome.progress : undefined;
  const add = () => {
    if (!templateRef || !operands) return;
    void press.press(async () => {
      const result = await actions.instantiateTemplate({ ...operands, mode: 'apply', templateRef,
        ...(props.update || operands.destination.kind === 'repositoryPullRequest' ? {} : { deploy: { requestKey: randomUUID() } }) }, { confirmed: true });
      if (result.kind === 'pullRequest') setPullRequestUrl(result.pullRequest.url);
      return result.kind === 'partial' ? { ok: false, error: result.errorCode, details: result } : { ok: true };
    });
  };
  const title = props.item.title;
  const currentFiles = props.detail.content.definition.kind === 'stored' ? props.detail.content.definition.publicFiles ?? [] : [];
  const proposedFiles = preflight.status === 'ready' ? preflight.publicFiles ?? [] : [];
  const filePaths = [...new Set([...currentFiles.map(file => file.path), ...proposedFiles.map(file => file.path)])];
  // A lost confirmation means the Add may have landed: pressing it again would race the change it just made.
  const outcomeUnknown = press.outcome?.kind === 'refused' && press.outcome.code === 'outcome_unknown';
  const footer = added || partial || outcomeUnknown ? (
    <ModalCardFooterActions>
      <RoundButton testID="project-deployments.add.done" size="normal"
        title={t(partial && props.onNavigate ? 'projects.deployments.openEnvironment' : outcomeUnknown ? 'common.close' : 'common.done')}
        onPress={() => {
          props.onClose();
          if (partial) props.onNavigate?.({ tab: deploymentPartialRecoveryTab(partial), section: null });
        }} />
    </ModalCardFooterActions>
  ) : (
    <ModalCardFooterActions cancel={{ onPress: props.onClose, testID: 'project-deployments.add.cancel', disabled: press.running }}>
      {props.update ? null : <RoundButton testID="project-deployments.add.back" size="normal" display="secondary" disabled={press.running}
        title={t('projects.deployments.addBack')} onPress={props.onBack} />}
      {/* Changed choices are reviewed by the same primary press, so Add never sits disabled without saying why (D27). */}
      <RoundButton testID="project-deployments.add.confirm" size="normal" title={choicesChanged ? t('capabilities.store.appPage.review')
        : t(props.operands.destination.kind === 'repositoryPullRequest'
          ? 'projects.deployments.settingsSections.moveToRepository.review' : props.update ? 'common.save' : 'projects.deployments.addConfirm')}
        disabled={!templateRef || invalidDomain || press.running || preflight.status === 'checking' || (!choicesChanged && preflight.status !== 'ready')}
        loading={press.running} onPress={choicesChanged ? reviewChoices : add} />
    </ModalCardFooterActions>
  );
  const { setChrome } = props;
  React.useEffect(() => { setChrome?.({ kind: 'card', footer }); });
  React.useEffect(() => () => setChrome?.(null), [setChrome]);
  return (
    <ListPresentationProvider value="page" pageInsets="contained">
      <View testID="project-deployments.add.review" style={deploymentSheetStyles.body}>
        {added ? (
          <>
            <SurfaceStateCard testID="project-deployments.add.added" size="details" layout="inline" kind="success"
              title={pullRequestUrl ? t('projects.deployments.overviewStatus.catalogRepositoryOpened') : props.update ? t('projects.deployments.overviewStatus.catalogUpdateSaved') : t('projects.deployments.addAdded', { name: title })}
              {...(pullRequestUrl ? { reason: t('projects.deployments.overviewStatus.catalogRepositoryBody'),
                action: { label: pullRequestUrl, onPress: () => { void requestOpenExternalUrl(pullRequestUrl); }, testID: 'project-deployments.add.pullRequest' } } : {})} />
            {preflight.status === 'ready' && preflight.firstRun ? (
              <SurfaceStateCard testID="project-deployments.add.firstRun" size="details" layout="inline" kind="empty"
                title={t('projects.deployments.addFirstRunTitle')} reason={t('projects.deployments.addFirstRunBody')} />
            ) : null}
          </>
        ) : (
          <>
            <Text style={deploymentSheetStyles.lead}>{props.operands.destination.kind === 'repositoryPullRequest' ? t('projects.deployments.overviewStatus.catalogRepositoryBody') : props.update ? t('projects.deployments.overviewStatus.catalogUpdateBody')
              : t('projects.deployments.addDeploysNow', { name: title, machine: props.machine })}</Text>
            <ItemGroup testID="project-deployments.add.facts" header="none">
              <Item testID="project-deployments.add.template" title={title} subtitle={props.item.description ?? undefined} mode="info" />
              {preflight.status === 'ready' && preflight.repositoryChange ? <Item
                testID="project-deployments.template.repositoryBase" title={preflight.repositoryChange.repository.repository}
                subtitle={`${preflight.repositoryChange.baseBranch} · ${preflight.repositoryChange.baseCommit}`} mode="info" /> : null}
              {preflight.status === 'ready' && preflight.generatedSecrets > 0 ? (
                <Item testID="project-deployments.add.secrets" mode="info"
                  title={t('capabilities.store.appPage.secretsTitle', { count: preflight.generatedSecrets })}
                  subtitle={t('capabilities.store.appPage.secretsBody')} />
              ) : null}
              {read.kind === 'ready' ? <Item testID="project-deployments.add.preflight" title={t('projects.deployments.addPreflight')} mode="info"
                detail={preflight.status === 'checking' ? t('projects.deployments.addChecking')
                  : preflight.status === 'failed' ? undefined
                    : preflight.shortOn.length === 0 ? t('projects.deployments.addRoomOk') : undefined}
                {...(preflight.status === 'ready' && preflight.shortOn.length > 0 ? { subtitle: t(preflight.shortOn.includes('memoryBytes')
                  ? 'projects.deployments.addShortMemory' : 'projects.deployments.addShortDisk') } : {})} /> : null}
            </ItemGroup>
            {preflight.status === 'ready' && preflight.repositoryChange ? preflight.repositoryChange.files.map(file =>
              <View key={file.path} testID="project-deployments.template.repositoryDiff">
                <Item title={file.path} mode="info" />
                <DiffViewer mode="text" oldText={file.before ?? ''} newText={file.content ?? ''} />
              </View>) : null}
            {read.kind === 'ready' && !props.update ? <>
              <DeploymentTemplateChoices template={read.app} lifetime={props.lifetime} value={choices} onChange={setChoices}
                services={preflight.connectToServices ?? []} domainChoices={domainChoices} testID="project-deployments.add.choices"
                existingVariableNames={props.detail.content.bindings.flatMap(binding => binding.purpose === 'variable' ? [binding.name] : [])} />
              {!choicesChanged && preflight.status === 'failed' ? <RoundButton testID="project-deployments.add.reviewChoices"
                size="small" display="secondary" title={t('capabilities.store.appPage.review')} disabled={preflight.status === 'checking' || press.running}
                onPress={reviewChoices} /> : null}
            </> : null}
            {props.update && preflight.status === 'ready' && preflight.document && props.detail.content.definition.kind === 'stored' ? <>
              <DiffViewer mode="text" oldText={props.detail.content.definition.document} newText={preflight.document}
                filePath="compose.yaml" testID="project-deployments.template.diff" />
              {filePaths.map(path => <DiffViewer key={path} mode="text" filePath={path}
                oldText={currentFiles.find(file => file.path === path)?.content ?? ''}
                newText={proposedFiles.find(file => file.path === path)?.content ?? ''} />)}
            </> : null}
            {read.kind === 'loading' ? <SurfaceStateCard testID="project-deployments.add.itemLoading" size="line" kind="loading"
              title={t('common.loading')} /> : null}
            {read.kind === 'unavailable' ? <SurfaceStateCard testID="project-deployments.add.itemUnavailable" size="line" kind="error"
              title={t('projects.deployments.addRefused')} reason={describeRegistrySourceFailure(read.status)} diagnosticCode={read.error}
              action={{ label: t('common.retry'), onPress: () => { void read.refresh(); } }} /> : null}
            {props.update && read.kind === 'unavailable' && props.onManageSource ? <RoundButton size="small" display="secondary"
              title={t('capabilities.registries.select.manage')} onPress={props.onManageSource} /> : null}
            {read.kind === 'needs_review' && read.reviewSource ? <DeploymentTemplateMappingCorrection source={read.reviewSource}
              onReview={read.correctMappings} testID="project-deployments.add.mapping" /> : null}
            {needsReview ? <SurfaceStateCard testID="project-deployments.add.needsReview" size="line" kind="unavailable"
              title={t('projects.deployments.addNeedsReview')} /> : null}
            {partial && press.outcome?.kind === 'refused' && press.outcome.failure ? (
              <DeploymentPartialProgress testID="project-deployments.add.progress" progress={partial} failure={press.outcome.failure} />
            ) : null}
            {/* Partial results keep the failed step and saved work together in their existing presenter. */}
            {!partial && refusalCode ? <DeploymentAddRefusal testID="project-deployments.add.refused" code={refusalCode}
              {...(props.onOpenRecovery ? { onOpenRecovery: (destination: DeploymentFailureRecoveryDestinationV1) => {
                props.onClose(); props.onOpenRecovery?.(destination);
              } } : {})} /> : null}
          </>
        )}
        {setChrome ? null : footer}
      </View>
    </ListPresentationProvider>
  );
}

/**
 * A refused Add, said once: the shared recovery owner's sentence and its one next step. A code that owner does not know
 * keeps the generic remedy with its diagnostic code.
 */
export function DeploymentAddRefusal(props: Readonly<{
  testID: string;
  code: string;
  onOpenRecovery?: (destination: DeploymentFailureRecoveryDestinationV1) => void;
}>) {
  const recovery = readDeploymentRefusalRecoveryV1(props.code);
  const { onOpenRecovery } = props;
  if (!recovery) {
    return <SurfaceStateCard testID={props.testID} size="line" kind="error" title={t('projects.deployments.addRefused')}
      reason={deploymentActionRefusalRemedy(props.code)} diagnosticCode={props.code} />;
  }
  return <SurfaceStateCard testID={props.testID} size="line" kind="error" title={recovery.remedy}
    {...(onOpenRecovery ? { action: { label: recovery.nextAction.label, testID: `${props.testID}.next`,
      onPress: () => onOpenRecovery(recovery.nextAction.destination) } } : {})} />;
}

export function showDeploymentAppSourcesSheet(sourceId: string): void {
  showDeploymentSheet({ component: DeploymentAppSourcesSheet, props: { sourceId },
    title: t('capabilities.registries.select.manage'), testID: 'project-deployments.template.sources' });
}

function DeploymentAppSourcesSheet(props: Readonly<{ sourceId: string }> & CustomModalInjectedProps) {
  const [selected, setSelected] = React.useState<string | null>(props.sourceId);
  return <RegistrySourcesView kind="app" enabled initialIntent="manage" onBack={props.onClose}
    selection={{ value: selected, onChange: setSelected, onStale: () => setSelected(null), navigationBackClosesDetail: false }}
    testID="project-deployments.template.sources.view" />;
}
