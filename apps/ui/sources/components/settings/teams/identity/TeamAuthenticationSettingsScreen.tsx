import * as React from 'react';
import { useRouter } from '@/components/appShell/workspace/destinationRoute';
import type { AuthEntryProjectionV1 } from '@happier-dev/protocol';
import type {
  IdentityConnectionV1,
  TeamIdentityEligibleProviderV1,
} from '@happier-dev/protocol/teams';
import { useUnistyles } from 'react-native-unistyles';

import { AttentionBanner } from '@/components/ui/lists/AttentionBanner';
import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { ItemLoadStateRows } from '@/components/ui/lists/ItemLoadStateRows';
import { SectionActionButton } from '@/components/ui/lists/SectionActionButton';
import { DropdownMenu } from '@/components/ui/forms/dropdown/DropdownMenu';
import { StatusDot } from '@/components/ui/status/StatusDot';
import { SurfaceStateCard } from '@/components/ui/surfaces/SurfaceStateCard';
import {
  signInConnectionStatusLabel,
  signInConnectionStatusTone,
} from '@/components/settings/identity/signInConnectionStatus';
import { useTeamManagerNames } from '@/hooks/teams/useTeamManagerNames';
import { teamSignInReturnPath } from '@/components/teams/entry/teamSignInHome';
import { useHomeViewerRole } from '@/hooks/home/useHomeViewerRole';
import { useHomeGovernanceEligibilitySnapshots } from '@/hooks/home/useHomeGovernanceEligibilitySnapshots';
import {
  SettingAnchor,
  SettingSection,
} from '@/components/settings/shell/SettingRow';
import { TEAM_AUTHENTICATION_SETTINGS } from './teamAuthenticationSettings';
import {
  identityAdministrationFailure,
  identityAdministrationFailureMessage,
} from '@/components/settings/identity/identityAdministrationFailure';
import { projectAuthEntryMethodCapabilities } from '@/auth/capabilities/authMethodCapabilities';
import { fetchHomeAuthEntry } from '@/auth/entry/authEntryClient';
import { serverAccountScopeKeySuffix } from '@/sync/domains/scope/serverAccountScope';
import {
  isHomeAdministrationAccountChange,
  subscribeHomeAccountChange,
} from '@/sync/runtime/orchestration/homeAccountChange';
import { announceAccessibilityMessage } from '@/components/ui/accessibility/announceAccessibilityMessage';
import { t } from '@/text';

import { TeamSection } from '../TeamSection';
import type { TeamSectionContext } from '../teamSectionContext';
import {
  teamDirectoryPath,
  teamDirectorySourcePath,
  teamIdentityConnectionPath,
  teamIdentityProviderSetupPath,
} from '../teamsRoutes';
import {
  teamAcceptedSignInSummary,
  teamAdmissionModeLabel,
} from '../teamPolicyPresentation';
import {
  directorySourcePresentationState,
  directorySourceStateLabel,
} from './directoryAdministrationPresentation';
import { useDirectoryAdministration } from './useDirectoryAdministration';
import { TeamAuthenticationPolicySections } from './TeamAuthenticationPolicySections';
import { TeamMemberSignInLinkSection } from './TeamMemberSignInLinkSection';
import { TeamGitHubAppsSection } from './TeamGitHubAppScreens';
import {
  identityConnectionMode,
  identityConnectionNextStepLabel,
  identityProviderKindIconName,
  identityProviderKindLabel,
  teamIdentityConnectionStatus,
} from './identityAdministrationPresentation';
import { useIdentityAdministration } from './useIdentityAdministration';
import {
  eligibleProviderFixHref,
  eligibleProviderFixLabel,
  eligibleProviderUnavailableReason,
  resolveEligibleProviderRecovery,
} from './eligibleProviderAvailability';
import {
  askAdministratorsText,
  askTeamManagersText,
} from '../collection/teamsCreateGuidanceText';
import { createIdentityAdministrationClient } from './identityAdministrationClient';
import { Icon } from '@/components/ui/icons/Icon';

/** Consume the catalog's exact Team-owned GitHub creation decision. */
function githubAppCreationAvailable(
  eligibleProviders: readonly TeamIdentityEligibleProviderV1[],
): boolean {
  return eligibleProviders.some(
    (provider) =>
      provider.providerKind === 'github_app_identity' &&
      provider.availability.status === 'available' &&
      provider.availability.setupChoice.kind === 'create_managed',
  );
}

const AuthorizedAuthenticationContent = React.memo(
  function AuthorizedAuthenticationContent(
    props: Readonly<{
      context: TeamSectionContext;
      scope: Parameters<typeof useIdentityAdministration>[0];
      address: Parameters<typeof teamIdentityConnectionPath>[0];
    }>,
  ) {
    const router = useRouter();
    const { state, refresh } = useIdentityAdministration(
      props.scope,
      props.address.teamId,
      props.context.requestApproval,
    );
    const client = React.useMemo(
      () =>
        createIdentityAdministrationClient(props.scope, {
          onApprovalPending: props.context.requestApproval,
        }),
      [
        props.context.requestApproval,
        props.scope.accountId,
        props.scope.serverId,
      ],
    );
    const [pendingProviderId, setPendingProviderId] = React.useState<
      string | null
    >(null);
    const [providerFailure, setProviderFailure] = React.useState<string | null>(
      null,
    );

    // Ask this exact Home's current entry owner, as Welcome does. Features are
    // independently cached discovery, not the complete contextual method list.
    // Keep only a route-local answer; Home policy and method decisions remain
    // with the server and the shared entry projector.
    const homeScopeKey = serverAccountScopeKeySuffix(props.scope);
    const [homeEntry, setHomeEntry] = React.useState<Readonly<{
      scopeKey: string;
      status: 'loading' | 'ready' | 'unavailable';
      projection: Extract<AuthEntryProjectionV1, { state: 'ready' }> | null;
    }> | null>(null);
    const [homeEntryRefresh, setHomeEntryRefresh] = React.useState(0);
    const refreshHomeEntry = React.useCallback(() => {
      setHomeEntry((current) =>
        current?.scopeKey === homeScopeKey
          ? { ...current, status: 'loading' }
          : null,
      );
      setHomeEntryRefresh((current) => current + 1);
    }, [homeScopeKey]);
    React.useEffect(() => {
      const controller = new AbortController();
      const scope = {
        serverId: props.scope.serverId,
        accountId: props.scope.accountId,
      };
      void fetchHomeAuthEntry({
        accountScope: scope,
        signal: controller.signal,
      }).then((result) => {
        if (controller.signal.aborted) return;
        const projection =
          result.kind === 'ready' &&
          result.projection.state === 'ready' &&
          result.projection.scope.kind === 'home'
            ? result.projection
            : null;
        setHomeEntry((current) => ({
          scopeKey: homeScopeKey,
          status: projection ? 'ready' : 'unavailable',
          projection:
            projection ??
            (result.kind === 'unavailable' && current?.scopeKey === homeScopeKey
              ? current.projection
              : null),
        }));
      });
      return () => controller.abort();
    }, [
      homeScopeKey,
      props.scope.serverId,
      props.scope.accountId,
      homeEntryRefresh,
    ]);
    React.useEffect(
      () =>
        subscribeHomeAccountChange((event) => {
          if (
            event.serverId === props.scope.serverId &&
            isHomeAdministrationAccountChange(event)
          )
            refreshHomeEntry();
        }),
      [props.scope.serverId, refreshHomeEntry],
    );
    const currentHomeEntry =
      homeEntry?.scopeKey === homeScopeKey ? homeEntry : null;
    const homeMethods = React.useMemo(
      () =>
        currentHomeEntry?.projection
          ? projectAuthEntryMethodCapabilities(currentHomeEntry.projection)
              .catalog.methods.filter((method) =>
                method.enabledActions.some((action) => action.id === 'login'),
              )
              .map((method) =>
                Object.freeze({
                  methodId: method.id,
                  displayName: method.presentation?.displayName ?? method.id,
                }),
              )
          : [],
      [currentHomeEntry?.projection],
    );
    // The Home's own sign-in methods feed "How members sign in"; when they cannot be read the
    // section says so on one line, beside the policy it affects (DR-13).
    const homeMethodsNotice =
      currentHomeEntry?.status === 'unavailable' ? (
        <ItemGroup>
          <SurfaceStateCard
            testID="team-authentication-home-methods-unavailable"
            kind="error"
            size="line"
            title={t('teams.authentication.homeMethodsUnavailable')}
            action={{
              label: t('common.retry'),
              onPress: refreshHomeEntry,
              testID: 'team-authentication-home-methods-retry',
            }}
            accessibilitySemantics="alert"
          />
        </ItemGroup>
      ) : null;

    // A typed Home outcome becomes one localized sentence, announced as well as
    // shown because it lands away from the control that was pressed.
    const reportProviderFailure = React.useCallback((code: string) => {
      const message = identityAdministrationFailureMessage(code);
      setProviderFailure(message);
      announceAccessibilityMessage(message);
    }, []);

    const finishConnectionCreation = React.useCallback(
      (connectionId: string) => {
        refresh();
        router.push(teamIdentityConnectionPath(props.address, connectionId));
      },
      [props.address, refresh, router],
    );

    // Page order is by consequence (DR-05, lab `tsAuth-A`): who can join and how members sign in
    // come first, then the connections those choices draw on, then the directory, the member
    // sign-in link and the rarely touched GitHub Apps. Admission and accepted sign-in are Team
    // *policy*, not connection data: a list that has not answered still shows the current policy,
    // while admission edits wait for the server-owned applicability projection. Only the
    // connections section's body changes while the identity projection loads or fails.
    if (state.kind === 'loading' || state.kind === 'unavailable') {
      const recovery =
        state.kind === 'unavailable'
          ? identityAdministrationFailure(state.failure.code).recovery
          : null;
      return (
        <>
          {homeMethodsNotice}
          <TeamAuthenticationPolicySections
            context={props.context}
            connections={[]}
            connectionsCurrent={false}
            admissionModeApplicability={null}
            homeMethods={homeMethods}
            homeMethodsCurrent={currentHomeEntry?.status === 'ready'}
          />
          <ItemGroup
            title={t('teams.authentication.connectionsSection')}
            description={t('teams.authentication.connectionsDescription')}
          >
            {state.kind === 'loading' ? (
              <ItemLoadStateRows
                testID="team-authentication-loading"
                state={{ kind: 'loading' }}
                rows={2}
                accessibilityLabel={t('common.loading')}
              />
            ) : (
              <SurfaceStateCard
                testID="team-authentication-unavailable"
                kind={recovery === 'team_authentication' ? 'warning' : 'error'}
                size="line"
                title={identityAdministrationFailureMessage(state.failure.code)}
                action={
                  recovery === 'team_authentication'
                    ? {
                        label: t('teams.entry.signInToTeam'),
                        onPress: () =>
                          router.push(
                            teamSignInReturnPath({
                              teamId: props.address.teamId,
                              serverId: props.address.serverId,
                            }),
                          ),
                      }
                    : state.failure.retryable
                      ? { label: t('common.retry'), onPress: refresh }
                      : undefined
                }
                accessibilitySemantics="alert"
              />
            )}
          </ItemGroup>
        </>
      );
    }

    const projectionCurrent = !state.refreshing && !state.stale;

    const useExistingProvider = async (
      provider: (typeof state.eligibleProviders)[number],
    ) => {
      if (!props.context.canMutate || !projectionCurrent) return;
      if (
        provider.availability.status !== 'available' ||
        provider.availability.setupChoice.kind !== 'use_existing'
      )
        return;
      const choice = provider.availability.setupChoice;
      setPendingProviderId(choice.providerInstanceId);
      setProviderFailure(null);
      try {
        const result = await client.execute(
          'teams.identity.connections.create',
          {
            v: 1,
            teamId: props.address.teamId,
            providerInstanceId: choice.providerInstanceId,
            externalReference: choice.connectionDraft.externalReference,
            settings: choice.connectionDraft.settings,
          },
          {
            onApprovalSucceeded: (value) =>
              finishConnectionCreation(value.connection.id),
            onApprovalFailed: reportProviderFailure,
          },
        );
        if (!result.ok) {
          if ('approvalPending' in result) return;
          reportProviderFailure(result.failure.code);
          return;
        }
        finishConnectionCreation(result.value.connection.id);
      } catch {
        // Transport failures must settle visibly; otherwise the action's
        // pending state clears while the rejection becomes an unhandled
        // promise and the row gives no recovery path.
        reportProviderFailure('operation_failed');
      } finally {
        setPendingProviderId(null);
      }
    };

    const createManagedProvider = async (
      provider: (typeof state.eligibleProviders)[number],
    ) => {
      if (!props.context.canMutate || !projectionCurrent) return;
      if (
        provider.availability.status !== 'available' ||
        provider.availability.setupChoice.kind !== 'create_managed'
      )
        return;
      const actionId = provider.availability.setupChoice.actionId;
      if (actionId === 'teams.identity.workos.connection.create') {
        router.push(teamIdentityProviderSetupPath(props.address, 'workos_sso'));
        return;
      }
      router.push(
        teamIdentityProviderSetupPath(
          props.address,
          provider.providerKind === 'oidc' ? 'oidc' : 'github_app_identity',
        ),
      );
    };

    return (
      <>
        {state.stale ? (
          <AttentionBanner
            testID="team-authentication-stale"
            title={t('teams.unavailable.offline')}
            description={t('teams.stale.label')}
            accessibilityLiveRegion="polite"
            action={{ label: t('common.retry'), onPress: refresh }}
          />
        ) : null}
        {/* Admission and accepted sign-in are Team policy, written through the
            one revision-guarded `teams.policy.set` owner rather than through
            the connection client below. */}
        {homeMethodsNotice}
        <TeamAuthenticationPolicySections
          context={props.context}
          connections={state.items}
          connectionsCurrent={projectionCurrent}
          admissionModeApplicability={state.admissionModeApplicability}
          homeMethods={homeMethods}
          homeMethodsCurrent={currentHomeEntry?.status === 'ready'}
        />
        {/* "Add connection" is the section's own "+" (DR-04/DR-05, lab `tsAuth-M`): a menu of every
            kind this Team could add, each unavailable one keeping its row with why and who can
            change it. */}
        <SettingAnchor
          setting={TEAM_AUTHENTICATION_SETTINGS.settings.connections}
        >
          <ItemGroup
            title={t('teams.authentication.connectionsSection')}
            description={t('teams.authentication.connectionsDescription')}
            action={
              <SettingAnchor
                setting={TEAM_AUTHENTICATION_SETTINGS.settings.eligibleProviders}
              >
                <AddConnectionMenu
                  context={props.context}
                  eligibleProviders={state.eligibleProviders}
                  pendingProviderId={pendingProviderId}
                  actionable={projectionCurrent && props.context.canMutate}
                  onUseExisting={(provider) => void useExistingProvider(provider)}
                  onCreateManaged={(provider) =>
                    void createManagedProvider(provider)
                  }
                />
              </SettingAnchor>
            }
          >
            {state.items.length === 0 ? (
              <SurfaceStateCard
                testID="team-authentication-empty"
                kind="empty"
                size="line"
                title={t('teams.authentication.empty')}
              />
            ) : (
              state.items.map((connection) => (
                <ConnectionRow
                  key={connection.id}
                  connection={connection}
                  onPress={() =>
                    router.push(
                      teamIdentityConnectionPath(props.address, connection.id),
                    )
                  }
                />
              ))
            )}
            {providerFailure ? (
              <SurfaceStateCard
                testID="team-authentication-failure"
                kind="error"
                size="line"
                title={providerFailure}
                accessibilitySemantics="alert"
              />
            ) : null}
          </ItemGroup>
        </SettingAnchor>
        <DirectorySection scope={props.scope} address={props.address} />
        {/* The page members are sent to. It carries no bearer, so it is
            shown to any administrator who can read this screen. */}
        <TeamMemberSignInLinkSection
          address={props.address}
          memberSignInUrl={state.memberSignInUrl}
        />
        {/* Existing registrations remain inspectable when policy later
            disables new setup; only the create affordance is unavailable. */}
        <TeamGitHubAppsSection
          context={props.context}
          createAvailable={githubAppCreationAvailable(state.eligibleProviders)}
        />
      </>
    );
  },
);

/**
 * One sign-in connection (lab `tsAuth-A`): the provider's mark, its name, and one line. A working
 * connection says how it is used; any other says its state first — with a dot when it needs
 * someone — and, while it is being set up, the step that comes next.
 */
const ConnectionRow = React.memo(function ConnectionRow(
  props: Readonly<{
    connection: IdentityConnectionV1;
    onPress: () => void;
  }>,
) {
  const { theme } = useUnistyles();
  const { connection } = props;
  const status = teamIdentityConnectionStatus(connection.state);
  const tone = signInConnectionStatusTone(status);
  const mode =
    identityConnectionMode(connection) === 'sign_in_time_groups'
      ? t('teams.authentication.mode.signInTimeGroups')
      : t('teams.authentication.mode.signInOnly');
  const subtitle =
    status === 'active'
      ? mode
      : [
          signInConnectionStatusLabel(status),
          identityConnectionNextStepLabel(connection) ?? mode,
        ].join(' · ');
  return (
    <Item
      testID={`team-authentication-connection-${connection.id}`}
      icon={<Icon name={identityProviderKindIconName(connection.provider.kind)} />}
      title={connection.provider.displayName}
      subtitle={subtitle}
      subtitleLeading={
        tone === 'quiet' ? undefined : (
          <StatusDot
            size={6}
            color={
              tone === 'trouble'
                ? theme.colors.state.danger.foreground
                : theme.colors.state.warning.foreground
            }
          />
        )
      }
      onPress={props.onPress}
    />
  );
});

/**
 * The Team's directory, by name (lab `tsAuth-A`): each connected source with where its sync stands,
 * or, with none, what a directory would do and the way to connect one. The sources are read through
 * the directory's own owner; when that read cannot answer, the row still leads to the Directory
 * page, which says why.
 */
const DirectorySection = React.memo(function DirectorySection(
  props: Readonly<{
    scope: Parameters<typeof useDirectoryAdministration>[0];
    address: Parameters<typeof teamDirectoryPath>[0];
  }>,
) {
  const router = useRouter();
  const { state } = useDirectoryAdministration(
    props.scope,
    props.address.teamId,
    true,
  );
  const openDirectory = () => router.push(teamDirectoryPath(props.address));
  return (
    <ItemGroup
      title={t('teams.authentication.directory.section')}
      description={t('teams.authentication.directory.overviewSubtitle')}
    >
      <SettingAnchor setting={TEAM_AUTHENTICATION_SETTINGS.settings.directory}>
        {state.kind === 'loading' ? (
          <ItemLoadStateRows
            testID="team-authentication-directory-loading"
            state={{ kind: 'loading' }}
            rows={1}
            accessibilityLabel={t('common.loading')}
          />
        ) : state.kind === 'unavailable' ? (
          <Item
            testID="team-authentication-directory"
            icon={<Icon name="tree-structure" />}
            title={t('teams.authentication.directory.title')}
            subtitle={t('teams.authentication.directory.manageSubtitle')}
            onPress={openDirectory}
          />
        ) : state.items.length === 0 ? (
          <Item
            testID="team-authentication-directory"
            icon={<Icon name="tree-structure" />}
            title={t('teams.authentication.directory.empty')}
            subtitle={t('teams.authentication.directory.emptyBody')}
            subtitleLines={0}
            detail={t('teams.authentication.directory.connect')}
            onPress={openDirectory}
          />
        ) : (
          <>
            {state.items.map((source) => (
              <Item
                key={source.id}
                testID={`team-authentication-directory-source:${source.id}`}
                icon={<Icon name="tree-structure" />}
                title={source.displayName}
                subtitle={[
                  source.kind === 'workos_directory'
                    ? t('teams.authentication.directory.kind.workos')
                    : t('teams.authentication.directory.kind.github'),
                  directorySourceStateLabel(
                    directorySourcePresentationState(source),
                  ),
                ].join(' · ')}
                onPress={() =>
                  router.push(teamDirectorySourcePath(props.address, source.id))
                }
              />
            ))}
            <Item
              testID="team-authentication-directory"
              title={t('teams.authentication.directory.title')}
              subtitle={t('teams.authentication.directory.manageSubtitle')}
              onPress={openDirectory}
            />
          </>
        )}
      </SettingAnchor>
    </ItemGroup>
  );
});

function eligibleProviderKey(
  provider: TeamIdentityEligibleProviderV1,
  index: number,
): string {
  return (
    provider.providerId ?? `${provider.providerKind}:${provider.owner}:${index}`
  );
}

/**
 * The ways this Team can add a sign-in connection, as the section's "+" menu (lab
 * `tsAuth-M`/`tsAuth-H`).
 *
 * Every kind keeps its row. One the Team cannot use right now says why in the Home's own words and
 * who can change it: a Home owner is led to the exact row or page that fixes it, anyone else is told
 * whom to ask.
 */
const AddConnectionMenu = React.memo(function AddConnectionMenu(
  props: Readonly<{
    context: TeamSectionContext;
    eligibleProviders: readonly TeamIdentityEligibleProviderV1[];
    pendingProviderId: string | null;
    actionable: boolean;
    onUseExisting: (provider: TeamIdentityEligibleProviderV1) => void;
    onCreateManaged: (provider: TeamIdentityEligibleProviderV1) => void;
  }>,
) {
  const router = useRouter();
  const [open, setOpen] = React.useState(false);
  const serverId = props.context.address.serverId;
  const viewerHomeRole = useHomeViewerRole(serverId);
  // Whom to ask comes from the Home's one disclosure of its owners' and administrators' names,
  // the same answer Team creation names them from.
  const eligibilityScopes = React.useMemo(
    () => [props.context.scope],
    [props.context.scope],
  );
  const eligibility = useHomeGovernanceEligibilitySnapshots(eligibilityScopes);
  const administratorNames =
    eligibility.snapshotsByServerId.get(serverId)?.data?.administratorNames ??
    null;
  const choices = props.eligibleProviders.map((provider, index) => {
    const choice =
      provider.availability.status === 'available'
        ? provider.availability.setupChoice
        : null;
    const title =
      provider.displayName ?? identityProviderKindLabel(provider.providerKind);
    const reason = eligibleProviderUnavailableReason(
      provider,
      props.context.homeName,
      title,
    );
    const recovery = resolveEligibleProviderRecovery(provider, {
      viewerHomeRole,
      administratorNames,
    });
    const blocked =
      provider.availability.status === 'unavailable' ||
      choice?.kind === 'contact_home_admin';
    const fix = recovery.kind === 'fix_on_home' ? recovery : null;
    const subtitle = !blocked
      ? provider.owner === 'home'
        ? t('identityAdministration.providerOwnerHome')
        : t('identityAdministration.providerOwnerTeam')
      : [
          reason,
          fix
            ? eligibleProviderFixLabel(fix.destination)
            : recovery.kind === 'ask'
              ? askAdministratorsText(recovery.names)
              : null,
        ]
          .filter(Boolean)
          .join(' ');
    const id = eligibleProviderKey(provider, index);
    return {
      id,
      provider,
      choice,
      fixHref: fix
        ? eligibleProviderFixHref(serverId, provider, fix.destination)
        : null,
      item: {
        id,
        testID: `team-eligible-provider:${provider.providerId ?? provider.providerKind}`,
        title,
        subtitle,
        icon: <Icon name={identityProviderKindIconName(provider.providerKind)} />,
        // A reason a Home owner can fix stays pressable: it leads to the fix.
        disabled: fix
          ? false
          : !props.actionable || props.pendingProviderId !== null || blocked,
      },
    };
  });
  return (
    <DropdownMenu
      testID="team-authentication-add-menu"
      open={open}
      onOpenChange={setOpen}
      items={choices.map((choice) => choice.item)}
      onSelect={(id) => {
        setOpen(false);
        const chosen = choices.find((choice) => choice.id === id);
        if (!chosen) return;
        if (chosen.fixHref) router.push(chosen.fixHref);
        else if (chosen.choice?.kind === 'use_existing')
          props.onUseExisting(chosen.provider);
        else if (chosen.choice?.kind === 'create_managed')
          props.onCreateManaged(chosen.provider);
      }}
      placement="bottom"
      popoverAnchorAlign="end"
      matchTriggerWidth={false}
      maxWidthCap={360}
      showCategoryTitles={false}
      popoverPortalWebTarget="body"
      trigger={({ toggle }) => (
        <SectionActionButton
          testID="team-authentication-add-connection"
          title={t('teams.authentication.add.action')}
          icon="plus"
          expanded={open}
          loading={props.pendingProviderId !== null}
          onPress={toggle}
        />
      )}
    />
  );
});

/**
 * What a member who cannot change sign-in still sees (lab `tsAuth-D`): who can change it, by name,
 * and the facts the Team projection already carries for every member — who can join and what
 * sign-in the Team accepts. Mounted only for that viewer, so the roster read behind the names runs
 * only then.
 */
const AuthenticationFacts = React.memo(function AuthenticationFacts(
  props: Readonly<{ context: TeamSectionContext }>,
) {
  const { context } = props;
  const names = useTeamManagerNames(context, true);
  return (
    <>
      <AttentionBanner
        testID="team-authentication-forbidden"
        tone="neutral"
        icon={<Icon name="lock" />}
        title={t('teams.denied.authentication', { team: context.team.name })}
        description={askTeamManagersText(names)}
      />
      <ItemGroup title={t('teams.authentication.policy.admissionSection')}>
        <Item
          testID="team-authentication-fact-admission"
          title={teamAdmissionModeLabel(context.team.policy.admissionMode)}
          mode="info"
          showChevron={false}
        />
      </ItemGroup>
      <ItemGroup title={t('teams.authentication.policy.acceptedSection')}>
        <Item
          testID="team-authentication-fact-accepted"
          title={teamAcceptedSignInSummary(context.team.policy, context.homeName)}
          mode="info"
          showChevron={false}
        />
      </ItemGroup>
    </>
  );
});

/** The page's sections, titled at once and holding their rows while the Team is read (lab `tsAuth-L`). */
function AuthenticationLoading() {
  const section = (title: string, rows: number) => (
    <ItemGroup title={title}>
      <ItemLoadStateRows
        state={{ kind: 'loading' }}
        rows={rows}
        accessibilityLabel={t('teams.loading')}
      />
    </ItemGroup>
  );
  return (
    <>
      {section(t('teams.authentication.policy.admissionSection'), 1)}
      {section(t('teams.authentication.policy.acceptedSection'), 1)}
      {section(t('teams.authentication.connectionsSection'), 2)}
      {section(t('teams.authentication.directory.section'), 1)}
    </>
  );
}

export const TeamAuthenticationSettingsScreen = React.memo(
  function TeamAuthenticationSettingsScreen(
    props: Readonly<{
      serverId: string;
      teamId: string;
    }>,
  ) {
    return (
      <TeamSection
        serverId={props.serverId}
        teamId={props.teamId}
        title={t('teams.tabs.authentication')}
        description={t('teams.pages.authentication')}
        renderLoading={AuthenticationLoading}
      >
        {(context) =>
          context.team.capabilities.manageAuthentication ? (
            <AuthorizedAuthenticationContent
              context={context}
              scope={context.scope}
              address={context.address}
            />
          ) : (
            <SettingSection
              section={TEAM_AUTHENTICATION_SETTINGS.sectionRefs.accepted}
              answersFor={Object.values(
                TEAM_AUTHENTICATION_SETTINGS.sectionRefs,
              )}
            >
              <AuthenticationFacts context={context} />
            </SettingSection>
          )
        }
      </TeamSection>
    );
  },
);
