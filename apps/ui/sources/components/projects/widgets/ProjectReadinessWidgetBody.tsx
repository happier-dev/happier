import * as React from 'react';
import { View } from 'react-native';
import { useUnistyles } from 'react-native-unistyles';
import type { ProjectReadinessFactV1, ProjectReadinessReadInputV1 } from '@happier-dev/protocol/projects/readinessV1';
import type { ProjectSurfaceTargetV1 } from '@/sync/domains/widgets/projectWidgetAreaContext';
import type { ServerAccountScopeLifetime } from '@/sync/domains/scope/serverAccountScope';
import { useActiveServerAccountScopeLifetime } from '@/sync/domains/state/storage';
import { useLayoutPresentationActive } from '@/components/ui/presentation/PluginSurfaceFocusEligibility';
import { useRouter } from '@/components/appShell/workspace/destinationRoute';
import { HappierCountedDisclosure } from '@happier-dev/plugin-ui/presentation';
import { ExpandableItem } from '@/components/ui/lists/ExpandableItem';
import { Item } from '@/components/ui/lists/Item';
import { SectionActionButton } from '@/components/ui/lists/SectionActionButton';
import { SelectionListFilterChip } from '@/components/ui/selectionList/SelectionListFilterChips';
import { SurfaceStateCard } from '@/components/ui/surfaces/SurfaceStateCard';
import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import { formatAsOfTime } from '@/utils/time/formatAsOfTime';
import { usePluginSurfaceDestinationNavigationBinding } from '@/components/plugins/surfaces/pluginSurfaceDestinationNavigation';
import { NewAccountTriggerPopover } from '@/components/workflows/triggers/AccountTriggersSection';
import { subjectStarterEventSeed } from '@/components/workflows/triggers/subjectTriggerStarters';
import { WidgetGlanceRow } from '@/components/widgets/glance/WidgetGlanceRow';
import { useWidgetFrameResourceActivity } from '@/components/widgets/frame/widgetFrameResourceActivity';
import { InvestigationOutcomeBanner } from '@/components/inbox/detail/InvestigationOutcomeBanner';
import { useInvestigateFailure } from '@/hooks/inbox/useInvestigateFailure';
import { t } from '@/text';
import { useDeploymentProject } from '../deployments/useDeploymentProject';
import { useDeploymentCollection } from '../deployments/useDeploymentReads';
import { deploymentEnvironmentRoute } from '../deployments/deploymentNavigation';
import { projectSourceRoute } from '../sources/projectSourceNavigation';
import { useProjectReadiness } from './useProjectReadiness';

/**
 * The Environment the person last chose for each Project, for as long as this device holds the Account's credential:
 * a Fix leaves the Project page and Back mounts the widget again, which must not ask them to choose again. Device-local
 * presentation memory; it retires with the Account lifetime and is never persisted or synced.
 */
const chosenEnvironments = new WeakMap<ServerAccountScopeLifetime, Map<string, string>>();

function useChosenEnvironment(lifetime: ServerAccountScopeLifetime | null, projectId: string | null) {
  const [chosen, setChosen] = React.useState<Readonly<{ projectId: string; environmentId: string }> | null>(null);
  const remembered = lifetime && projectId ? chosenEnvironments.get(lifetime)?.get(projectId) ?? null : null;
  const environmentId = chosen?.projectId === projectId ? chosen.environmentId : remembered;
  const choose = React.useCallback((environmentId: string) => {
    if (!projectId) return;
    if (lifetime) {
      const byProject = chosenEnvironments.get(lifetime) ?? new Map<string, string>();
      byProject.set(projectId, environmentId);
      chosenEnvironments.set(lifetime, byProject);
    }
    setChosen({ projectId, environmentId });
  }, [lifetime, projectId]);
  return [environmentId, choose] as const;
}

/** The selected Environment is presentation state; every fact comes from the composite Action. */
export function ProjectReadinessWidgetBody(props: Readonly<{ target: ProjectSurfaceTargetV1; testID: string }>) {
  const { theme } = useUnistyles();
  const lifetime = useActiveServerAccountScopeLifetime();
  const visible = useLayoutPresentationActive();
  const projectId = props.target.source?.source.id ?? null;
  const demand = { mounted: true, visible, focused: visible };
  const { controller } = useDeploymentProject(lifetime, projectId, demand);
  const collection = useDeploymentCollection(controller, demand);
  const [chosenEnvironmentId, chooseEnvironment] = useChosenEnvironment(lifetime, projectId);
  const selected = chosenEnvironmentId !== null
    ? collection.snapshot.value?.items.find(item => item.environment.id === chosenEnvironmentId) : undefined;
  const environment = selected?.environment;
  const input = React.useMemo<ProjectReadinessReadInputV1 | null>(() => environment?.controllerMachineId && projectId ? {
    serverId: environment.serverId, machineId: environment.controllerMachineId, projectId,
    environments: [{ environmentId: environment.id, expectedRevision: environment.revision }],
  } : null, [environment?.serverId, environment?.controllerMachineId, environment?.id, environment?.revision, projectId]);
  const readiness = useProjectReadiness(lifetime, input, visible);
  useWidgetFrameResourceActivity(readiness.pending || collection.snapshot.status === 'loading');
  if (!projectId) return <SurfaceStateCard kind="unavailable" size="line" title={t('projects.readiness.sourceRequired')} />;
  const items = collection.snapshot.value?.items ?? [];
  return <View testID={props.testID} style={{ gap: theme.space.s8 }}>
    <View style={{ flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', justifyContent: 'space-between', gap: theme.space.s4 }}>
      <SelectionListFilterChip filter={{ id: `${props.testID}.environment`, testID: `${props.testID}.environment`,
        label: t('projects.readiness.environment'), valueLabel: selected?.title ?? t('projects.readiness.choose'),
        muted: !selected, selectedId: selected?.environment.id ?? null,
        options: items.map(item => ({ id: item.environment.id, label: item.title })),
        onChange: chooseEnvironment }} />
      <SectionActionButton testID={`${props.testID}.refresh`} title={t('common.refresh')} icon="arrow-clockwise"
        loading={readiness.pending} onPress={() => { void (input ? readiness.refresh() : collection.refresh()); }} />
    </View>
    {collection.snapshot.status === 'unavailable' || collection.snapshot.value?.coverage === 'partial'
      ? <SurfaceStateCard kind="unavailable" size="line" title={t('projects.readiness.partial')}
          diagnosticCode={collection.snapshot.failure?.code} /> : null}
    {/* An unread list already says so above; it is never also "no Environments". */}
    {!selected && collection.snapshot.status === 'unavailable' && !items.length ? null : !selected ? <SurfaceStateCard size="line"
      kind={collection.snapshot.status === 'idle' || collection.snapshot.status === 'loading' ? 'loading' : 'empty'}
      title={collection.snapshot.status === 'idle' || collection.snapshot.status === 'loading' ? t('projects.readiness.loading')
        : items.length ? t('projects.readiness.choose') : t('projects.readiness.empty')} />
      : !input ? <SurfaceStateCard kind="unavailable" size="line" title={t('projects.readiness.controllerRequired')} />
      : <>
        {readiness.failureCode ? <SurfaceStateCard kind="unavailable" size="line" title={t('projects.readiness.failed')}
          diagnosticCode={readiness.failureCode} /> : null}
        {!readiness.result && readiness.pending ? <SurfaceStateCard kind="loading" size="line" title={t('projects.readiness.loading')} /> : null}
        {readiness.result ? <ReadinessFacts key={environment!.id} facts={readiness.result.facts}
          serverId={environment!.serverId} projectId={projectId} environmentId={environment!.id}
          machineId={environment!.controllerMachineId!} lifetime={lifetime} testID={props.testID} /> : null}
      </>}
    {collection.hasPreviousPage || collection.hasNextPage ? <View style={{ flexDirection: 'row', justifyContent: 'space-between' }}>
      <SectionActionButton title={t('common.previous')} icon="arrow-left" disabled={!collection.hasPreviousPage}
        onPress={() => { void collection.previousPage(); }} />
      <SectionActionButton title={t('common.next')} icon="arrow-right" disabled={!collection.hasNextPage}
        onPress={() => { void collection.nextPage(); }} />
    </View> : null}
  </View>;
}

/** Ready details borrow the shared disclosure; only owner-reported gaps stay open. */
function ReadinessFacts(props: Omit<React.ComponentProps<typeof ReadinessFact>, 'fact'> & Readonly<{ facts: readonly ProjectReadinessFactV1[] }>) {
  const ready = props.facts.filter(fact => fact.status === 'ready');
  const renderFact = (fact: ProjectReadinessFactV1) => <ReadinessFact {...props} key={`${fact.kind}:${fact.environmentId ?? ''}`}
    fact={fact} testID={`${props.testID}.${fact.kind}`} />;
  return <>
    {props.facts.filter(fact => fact.status !== 'ready').map(renderFact)}
    {ready.length ? <HappierCountedDisclosure testID={`${props.testID}.ready`}
      title={t('projects.readiness.ready')} count={ready.length}
      subtitle={ready.map(fact => t(`projects.readiness.${fact.kind}`)).join(', ')}
      Disclosure={ExpandableItem} renderHeader={state => <Item {...state.headerProps} testID={state.testID}
        title={state.title} subtitle={state.subtitle} detail={state.detail} />}
    >{ready.map(renderFact)}</HappierCountedDisclosure> : null}
  </>;
}

function ReadinessFact(props: Readonly<{ fact: ProjectReadinessFactV1; serverId: string; projectId: string;
  environmentId: string; machineId: string; lifetime: ServerAccountScopeLifetime | null; testID: string }>) {
  const { theme } = useUnistyles();
  const router = useRouter();
  const navigation = usePluginSurfaceDestinationNavigationBinding();
  const anchor = React.useRef<View>(null);
  const [openingChecks, setOpeningChecks] = React.useState(false);
  const [setupFailure, setSetupFailure] = React.useState<string | null>(null);
  const subject = React.useMemo(() => ({ kind: 'deploymentEnvironment' as const, serverId: props.serverId,
    environmentId: props.environmentId, readiness: { projectId: props.projectId, fact: props.fact.kind } }),
  [props.serverId, props.environmentId, props.projectId, props.fact.kind]);
  const options = React.useMemo(() => ({ externalActionTarget: { kind: 'machine' as const, machineId: props.machineId } }), [props.machineId]);
  const investigation = useInvestigateFailure(subject, options);
  const fix = async () => {
    setSetupFailure(null);
    const kind = props.fact.kind;
    if (kind === 'health' || kind === 'alerts') { setOpeningChecks(true); return; }
    if (kind === 'ci' || kind === 'security') {
      if (props.fact.reason === 'project_repository_required') { router.push(projectSourceRoute(props.projectId)); return; }
      if (props.fact.setupSurface) {
        if (navigation?.targetKind !== 'project') { setSetupFailure('plugin_surface_open_owner_unavailable'); return; }
        const result = await navigation.openSurface({ destination: props.fact.setupSurface });
        if (!result.ok) setSetupFailure(result.reason);
        return;
      }
      void investigation.investigate();
      return;
    }
    router.push(deploymentEnvironmentRoute({ serverId: props.serverId, projectSourceId: props.projectId,
      environmentId: props.environmentId, tab: kind === 'secrets' ? 'variables' : 'settings',
      ...(kind === 'backups' ? { section: 'backups' as const, setup: 'backups' as const } : {}) }));
  };
  const evidence = readinessEvidence(props.fact);
  return <View ref={anchor} testID={props.testID} style={{ gap: theme.space.s4 }}>
    <WidgetGlanceRow title={t(`projects.readiness.${props.fact.kind}`)} variant="fact"
      fact={t(`projects.readiness.${props.fact.status}`)} factTone={props.fact.status === 'actionNeeded' ? 'attention' : 'quiet'} />
    <SurfaceStateCard size="line" kind={props.fact.status === 'ready' ? 'success' : props.fact.status === 'actionNeeded' ? 'warning' : 'unavailable'}
      title={props.fact.status === 'unavailable' ? t('projects.readiness.ownerUnavailable') : t(`projects.readiness.${props.fact.status}`)}
      diagnosticCode={props.fact.reason} />
    {evidence ? <Text testID={`${props.testID}.evidence`} style={{ ...Typography.variant('meta'), color: theme.colors.text.secondary }}>
      {evidence}
    </Text> : null}
    {setupFailure ? <SurfaceStateCard testID={`${props.testID}.setupUnavailable`} size="line" kind="unavailable"
      title={t('projects.readiness.ownerUnavailable')} diagnosticCode={setupFailure} /> : null}
    {props.fact.status !== 'ready' ? <View style={{ flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'flex-end', gap: theme.space.s4 }}>
      <SectionActionButton testID={`${props.testID}.fix`} title={t('projects.readiness.fix')} destination onPress={() => { void fix(); }} />
      <SectionActionButton testID={`${props.testID}.ask`} title={t('projects.readiness.askAgent')} icon="sparkle"
        loading={investigation.pending} onPress={() => { void investigation.investigate(); }} />
    </View> : null}
    {openingChecks ? <NewAccountTriggerPopover anchorRef={anchor} onRequestClose={() => setOpeningChecks(false)}
      accountLifetime={props.lifetime} initialProject={{ machineId: props.machineId, directory: '~' }}
      eventSeed={subjectStarterEventSeed('healthFailed', { subject: { kind: 'environment', environmentId: props.environmentId,
        machineId: props.machineId }, controllerMachineId: props.machineId })} /> : null}
    {investigation.showOutcome && investigation.outcome ? <InvestigationOutcomeBanner outcome={investigation.outcome}
      serverId={props.serverId} testID={`${props.testID}.handoff`} onChoosePlacement={investigation.investigateWithPlacement}
      pending={investigation.pending} /> : null}
  </View>;
}

/** Render owner evidence verbatim; coverage and availability decisions stay in the composite read. */
function readinessEvidence(fact: ProjectReadinessFactV1): string {
  const lines: string[] = [];
  const label = (caption: string, value: string | number) => `${caption}: ${value}`;
  if (fact.healthCoverage) {
    const coverage = fact.healthCoverage;
    lines.push(label(t('projects.readiness.evidence'), coverage.sourceRevision), label(t('projects.readiness.health'), coverage.checkCount));
    if (coverage.observerMachineId) lines.push(label(t('projects.readiness.observer'), coverage.observerMachineId));
    let earliest: number | null = null;
    let latest: number | null = null;
    const vantages = new Set<NonNullable<typeof coverage.domains[number]['facts']['vantage']>>();
    for (const domain of coverage.domains) {
      if (domain.facts.observedAt !== null) {
        earliest = earliest === null ? domain.facts.observedAt : Math.min(earliest, domain.facts.observedAt);
        latest = latest === null ? domain.facts.observedAt : Math.max(latest, domain.facts.observedAt);
      }
      if (domain.facts.vantage) vantages.add(domain.facts.vantage);
    }
    if (earliest !== null && latest !== null) lines.push(label(t('projects.readiness.observed'), earliest === latest
      ? formatAsOfTime(earliest) : `${formatAsOfTime(earliest)} – ${formatAsOfTime(latest)}`));
    lines.push(...[...vantages].map(vantage => vantage === 'outside' ? t('projects.readiness.outside') : t('projects.readiness.sameMachine')));
  }
  if (fact.alertWiring) {
    const wiring = fact.alertWiring;
    lines.push(label(t('projects.readiness.evidence'), wiring.sourceRevision), label(t('projects.readiness.controller'), wiring.controllerMachineId));
    if (wiring.observerMachineId) lines.push(label(t('projects.readiness.observer'), wiring.observerMachineId));
    lines.push(label(t('projects.readiness.channels'), wiring.channelIds.join(', ')),
      wiring.phases.map(phase => phase === 'open' ? t('projects.readiness.openPhase') : t('projects.readiness.recoveredPhase')).join(' · '));
  }
  if (fact.secretScope) lines.push(label(t('projects.readiness.requiredGrants'), fact.secretScope.requiredGrantCount),
    label(t('projects.readiness.missingGrants'), fact.secretScope.missingGrantCount));
  if (fact.backups?.lastSuccessfulBackup) lines.push(label(t('projects.readiness.lastBackup'), formatAsOfTime(fact.backups.lastSuccessfulBackup.completedAt)));
  if (fact.backups?.lastVerification) lines.push(label(t('projects.readiness.lastVerification'), formatAsOfTime(fact.backups.lastVerification.completedAt)));
  return lines.filter(Boolean).join('\n');
}
