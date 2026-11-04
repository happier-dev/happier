import * as React from 'react';
import { useUnistyles } from 'react-native-unistyles';
import { PUBLIC_PROFILE_FIELDS_V1 } from '@happier-dev/protocol/account/publicProfile';
import { isActionApprovalDeclinedErrorCode } from '@happier-dev/protocol/actions/actionExecutionResult';

import { useRouter } from '@/components/appShell/workspace/destinationRoute';
import { useMountedActionExecution } from '@/components/approvals/useMountedActionExecution';
import { SettingsPageHeader } from '@/components/settings/shell/SettingsPageHeader';
import { SETTINGS_ROUTES } from '@/components/settings/catalog/routes';
import { RoundButton } from '@/components/ui/buttons/RoundButton';
import { Icon } from '@/components/ui/icons/Icon';
import { EmptyState } from '@/components/ui/empty/EmptyState';
import { Switch } from '@/components/ui/forms/Switch';
import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { ItemList } from '@/components/ui/lists/ItemList';
import { SurfaceStateCard } from '@/components/ui/surfaces/SurfaceStateCard';
import { useFeatureDecision } from '@/hooks/server/useFeatureDecision';
import { useFriendsEnabled } from '@/hooks/server/useFriendsEnabled';
import { useActiveServerSnapshot } from '@/hooks/server/useActiveServerSnapshot';
import { resolveHomeDisplayName } from '@/components/settings/server/homeDisplayName';
import { getServerProfileById } from '@/sync/domains/server/serverProfiles';
import { formatUsageCalendarPeriod } from '@/sync/domains/usage/usageCalendarPresentation';
import { useAccountSettingsScope } from '@/sync/store/settingsWriters';
import { useProfile } from '@/sync/domains/state/storage';
import { t } from '@/text';
import { formatRelativeTime } from '@/utils/time/formatShortRelativeTime';
import { openExternalUrl } from '@/utils/url/openExternalUrl';
import {
  publicProfileMutationNotice,
  type PublicProfileOperation,
} from './publicProfileMutation';
import { usePublicProfileOwnerRead } from './usePublicProfileOwnerRead';

/**
 * Settings → Account → Public profile: the published page's link, status and handle, what is
 * public, indexing, and the reversible-then-destructive lifecycle controls (lab S0/S1/S2).
 * Field choices live on the page itself; this page only summarises them.
 */
export const PublicProfileSettingsScreen = React.memo(
  function PublicProfileSettingsScreen() {
    const router = useRouter();
    const { theme } = useUnistyles();
    const scope = useAccountSettingsScope();
    const execution = useMountedActionExecution(scope);
    const feature = useFeatureDecision('account.publicProfiles', {
      scopeKind: 'runtime',
    });
    const friendsEnabled = useFriendsEnabled();
    const profile = useProfile();
    const activeServer = useActiveServerSnapshot();
    const homeName = resolveHomeDisplayName(getServerProfileById(activeServer.serverId));
    const { state, reload } = usePublicProfileOwnerRead(execution);
    const [pending, setPending] = React.useState<PublicProfileOperation | null>(
      null,
    );
    const [notice, setNotice] = React.useState<string | null>(null);

    const run = React.useCallback(
      async (operation: PublicProfileOperation, input: unknown = {}) => {
        if (pending) return;
        setPending(operation);
        setNotice(null);
        try {
          const outcome = await execution.execute(
            `account.public_profile.${operation}`,
            input,
          );
          if (!outcome.ok) {
            if (!isActionApprovalDeclinedErrorCode(outcome.errorCode))
              setNotice(publicProfileMutationNotice(outcome));
            return;
          }
          const message = publicProfileMutationNotice(outcome.result);
          if (message) setNotice(message);
          await reload();
        } catch {
          // The answer was lost, not refused: reread the record rather than guess what changed.
          setNotice(t('publicIdentity.profile.actionUncertain'));
          await reload();
        } finally {
          setPending(null);
        }
      },
      [execution, pending, reload],
    );

    const read = state.kind === 'ready' ? state.read : null;
    const record = read?.kind === 'ready' ? read.record : null;
    const live = record !== null && record.state !== 'draft';
    const pageUrl = read?.context.urls?.page ?? null;
    const handle = read?.context.handle ?? profile.username ?? null;

    const header = (
      <SettingsPageHeader
        testID="settings-public-profile-header"
        title={t('publicIdentity.profile.title')}
        description={
          live && pageUrl
            ? t('publicIdentity.profile.purposePublished', {
                url: displayUrl(pageUrl),
              })
            : t('publicIdentity.profile.purposeIntro')
        }
        actions={
          live && pageUrl && record?.state === 'published' ? (
            <RoundButton
              testID="settings-public-profile-open"
              display="secondary"
              title={t('publicIdentity.profile.openPage')}
              onPress={() => {
                void openExternalUrl(pageUrl);
              }}
            />
          ) : undefined
        }
      />
    );

    if (state.kind === 'loading' || (feature === null && !record)) {
      return (
        <ItemList style={{ paddingTop: 0 }}>
          {header}
          <SurfaceStateCard
            testID="settings-public-profile-loading"
            kind="loading"
            title={t('publicIdentity.profile.title')}
            replacesContent
          />
        </ItemList>
      );
    }
    // A service without public profiles (or one too old to answer) says so; a switched-off service
  // still lets an owner withdraw a page that is already public.
    if (!live && feature?.state !== 'enabled') {
      return (
        <ItemList style={{ paddingTop: 0 }}>
          {header}
          <SurfaceStateCard
            testID="settings-public-profile-unavailable"
            kind="unavailable"
            title={t('publicIdentity.profile.unavailableTitle')}
            reason={homeName ? t('publicIdentity.profile.unavailableBody', { home: homeName }) : t('publicIdentity.profile.unavailableBodyThisHome')}
            replacesContent
          />
        </ItemList>
      );
    }
    if (state.kind === 'failed') {
      return (
        <ItemList style={{ paddingTop: 0 }}>
          {header}
          <SurfaceStateCard
            testID="settings-public-profile-load-failed"
            kind="error"
            title={t('publicIdentity.profile.loadFailedTitle')}
            reason={t('publicIdentity.profile.loadFailedBody')}
            action={{
              label: t('publicIdentity.profile.retry'),
              onPress: reload,
            }}
            replacesContent
          />
        </ItemList>
      );
    }
    if (!live || !record) {
      return (
        <ItemList style={{ paddingTop: 0 }}>
          {header}
          <EmptyState
            testID="settings-public-profile-invitation"
            layout="page"
            scene="shipped"
            title={t('publicIdentity.profile.invitationTitle')}
            subtitle={
              handle
                ? t('publicIdentity.profile.invitationBody')
                : t('publicIdentity.profile.usernameFirst')
            }
            primaryAction={handle ? {
              testID: 'settings-public-profile-preview',
              label: t('publicIdentity.profile.previewMyProfile'),
              onPress: () => router.push(SETTINGS_ROUTES.accountPublicProfileEdit),
            } : {
              testID: 'settings-public-profile-choose-username',
              label: t('publicIdentity.profile.chooseUsername'),
              onPress: () => router.push(SETTINGS_ROUTES.account),
            }}
          />
        </ItemList>
      );
    }

    const snapshot = record.snapshot;
    const shown = record.policy
      ? PUBLIC_PROFILE_FIELDS_V1.filter((field) => record.policy!.fields[field])
          .length
      : 0;
    const restriction = record.restriction;
    return (
      <ItemList style={{ paddingTop: 0 }}>
        {header}
        {restriction ? (
          <SurfaceStateCard
            testID="settings-public-profile-restricted"
            kind="warning"
            layout="inline"
            size="line"
            title={t('publicIdentity.profile.restrictedTitle')}
            reason={t('publicIdentity.profile.restrictedBody', {
              reason: restriction.reason,
            })}
          />
        ) : null}
        {notice ? (
          <SurfaceStateCard
            testID="settings-public-profile-notice"
            kind="warning"
            layout="inline"
            size="line"
            title={notice}
          />
        ) : null}

        <ItemGroup title={t('publicIdentity.profile.yourPage')}>
          {pageUrl ? (
            <Item
              testID="settings-public-profile-link"
              title={t('publicIdentity.profile.link')}
              subtitle={displayUrl(pageUrl)}
              copy={pageUrl}
              showChevron={false}
            />
          ) : null}
          <Item
            testID="settings-public-profile-status"
            title={t('publicIdentity.profile.status')}
            subtitle={
              record.state === 'paused'
                ? t('publicIdentity.profile.statusPaused')
                : t('publicIdentity.profile.statusPublished', {
                    synced: snapshot
                      ? formatRelativeTime(snapshot.computedAtMs)
                      : '—',
                  })
            }
            showChevron={false}
            rightElement={
              record.state === 'published' && !restriction ? (
                <RoundButton
                  testID="settings-public-profile-sync"
                  size="small"
                  display="secondary"
                  title={t('publicIdentity.profile.syncNow')}
                  loading={pending === 'refresh'}
                  disabled={pending !== null}
                  onPress={() => run('refresh')}
                />
              ) : undefined
            }
          />
          {handle ? (
            <Item
              testID="settings-public-profile-handle"
              title={t('publicIdentity.profile.handle')}
              subtitle={
                friendsEnabled
                  ? t('publicIdentity.profile.handleDetailWithFriends', {
                      username: handle,
                    })
                  : t('publicIdentity.profile.handleDetail', {
                      username: handle,
                    })
              }
              showChevron={false}
              rightElement={
                <RoundButton
                  testID="settings-public-profile-change-handle"
                  size="small"
                  display="secondary"
                  title={t('publicIdentity.profile.change')}
                  onPress={() => router.push(SETTINGS_ROUTES.account)}
                />
              }
            />
          ) : null}
        </ItemGroup>

        <ItemGroup
          title={t('publicIdentity.profile.whatsPublic')}
          description={t('publicIdentity.profile.whatsPublicDescription')}
        >
          {snapshot ? (
            <Item
              testID="settings-public-profile-period"
              title={t('publicIdentity.profile.period')}
              subtitle={t('publicIdentity.profile.periodDetail', {
                range: formatUsageCalendarPeriod(snapshot.period),
              })}
              subtitleLines={2}
              showChevron={false}
              mode="info"
            />
          ) : null}
          {record.policy ? (
            <Item
              testID="settings-public-profile-edit"
              icon={<Icon name="eye" size={20} color={theme.colors.text.secondary} />}
              title={t('publicIdentity.profile.editOnPage')}
              subtitle={t('publicIdentity.profile.itemsPublic', {
                shown,
                total: PUBLIC_PROFILE_FIELDS_V1.length,
              })}
              onPress={() => router.push(SETTINGS_ROUTES.accountPublicProfileEdit)}
            />
          ) : null}
          <Item
            testID="settings-public-profile-team-usage"
            title={t('publicIdentity.profile.teamUsage')}
            subtitle={t('publicIdentity.profile.teamUsageDetail')}
            subtitleLines={0}
            detail={t('publicIdentity.profile.excluded')}
            showChevron={false}
            mode="info"
          />
        </ItemGroup>

        {record.policy ? (
          <ItemGroup title={t('publicIdentity.profile.searchEngines')}>
            <IndexingRow
              indexable={record.policy.indexable}
              disabled={pending !== null || Boolean(restriction)}
              onChange={(indexable) =>
                run('update', { policy: { ...record.policy!, indexable } })
              }
            />
          </ItemGroup>
        ) : null}

        <ItemGroup title={t('publicIdentity.profile.pauseOrRemove')}>
          {record.state === 'paused' ? (
            <Item
              testID="settings-public-profile-resume-row"
              title={t('publicIdentity.profile.resumeTitle')}
              subtitle={t('publicIdentity.profile.resumeDetail')}
              subtitleLines={0}
              showChevron={false}
              rightElement={
                <RoundButton
                  testID="settings-public-profile-resume"
                  size="small"
                  display="secondary"
                  title={t('publicIdentity.profile.resume')}
                  loading={pending === 'resume'}
                  disabled={pending !== null || Boolean(restriction)}
                  onPress={() => run('resume')}
                />
              }
            />
          ) : (
            <Item
              testID="settings-public-profile-pause-row"
              title={t('publicIdentity.profile.pauseTitle')}
              subtitle={t('publicIdentity.profile.pauseDetail')}
              subtitleLines={0}
              showChevron={false}
              rightElement={
                <RoundButton
                  testID="settings-public-profile-pause"
                  size="small"
                  display="secondary"
                  title={t('publicIdentity.profile.pause')}
                  loading={pending === 'pause'}
                  disabled={pending !== null}
                  onPress={() => run('pause')}
                />
              }
            />
          )}
          <Item
            testID="settings-public-profile-unpublish-row"
            title={t('publicIdentity.profile.unpublishTitle')}
            subtitle={t('publicIdentity.profile.unpublishDetail')}
            subtitleLines={0}
            showChevron={false}
            rightElement={
              <RoundButton
                testID="settings-public-profile-unpublish"
                size="small"
                display="destructive"
                title={t('publicIdentity.profile.unpublishAction')}
                loading={pending === 'unpublish'}
                disabled={pending !== null}
                onPress={() => run('unpublish')}
              />
            }
          />
        </ItemGroup>
      </ItemList>
    );
  },
);

function IndexingRow(
  props: Readonly<{
    indexable: boolean;
    disabled: boolean;
    onChange: (value: boolean) => void;
  }>,
) {
  const { theme } = useUnistyles();
  return (
    <Item
      testID="settings-public-profile-indexing"
      title={t('publicIdentity.profile.indexTitle')}
      subtitle={
        props.indexable
          ? t('publicIdentity.profile.indexOn')
          : t('publicIdentity.profile.indexOff')
      }
      showChevron={false}
      rightElement={
          <Switch
            testID="settings-public-profile-indexing-switch"
            value={props.indexable}
            disabled={props.disabled}
            onValueChange={props.onChange}
            trackColor={{
              false: theme.colors.switch.track.inactive,
              true: theme.colors.switch.track.active,
            }}
            thumbColor={
              props.indexable
                ? theme.colors.switch.thumb.active
                : theme.colors.switch.thumb.inactive
            }
          />
      }
    />
  );
}

/** "happier.dev/@leeroy": the scheme adds nothing a person reads or types. */
function displayUrl(url: string): string {
  return url.replace(/^https?:\/\//, '').replace(/\/$/, '');
}
