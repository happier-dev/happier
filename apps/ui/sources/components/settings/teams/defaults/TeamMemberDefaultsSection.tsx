import * as React from 'react';
import { useUnistyles } from 'react-native-unistyles';

import { qualifiedPurposeKey } from '@happier-dev/protocol/connect/connectedAccountPurposeBindings';
import { sessionModelPickerValueFromRef, isTeamCredentialProviderModelPickerValue } from '@/components/sessions/modelPicker/sessionModelSelectionKey';
import type { ManagedSessionDefaultsV1, TeamCredentialProviderModelSelectionV1 } from '@happier-dev/protocol/teams';
import type { AgentExecutionTargetV1 } from '@happier-dev/protocol/agents/executionTargetV1';
import type { PrincipalRefV1 } from '@happier-dev/protocol/teams/principal';
import { resolveAgentExecutionTargetForBackendTarget } from '@/agents/backendCatalog/resolveAgentExecutionTargetForBackendTarget';

import { resolveBundledAgentIdFromContributionIdentity } from '@/agents/catalog/catalog';
import {
  getResolvedAgentCatalogEntries,
  type ResolvedAgentCatalogEntry,
} from '@/agents/backendCatalog/agentCatalogProjection';
import { useEnabledAgentIds } from '@/agents/hooks/useEnabledAgentIds';
import { AgentCatalogIdentityIcon } from '@/agents/presentation/AgentCatalogIdentityIcon';
import { ConnectedAccountPurposeTargetChooser } from '@/components/settings/connectedServices/account/ConnectedAccountPurposeTargetChooser';
import { useExactModelChoice } from '@/components/sessions/modelPicker/useExactModelChoice';
import { DropdownMenu } from '@/components/ui/forms/dropdown/DropdownMenu';
import { renderDropdownItemTriggerRightElement } from '@/components/ui/forms/dropdown/renderDropdownItemTriggerRightElement';
import { resolveFieldBoxColors } from '@/components/ui/forms/fieldBox';
import { Icon } from '@/components/ui/icons/Icon';
import { AttentionBanner } from '@/components/ui/lists/AttentionBanner';
import { homeGovernanceFailureNotice } from '@/components/settings/home/governance/homeGovernanceLabels';
import { ExpandableItem } from '@/components/ui/lists/ExpandableItem';
import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { SkeletonTitle } from '@/components/ui/lists/SkeletonRows';
import { usePageRowMetrics } from '@/components/ui/lists/useResolvedItemDensity';
import { useFeatureEnabled } from '@/hooks/server/useFeatureEnabled';
import { useProjectSessionDefaultsSectionAdapter, type ProjectSessionDefaultsInheritance, type ProjectSessionDefaultsSectionInput } from '@/hooks/projects/useProjectSessionDefaultsSectionAdapter';
import { resolveActionExecutionErrorMessage } from '@/sync/ops/actions/resolveActionExecutionFailureMessage';
import { useHomeTeamCredentialModelCatalog } from '@/hooks/teams/useHomeTeamCredentialModelCatalog';
import { getPermissionModeOptionsForAgentType } from '@/sync/domains/permissions/permissionModeOptions';
import { setTeamPolicy } from '@/sync/ops/teams/teamOperations';
import { setHomeSessionDefaults } from '@/sync/ops/home/homeGovernanceOperations';
import { isTeamActionApprovalPendingError } from '@/sync/ops/teams/teamActionClient';
import { t } from '@/text';

import type { ResolvedInheritedManagedSessionDefaults } from '@happier-dev/protocol/teams/managedDefaults';
import { describeInheritedDefaultSource } from './inheritedDefaultSourceLabel';
import { ApprovalProfileDefaultRow } from './ApprovalProfileDefaultRow';
import { TeamMemberMachineDefaultRow } from './TeamMemberMachineDefaultRow';
import type { TeamSectionContext } from '../teamSectionContext';
import type { HomeAdministrationContext } from '@/components/settings/home/governance/homeAdministrationContext';
import { teamMutationFailureLabel } from '../teamMutationPresentation';
import {
  buildMemberDefaultsPatch,
  memberDefaultsConflicts,
  readMemberDefaults,
  withApprovalProfile,
  withConnectedService,
  withModel,
  withPermissionMode,
  type MemberDefaultsAccess,
  type MemberDefaultsConflicts,
  type MemberDefaultsScope,
} from './memberDefaults';

/** The "None" row of a defaults menu; a trimmed id so the page field can show it. */
const NONE_ID = '__none__';

type SaveDefaults = (next: ManagedSessionDefaultsV1) => void;
type DefaultsAttention = Readonly<Pick<React.ComponentProps<typeof AttentionBanner>, 'title' | 'description' | 'action' | 'accessibilityLiveRegion'>>;

type RowState = Readonly<{
  serverId: string;
  teamId: string;
  connectedServicesTeamResourcesOnly: boolean;
  defaults: ManagedSessionDefaultsV1;
  editable: boolean;
  /** Something else is in flight, or the Home cannot take a write right now. */
  disabled: boolean;
  conflictNote: string;
  save: SaveDefaults;
  inheritance?: ProjectSessionDefaultsInheritance;
}>;

/**
 * "Defaults for members" (owner ruling 2026-11-07, row 519): the Machine, and per
 * Agent the permission mode, model and connected services a member's new
 * sessions start with. Members can change each one; nothing is copied into their
 * settings. One writer, `teams.policy.set` through the Action executor; who may
 * write is the Home's decision, mirrored by `access` and said when it is no.
 *
 * The same whole editor serves a project's Session defaults (plan F §2/§6, lab L11) when `scope` is
 * `'personal-project'` (For me) or `'project'` (the project's shared Source): Machine first, the project-only
 * Agent row, then the Approval profile and one row per Agent; each pick saves on its own through the host's
 * writer, and the page header, not the section, names the scope.
 */
type TeamScopeDefaultsProps = Readonly<{
  context: TeamSectionContext;
  scope: MemberDefaultsScope;
  access: MemberDefaultsAccess;
  writable: boolean;
  testID: string;
  /** The page already says who changes these (its lock banner), so the section does not repeat it. */
  readOnlyReasonOnPage?: boolean;
}> | Readonly<{
  context: HomeAdministrationContext;
  scope: { kind: 'team' };
  access: MemberDefaultsAccess;
  writable: boolean;
  testID: string;
  home: true;
  homeDefaults: ManagedSessionDefaultsV1 | null;
}>;

type ProjectScopeDefaultsProps = ProjectSessionDefaultsSectionInput & Readonly<{
  serverId: string;
  teamId: string | null;
  editable: boolean;
  busy: boolean;
  testID: string;
}>;

type TeamMemberDefaultsSectionProps = TeamScopeDefaultsProps | ProjectScopeDefaultsProps;

function isProjectScope(props: TeamMemberDefaultsSectionProps): props is ProjectScopeDefaultsProps {
  return typeof props.scope === 'string';
}

export const TeamMemberDefaultsSection = React.memo(
  function TeamMemberDefaultsSection(props: TeamMemberDefaultsSectionProps) {
    // A host is a project or a Team/Group/Home for its whole life; each kind keeps its own writer state.
    return isProjectScope(props) ? <ProjectScopeDefaults {...props} /> : <TeamScopeDefaults {...props} />;
  },
);

function TeamScopeDefaults(props: TeamScopeDefaultsProps) {
    const { context, scope, access } = props;
    const home = 'home' in props && props.home;
    const [busy, setBusy] = React.useState(false);
    const [error, setError] = React.useState<DefaultsAttention | null>(null);
    const inFlightRef = React.useRef(false);
    React.useEffect(
      () => () => {
        inFlightRef.current = false;
      },
      [],
    );

    const policy = 'team' in context ? context.team.policy : null;
    const stored = policy?.managedDefaults ?? null;
    const repairRequired = policy?.managedDefaultsStatus === 'repair_required';
    // A Group's layer cannot be rewritten over an unreadable document; only the Team's whole save repairs it.
    const editable =
      access.editable && !(repairRequired && scope.kind === 'group');
    const defaults = home ? props.homeDefaults ?? {} : readMemberDefaults(stored, scope);

    const save = React.useCallback<SaveDefaults>(
      (next) => {
        if (inFlightRef.current) return;
        inFlightRef.current = true;
        setBusy(true);
        setError(null);
        void (async () => {
          try {
            const outcome = 'projection' in context
              ? await setHomeSessionDefaults({
                  scope: context.scope,
                  expectedRevision: context.projection.policy.revision,
                  sessionDefaults: Object.keys(next).length === 0 ? null : next,
                })
              : await setTeamPolicy({
                  scope: context.scope,
                  address: context.address,
                  ...buildMemberDefaultsPatch(stored, scope, next),
                });
            if (outcome.kind === 'failed') {
              if ('projection' in context && outcome.failure.code !== 'managed_default_machine_not_member_usable') {
                const notice = homeGovernanceFailureNotice(outcome.failure);
                const stale = outcome.failure.code === 'home_policy_revision_conflict';
                setError({
                  title: notice.title,
                  description: stale ? t('homeGovernance.sessionDefaultsChanged') : notice.body,
                  accessibilityLiveRegion: 'assertive',
                  action: stale ? { label: t('common.refresh'), onPress: context.refresh, testID: `${props.testID}-refresh` } : undefined,
                });
              } else {
                const description = teamMutationFailureLabel(outcome.failure);
                if (description) setError({ title: t('homeGovernance.changeFailedTitle'), description, accessibilityLiveRegion: 'assertive' });
              }
            } else if (outcome.kind === 'approval_pending') context.requestApproval?.(outcome.artifactId);
          } catch (cause) {
            if (isTeamActionApprovalPendingError(cause))
              context.requestApproval?.(cause.registration);
            else setError({ title: t('homeGovernance.changeFailedTitle'), description: t('teams.errors.generic'), accessibilityLiveRegion: 'assertive' });
          } finally {
            inFlightRef.current = false;
            setBusy(false);
          }
        })();
      },
      [context, scope, stored, props.testID],
    );

    const sessionConflicts = home ? NO_CONFLICTS : memberDefaultsConflicts(stored, scope, '', policy?.homeDefaults);
    // The people a Team or Group default reaches: the audience a picked profile is offered to.
    const audience = React.useMemo<readonly PrincipalRefV1[] | undefined>(() => {
      if (!('address' in context)) return undefined;
      const teamId = context.address.teamId;
      return [scope.kind === 'group' ? { kind: 'group', teamId, groupId: scope.groupId } : { kind: 'team', teamId }];
    }, [context, scope]);
    const saveApprovalProfile = React.useCallback(
      (approvalProfileId: string | null | undefined) => save(withApprovalProfile(defaults, approvalProfileId)),
      [defaults, save],
    );

    const row: RowState = {
      serverId: context.scope.serverId,
      teamId: 'address' in context ? context.address.teamId : '',
      connectedServicesTeamResourcesOnly: true,
      defaults,
      editable,
      disabled: busy || !props.writable,
      conflictNote: t(
        scope.kind === 'team'
          ? 'teams.settings.memberDefaults.conflictTeam'
          : 'teams.settings.memberDefaults.conflictGroup',
      ),
      save,
    };

    const description = [
      t('teams.settings.memberDefaults.description'),
      access.editable
        ? null
          : access.reason === 'team' && !home && !('readOnlyReasonOnPage' in props && props.readOnlyReasonOnPage)
          ? t('teams.settings.memberDefaults.readOnlyTeam')
          : access.reason === 'group' ? t('teams.settings.memberDefaults.readOnlyGroup') : null,
    ]
      .filter(Boolean)
      .join(' ');

    return (
      <DefaultsEditor
        testID={props.testID}
        row={row}
        attention={error ?? (repairRequired ? { title: t('teams.settings.memberDefaults.repairRequired') } : null)}
        // The Home's defaults are a page of their own whose header already names and explains them.
        title={home ? undefined : t('teams.settings.memberDefaults.title')}
        description={home ? undefined : description}
        placementConflict={sessionConflicts.placement}
        onApprovalPending={context.requestApproval}
        approvalProfile={home ? null : {
          scopeOrHome: context.scope,
          value: defaults.approvalProfileId,
          audience,
          description: t('teams.settings.memberDefaults.approvalProfileMembers'),
          conflictNote: sessionConflicts.approvalProfile ? row.conflictNote : undefined,
          editable,
          disabled: row.disabled,
          save: saveApprovalProfile,
        }}
        // Team, Group and Home defaults name no default Agent; their Agents with a value lead.
        selectedAgent={undefined}
        conflictsFor={(key) => memberDefaultsConflicts(stored, scope, key, policy?.homeDefaults)}
      />
    );
}

/** A project scope's state: the host owns the scope (For me, or the project's Source) and its writer. */
function ProjectScopeDefaults(props: ProjectScopeDefaultsProps) {
  const { defaults } = props;
  const { save, selectAgent, selectApprovalProfile, error, retry, inheritance } = useProjectSessionDefaultsSectionAdapter(props);
  // A project default reaches everyone admitted to it (owner 2026-11-16 ~19:15Z); "For me" reaches only me.
  const shared = props.scope === 'project';
  const audience = React.useMemo<readonly PrincipalRefV1[] | undefined>(
    () => (shared && props.teamId ? [{ kind: 'team', teamId: props.teamId }] : undefined),
    [shared, props.teamId],
  );
  const row: RowState = {
    serverId: props.serverId,
    teamId: props.teamId ?? '',
    connectedServicesTeamResourcesOnly: shared,
    defaults,
    editable: props.editable,
    disabled: props.busy,
    conflictNote: '',
    save,
    inheritance,
  };
  return (
    <DefaultsEditor
      testID={props.testID}
      row={row}
      attention={error ? {
        title: t('homeGovernance.changeFailedTitle'),
        description: resolveActionExecutionErrorMessage(error.cause, t('teams.errors.generic'), { safeToRetry: true }),
        action: props.editable ? { label: t('common.retry'), onPress: retry,
          testID: `${props.testID}-retry`, disabled: props.busy } : undefined,
        accessibilityLiveRegion: 'assertive',
      } : null}
      placementConflict={false}
      projectAgent={{ current: defaults.defaultAgentTarget, onSelect: selectAgent }}
      approvalProfile={{
        scopeOrHome: props.serverId,
        value: defaults.approvalProfileId,
        audience,
        inherited: inheritance.approvalProfileId,
        description: shared ? t('teams.settings.memberDefaults.approvalProfileProject') : undefined,
        editable: props.editable,
        disabled: props.busy,
        save: selectApprovalProfile,
      }}
      selectedAgent={defaults.defaultAgentTarget ?? inheritance.agentTarget.value}
      conflictsFor={noConflicts}
    />
  );
}

/**
 * The editor's one assembly for every scope: an attention banner when a save failed, then one section with the
 * Machine first, a project's Agent row, the Approval profile (not on the Home's page), and one row per Agent.
 */
function DefaultsEditor(props: Readonly<{
  testID: string;
  row: RowState;
  attention: DefaultsAttention | null;
  title?: string;
  description?: string;
  placementConflict: boolean;
  onApprovalPending?: TeamSectionContext['requestApproval'];
  /** Only a project names the Agent its new sessions start with. */
  projectAgent?: Readonly<{ current: AgentExecutionTargetV1 | undefined; onSelect: (target: AgentExecutionTargetV1 | undefined) => void }>;
  approvalProfile: Omit<React.ComponentProps<typeof ApprovalProfileDefaultRow>, 'testID'> | null;
  selectedAgent: AgentExecutionTargetV1 | undefined;
  conflictsFor: (backendTargetKey: string) => MemberDefaultsConflicts;
}>) {
  const { testID, row } = props;
  const enabledAgentIds = useEnabledAgentIds();
  const agents = React.useMemo(
    // Only Agents with a backend target can carry a Session default.
    () => getResolvedAgentCatalogEntries({ enabledAgentIds }).filter((entry) => entry.backendTargetKey !== null),
    [enabledAgentIds],
  );
  return (
    <>
      {props.attention ? <AttentionBanner testID={`${testID}-attention`} {...props.attention} /> : null}
      <ItemGroup testID={testID} title={props.title} description={props.description}>
        <TeamMemberMachineDefaultRow state={row} conflict={props.placementConflict} testID={`${testID}-machine`}
          onApprovalPending={props.onApprovalPending} />
        {props.projectAgent ? (
          <ProjectAgentDefaultRow agents={agents} state={row} current={props.projectAgent.current}
            onSelect={props.projectAgent.onSelect} testID={`${testID}-agent`} />
        ) : null}
        {props.approvalProfile ? <ApprovalProfileDefaultRow {...props.approvalProfile} testID={`${testID}-approvalProfile`} /> : null}
        <AgentDefaultsList agents={agents} state={row} selected={props.selectedAgent}
          conflictsFor={props.conflictsFor} testID={testID} />
      </ItemGroup>
    </>
  );
}

const noConflicts = () => NO_CONFLICTS;

/**
 * The Agents a defaults scope shows (lab L11; design review 2026-11-17): the default Agent's group open first,
 * then each Agent with a value at some layer, then the rest behind one "Other Agents" row, so an unset Agent
 * is one press away instead of a row of "None". Inherited layers are read once per Agent here, not on render.
 */
const AgentDefaultsList = React.memo(function AgentDefaultsList(props: Readonly<{
  agents: readonly ResolvedAgentCatalogEntry[];
  state: RowState;
  selected: AgentExecutionTargetV1 | undefined;
  conflictsFor: (backendTargetKey: string) => MemberDefaultsConflicts;
  testID: string;
}>) {
  // While "Other Agents" is open, the Agents it showed stay in it: a value set there must not move the row being
  // edited out from under the person (and remount it closed). They join the valued Agents once it closes.
  const [openedOthers, setOpenedOthers] = React.useState<ReadonlySet<string> | null>(null);
  const othersOpen = openedOthers !== null;
  const { defaults, inheritance } = props.state;
  const groups = React.useMemo(() => {
    const lead: { entry: ResolvedAgentCatalogEntry; summary: string | null }[] = [];
    const valued: typeof lead = [];
    const others: typeof lead = [];
    for (const entry of props.agents) {
      const key = entry.backendTargetKey!;
      const target = agentExecutionTargetOf(entry);
      const inherited = inheritance && target ? inheritance.forAgent(target) : null;
      const decision = inherited
        ? [inherited.permissionMode, inherited.model, ...inherited.connectedServices].find((field) => field.source !== 'none') ?? null
        : null;
      // What the Agent starts with from other layers, as values (lab L11): its permission mode by name and its
      // model by id (a closed Agent reads no model catalog); the source name only when no value can be shown.
      const values = inherited ? [
        inherited.permissionMode.source !== 'none' && inherited.permissionMode.value !== undefined
          ? getPermissionModeOptionsForAgentType(entry.agentId, 'settings')
            .find((option) => option.value === inherited.permissionMode.value)?.label ?? null
          : null,
        inherited.model.source !== 'none' ? inherited.model.value?.ref.modelId ?? null : null,
      ].filter((value): value is string => Boolean(value)) : [];
      const summary = values.length > 0 ? values.join(' · ')
        : decision && inherited ? describeInheritedDefaultSource(decision.source, inherited.permissionMode.names) : null;
      const stored = defaults.permissionModeByAgentTargetKey?.[key] !== undefined
        || defaults.modelByAgentTargetKey?.[key] !== undefined
        || (defaults.connectedServicesByAgentTargetKey?.[key]?.length ?? 0) > 0;
      const item = { entry, summary };
      if (props.selected && target && sameAgentTarget(target, props.selected)) lead.push(item);
      else if (openedOthers?.has(key)) others.push(item);
      else if (stored || decision) valued.push(item);
      else others.push(item);
    }
    return { lead, valued, others };
  }, [props.agents, props.selected, defaults, inheritance, openedOthers]);
  const setOthersOpen = React.useCallback((open: boolean) => {
    setOpenedOthers(open ? new Set(groups.others.map((item) => item.entry.backendTargetKey!)) : null);
  }, [groups.others]);
  const row = (item: Readonly<{ entry: ResolvedAgentCatalogEntry; summary: string | null }>, initiallyExpanded = false) => (
    <AgentDefaultsItem key={item.entry.backendTargetKey} entry={item.entry} state={props.state}
      conflicts={props.conflictsFor(item.entry.backendTargetKey!)} summary={item.summary}
      initiallyExpanded={initiallyExpanded} testID={`${props.testID}-agent:${item.entry.agentId}`} />
  );
  return (
    <>
      {groups.lead.map((item) => row(item, true))}
      {groups.valued.map((item) => row(item))}
      {/* Nothing to say about unset Agents when read-only; editable, they are one press away. */}
      {groups.others.length > 0 && props.state.editable ? (
        <ExpandableItem
          testID={`${props.testID}-otherAgents`}
          expanded={othersOpen}
          onExpandedChange={setOthersOpen}
          header={({ headerProps }) => (
            <Item {...headerProps} testID={`${props.testID}-otherAgents:header`} icon={<Icon name="stack" />}
              title={t('teams.settings.memberDefaults.otherAgents')} detail={String(groups.others.length)} />
          )}
        >
          {othersOpen ? groups.others.map((item) => row(item)) : null}
        </ExpandableItem>
      ) : null}
    </>
  );
});

/** One Agent's defaults: collapsed it says which are set; open, one row per choice. */
const AgentDefaultsItem = React.memo(function AgentDefaultsItem(
  props: Readonly<{
    entry: ResolvedAgentCatalogEntry;
    state: RowState;
    conflicts: MemberDefaultsConflicts;
    testID: string;
    /** The scope's default Agent opens with its rows showing (lab L11). */
    initiallyExpanded?: boolean;
    /** Collapsed, with nothing set here: where this Agent's defaults come from, else the Agent's own default. */
    summary?: string | null;
  }>,
) {
  const { theme } = useUnistyles();
  const [expanded, setExpanded] = React.useState(props.initiallyExpanded === true);
  const unset = props.summary ?? t('teams.settings.memberDefaults.agentDefault');
  const key = props.entry.backendTargetKey!;
  const { defaults, inheritance } = props.state;
  // A project scope shows what each field falls back to; resolved only while the Agent is open.
  const inherited = React.useMemo(() => {
    if (!expanded || !inheritance) return null;
    const target = agentExecutionTargetOf(props.entry);
    return target ? inheritance.forAgent(target) : null;
  }, [expanded, inheritance, props.entry]);
  const permissionMode = defaults.permissionModeByAgentTargetKey?.[key];
  // Collapsed, the row names what is set: the permission mode by its value, the rest by kind.
  const setLabels = [
    permissionMode !== undefined
      ? getPermissionModeOptionsForAgentType(props.entry.agentId, 'settings')
          .find((option) => option.value === permissionMode)?.label
          ?? t('teams.settings.memberDefaults.permissionMode')
      : null,
    // The model by id, like the inherited summary (a closed Agent reads no model catalog).
    defaults.modelByAgentTargetKey?.[key]?.ref.modelId ?? null,
    ...(defaults.connectedServicesByAgentTargetKey?.[key]?.length
      ? [t('connectedServices.title')]
      : []),
  ].filter((label): label is string => label !== null);
  const anyConflict =
    props.conflicts.permissionMode ||
    props.conflicts.model ||
    props.conflicts.connectedServices.size > 0;
  const icon = (
    <AgentCatalogIdentityIcon
      entry={props.entry}
      machineId={null}
      serverId={props.state.serverId}
      current={false}
      color={theme.colors.text.secondary}
      size={24}
    />
  );
  // Read-only with nothing set, opening would only repeat "None": the row is a value, like the Machine row.
  if (!props.state.editable && setLabels.length === 0) {
    return (
      <Item
        testID={`${props.testID}:header`}
        title={props.entry.title}
        subtitle={unset}
        icon={icon}
        mode="info"
        showChevron={false}
      />
    );
  }
  return (
    <ExpandableItem
      testID={props.testID}
      expanded={expanded}
      onExpandedChange={setExpanded}
      header={({ headerProps }) => (
        <Item
          {...headerProps}
          testID={`${props.testID}:header`}
          title={props.entry.title}
          // What this Agent starts with, as the line under its name, open or not (lab L11); a conflict takes
          // that line while the row is closed, since the open rows show their own.
          subtitle={
            anyConflict && !expanded ? props.state.conflictNote : setLabels.join(' · ') || unset
          }
          subtitleLines={0}
          icon={icon}
        />
      )}
    >
      {/* Opening is the demand: closed Agents read no models or credentials. */}
      {expanded ? (
        <>
          <PermissionModeDefaultRow
            entry={props.entry}
            state={props.state}
            conflict={props.conflicts.permissionMode}
            inherited={inherited?.permissionMode ?? null}
            testID={`${props.testID}:permission`}
          />
          <ModelDefaultRow
            entry={props.entry}
            state={props.state}
            conflict={props.conflicts.model}
            inherited={inherited?.model ?? null}
            testID={`${props.testID}:model`}
          />
          <ConnectedServiceDefaultRows
            entry={props.entry}
            state={props.state}
            conflicts={props.conflicts.connectedServices}
            testID={`${props.testID}:service`}
          />
        </>
      ) : null}
    </ExpandableItem>
  );
});

const PermissionModeDefaultRow = React.memo(function PermissionModeDefaultRow(
  props: Readonly<{
    entry: ResolvedAgentCatalogEntry;
    state: RowState;
    conflict: boolean;
    /** What clearing this project field restores, and whose it is (project scopes only). */
    inherited?: ResolvedInheritedManagedSessionDefaults['permissionMode'] | null;
    testID: string;
  }>,
) {
  const [open, setOpen] = React.useState(false);
  const { state } = props;
  const key = props.entry.backendTargetKey!;
  const options = getPermissionModeOptionsForAgentType(
    props.entry.agentId,
    'settings',
  );
  if (options.length === 0) return null;
  const current = state.defaults.permissionModeByAgentTargetKey?.[key];
  const title = t('teams.settings.memberDefaults.permissionMode');
  const none = t('teams.settings.memberDefaults.none');
  const restoreLabel = props.inherited?.value !== undefined
    ? options.find((option) => option.value === props.inherited?.value)?.label ?? null : null;
  const restoreSource = restoreLabel && props.inherited ? describeInheritedDefaultSource(props.inherited.source, props.inherited.names) : null;
  const inheritedLabel = current === undefined ? restoreLabel : null;
  const note = [current === undefined ? restoreSource : null, props.conflict ? state.conflictNote : null]
    .filter(Boolean).join(' ') || undefined;
  if (!state.editable) {
    return (
      <Item
        testID={props.testID}
        title={title}
        subtitle={note}
        subtitleLines={0}
        detail={
          options.find((option) => option.value === current)?.label ??
          inheritedLabel ?? none
        }
        mode="info"
        showChevron={false}
      />
    );
  }
  return (
    <DropdownMenu
      open={open}
      onOpenChange={setOpen}
      variant="selectable"
      search={false}
      selectedId={current ?? NONE_ID}
      showCategoryTitles={false}
      matchTriggerWidth
      connectToTrigger
      rowKind="item"
      popoverPortalWebTarget="body"
      itemTrigger={{
        title,
        subtitle: note,
        showSelectedSubtitle: false,
        // Nothing set here: the field shows the value a new session falls back to.
        detailFormatter: (item) => item?.id === NONE_ID ? inheritedLabel ?? none : item?.title ?? null,
        itemProps: { disabled: state.disabled, testID: props.testID },
      }}
      items={[
        {
          id: NONE_ID,
          title: restoreLabel ? t('teams.settings.memberDefaults.useDefault', { value: restoreLabel }) : none,
          subtitle: restoreSource ?? undefined,
          testID: `${props.testID}:none`,
        },
        ...options.map((option) => ({
          id: option.value,
          title: option.label,
          subtitle: option.description,
          testID: `${props.testID}:${option.value}`,
        })),
      ]}
      onSelect={(id) => {
        setOpen(false);
        const next = options.find((option) => option.value === id)?.value;
        if (state.disabled || next === current) return;
        state.save(withPermissionMode(state.defaults, key, next));
      }}
    />
  );
});

const ModelDefaultRow = React.memo(function ModelDefaultRow(
  props: Readonly<{
    entry: ResolvedAgentCatalogEntry;
    state: RowState;
    conflict: boolean;
    /** What clearing this project field restores, and whose it is (project scopes only). */
    inherited?: ResolvedInheritedManagedSessionDefaults['model'] | null;
    testID: string;
  }>,
) {
  const { theme } = useUnistyles();
  const { state } = props;
  const key = props.entry.backendTargetKey!;
  const stored = state.defaults.modelByAgentTargetKey?.[key];
  const restore = props.inherited?.value ?? null;
  const restoreSource = restore && props.inherited ? describeInheritedDefaultSource(props.inherited.source, props.inherited.names) : null;
  const restoreLabel = restore && 'modelId' in restore.ref ? restore.ref.modelId : null;
  // Nothing set here: the field shows the model a new session falls back to; picking any model sets it here.
  const inheriting = stored === undefined && restore !== null;
  const shownRef = stored?.ref ?? (inheriting ? restore.ref : undefined);
  const pickerSelection = React.useMemo(() => sessionModelPickerValueFromRef(shownRef), [shownRef]);
  const selected = pickerSelection && 'providerConnectionId' in pickerSelection ? pickerSelection : null;
  const selectedTeamCredentialModel = isTeamCredentialProviderModelPickerValue(pickerSelection) ? pickerSelection : null;
  const placement = state.defaults.placement;
  const machineId = placement?.kind === 'machine' && placement.target.serverId === state.serverId
    ? placement.target.machineId : null;
  const resourcesEnabled = useFeatureEnabled('teams.credentialResources', {
    scopeKind: 'spawn', serverId: state.serverId,
  });
  const catalog = useHomeTeamCredentialModelCatalog({
    serverId: state.serverId, machineId, agentTargetKey: key,
    enabled: resourcesEnabled && Boolean(state.teamId),
  });
  const onSelectTeamCredentialModel = React.useCallback((selection: TeamCredentialProviderModelSelectionV1) => {
    if (state.disabled) return;
    const { kind: _kind, ...ref } = selection;
    state.save(withModel(state.defaults, key, {
      v: 2, updatedAt: Date.now(), ref: { source: 'team_resource', ...ref },
    }));
  }, [key, state.defaults, state.disabled, state.save]);
  const teamModelChoice = React.useMemo(() => ({
    probe: catalog.probe,
    teamCredentialResources: catalog.resources.filter(resource => resource.teamId === state.teamId),
    teamCredentialDisplayNames: catalog.displayNames,
    teamNameById: catalog.teamNameById,
    homeNameByTeamId: catalog.homeNameByTeamId,
    teamCredentialResourceStatusByKey: catalog.resourceStatusByKey,
    selectedTeamCredentialModel,
    onSelectTeamCredentialModel,
  }), [catalog.probe, catalog.resources, catalog.displayNames, catalog.teamNameById, catalog.homeNameByTeamId,
    catalog.resourceStatusByKey, state.teamId, selectedTeamCredentialModel, onSelectTeamCredentialModel]);
  const title = t('teams.settings.memberDefaults.model');
  const none = t('teams.settings.memberDefaults.none');
  const choice = useExactModelChoice({
    purpose: 'preference',
    agentTargetKey: key,
    agentId: props.entry.identity
      ? resolveBundledAgentIdFromContributionIdentity(props.entry.identity)
      : props.entry.catalogAgentId,
    machineId,
    serverId: state.serverId,
    selected,
    title,
    fallbackLabel: none,
    clearOptionLabel: restore ? t('teams.settings.memberDefaults.useDefault', { value: restoreLabel ?? none }) : none,
    clearOptionDescription: restoreSource ?? t('teams.settings.memberDefaults.modelNone'),
    enabled: true,
    teamModelChoice,
  });
  const hasSelection = selected !== null || selectedTeamCredentialModel !== null;
  const label = hasSelection ? (choice.presentation.subtitle ?? null) : null;
  const note = [inheriting ? restoreSource : null, props.conflict ? state.conflictNote : null].filter(Boolean).join(' ') || undefined;
  if (!state.editable) {
    return (
      <Item
        testID={props.testID}
        title={title}
        subtitle={note}
        subtitleLines={0}
        detail={label ?? none}
        mode="info"
        showChevron={false}
      />
    );
  }
  return (
    <Item
      testID={props.testID}
      title={title}
      subtitle={note}
      subtitleLines={0}
      accessibilityLabel={`${title}: ${label ?? none}`}
      accessoryLayout="adaptive"
      fieldAccessory
      rightElementPassive
      showChevron={false}
      disabled={state.disabled}
      rightElement={renderDropdownItemTriggerRightElement({
        // "None" is this section's answer, in the same ink as every other row's, not a prompt.
        detail: label ?? none,
        open: false,
        detailColor: theme.colors.text.primary,
        chevronColor: theme.colors.text.secondary,
        field: resolveFieldBoxColors(theme),
        placeholder: none,
        secondary: hasSelection ? (choice.presentation.detail ?? null) : null,
        secondaryColor: theme.colors.text.secondary,
        fieldSpan: 'column',
        loading: Boolean(selected?.providerConnectionId) && choice.loading,
      })}
      onPress={() =>
        choice.open((ref) => {
          if (state.disabled) return;
          state.save(
            withModel(
              state.defaults,
              key,
              ref ? { v: 1, ref, updatedAt: Date.now() } : undefined,
            ),
          );
        })
      }
    />
  );
});

/**
 * Shared defaults offer only this Team's resources; private Project defaults
 * also offer the viewer's own accounts and groups through the same chooser.
 * A default never grants access to what it names.
 */
const ConnectedServiceDefaultRows = React.memo(
  function ConnectedServiceDefaultRows(
    props: Readonly<{
      entry: ResolvedAgentCatalogEntry;
      state: RowState;
      conflicts: ReadonlySet<string>;
      testID: string;
    }>,
  ) {
    const { state } = props;
    const identity = props.entry.identity;
    const declarations = props.entry.connectedAccounts;
    const key = props.entry.backendTargetKey!;
    const resourcesEnabled = useFeatureEnabled('teams.credentialResources', {
      scopeKind: 'spawn',
      serverId: state.serverId,
    });
    const catalog = useHomeTeamCredentialModelCatalog({
      serverId: state.serverId,
      enabled: resourcesEnabled && declarations.length > 0,
    });
    const teamCatalog = React.useMemo(
      () => ({
        resources: catalog.resources.filter(
          (resource) => resource.teamId === state.teamId,
        ),
        teamNameById: catalog.teamNameById,
        displayNames: catalog.displayNames,
        resourceStatusByKey: catalog.resourceStatusByKey,
      }),
      [
        catalog.resources,
        catalog.teamNameById,
        catalog.displayNames,
        catalog.resourceStatusByKey,
        state.teamId,
      ],
    );
    if (!identity || declarations.length === 0) return null;
    const stored =
      state.defaults.connectedServicesByAgentTargetKey?.[key] ?? [];
    return (
      <>
        {declarations.map((declaration) => {
          const purpose = { consumer: identity, purpose: declaration.purpose };
          const purposeKey = qualifiedPurposeKey(purpose);
          const current =
            stored.find(
              (entry) => qualifiedPurposeKey(entry.purpose) === purposeKey,
            ) ?? null;
          return (
            <ConnectedAccountPurposeTargetChooser
              key={purposeKey}
              testID={`${props.testID}:${declaration.purpose}`}
              localizedTextPluginId={identity.pluginId}
              declaration={{ ...declaration, required: false }}
              value={current?.target ?? null}
              teamResourceValue={current?.teamResource ?? null}
              teamCredentialCatalog={teamCatalog}
              teamResourcesOnly={state.connectedServicesTeamResourcesOnly}
              noneLabel={t('teams.settings.memberDefaults.none')}
              description={
                props.conflicts.has(purposeKey) ? state.conflictNote : undefined
              }
              onReload={catalog.reload}
              disabled={!state.editable || state.disabled}
              onChange={(target, teamResource) => {
                if (!state.editable || state.disabled) return;
                state.save(
                  withConnectedService(
                    state.defaults,
                    key,
                    purposeKey,
                    target || teamResource
                      ? {
                          purpose,
                          service: declaration.service,
                          target,
                          teamResource: teamResource
                            ? {
                                teamId: teamResource.teamId,
                                selection: teamResource.selection,
                              }
                            : null,
                        }
                      : null,
                  ),
                );
              }}
            />
          );
        })}
      </>
    );
  },
);

const NO_CONFLICTS: MemberDefaultsConflicts = Object.freeze({
  approvalProfile: false, placement: false, permissionMode: false, model: false, connectedServices: new Set<string>(),
});

/** The Agent a project's new sessions start with: an exact execution target, never an id parsed from a label. */
function agentExecutionTargetOf(entry: ResolvedAgentCatalogEntry): AgentExecutionTargetV1 | null {
  if (entry.identity) return { kind: 'agent', identity: entry.identity };
  return entry.backendTargetKey ? resolveAgentExecutionTargetForBackendTarget({ backendTarget: entry.backendTargetKey }) : null;
}

function sameAgentTarget(left: AgentExecutionTargetV1 | null | undefined, right: AgentExecutionTargetV1 | null | undefined): boolean {
  return Boolean(left && right && left.identity.pluginId === right.identity.pluginId
    && left.identity.localId === right.identity.localId && left.definitionId === right.definitionId);
}

const ProjectAgentDefaultRow = React.memo(function ProjectAgentDefaultRow(props: Readonly<{
  agents: readonly ResolvedAgentCatalogEntry[];
  state: RowState;
  current: AgentExecutionTargetV1 | undefined;
  onSelect: (target: AgentExecutionTargetV1 | undefined) => void;
  testID: string;
}>) {
  const { theme } = useUnistyles();
  const [open, setOpen] = React.useState(false);
  const options = React.useMemo(() => props.agents.flatMap((entry) => {
    const target = agentExecutionTargetOf(entry);
    return target ? [{ entry, target }] : [];
  }), [props.agents]);
  const selected = options.find((option) => sameAgentTarget(option.target, props.current));
  const title = t('projects.sessionDefaults.agent');
  const none = t('teams.settings.memberDefaults.none');
  const restore = props.state.inheritance?.agentTarget;
  const restoreOption = restore?.value ? options.find((option) => sameAgentTarget(option.target, restore.value)) : undefined;
  const restoreSource = restoreOption && restore ? describeInheritedDefaultSource(restore.source, restore.names) : null;
  const inheritedTitle = props.current === undefined ? restoreOption?.entry.title ?? null : null;
  // Like Machine and Approval, the row always says something: whose Agent it inherits, else what it decides.
  const subtitle = (props.current === undefined ? restoreSource : null) ?? t('teams.settings.memberDefaults.agentDescription');
  if (!props.state.editable) {
    // A preference row: no icon (apps/ui AGENTS Configuration surfaces; UI refinements A fix 4).
    return <Item testID={props.testID} title={title} subtitle={subtitle}
      detail={selected?.entry.title ?? inheritedTitle ?? none} mode="info" showChevron={false} />;
  }
  return (
    <DropdownMenu
      open={open}
      onOpenChange={setOpen}
      variant="selectable"
      search={false}
      selectedId={selected?.entry.backendTargetKey ?? NONE_ID}
      showCategoryTitles={false}
      matchTriggerWidth
      connectToTrigger
      rowKind="item"
      popoverPortalWebTarget="body"
      itemTrigger={{
        title,
        subtitle,
        showSelectedSubtitle: false,
        detailFormatter: (item) => item?.id === NONE_ID ? inheritedTitle ?? none : item?.title ?? null,
        itemProps: { disabled: props.state.disabled, testID: props.testID },
      }}
      items={[
        { id: NONE_ID, title: restoreOption ? t('teams.settings.memberDefaults.useDefault', { value: restoreOption.entry.title }) : none,
          subtitle: restoreSource ?? undefined, testID: `${props.testID}:none` },
        ...options.map(({ entry }) => ({
          id: entry.backendTargetKey!,
          title: entry.title,
          icon: <AgentCatalogIdentityIcon entry={entry} machineId={null} serverId={props.state.serverId}
            current={false} color={theme.colors.text.secondary} size={18} />,
          testID: `${props.testID}:${entry.agentId}`,
        })),
      ]}
      onSelect={(id) => {
        setOpen(false);
        const next = options.find((option) => option.entry.backendTargetKey === id)?.target;
        if (props.state.disabled || sameAgentTarget(next, props.current) || (!next && !props.current)) return;
        props.onSelect(next);
      }}
    />
  );
});

/**
 * The project editor while its read is in flight: the same section with the rows every loaded editor shows (Machine,
 * Agent and Approval profile), by name, each field and description line holding a quiet bar, and the closing "Other agents" row, whose
 * mark keeps the section's leading column where the loaded rows put their titles. Which Agents lead and how many
 * connected-service rows they open with come from the read and join between them, so the rows above never move
 * (TS-UI-ACCEPT-FINAL-1124: a held Agent group collapsed by 342 px for a Project with no Agent set). A read-only scope
 * with nothing set drops the last row, which moves nothing above it.
 */
export const ProjectSessionDefaultsLoadingSection = React.memo(function ProjectSessionDefaultsLoadingSection(props: Readonly<{
  /** The shared scope: the Approval profile row carries its standing description. */
  shared: boolean;
  testID: string;
}>) {
  const { theme } = useUnistyles();
  const rowMetrics = usePageRowMetrics();
  // A row's facts arrive on its description line: the bar holds that line, as the account security rows do.
  const line = <SkeletonTitle lineHeight={rowMetrics.subtitle.lineHeight} />;
  const field = renderDropdownItemTriggerRightElement({
    detail: null,
    open: false,
    detailColor: theme.colors.text.primary,
    chevronColor: theme.colors.text.secondary,
    field: resolveFieldBoxColors(theme),
    fieldSpan: 'column',
    loading: true,
  });
  const fieldRow = (testID: string, title: React.ReactNode, subtitle?: React.ReactNode) => (
    <Item testID={testID} title={title} subtitle={subtitle} subtitleLines={0} accessoryLayout="adaptive" fieldAccessory
      rightElementPassive showChevron={false} rightElement={field} />
  );
  return (
    <ItemGroup testID={props.testID} accessibilityLabel={t('common.loading')}>
      {fieldRow(`${props.testID}-machine`, t('teams.settings.memberDefaults.machine'), line)}
      {/* The Agent row always carries a line (its inherited source or its description), so its bar holds it. */}
      {fieldRow(`${props.testID}-agent`, t('projects.sessionDefaults.agent'), line)}
      {fieldRow(`${props.testID}-approvalProfile`, t('teams.settings.memberDefaults.approvalProfile'),
        props.shared ? t('teams.settings.memberDefaults.approvalProfileProject') : line)}
      <Item testID={`${props.testID}-otherAgents`} icon={<Icon name="stack" />}
        title={t('teams.settings.memberDefaults.otherAgents')} />
    </ItemGroup>
  );
});
