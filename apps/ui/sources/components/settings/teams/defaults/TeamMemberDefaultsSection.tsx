import * as React from 'react';
import { useUnistyles } from 'react-native-unistyles';

import { qualifiedPurposeKey } from '@happier-dev/protocol/connect/connectedAccountPurposeBindings';
import { projectSessionModelSelectionV2ToV1 } from '@happier-dev/protocol/providers/selection/v2';
import type { ManagedSessionDefaultsV1 } from '@happier-dev/protocol/teams';

import { resolveBundledAgentIdFromContributionIdentity } from '@/agents/catalog/catalog';
import {
  getResolvedAgentCatalogEntries,
  type ResolvedAgentCatalogEntry,
} from '@/agents/backendCatalog/agentCatalogProjection';
import { useEnabledAgentIds } from '@/agents/hooks/useEnabledAgentIds';
import { AgentCatalogIdentityIcon } from '@/agents/presentation/AgentCatalogIdentityIcon';
import { ConnectedAccountPurposeTargetChooser } from '@/components/settings/connectedServices/account/ConnectedAccountPurposeTargetChooser';
import { MachineSelector } from '@/components/sessions/new/components/MachineSelector';
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
import { useHomeTeamCredentialModelCatalog } from '@/hooks/teams/useHomeTeamCredentialModelCatalog';
import { useMachineListForServer } from '@/sync/domains/state/storage';
import type { Machine } from '@/sync/domains/state/storageTypes';
import { getPermissionModeOptionsForAgentType } from '@/sync/domains/permissions/permissionModeOptions';
import { setTeamPolicy } from '@/sync/ops/teams/teamOperations';
import { isTeamActionApprovalPendingError } from '@/sync/ops/teams/teamActionClient';
import { t } from '@/text';
import {
  getMachineDisplayName,
  resolveMachineDisplayNames,
} from '@/utils/sessions/machineDisplayNames';

import type { TeamSectionContext } from '../teamSectionContext';
import { teamMutationFailureLabel } from '../teamMutationPresentation';
import {
  buildMemberDefaultsPatch,
  memberDefaultsConflicts,
  readMemberDefaults,
  withConnectedService,
  withModel,
  withPermissionMode,
  withPlacement,
  type MemberDefaultsAccess,
  type MemberDefaultsConflicts,
  type MemberDefaultsScope,
} from './memberDefaults';

const EMPTY_MACHINES: readonly Machine[] = Object.freeze([]);
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
}>;

/**
 * "Defaults for members" (owner ruling 2026-11-07, row 519): the Machine, and per
 * Agent the permission mode, model and connected services a member's new
 * sessions start with. Members can change each one; nothing is copied into their
 * settings. One writer, `teams.policy.set` through the Action executor; who may
 * write is the Home's decision, mirrored by `access` and said when it is no.
 */
export const TeamMemberDefaultsSection = React.memo(
  function TeamMemberDefaultsSection(
    props: Readonly<{
      context: TeamSectionContext;
      scope: MemberDefaultsScope;
      access: MemberDefaultsAccess;
      /** The page can write right now (Home reachable, nothing pending, current data). */
      writable: boolean;
      testID: string;
    }>,
  ) {
    const { context, scope, access } = props;
    const [busy, setBusy] = React.useState(false);
    const [error, setError] = React.useState<string | null>(null);
    const inFlightRef = React.useRef(false);
    React.useEffect(
      () => () => {
        inFlightRef.current = false;
      },
      [],
    );

    const policy = context.team.policy;
    const stored = policy.managedDefaults ?? null;
    const repairRequired = policy.managedDefaultsStatus === 'repair_required';
    // A Group's layer cannot be rewritten over an unreadable document; only the Team's whole save repairs it.
    const editable =
      access.editable && !(repairRequired && scope.kind === 'group');
    const defaults = readMemberDefaults(stored, scope);

    const save = React.useCallback<SaveDefaults>(
      (next) => {
        if (inFlightRef.current) return;
        inFlightRef.current = true;
        setBusy(true);
        setError(null);
        void (async () => {
          try {
            const outcome = await setTeamPolicy({
              scope: context.scope,
              address: context.address,
              ...buildMemberDefaultsPatch(stored, scope, next),
            });
            if (outcome.kind === 'failed')
              setError(teamMutationFailureLabel(outcome.failure));
          } catch (cause) {
            if (isTeamActionApprovalPendingError(cause))
              context.requestApproval(cause.registration);
            else setError(t('teams.errors.generic'));
          } finally {
            inFlightRef.current = false;
            setBusy(false);
          }
        })();
      },
      [context, scope, stored],
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

    const row: RowState = {
      serverId: context.scope.serverId,
      teamId: context.address.teamId,
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
        : access.reason === 'team'
          ? t('teams.settings.memberDefaults.readOnlyTeam', {
              team: context.team.name,
            })
          : t('teams.settings.memberDefaults.readOnlyGroup'),
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
          title={t('teams.settings.memberDefaults.title')}
          description={description}
        >
          <MachineDefaultRow
            state={row}
            conflict={memberDefaultsConflicts(stored, scope, '').placement}
            testID={`${props.testID}-machine`}
          />
          {agents.map((entry) => (
            <AgentDefaultsItem
              key={entry.backendTargetKey}
              entry={entry}
              state={row}
              conflicts={memberDefaultsConflicts(
                stored,
                scope,
                entry.backendTargetKey!,
              )}
              testID={`${props.testID}-agent:${entry.agentId}`}
            />
          ))}
        </ItemGroup>
      </>
    );
  },
);

const MachineDefaultRow = React.memo(function MachineDefaultRow(
  props: Readonly<{
    state: RowState;
    conflict: boolean;
    testID: string;
  }>,
) {
  const { state } = props;
  const machines = useMachineListForServer(state.serverId) ?? EMPTY_MACHINES;
  const placement = state.defaults.placement;
  const selectedMachine =
    placement?.kind === 'machine' &&
    placement.target.serverId === state.serverId
      ? (machines.find(
          (machine) => machine.id === placement.target.machineId,
        ) ?? null)
      : null;
  // A Machine this viewer can't see, or a preset, still stands; it is named, never shown as None.
  const unseen =
    placement === undefined || selectedMachine
      ? null
      : t(
          placement.kind === 'preset'
            ? 'teams.settings.memberDefaults.preset'
            : 'teams.settings.memberDefaults.unavailableMachine',
        );
  const note = props.conflict ? props.state.conflictNote : null;

  if (!state.editable) {
    const name = selectedMachine
      ? (resolveMachineDisplayNames(machines).get(selectedMachine.id) ??
        getMachineDisplayName(selectedMachine) ??
        selectedMachine.id)
      : null;
    return (
      <Item
        testID={props.testID}
        title={t('teams.settings.memberDefaults.machine')}
        subtitle={note ?? undefined}
        subtitleLines={0}
        detail={name ?? unseen ?? t('teams.settings.memberDefaults.none')}
        icon={<MachineMark />}
        mode="info"
        showChevron={false}
      />
    );
  }
  return (
    <MachineSelector
      presentation="dropdown"
      dropdownInCallerSection
      serverId={state.serverId}
      machines={machines}
      selectedMachine={selectedMachine}
      showFavorites={false}
      showRecent={false}
      // A default names where sessions should start later, not where one can start now.
      disableOfflineMachines={false}
      includeSelectedUnavailableMachine
      dropdownTitle={t('teams.settings.memberDefaults.machine')}
      dropdownSubtitle={[unseen, note].filter(Boolean).join(' ') || undefined}
      dropdownTestID={props.testID}
      testIdPrefix={props.testID}
      dropdownClearOption={{
        title: t('teams.settings.memberDefaults.none'),
        current: placement === undefined,
        onSelect: () => {
          if (!state.disabled && placement !== undefined)
            state.save(withPlacement(state.defaults, undefined));
        },
      }}
      onSelect={(machine) => {
        if (state.disabled || machine.id === selectedMachine?.id) return;
        state.save(
          withPlacement(state.defaults, {
            kind: 'machine',
            target: { serverId: state.serverId, machineId: machine.id },
          }),
        );
      }}
    />
  );
});

function MachineMark() {
  const { theme } = useUnistyles();
  return <Icon name="desktop" size={24} color={theme.colors.text.secondary} />;
}

/** One Agent's defaults: collapsed it says which are set; open, one row per choice. */
const AgentDefaultsItem = React.memo(function AgentDefaultsItem(
  props: Readonly<{
    entry: ResolvedAgentCatalogEntry;
    state: RowState;
    conflicts: MemberDefaultsConflicts;
    testID: string;
  }>,
) {
  const { theme } = useUnistyles();
  const [expanded, setExpanded] = React.useState(false);
  const key = props.entry.backendTargetKey!;
  const { defaults } = props.state;
  const permissionMode = defaults.permissionModeByAgentTargetKey?.[key];
  // Collapsed, the row names what is set: the permission mode by its value, the rest by kind.
  const setLabels = [
    permissionMode !== undefined
      ? getPermissionModeOptionsForAgentType(props.entry.agentId, 'settings')
          .find((option) => option.value === permissionMode)?.label
          ?? t('teams.settings.memberDefaults.permissionMode')
      : null,
    defaults.modelByAgentTargetKey?.[key] !== undefined
      ? t('teams.settings.memberDefaults.model')
      : null,
    ...(defaults.connectedServicesByAgentTargetKey?.[key]?.length
      ? [t('connectedServices.title')]
      : []),
  ].filter((label): label is string => label !== null);
  const anyConflict =
    props.conflicts.permissionMode ||
    props.conflicts.model ||
    props.conflicts.connectedServices.size > 0;
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
          subtitle={
            anyConflict && !expanded ? props.state.conflictNote : undefined
          }
          subtitleLines={0}
          detail={
            expanded
              ? undefined
              : setLabels.join(' · ') || t('teams.settings.memberDefaults.none')
          }
          icon={
            <AgentCatalogIdentityIcon
              entry={props.entry}
              machineId={null}
              serverId={props.state.serverId}
              current={false}
              color={theme.colors.text.secondary}
              size={24}
            />
          }
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
            testID={`${props.testID}:permission`}
          />
          <ModelDefaultRow
            entry={props.entry}
            state={props.state}
            conflict={props.conflicts.model}
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
  const note = props.conflict ? state.conflictNote : undefined;
  if (!state.editable) {
    return (
      <Item
        testID={props.testID}
        title={title}
        subtitle={note}
        subtitleLines={0}
        detail={
          options.find((option) => option.value === current)?.label ??
          t('teams.settings.memberDefaults.none')
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
        itemProps: { disabled: state.disabled, testID: props.testID },
      }}
      items={[
        {
          id: NONE_ID,
          title: t('teams.settings.memberDefaults.none'),
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
    testID: string;
  }>,
) {
  const { theme } = useUnistyles();
  const { state } = props;
  const key = props.entry.backendTargetKey!;
  const stored = state.defaults.modelByAgentTargetKey?.[key];
  const selected = stored
    ? stored.v === 1
      ? stored.ref
      : (projectSessionModelSelectionV2ToV1(stored)?.ref ?? null)
    : null;
  const title = t('teams.settings.memberDefaults.model');
  const none = t('teams.settings.memberDefaults.none');
  const choice = useExactModelChoice({
    purpose: 'preference',
    agentTargetKey: key,
    agentId: props.entry.identity
      ? resolveBundledAgentIdFromContributionIdentity(props.entry.identity)
      : props.entry.catalogAgentId,
    machineId: null,
    serverId: state.serverId,
    selected,
    title,
    fallbackLabel: none,
    clearOptionLabel: none,
    clearOptionDescription: t('teams.settings.memberDefaults.modelNone'),
    enabled: true,
  });
  const label = selected ? (choice.presentation.subtitle ?? null) : null;
  const note = props.conflict ? state.conflictNote : undefined;
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
        secondary: selected ? (choice.presentation.detail ?? null) : null,
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
        resourceStatusByKey: catalog.resourceStatusByKey,
      }),
      [
        catalog.resources,
        catalog.teamNameById,
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
