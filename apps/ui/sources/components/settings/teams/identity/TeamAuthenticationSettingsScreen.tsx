import * as React from 'react';
import { useRouter } from '@/components/appShell/workspace/destinationRoute';
import type { AuthEntryProjectionV1 } from '@happier-dev/protocol/auth/entry';
import type {
  IdentityConnectionV1,
  TeamDirectorySourceSummaryV1,
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
import { t, usePreferredLanguage } from '@/text';

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
  teamAdmissionModeConsequence,
  teamAdmissionModeLabel,
  teamAdmissionModeSegmentLabel,
} from '../teamPolicyPresentation';
import {
  directorySourcePresentationState,
  directorySourceStateLabel,
} from './directoryAdministrationPresentation';
import { useDirectoryAdministration } from './useDirectoryAdministration';
import { ADMISSION_MODES, TeamAuthenticationPolicySections } from './TeamAuthenticationPolicySections';
import { TeamMemberSignInLinkSection } from './TeamMemberSignInLinkSection';
import { TeamGitHubAppsSection } from './TeamGitHubAppScreens';
import {
  identityConnectionMode,
  identityConnectionNextStepLabel,
  identityProviderKindMark,
  identityProviderKindLabel,
  teamIdentityConnectionStatus,
} from './identityAdministrationPresentation';
import { useIdentityAdministration } from './useIdentityAdministration';
import {
  eligibleProviderFixHref,
  eligibleProviderFixLabel,
  eligibleProviderUnavailableReason,
  resolveEligibleProviderRecovery,
  useEligibleProviderRecoveryViewer,
} from './eligibleProviderAvailability';
import {
  askAdministratorsText,
  askTeamManagersText,
} from '../collection/teamsCreateGuidanceText';
import { createIdentityAdministrationClient } from './identityAdministrationClient';
import { Icon } from '@/components/ui/icons/Icon';
import { SegmentedChoiceItem } from '@/components/ui/lists/SegmentedChoiceItem';
import { ReservedShape } from '@/components/ui/lists/ReservedShape';
import { useEventCallback } from '@/hooks/ui/useEventCallback';

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
    // The page is mounted once from the reserve (a held context, which asks no approval) through the live Team:
    // its reads start with the reserve and the Team's answer does not start them again.
    const requestApproval = useEventCallback(props.context.requestApproval);
    const { state, refresh } = useIdentityAdministration(
      props.scope,
      props.address.teamId,
      requestApproval,
    );
    const client = React.useMemo(
      () =>
        createIdentityAdministrationClient(props.scope, {
          onApprovalPending: requestApproval,
        }),
      [
        requestApproval,
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
        }, { reconnect: 'refresh' }),
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

    const openConnection = useEventCallback((connectionId: string) => {
      router.push(teamIdentityConnectionPath(props.address, connectionId));
    });
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
          {null}
          {homeMethodsNotice}
          <TeamAuthenticationPolicySections
            context={props.context}
            connections={NO_CONNECTIONS}
            connectionsCurrent={false}
            admissionModeApplicability={null}
            homeMethods={homeMethods}
            homeMethodsCurrent={currentHomeEntry?.status === 'ready'}
          />
          <SettingAnchor setting={TEAM_AUTHENTICATION_SETTINGS.settings.connections}><ItemGroup
            title={t('teams.authentication.connectionsSection')}
            description={t('teams.authentication.connectionsDescription')}
            action={state.kind === 'loading' ? <HeldSectionAction kind="connection" /> : undefined}
          >
            {state.kind === 'loading' ? (
              <TeamConnectionsReserve team={props.context.team} />
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
          </ItemGroup></SettingAnchor>
          {/* The directory is read on its own: it never waits on, or fails with, the connections. */}
          <DirectorySection scope={props.scope} address={props.address}
            knownEmpty={props.context.team.directoryMembership === null} />
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
              <ConnectionsEmptyLine />
            ) : (
              state.items.map((connection) => (
                <ConnectionRow
                  key={connection.id}
                  connection={connection}
                  onOpen={openConnection}
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
        <DirectorySection scope={props.scope} address={props.address}
          knownEmpty={props.context.team.directoryMembership === null} />
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
    onOpen: (connectionId: string) => void;
  }>,
) {
  usePreferredLanguage();
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
      icon={identityProviderKindMark(connection.provider.kind)}
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
      onPress={() => props.onOpen(connection.id)}
    />
  );
});

const DirectorySourceRow = React.memo(function DirectorySourceRow(
  props: Readonly<{
    source: TeamDirectorySourceSummaryV1;
    onOpen: (sourceId: string) => void;
  }>,
) {
  usePreferredLanguage();
  const { source } = props;
  return (
    <Item
      testID={`team-authentication-directory-source:${source.id}`}
      icon={identityProviderKindMark(
        source.kind === 'workos_directory' ? 'workos_sso' : 'github_app_identity',
      )}
      title={source.displayName}
      subtitle={[
        source.kind === 'workos_directory'
          ? t('teams.authentication.directory.kind.workos')
          : t('teams.authentication.directory.kind.github'),
        directorySourceStateLabel(directorySourcePresentationState(source)),
      ].join(' · ')}
      onPress={() => props.onOpen(source.id)}
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
    /** The Team summary says the Team has no directory: its line stands while the sources are read. */
    knownEmpty: boolean;
  }>,
) {
  const router = useRouter();
  const { state } = useDirectoryAdministration(
    props.scope,
    props.address.teamId,
    true,
  );
  const openDirectory = () => router.push(teamDirectoryPath(props.address));
  const openSource = useEventCallback((sourceId: string) => {
    router.push(teamDirectorySourcePath(props.address, sourceId));
  });
  return (
    <ItemGroup
      title={t('teams.authentication.directory.section')}
      description={t('teams.authentication.directory.overviewSubtitle')}
      // The way to a (first or another) source is the section's "+", like "Add connection" above;
      // each source row opens its own page, so no separate "manage" row repeats them.
      action={state.kind === 'ready' ? (
        <SectionActionButton
          testID="team-authentication-directory-add"
          icon="plus"
          title={t('teams.authentication.directory.setup.add')}
          onPress={openDirectory}
        />
      ) : state.kind === 'loading' ? <HeldSectionAction kind="directory" /> : undefined}
    >
      <SettingAnchor setting={TEAM_AUTHENTICATION_SETTINGS.settings.directory}>
        {state.kind === 'loading' && props.knownEmpty ? (
          <DirectoryEmptyLine />
        ) : state.kind === 'loading' ? (
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
          // The section description already says what a directory does; the quiet line names the
          // state and what adding one lets the Team do, as it does for sign-in connections above,
          // and "+ Add source" is the way in.
          <DirectoryEmptyLine />
        ) : (
          <>
            {state.items.map((source) => (
              <DirectorySourceRow key={source.id} source={source} onOpen={openSource} />
            ))}
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
  const { viewerHomeRole, administratorNames } =
    useEligibleProviderRecoveryViewer(props.context.scope);
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
        icon: identityProviderKindMark(provider.providerKind),
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
        title={t('teams.denied.authentication')}
        description={askTeamManagersText(names)}
      />
      <ItemGroup
        title={t('teams.authentication.policy.admissionSection')}
        description={t('teams.authentication.policy.admissionHelp')}
      >
        <Item
          testID="team-authentication-fact-admission"
          title={teamAdmissionModeLabel(context.team.policy.admissionMode)}
          subtitle={teamAdmissionModeConsequence(context.team.policy.admissionMode)}
          mode="info"
          showChevron={false}
          subtitleLines={0}
        />
      </ItemGroup>
      <ItemGroup
        title={t('teams.authentication.policy.acceptedSection')}
        description={t('teams.authentication.policy.acceptedHelp')}
      >
        <Item
          testID="team-authentication-fact-accepted"
          title={teamAcceptedSignInSummary(context.team.policy)}
          subtitle={context.team.policy.authenticationPolicyStatus !== 'repair_required'
            && context.team.policy.authenticationPolicy?.mode !== 'restricted'
            ? t('teams.authentication.policy.acceptedInheritConsequence', { home: context.homeName })
            : undefined}
          mode="info"
          showChevron={false}
          subtitleLines={0}
        />
      </ItemGroup>
      <SettingAnchor setting={TEAM_AUTHENTICATION_SETTINGS.settings.directory}>
        <ItemGroup
          title={t('teams.authentication.directory.section')}
          description={t('teams.authentication.directory.overviewSubtitle')}
        >
          <Item
            testID="team-authentication-fact-directory"
            title={context.team.directoryMembership?.providerDisplayName ?? (
              context.team.directoryMembership === null
                ? t('teams.authentication.directory.empty')
                : t('teams.authentication.directory.unknown')
            )}
            subtitle={context.team.directoryMembership
              ? directorySourceStateLabel(context.team.directoryMembership.state === 'healthy'
                ? 'active' : context.team.directoryMembership.state)
              : undefined}
            mode="info"
            showChevron={false}
            titleLines={0}
            subtitleLines={0}
          />
        </ItemGroup>
      </SettingAnchor>
    </>
  );
});

/**
 * The connections the Team summary proves exist: an "Only these" policy names each accepted Team connection, and
 * each holds a connection row's place. Otherwise the count is unknown and one quiet line waits over the empty
 * line's own box (that line drawn unseen), so an empty list replaces it without a move.
 */
function TeamConnectionsReserve(props: Readonly<{ team: TeamSectionContext['team'] }>) {
  const policy = props.team.policy.authenticationPolicy;
  const known = policy?.mode === 'restricted'
    ? policy.accepted.filter((reference) => reference.kind === 'team_connection').length
    : 0;
  return known > 0 ? (
    <ItemLoadStateRows
      testID="team-authentication-loading"
      state={{ kind: 'loading' }}
      rows={known}
      lines={2}
      accessibilityLabel={t('common.loading')}
    />
  ) : (
    <ReservedShape shape={<ConnectionsEmptyLine />}>
      <QuietLoadingLine testID="team-authentication-loading" />
    </ReservedShape>
  );
}

/** A Team without sign-in connections: one quiet line naming the state and what adding one does. */
function ConnectionsEmptyLine() {
  return (
    <SurfaceStateCard
      testID="team-authentication-empty"
      kind="empty"
      size="line"
      title={t('teams.authentication.empty')}
      reason={t('teams.authentication.policy.admissionNeeds.connection')}
    />
  );
}

const NO_OP = () => {};

/**
 * A manager's section "+" while what it adds to is read: it stands where it lands, disabled, so the section's
 * description does not rewrap when it arrives.
 */
function HeldSectionAction(props: Readonly<{ kind: 'connection' | 'directory' }>) {
  return (
    <SectionActionButton
      testID={props.kind === 'connection' ? 'team-authentication-add-connection' : 'team-authentication-directory-add'}
      icon="plus"
      title={props.kind === 'connection' ? t('teams.authentication.add.action') : t('teams.authentication.directory.setup.add')}
      disabled
      onPress={NO_OP}
    />
  );
}

type AuthenticationLoadingKnown = Parameters<
  NonNullable<React.ComponentProps<typeof TeamSection>['renderLoading']>
>[0];

/**
 * The page's sections while the Team is read (lab `tsAuth-L`), each with its title and description from the first
 * frame. When the Teams directory already holds this Team's row, the sections that row decides are drawn from it as
 * they will stand (read-only until the Team answers): who can join and how members sign in, or a member's facts.
 * What the row does not say is reserved: one row per section, or the connections the policy names.
 */
function AuthenticationLoading(known: AuthenticationLoadingKnown) {
  const team = known.row;
  const held: TeamSectionContext | null =
    team && known.scope && known.address && known.homeName !== undefined
      ? {
          scope: known.scope,
          address: known.address,
          homeName: known.homeName,
          team,
          mutationsAvailable: false,
          archived: team.archivedAt !== null,
          canMutate: false,
          approvalPending: false,
          refresh: NO_OP,
          requestApproval: NO_OP,
          settleLeave: NO_OP,
        }
      : null;
  // The same element the live page renders, so the page stays mounted when the Team answers.
  if (held) return <TeamAuthenticationBody context={held} />;
  return (
    <>
      <ItemGroup
        title={t('teams.authentication.policy.admissionSection')}
        description={t('teams.authentication.policy.admissionHelp')}
      >
        <HeldPolicyRow testID="team-admission-mode" title={t('teams.authentication.policy.admissionRow')}
          options={ADMISSION_MODES.map((mode) => ({ id: mode, label: teamAdmissionModeSegmentLabel(mode) }))} />
      </ItemGroup>
      <ItemGroup
        title={t('teams.authentication.policy.acceptedSection')}
        description={t('teams.authentication.policy.acceptedHelp')}
      >
        <HeldPolicyRow testID="team-authentication-policy-mode" title={t('teams.authentication.policy.acceptedRow')}
          options={[
            { id: 'inherit', label: t('teams.authentication.policy.acceptedInherit') },
            { id: 'restricted', label: t('teams.authentication.policy.acceptedRestricted') },
          ]} />
      </ItemGroup>
      <ItemGroup
        title={t('teams.authentication.connectionsSection')}
        description={t('teams.authentication.connectionsDescription')}
        action={<HeldSectionAction kind="connection" />}
      >
        <ReservedShape shape={<ConnectionsEmptyLine />}>
          <QuietLoadingLine testID="team-authentication-loading" />
        </ReservedShape>
      </ItemGroup>
      <ItemGroup
        title={t('teams.authentication.directory.section')}
        description={t('teams.authentication.directory.overviewSubtitle')}
        action={<HeldSectionAction kind="directory" />}
      >
        <ReservedShape shape={<DirectoryEmptyLine />}>
          <QuietLoadingLine testID="team-authentication-directory-loading" />
        </ReservedShape>
      </ItemGroup>
    </>
  );
}

type HeldPolicyOption = Readonly<{ id: string; label: string }>;

/**
 * A policy row every Team has, before anything of the Team is known: its title, its segments with none chosen
 * (read-only), and one quiet line where the chosen option's consequence lands, so the row is the row that arrives.
 */
function HeldPolicyRow(props: Readonly<{ testID: string; title: string; options: readonly HeldPolicyOption[] }>) {
  return (
    <SegmentedChoiceItem<string>
      testID={props.testID}
      title={props.title}
      subtitle={t('common.loading')}
      subtitleLines={0}
      accessoryLayout="stacked"
      options={props.options}
      value={null}
      onChange={NO_OP}
      disabled
      testIDPrefix={props.testID}
    />
  );
}

/** One quiet line in the empty line's own shape (the same line component), so what lands replaces it in place. */
function QuietLoadingLine(props: Readonly<{ testID: string }>) {
  return (
    <SurfaceStateCard
      testID={props.testID}
      kind="loading"
      size="line"
      title={t('common.loading')}
      accessibilitySemantics="status"
    />
  );
}

/** A Team without a directory: one quiet line naming the state and what adding one does, beside "+ Add source". */
function DirectoryEmptyLine() {
  return (
    <SurfaceStateCard
      testID="team-authentication-directory"
      kind="empty"
      size="line"
      title={t('teams.authentication.directory.empty')}
      reason={t('teams.authentication.policy.admissionNeeds.directory')}
    />
  );
}

/**
 * The page under its header, for the held Team (the reserve) and the live one alike: one element type in one place,
 * so its rows, controls and reads stay mounted across the handover.
 */
const TeamAuthenticationBody = React.memo(function TeamAuthenticationBody(props: Readonly<{ context: TeamSectionContext }>) {
  const { context } = props;
  return context.team.capabilities.manageAuthentication ? (
    <AuthorizedAuthenticationContent context={context} scope={context.scope} address={context.address} />
  ) : (
    <SettingSection
      section={TEAM_AUTHENTICATION_SETTINGS.sectionRefs.accepted}
      answersFor={Object.values(TEAM_AUTHENTICATION_SETTINGS.sectionRefs)}
    >
      <AuthenticationFacts context={context} />
    </SettingSection>
  );
});

const NO_CONNECTIONS: readonly never[] = [];

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
        {(context) => <TeamAuthenticationBody context={context} />}
      </TeamSection>
    );
  },
);
