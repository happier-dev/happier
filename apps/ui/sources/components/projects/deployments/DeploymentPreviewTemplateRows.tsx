import * as React from 'react';
import { View } from 'react-native';
import { useUnistyles } from 'react-native-unistyles';
import type { DeploymentEnvironmentReadDetailV1, DeploymentReadControllerV1, DeploymentReadDemandV1 } from '@happier-dev/deployments';
import { DropdownMenu } from '@/components/ui/forms/dropdown/DropdownMenu';
import { Item } from '@/components/ui/lists/Item';
import { SegmentedChoiceItem, type SegmentedChoiceOption } from '@/components/ui/lists/SegmentedChoiceItem';
import { Switch } from '@/components/ui/forms/Switch';
import { StatusDot } from '@/components/ui/status/StatusDot';
import { useProjectSource } from '@/components/projects/sources/useProjectSources';
import { readProjectRepositoryIdentityV1 } from '@/sync/domains/widgets/projectWidgetAreaContext';
import type { ServerAccountScopeLifetime } from '@/sync/domains/scope/serverAccountScope';
import { t } from '@/text';
import type { createDeploymentActions } from './deploymentActions';
import { DeploymentPreviewBranchChoice } from './DeploymentPreviewBranchChoice';
import { DeploymentPreviewNativeChoice } from './DeploymentPreviewNativeChoice';
import { showDeploymentSheet } from './deploymentSheet';
import { DeploymentPreviewDomainChoice } from './DeploymentPreviewDomainChoice';
import { sourceWord } from './DeploymentCreationDefaultsRows';
import { SectionActionButton } from '@/components/ui/lists/SectionActionButton';
import { SurfaceStateCard } from '@/components/ui/surfaces/SurfaceStateCard';
import { Typography } from '@/constants/Typography';
import { useEventCallback } from '@/hooks/ui/useEventCallback';
import { DeploymentPreviewTemplateV1Schema, type DeploymentPreviewForkEligibilityV1 } from '@happier-dev/protocol/deployments/deploymentPreviewTemplateV1';

/**
 * The preview template this Environment carries (lab `d5d/template`, `previewdb/template`, `previewdb/branch`,
 * `d5d/prodmachine`): whether new pull requests get previews, where they run, their address pattern and their data.
 * Read from the Environment's own content; fork opt-in consumes the host's placement admission.
 */
type PreviewTemplate = NonNullable<DeploymentEnvironmentReadDetailV1['content']['previewTemplate']>;
type PreviewData = 'own' | 'branch' | 'none';

function previewDataKind(template: PreviewTemplate): PreviewData {
  const data = template.data[0];
  return !data ? 'none' : data.kind === 'managed' ? 'branch' : 'own';
}

type PreviewTemplateRowsProps = Readonly<{
  detail: DeploymentEnvironmentReadDetailV1;
  controller: DeploymentReadControllerV1;
  demand: DeploymentReadDemandV1;
  machineName: (machineId: string) => string;
  /** Saves the whole next template once through `environments.update` (patch.previewTemplate); absent for viewers. */
  onSave: ((next: PreviewTemplate) => void) | null;
  saving: boolean;
  inspect: ReturnType<typeof createDeploymentActions>['inspectPlatformTarget'] | null;
  prepareDefaults: ReturnType<typeof createDeploymentActions>['prepareConfigurationDefaults'] | null;
  prepareForkPolicy?: ReturnType<typeof createDeploymentActions>['preparePreviewForkPolicy'] | null;
  onChooseMachine?: (() => void) | null;
  /** The captured Home/Account the Project repository is read under; absent while it is not current. */
  lifetime: ServerAccountScopeLifetime | null;
  unresolvedData?: 'own' | 'branch';
  onDataChoice?: (choice: PreviewData) => void;
  requireRuntimeChoice?: boolean;
  onRuntimeChoice?: () => void;
  testID: string;
}>;

export function PreviewTemplateRows(props: PreviewTemplateRowsProps) {
  const { theme } = useUnistyles();
  const template = props.detail.content.previewTemplate;
  const onSaveTemplate = props.onSave;
  // The saved data selections this page has seen, so switching to None and back keeps the exact choice.
  const [seenData, setSeenData] = React.useState<Readonly<Partial<Record<'own' | 'branch', PreviewTemplate['data']>>>>({});
  const [choosingBranch, setChoosingBranch] = React.useState(false);
  const [runtimeOpen, setRuntimeOpen] = React.useState(false);
  React.useEffect(() => {
    const kind = template ? previewDataKind(template) : 'none';
    if (template && kind !== 'none') setSeenData((seen) => seen[kind] === template.data ? seen : { ...seen, [kind]: template.data });
  }, [template]);
  if (!template) {
    return <PreviewSetupRow {...props} onSave={onSaveTemplate} />;
  }
  const { onSave } = props;
  const runtimeLinks = props.detail.targetLinks.map((row) => row.targetLink).filter((link) => link.role === 'runtime');
  const linkName = (link: (typeof runtimeLinks)[number] | undefined) => {
    const machines = link && 'machines' in link && Array.isArray(link.machines) ? link.machines.map(props.machineName) : [];
    return machines.join(', ') || link?.targetKind || '';
  };
  const link = runtimeLinks.find((candidate) => candidate.id === template.runtimeTargetLinkId);
  const sharesProduction = template.runtimeTargetLinkId === (props.detail.environment.runtimeTargetLinkId ?? props.detail.runtimeTargetLink?.id);
  const dataKind = props.unresolvedData ?? previewDataKind(template);
  const save = (patch: Partial<PreviewTemplate>) => onSave?.({ ...template, ...patch });
  const nativeSelection = template.data.find(selection => selection.kind === 'template');
  const openNative = () => {
    const lifetime = props.lifetime;
    if (!lifetime) return;
    showDeploymentSheet({ component: DeploymentPreviewNativeChoice,
      props: { detail: props.detail, lifetime, machineName: props.machineName,
        initialSelection: nativeSelection, onSelect: selection => save({ data: [selection] }), testID: `${props.testID}.native` },
      title: t('projects.deployments.settingsSections.previewsDataOwn'), testID: `${props.testID}.native.modal` });
  };
  const chooseRuntime = (runtimeTargetLinkId: string) => {
    props.onRuntimeChoice?.();
    save({ runtimeTargetLinkId });
  };
  const canChooseBranch = !!props.lifetime && !!props.inspect
    && props.detail.targetLinks.some(row => row.targetLink.role === 'data' && row.targetLink.source.kind === 'plugin');
  // A reason marks its segment unavailable (the shared segmented row rule), so only an option that cannot be chosen carries
  // one. Under the row the reason stands alone, so a single unavailable option names itself.
  const ownUnavailable = !props.lifetime && !seenData.own && dataKind !== 'own';
  const branchUnavailable = !seenData.branch && dataKind !== 'branch' && !canChooseBranch;
  const bothUnavailable = ownUnavailable && branchUnavailable;
  const unavailable = (own: boolean) => bothUnavailable ? t('projects.deployments.settingsSections.previewsDataUnavailable')
    : own ? t('projects.deployments.settingsSections.previewsDataOwnUnavailable')
      : t('projects.deployments.settingsSections.previewsDataBranchUnavailable');
  const dataOptions: ReadonlyArray<SegmentedChoiceOption<PreviewData>> = [
    { id: 'own', label: t('projects.deployments.settingsSections.previewsDataOwn'),
      ...(ownUnavailable ? { disabled: true, unavailableReason: unavailable(true) } : {}) },
    { id: 'branch', label: t('projects.deployments.settingsSections.previewsDataBranch'),
      ...(branchUnavailable ? { disabled: true, unavailableReason: unavailable(false) } : {}) },
    { id: 'none', label: t('projects.deployments.settingsSections.previewsDataNone') },
  ];
  const runsOnSubtitle = sharesProduction ? t('projects.deployments.settingsSections.previewsProductionMachine') : undefined;
  const runsOnLeading = sharesProduction ? <StatusDot size={6} color={theme.colors.state.warning.foreground} /> : undefined;
  return (
    <>
      <Item
        testID={`${props.testID}.enabled`}
        title={t('common.enabled')}
        subtitle={template.enabled
          ? t('projects.deployments.settingsSections.previewsOn')
          : t('projects.deployments.settingsSections.previewsOff')}
        mode={onSave ? undefined : 'info'}
        rightElement={onSave ? (
          <Switch value={template.enabled} disabled={props.saving}
            onValueChange={(enabled) => save({ enabled })} />
        ) : undefined}
      />
      {onSave && runtimeLinks.length > 0 && runtimeLinks.length <= 4 && (runtimeLinks.length > 1 || props.requireRuntimeChoice) ? (
        <SegmentedChoiceItem<string>
          testID={`${props.testID}.runsOn`}
          testIDPrefix={`${props.testID}.runsOn`}
          title={t('projects.deployments.settingsSections.previewsRunsOn')}
          subtitle={runsOnSubtitle}
          subtitleLeading={runsOnLeading}
          accessoryLayout="adaptive"
          options={runtimeLinks.map((candidate) => ({ id: candidate.id, label: linkName(candidate) }))}
          value={props.requireRuntimeChoice ? null : template.runtimeTargetLinkId}
          disabled={props.saving}
          onChange={chooseRuntime}
        />
      ) : onSave && runtimeLinks.length > 4 ? (
        <DropdownMenu testID={`${props.testID}.runsOn`} open={runtimeOpen} onOpenChange={setRuntimeOpen}
          items={runtimeLinks.map(candidate => ({ id: candidate.id, title: linkName(candidate) }))}
          selectedId={props.requireRuntimeChoice ? null : template.runtimeTargetLinkId}
          onSelect={runtimeTargetLinkId => { setRuntimeOpen(false); chooseRuntime(runtimeTargetLinkId); }}
          itemTrigger={{ title: t('projects.deployments.settingsSections.previewsRunsOn'), subtitle: runsOnSubtitle,
            detailFormatter: () => linkName(link), itemProps: { accessoryLayout: 'adaptive', disabled: props.saving } }} />
      ) : (
        <Item
          testID={`${props.testID}.runsOn`}
          title={t('projects.deployments.settingsSections.previewsRunsOn')}
          subtitle={[linkName(link), runsOnSubtitle].filter(Boolean).join('\n')}
          subtitleLeading={runsOnLeading}
          mode="info"
        />
      )}
      {onSave ? <DeploymentPreviewDomainChoice controller={props.controller} demand={props.demand}
        environmentId={props.detail.environment.id} domain={template.domain} saving={props.saving}
        onSave={domain => save({ domain })} testID={props.testID} /> : template.domain ? (
        <Item testID={`${props.testID}.address`} title={t('projects.deployments.settingsSections.previewsAddress')}
          detail={template.domain.hostnamePattern} mode="info" />
      ) : null}
      {onSave ? (
        <SegmentedChoiceItem<PreviewData>
          testID={`${props.testID}.data`}
          testIDPrefix={`${props.testID}.data`}
          title={t('projects.deployments.settingsSections.previewsData')}
          accessoryLayout="adaptive"
          options={dataOptions}
          value={choosingBranch ? 'branch' : dataKind}
          disabled={props.saving}
          onChange={(next) => {
            props.onDataChoice?.(next);
            setChoosingBranch(next === 'branch');
            if (next === 'own' && !seenData.own && !nativeSelection) { openNative(); return; }
            if (next === dataKind) return;
            const data = next === 'none' ? [] : seenData[next];
            if (data) save({ data });
          }}
        />
      ) : (
        <Item
          testID={`${props.testID}.data`}
          title={t('projects.deployments.settingsSections.previewsData')}
          detail={dataOptions.find((option) => option.id === dataKind)?.label}
          mode="info"
        />
      )}
      {onSave && props.lifetime && nativeSelection && dataKind === 'own' ? (
        <Item testID={`${props.testID}.native.selected`} title={t('projects.deployments.settingsSections.previewEditor.nativeTemplate')}
          detail={nativeSelection.templateRef.itemId} mode="info" rightElement={
            <SectionActionButton testID={`${props.testID}.native.configure`} title={t('common.edit')}
              disabled={props.saving} onPress={openNative} />} />
      ) : null}
      {onSave && props.lifetime && props.inspect && (choosingBranch || dataKind === 'branch') ? (
        <DeploymentPreviewBranchChoice detail={props.detail} lifetime={props.lifetime} inspect={props.inspect}
          saving={props.saving} onSave={(data) => save({ data })} testID={`${props.testID}.branch`} />
      ) : null}
      {onSave && props.prepareForkPolicy ? (
        <PreviewForkChoice environment={props.detail.environment} template={template} prepare={props.prepareForkPolicy}
          runtimeTargetLinkRevision={link?.revision ?? null}
          saving={props.saving} onSave={next => save({ forkPreviews: next })}
          onChooseMachine={props.onChooseMachine} testID={`${props.testID}.forkPolicy`} />
      ) : template.forkPreviews === 'off' ? (
        <Item testID={`${props.testID}.forks`} title={t('projects.deployments.settingsSections.previewsForks')}
          titleStyle={Typography.default('regular')} mode="info" />
      ) : null}
    </>
  );
}

function PreviewForkChoice(props: Readonly<{
  environment: DeploymentEnvironmentReadDetailV1['environment'];
  template: PreviewTemplate;
  runtimeTargetLinkRevision: number | null;
  prepare: NonNullable<PreviewTemplateRowsProps['prepareForkPolicy']>;
  saving: boolean;
  onSave: (policy: PreviewTemplate['forkPreviews']) => void;
  onChooseMachine?: (() => void) | null;
  testID: string;
}>) {
  const [eligibility, setEligibility] = React.useState<DeploymentPreviewForkEligibilityV1 | null>(null);
  const [failed, setFailed] = React.useState(false);
  const [retry, setRetry] = React.useState(0);
  const prepare = useEventCallback((signal: AbortSignal) => props.prepare(props.environment,
    { repository: props.template.repository, runtimeTargetLinkId: props.template.runtimeTargetLinkId }, { signal }));
  React.useEffect(() => {
    const controller = new AbortController();
    setEligibility(null);
    setFailed(false);
    void prepare(controller.signal).then(result => {
      if (!controller.signal.aborted) setEligibility(result);
    }, () => { if (!controller.signal.aborted) setFailed(true); });
    return () => controller.abort();
  }, [props.environment.id, props.environment.buildMachineId, props.environment.protection,
    props.template.runtimeTargetLinkId, props.runtimeTargetLinkRevision, props.prepare, prepare, retry]);
  const allowed = eligibility?.kind === 'eligible';
  const reason = eligibility?.kind === 'ineligible'
    ? t(eligibility.reason === 'production_workload' ? 'projects.deployments.settingsSections.previewEditor.forksProduction'
      : 'projects.deployments.settingsSections.previewEditor.forksUnsupported')
    : eligibility?.kind === 'unavailable' || failed ? t('projects.deployments.settingsSections.previewEditor.forksUnavailable')
      : !eligibility ? t('projects.deployments.settingsSections.previewEditor.forksLoading') : undefined;
  const labels: Record<PreviewTemplate['forkPreviews'], string> = {
    off: t('projects.deployments.settingsSections.previewEditor.forksOff'),
    approveEachCommit: t('projects.deployments.settingsSections.previewEditor.forksApprove'),
  };
  return <>
    <SegmentedChoiceItem<PreviewTemplate['forkPreviews']> testID={props.testID} testIDPrefix={props.testID}
      title={t('projects.deployments.settingsSections.previewEditor.forks')}
      subtitle={t('projects.deployments.settingsSections.previewEditor.forksBody')} accessoryLayout="adaptive"
      options={Object.values(DeploymentPreviewTemplateV1Schema.shape.forkPreviews._zod.def.entries).map(id => ({ id, label: labels[id],
        disabled: id === 'approveEachCommit' && !allowed,
        ...(id === 'approveEachCommit' && !allowed ? { unavailableReason: reason } : {}) }))}
      value={props.template.forkPreviews} disabled={props.saving}
      onChange={next => { if (next === 'off' || allowed) props.onSave(next); }} />
    {/* The choice above already says why; this row only offers the way forward. */}
    {failed ? <Item testID={`${props.testID}.retry`} title={t('common.retry')}
      onPress={() => setRetry(value => value + 1)} /> : null}
    {eligibility && !allowed && props.onChooseMachine ? <Item
      title={t('projects.deployments.settingsSections.previewEditor.forksChooseMachine')}
      onPress={props.onChooseMachine} /> : null}
  </>;
}

/**
 * No template yet (J6 entry): a repository-backed Environment turns previews on from its Project repository and its
 * own runtime link, saved once through `environments.update` (patch.previewTemplate). A stored definition says why
 * previews need a repository instead. The rest of the template is edited in the rows above once it exists.
 */
function PreviewSetupRow(props: PreviewTemplateRowsProps) {
  if (props.detail.content.definition.kind === 'stored') {
    return (
      <Item
        testID={`${props.testID}.needsRepository`}
        title={t('projects.deployments.settingsSections.previewsNeedRepository')}
        subtitle={t('projects.deployments.settingsSections.previewsNeedRepositoryBody')}
        mode="info"
      />
    );
  }
  const runtimeTargetLinkId = props.detail.environment.runtimeTargetLinkId;
  // Without a manager's save path or a runtime link there is nothing to turn on; the preview list says there are none.
  if (!props.onSave || !props.lifetime || !runtimeTargetLinkId) return null;
  return <PreviewTurnOnRow {...props} lifetime={props.lifetime} onSave={props.onSave} runtimeTargetLinkId={runtimeTargetLinkId} />;
}

function PreviewTurnOnRow(props: Readonly<{
  detail: DeploymentEnvironmentReadDetailV1;
  lifetime: ServerAccountScopeLifetime;
  onSave: (next: PreviewTemplate) => void;
  saving: boolean;
  runtimeTargetLinkId: string;
  testID: string;
  prepareDefaults: ReturnType<typeof createDeploymentActions>['prepareConfigurationDefaults'] | null;
  prepareForkPolicy?: PreviewTemplateRowsProps['prepareForkPolicy'];
  onChooseMachine?: PreviewTemplateRowsProps['onChooseMachine'];
  controller: DeploymentReadControllerV1;
  demand: DeploymentReadDemandV1;
  machineName: (id: string) => string;
  inspect: ReturnType<typeof createDeploymentActions>['inspectPlatformTarget'] | null;
}>) {
  const { theme } = useUnistyles();
  const project = useProjectSource(props.lifetime, props.detail.environment.projectSourceId);
  const repository = readProjectRepositoryIdentityV1({ source: project.source?.source ?? null });
  const [draft, setDraft] = React.useState<PreviewTemplate | null>(null);
  const [defaults, setDefaults] = React.useState<Awaited<ReturnType<NonNullable<typeof props.prepareDefaults>>> | null>(null);
  const [loading, setLoading] = React.useState(false);
  const [failure, setFailure] = React.useState(false);
  const [unresolvedData, setUnresolvedData] = React.useState<'own' | 'branch' | undefined>();
  const [requireRuntimeChoice, setRequireRuntimeChoice] = React.useState(false);
  if (!repository) {
    return project.status === 'loading' ? null : (
      <Item testID={`${props.testID}.noRepository`}
        title={t('projects.deployments.settingsSections.previewsNoRepository')} mode="info" />
    );
  }
  // The template rows below carry the one Runs on row for the draft.
  if (draft) return <>
    {defaults && unresolvedData && draft.data.length === 0 ? <Item testID={`${props.testID}.data.default`}
      title={t('projects.deployments.settingsSections.previewsData')}
      detail={t(unresolvedData === 'own' ? 'projects.deployments.settingsSections.previewsDataOwn'
        : 'projects.deployments.settingsSections.previewsDataBranch')}
      subtitle={sourceWord(defaults.sources.previewDatabase)} mode="info" /> : null}
    <PreviewTemplateRows {...props} detail={{ ...props.detail, content: { ...props.detail.content, previewTemplate: draft } }}
      saving={props.saving} onSave={setDraft}
      unresolvedData={draft.data.length === 0 ? unresolvedData : undefined}
      onDataChoice={choice => setUnresolvedData(choice === 'none' ? undefined : choice)}
      requireRuntimeChoice={requireRuntimeChoice} onRuntimeChoice={() => setRequireRuntimeChoice(false)} />
    <Item title={t('projects.deployments.settingsSections.previewEditor.configure')} rightElement={<View style={{ flexDirection: 'row', alignItems: 'center', gap: theme.space.s8 }}>
      <SectionActionButton title={t('common.cancel')} onPress={() => { setDraft(null); setDefaults(null); }} />
      <SectionActionButton testID={`${props.testID}.setup.save`} title={t('common.save')}
        disabled={props.saving || requireRuntimeChoice || Boolean(unresolvedData && draft.data.length === 0)}
        onPress={() => { if (!requireRuntimeChoice && !(unresolvedData && draft.data.length === 0)) props.onSave(draft); }} />
    </View>} />
  </>;
  return (
    <>
    <Item
      testID={`${props.testID}.setup`}
      title={t('projects.deployments.settingsSections.previewsTitle')}
      subtitle={t('projects.deployments.settingsSections.previewsSetUpOff')}
      rightElement={
        <Switch value={false} disabled={props.saving || loading || !props.prepareDefaults} onValueChange={(enabled) => {
          if (!enabled || !props.prepareDefaults) return;
          setLoading(true); setFailure(false);
          void props.prepareDefaults(props.detail.environment, 'previews').then(resolved => {
            if (!props.lifetime.isCurrent()) return;
            const runtime = resolved.values.previewMachineId ? props.detail.targetLinks.find(row =>
              row.targetLink.role === 'runtime' && row.targetLink.machines?.includes(resolved.values.previewMachineId!))?.targetLink.id
              : props.runtimeTargetLinkId;
            setDefaults(resolved);
            setRequireRuntimeChoice(!runtime);
            setUnresolvedData(resolved.values.previewDatabase && resolved.values.previewDatabase !== 'none'
              ? resolved.values.previewDatabase : undefined);
            setDraft({ v: 1, enabled: true, forkPreviews: 'off', repository, runtimeTargetLinkId: runtime ?? props.runtimeTargetLinkId,
              domain: null, bindingBlueprints: [], data: [] });
          }).catch(() => setFailure(true)).finally(() => setLoading(false));
        }} />
      }
    />
    {failure ? <SurfaceStateCard kind="error" size="line" title={t('projects.deployments.settingsSections.previewsDataUnavailable')} /> : null}
    </>
  );
}

