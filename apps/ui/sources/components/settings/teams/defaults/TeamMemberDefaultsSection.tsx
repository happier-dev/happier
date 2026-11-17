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
import { ExpandableItem } from '@/components/ui/lists/ExpandableItem';
import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { useFeatureEnabled } from '@/hooks/server/useFeatureEnabled';
import { useProjectSessionDefaultsSectionAdapter, type ProjectSessionDefaultsInheritance, type ProjectSessionDefaultsSectionInput } from '@/hooks/projects/useProjectSessionDefaultsSectionAdapter';
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

type RowState = Readonly<{
  serverId: string;
  teamId: string;
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
 */
type TeamMemberDefaultsSectionProps = Readonly<{
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

export const TeamMemberDefaultsSection = React.memo(
  function TeamMemberDefaultsSection(
    props: TeamMemberDefaultsSectionProps,
  ) {
    const { context, scope, access } = props;
    const home = 'home' in props && props.home;
    const [busy, setBusy] = React.useState(false);
    const [error, setError] = React.useState<string | null>(null);
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
            if (outcome.kind === 'failed')
              setError(teamMutationFailureLabel(outcome.failure));
            else if (outcome.kind === 'approval_pending') context.requestApproval?.(outcome.artifactId);
          } catch (cause) {
            if (isTeamActionApprovalPendingError(cause))
              context.requestApproval?.(cause.registration);
            else setError(t('teams.errors.generic'));
          } finally {
            inFlightRef.current = false;
            setBusy(false);
          }
        })();
      },
      [context, home, scope, stored],
    );

    const enabledAgentIds = useEnabledAgentIds();
    const agents = React.useMemo(
      () =>
        // Only Agents with a backend target can carry a Session default.
        getResolvedAgentCatalogEntries({ enabledAgentIds }).filter(
          (entry) => entry.backendTargetKey !== null,
        ),
      [enabledAgentIds],
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
      <>
        {error || repairRequired ? (
          <AttentionBanner
            testID={`${props.testID}-attention`}
            title={
              error
                ? t('homeGovernance.changeFailedTitle')
                : t('teams.settings.memberDefaults.repairRequired')
            }
            description={error ?? undefined}
            accessibilityLiveRegion={error ? 'assertive' : undefined}
          />
        ) : null}
        <ItemGroup
          testID={props.testID}
          // The Home's defaults are a page of their own whose header already names and explains them.
          title={home ? undefined : t('teams.settings.memberDefaults.title')}
          description={home ? undefined : description}
        >
          <TeamMemberMachineDefaultRow
            state={row}
            conflict={sessionConflicts.placement}
            testID={`${props.testID}-machine`}
            onApprovalPending={context.requestApproval}
          />
          {home ? null : (
            <ApprovalProfileDefaultRow
              scopeOrHome={context.scope}
              value={defaults.approvalProfileId}
              audience={audience}
              description={t('teams.settings.memberDefaults.approvalProfileMembers')}
              conflictNote={sessionConflicts.approvalProfile ? row.conflictNote : undefined}
              editable={editable}
              disabled={row.disabled}
              save={saveApprovalProfile}
              testID={`${props.testID}-approvalProfile`}
            />
          )}
          <AgentDefaultsList
            agents={agents}
            state={row}
            // Team, Group and Home defaults name no default Agent; their Agents with a value lead.
            selected={undefined}
            conflictsFor={(key) => memberDefaultsConflicts(stored, scope, key, policy?.homeDefaults)}
            testID={props.testID}
          />
        </ItemGroup>
      </>
    );
  },
);

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
  const selected = isTeamCredentialProviderModelPickerValue(pickerSelection) ? null : pickerSelection;
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
 * The Agent's connected-service purposes. A Team default is chosen for other
 * people, so only this Team's shared resources (or none) are offered, never the
 * viewer's own accounts; a default never grants access to what it names.
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
              value={null}
              teamResourceValue={current?.teamResource ?? null}
              teamCredentialCatalog={teamCatalog}
              teamResourcesOnly
              noneLabel={t('teams.settings.memberDefaults.none')}
              description={
                props.conflicts.has(purposeKey) ? state.conflictNote : undefined
              }
              onReload={catalog.reload}
              disabled={!state.editable || state.disabled}
              onChange={(_target, teamResource) => {
                if (!state.editable || state.disabled) return;
                state.save(
                  withConnectedService(
                    state.defaults,
                    key,
                    purposeKey,
                    teamResource
                      ? {
                          purpose,
                          service: declaration.service,
                          target: null,
                          teamResource: {
                            teamId: teamResource.teamId,
                            selection: teamResource.selection,
                          },
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
  const subtitle = props.current === undefined ? restoreSource ?? undefined : undefined;
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
 * The same member-defaults editor, for a project (plan F §2, lab L11): Machine first, the project-only Agent
 * row, then one row per Agent; each pick saves on its own. The host owns the scope (For me, or the project's
 * Source) and its writer; this section only renders the rows and reports a failed save.
 */
export const ProjectSessionDefaultsSection = React.memo(function ProjectSessionDefaultsSection(props: ProjectSessionDefaultsSectionInput & Readonly<{
  serverId: string;
  teamId: string | null;
  editable: boolean;
  busy: boolean;
  testID: string;
}>) {
  const { defaults } = props;
  const { save, selectAgent, selectApprovalProfile, error, inheritance } = useProjectSessionDefaultsSectionAdapter(props);
  // A project default reaches everyone admitted to it (owner 2026-11-16 ~19:15Z); "For me" reaches only me.
  const shared = props.scope === 'project';
  const audience = React.useMemo<readonly PrincipalRefV1[] | undefined>(
    () => (shared && props.teamId ? [{ kind: 'team', teamId: props.teamId }] : undefined),
    [shared, props.teamId],
  );
  const enabledAgentIds = useEnabledAgentIds();
  const agents = React.useMemo(
    () => getResolvedAgentCatalogEntries({ enabledAgentIds }).filter((entry) => entry.backendTargetKey !== null),
    [enabledAgentIds],
  );
  const row: RowState = {
    serverId: props.serverId,
    teamId: props.teamId ?? '',
    defaults,
    editable: props.editable,
    disabled: props.busy,
    conflictNote: '',
    save,
    inheritance,
  };
  return (
    <>
      {error ? (
        <AttentionBanner testID={`${props.testID}-attention`} title={t('homeGovernance.changeFailedTitle')}
          description={t('teams.errors.generic')} accessibilityLiveRegion="assertive" />
      ) : null}
      <ItemGroup testID={props.testID}>
        <TeamMemberMachineDefaultRow state={row} conflict={false} testID={`${props.testID}-machine`} />
        <ProjectAgentDefaultRow agents={agents} state={row} current={defaults.defaultAgentTarget}
          onSelect={selectAgent} testID={`${props.testID}-agent`} />
        <ApprovalProfileDefaultRow scopeOrHome={props.serverId} value={defaults.approvalProfileId} audience={audience}
          inherited={inheritance.approvalProfileId}
          description={shared ? t('teams.settings.memberDefaults.approvalProfileProject') : undefined}
          editable={props.editable} disabled={props.busy} save={selectApprovalProfile} testID={`${props.testID}-approvalProfile`} />
        <AgentDefaultsList agents={agents} state={row}
          selected={defaults.defaultAgentTarget ?? inheritance.agentTarget.value}
          conflictsFor={noConflicts} testID={props.testID} />
      </ItemGroup>
    </>
  );
});
