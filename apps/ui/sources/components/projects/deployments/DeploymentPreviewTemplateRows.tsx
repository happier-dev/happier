import * as React from 'react';
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
import { DeploymentPreviewDomainChoice } from './DeploymentPreviewDomainChoice';
import { sourceWord } from './DeploymentCreationDefaultsRows';
import { SectionActionButton } from '@/components/ui/lists/SectionActionButton';
import { SurfaceStateCard } from '@/components/ui/surfaces/SurfaceStateCard';
import { Typography } from '@/constants/Typography';

/**
 * The preview template this Environment carries (lab `d5d/template`, `previewdb/template`, `previewdb/branch`,
 * `d5d/prodmachine`): whether new pull requests get previews, where they run, their address pattern and their data.
 * Read from the Environment's own content; forks never get previews, which is a fact rather than a choice here.
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
  /** The captured Home/Account the Project repository is read under; absent while it is not current. */
  lifetime: ServerAccountScopeLifetime | null;
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
  const dataKind = previewDataKind(template);
  const save = (patch: Partial<PreviewTemplate>) => onSave?.({ ...template, ...patch });
  const canChooseBranch = !!props.lifetime && !!props.inspect
    && props.detail.targetLinks.some(row => row.targetLink.role === 'data' && row.targetLink.source.kind === 'plugin');
  // A reason marks its segment unavailable (the shared segmented row rule), so only an option that cannot be chosen carries
  // one. Under the row the reason stands alone, so a single unavailable option names itself.
  const ownUnavailable = !seenData.own && dataKind !== 'own';
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
      {onSave && runtimeLinks.length > 1 && runtimeLinks.length <= 4 ? (
        <SegmentedChoiceItem<string>
          testID={`${props.testID}.runsOn`}
          testIDPrefix={`${props.testID}.runsOn`}
          title={t('projects.deployments.settingsSections.previewsRunsOn')}
          subtitle={runsOnSubtitle}
          subtitleLeading={runsOnLeading}
          accessoryLayout="adaptive"
          options={runtimeLinks.map((candidate) => ({ id: candidate.id, label: linkName(candidate) }))}
          value={template.runtimeTargetLinkId}
          disabled={props.saving}
          onChange={(runtimeTargetLinkId) => save({ runtimeTargetLinkId })}
        />
      ) : onSave && runtimeLinks.length > 4 ? (
        <DropdownMenu testID={`${props.testID}.runsOn`} open={runtimeOpen} onOpenChange={setRuntimeOpen}
          items={runtimeLinks.map(candidate => ({ id: candidate.id, title: linkName(candidate) }))}
          selectedId={template.runtimeTargetLinkId}
          onSelect={runtimeTargetLinkId => { setRuntimeOpen(false); save({ runtimeTargetLinkId }); }}
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
            setChoosingBranch(next === 'branch');
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
      {onSave && props.lifetime && props.inspect && (choosingBranch || dataKind === 'branch') ? (
        <DeploymentPreviewBranchChoice detail={props.detail} lifetime={props.lifetime} inspect={props.inspect}
          saving={props.saving} onSave={(data) => save({ data })} testID={`${props.testID}.branch`} />
      ) : null}
      {template.forkPreviews === 'off' ? (
        <Item testID={`${props.testID}.forks`} title={t('projects.deployments.settingsSections.previewsForks')}
          titleStyle={Typography.default('regular')} mode="info" />
      ) : null}
    </>
  );
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
  controller: DeploymentReadControllerV1;
  demand: DeploymentReadDemandV1;
  machineName: (id: string) => string;
  inspect: ReturnType<typeof createDeploymentActions>['inspectPlatformTarget'] | null;
}>) {
  const project = useProjectSource(props.lifetime, props.detail.environment.projectSourceId);
  const repository = readProjectRepositoryIdentityV1({ source: project.source?.source ?? null });
  const [draft, setDraft] = React.useState<PreviewTemplate | null>(null);
  const [defaults, setDefaults] = React.useState<Awaited<ReturnType<NonNullable<typeof props.prepareDefaults>>> | null>(null);
  const [loading, setLoading] = React.useState(false);
  const [failure, setFailure] = React.useState(false);
  if (!repository) {
    return project.status === 'loading' ? null : (
      <Item testID={`${props.testID}.noRepository`}
        title={t('projects.deployments.settingsSections.previewsNoRepository')} mode="info" />
    );
  }
  if (draft) return <>
    {defaults ? <Item title={t('projects.deployments.settingsSections.previewsRunsOn')}
      detail={defaults.values.previewMachineId ? props.machineName(defaults.values.previewMachineId) : undefined}
      subtitle={sourceWord(defaults.sources.previewMachineId)} mode="info" /> : null}
    <PreviewTemplateRows {...props} detail={{ ...props.detail, content: { ...props.detail.content, previewTemplate: draft } }}
      saving={props.saving} onSave={setDraft} />
    <Item title={t('projects.deployments.settingsSections.previewEditor.configure')} rightElement={<>
      <SectionActionButton title={t('common.cancel')} onPress={() => { setDraft(null); setDefaults(null); }} />
      <SectionActionButton testID={`${props.testID}.setup.save`} title={t('common.save')}
        disabled={props.saving} onPress={() => props.onSave(draft)} />
    </>} />
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
            if (!runtime || resolved.values.previewDatabase && resolved.values.previewDatabase !== 'none') {
              setFailure(true); return;
            }
            setDefaults(resolved);
            setDraft({ v: 1, enabled: true, forkPreviews: 'off', repository, runtimeTargetLinkId: runtime,
              domain: null, bindingBlueprints: [], data: [] });
          }).catch(() => setFailure(true)).finally(() => setLoading(false));
        }} />
      }
    />
    {failure ? <SurfaceStateCard kind="error" size="line" title={t('projects.deployments.settingsSections.previewsDataUnavailable')} /> : null}
    </>
  );
}

