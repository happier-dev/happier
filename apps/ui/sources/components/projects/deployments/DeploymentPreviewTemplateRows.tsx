import * as React from 'react';
import { View } from 'react-native';
import { presentConnectSheet } from '@/components/settings/connectedServices/setup/ConnectedServiceSetupModal';
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
import { HappyError } from '@/utils/errors/errors';
import type { createDeploymentActions } from './deploymentActions';
import { deploymentPreviewAvailability } from './deploymentPresentation';
import { DeploymentPreviewBranchChoice } from './DeploymentPreviewBranchChoice';
import { DeploymentPreviewNativeChoice } from './DeploymentPreviewNativeChoice';
import { showDeploymentSheet } from './deploymentSheet';
import { DeploymentPreviewDomainChoice } from './DeploymentPreviewDomainChoice';
import { sourceWord } from './DeploymentCreationDefaultsRows';
import { SectionActionButton } from '@/components/ui/lists/SectionActionButton';
import { SurfaceStateCard } from '@/components/ui/surfaces/SurfaceStateCard';
import { Typography } from '@/constants/Typography';
import { useEventCallback } from '@/hooks/ui/useEventCallback';
import { DeploymentPreviewTemplateV1Schema, DeploymentPreviewForkEligibilityV1Schema, type DeploymentPreviewForkEligibilityV1 } from '@happier-dev/protocol/deployments/deploymentPreviewTemplateV1';

/**
 * The preview template this Environment carries (lab `d5d/template`, `previewdb/template`, `previewdb/branch`,
 * `d5d/prodmachine`): whether new pull requests get previews, where they run, their address pattern and their data.
 * Read from the Environment's own content; fork opt-in consumes the host's placement admission.
 */
type PreviewTemplate = NonNullable<DeploymentEnvironmentReadDetailV1['content']['previewTemplate']>;
type WatcherOptions = Awaited<ReturnType<ReturnType<typeof createDeploymentActions>['preparePreviewWatcher']>>;
type WatcherAccount = WatcherOptions['options'][number]['value'];
type SavePreview = (next: PreviewTemplate, account?: WatcherAccount) => void;
type PreviewData = 'own' | 'branch' | 'none';

function previewDataKind(template: PreviewTemplate): PreviewData {
  const data = template.data[0];
  return !data ? 'none' : data.kind === 'managed' ? 'branch' : 'own';
}

type PreviewTemplateRowsProps = Readonly<{
  detail: DeploymentEnvironmentReadDetailV1;
  previewAvailability?: ReturnType<typeof deploymentPreviewAvailability>;
  controller: DeploymentReadControllerV1;
  demand: DeploymentReadDemandV1;
  machineName: (machineId: string) => string;
  /** Saves the whole next template once through `environments.update` (patch.previewTemplate); absent for viewers. */
  onSave: SavePreview | null;
  saving: boolean;
  inspect: ReturnType<typeof createDeploymentActions>['inspectPlatformTarget'] | null;
  prepareDefaults: ReturnType<typeof createDeploymentActions>['prepareConfigurationDefaults'] | null;
  prepareWatcher?: ReturnType<typeof createDeploymentActions>['preparePreviewWatcher'] | null;
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
  const [watcher, setWatcher] = React.useState<WatcherOptions | null>(null);
  const [watcherBusy, setWatcherBusy] = React.useState(false);
  const [watcherFailure, setWatcherFailure] = React.useState<string>();
  React.useEffect(() => {
    const kind = template ? previewDataKind(template) : 'none';
    if (template && kind !== 'none') setSeenData((seen) => seen[kind] === template.data ? seen : { ...seen, [kind]: template.data });
  }, [template]);
  const previewAvailability = props.previewAvailability ?? deploymentPreviewAvailability(props.detail);
  if (previewAvailability === 'preview') return null;
  if (previewAvailability === 'needsRepository') {
    return (
      <Item
        testID={`${props.testID}.needsRepository`}
        title={t('projects.deployments.settingsSections.previewsNeedRepository')}
        subtitle={t('projects.deployments.settingsSections.previewsNeedRepositoryBody')}
        mode="info"
      />
    );
  }
  if (!template) {
    const { previewAvailability: _resolvedFromSavedContent, ...setup } = props;
    return <PreviewSetupRow {...setup} onSave={onSaveTemplate} />;
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
  const enable = async () => {
    if (!props.prepareWatcher || !props.lifetime || watcherBusy) return;
    setWatcherBusy(true);
    setWatcherFailure(undefined);
    try {
      const next = { ...template, enabled: true };
      const resolved = await props.prepareWatcher(props.detail.environment, next);
      if (!props.lifetime.isCurrent()) return;
      if (resolved.options.length === 1) {
        setWatcher(null);
        onSave?.(next, resolved.options[0]?.value);
      } else setWatcher(resolved);
    } catch (error) {
      if (!props.lifetime.isCurrent()) return;
      const details = error instanceof HappyError && error.code === 'deployment_access_denied' ? error.details : undefined;
      const eligibility = DeploymentPreviewForkEligibilityV1Schema.safeParse(
        details && typeof details === 'object' && 'forkEligibility' in details ? details.forkEligibility : undefined);
      setWatcherFailure((eligibility.success ? forkUnavailableMessage(eligibility.data) : undefined)
        ?? t('projects.deployments.settingsSections.previewEditor.watcherUnavailable'));
    }
    finally { setWatcherBusy(false); }
  };
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
  const runsOnSubtitle = sharesProduction ? t('projects.deployments.settingsSections.previewsProductionTarget') : undefined;
  const runsOnLeading = sharesProduction ? <StatusDot size={6} color={theme.colors.state.warning.foreground} /> : undefined;
  return (
    <>
      <Item
        testID={`${props.testID}.enabled`}
        title={t('common.enabled')}
        subtitle={previewAvailability === 'on'
          ? t('projects.deployments.settingsSections.previewsOn')
          : t('projects.deployments.settingsSections.previewsOff')}
        mode={onSave ? undefined : 'info'}
        rightElement={onSave ? (
          <Switch value={template.enabled} disabled={props.saving || watcherBusy}
            onValueChange={enabled => {
              if (enabled && !template.enabled && props.prepareWatcher && props.lifetime) void enable();
              else save({ enabled });
            }} />
        ) : undefined}
      />
      {watcher && props.lifetime && onSave ? <PreviewWatcherChoice watcher={watcher} lifetime={props.lifetime}
        value={undefined} onChoose={account => { setWatcher(null); onSave({ ...template, enabled: true }, account); }}
        onConnected={enable} testID={props.testID} /> : null}
      {watcherFailure ? <PreviewWatcherFailure title={watcherFailure} /> : null}
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
  const reason = eligibility ? forkUnavailableMessage(eligibility)
    : t(failed ? 'projects.deployments.settingsSections.previewEditor.forksUnavailable'
      : 'projects.deployments.settingsSections.previewEditor.forksLoading');
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
 * own runtime link, saved once through `environments.update` (patch.previewTemplate). The rest of the template
 * is edited in the rows above once it exists.
 */
function PreviewSetupRow(props: PreviewTemplateRowsProps) {
  const runtimeTargetLinkId = props.detail.environment.runtimeTargetLinkId;
  // Without a manager's save path or a runtime link there is nothing to turn on; the preview list says there are none.
  if (!props.onSave || !props.lifetime || !runtimeTargetLinkId) return null;
  return <PreviewTurnOnRow {...props} lifetime={props.lifetime} onSave={props.onSave} runtimeTargetLinkId={runtimeTargetLinkId} />;
}

function PreviewTurnOnRow(props: Readonly<{
  detail: DeploymentEnvironmentReadDetailV1;
  lifetime: ServerAccountScopeLifetime;
  onSave: SavePreview;
  saving: boolean;
  runtimeTargetLinkId: string;
  testID: string;
  prepareDefaults: ReturnType<typeof createDeploymentActions>['prepareConfigurationDefaults'] | null;
  prepareWatcher?: ReturnType<typeof createDeploymentActions>['preparePreviewWatcher'] | null;
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
  const [watcher, setWatcher] = React.useState<WatcherOptions | null>(null);
  const [watcherAccount, setWatcherAccount] = React.useState<WatcherAccount>();
  const [watcherFailed, setWatcherFailed] = React.useState(false);
  if (!repository) {
    return project.status === 'loading' ? null : (
      <Item testID={`${props.testID}.noRepository`}
        title={t('projects.deployments.settingsSections.previewsNoRepository')} mode="info" />
    );
  }
  const start = async () => {
    if (!props.prepareDefaults || loading) return;
    setLoading(true);
    setFailure(false);
    setWatcherFailed(false);
    let readingWatcher = Boolean(props.prepareWatcher);
    try {
      const initial: PreviewTemplate = { v: 1, enabled: true, forkPreviews: 'off', repository,
        runtimeTargetLinkId: props.runtimeTargetLinkId, domain: null, bindingBlueprints: [], data: [] };
      if (props.prepareWatcher) {
        const result = await props.prepareWatcher(props.detail.environment, initial);
        if (!props.lifetime.isCurrent()) return;
        setWatcher(result);
        setWatcherAccount(result.options.length === 1 ? result.options[0]?.value : undefined);
        if (result.options.length === 0) return;
      }
      readingWatcher = false;
      const resolved = await props.prepareDefaults(props.detail.environment, 'previews');
      if (!props.lifetime.isCurrent()) return;
      const runtime = resolved.values.previewMachineId ? props.detail.targetLinks.find(row =>
        row.targetLink.role === 'runtime' && row.targetLink.machines?.includes(resolved.values.previewMachineId!))?.targetLink.id
        : props.runtimeTargetLinkId;
      setDefaults(resolved);
      setRequireRuntimeChoice(!runtime);
      setUnresolvedData(resolved.values.previewDatabase && resolved.values.previewDatabase !== 'none'
        ? resolved.values.previewDatabase : undefined);
      setDraft({ ...initial, runtimeTargetLinkId: runtime ?? initial.runtimeTargetLinkId });
    } catch {
      if (readingWatcher) setWatcherFailed(true);
      else setFailure(true);
    } finally { setLoading(false); }
  };
  const watcherChoice = watcher && watcher.options.length !== 1
    ? <PreviewWatcherChoice watcher={watcher} lifetime={props.lifetime} value={watcherAccount}
      onChoose={setWatcherAccount} onConnected={start} testID={props.testID} /> : null;
  // The template rows below carry the one Runs on row for the draft.
  if (draft) return <>
    {watcherChoice}
    {defaults && unresolvedData && draft.data.length === 0 ? <Item testID={`${props.testID}.data.default`}
      title={t('projects.deployments.settingsSections.previewsData')}
      detail={t(unresolvedData === 'own' ? 'projects.deployments.settingsSections.previewsDataOwn'
        : 'projects.deployments.settingsSections.previewsDataBranch')}
      subtitle={sourceWord(defaults.sources.previewDatabase)} mode="info" /> : null}
    <PreviewTemplateRows {...props} detail={{ ...props.detail, content: { ...props.detail.content, previewTemplate: draft } }}
      saving={props.saving} onSave={setDraft} prepareWatcher={null}
      unresolvedData={draft.data.length === 0 ? unresolvedData : undefined}
      onDataChoice={choice => setUnresolvedData(choice === 'none' ? undefined : choice)}
      requireRuntimeChoice={requireRuntimeChoice} onRuntimeChoice={() => setRequireRuntimeChoice(false)} />
    <Item title={t('projects.deployments.settingsSections.previewEditor.configure')} rightElement={<View style={{ flexDirection: 'row', alignItems: 'center', gap: theme.space.s8 }}>
      <SectionActionButton title={t('common.cancel')} onPress={() => { setDraft(null); setDefaults(null); setWatcher(null); }} />
      <SectionActionButton testID={`${props.testID}.setup.save`} title={t('common.save')}
        disabled={props.saving || requireRuntimeChoice || Boolean(unresolvedData && draft.data.length === 0) || Boolean(watcher && !watcherAccount)}
        onPress={() => {
          if (!requireRuntimeChoice && !(unresolvedData && draft.data.length === 0) && (!watcher || watcherAccount))
            props.onSave(draft, draft.enabled ? watcherAccount : undefined);
        }} />
    </View>} />
  </>;
  return (
    <>
    <Item
      testID={`${props.testID}.setup`}
      title={t('projects.deployments.settingsSections.previewsTitle')}
      subtitle={t('projects.deployments.settingsSections.previewsSetUpOff')}
      rightElement={
        <Switch value={false} disabled={props.saving || loading || !props.prepareDefaults}
          onValueChange={enabled => { if (enabled) void start(); }} />
      }
    />
    {watcherChoice}
    {watcherFailed ? <PreviewWatcherFailure /> : null}
    {failure ? <SurfaceStateCard kind="error" size="line" title={t('projects.deployments.settingsSections.previewsDataUnavailable')} /> : null}
    </>
  );
}


function forkUnavailableMessage(eligibility: DeploymentPreviewForkEligibilityV1) {
  if (eligibility.kind === 'ineligible') return t(eligibility.reason === 'production_workload'
    ? 'projects.deployments.settingsSections.previewEditor.forksProduction'
    : 'projects.deployments.settingsSections.previewEditor.forksUnsupported');
  if (eligibility.kind === 'unavailable') return t('projects.deployments.settingsSections.previewEditor.forksUnavailable');
  return undefined;
}

function PreviewWatcherFailure({ title = t('projects.deployments.settingsSections.previewEditor.watcherUnavailable') }: {
  title?: string;
}) {
  return <SurfaceStateCard kind="error" size="line" title={title} />;
}

function PreviewWatcherChoice(props: Readonly<{
  watcher: WatcherOptions;
  lifetime: ServerAccountScopeLifetime;
  value?: WatcherAccount;
  onChoose: (account: WatcherAccount) => void;
  onConnected: () => Promise<void>;
  testID: string;
}>) {
  const [open, setOpen] = React.useState(false);
  const { options, service } = props.watcher;
  if (options.length === 0) return <Item testID={`${props.testID}.watcher.connect`}
    title={t('projects.deployments.settingsSections.previewEditor.watcherConnect')}
    onPress={() => {
      if (!props.lifetime.isCurrent()) return;
      // Previews need the account for this repository's pull requests and webhook, not for an agent: the sheet says why and
      // leads with GitHub's declared method rather than an agent's device sign-in (R21-D6).
      void presentConnectSheet({ scope: props.lifetime.scope, service, intent: 'add', methodOrder: 'declaredDefault',
        reason: t('projects.deployments.settingsSections.previewEditor.watcherConnectReason') }).then(result => {
        if (result.kind === 'connected' && props.lifetime.isCurrent()) return props.onConnected();
      });
    }} />;
  const selected = options.findIndex(option => option.value === props.value);
  return <DropdownMenu testID={`${props.testID}.watcher`} open={open} onOpenChange={setOpen}
    items={options.map((option, index) => ({ id: String(index), title: option.label }))}
    selectedId={selected >= 0 ? String(selected) : null}
    onSelect={id => {
      setOpen(false);
      const option = options[Number(id)];
      if (option) props.onChoose(option.value);
    }}
    itemTrigger={{ title: t('projects.deployments.settingsSections.previewEditor.watcherAccount'),
      detailFormatter: () => options[selected]?.label ?? t('common.choose') }} />;
}
