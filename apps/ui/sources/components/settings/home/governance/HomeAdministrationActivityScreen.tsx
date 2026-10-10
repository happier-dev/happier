import * as React from 'react';
import type { HomeAdministrationEventV1 } from '@happier-dev/protocol/home/governance';
import { useUnistyles } from 'react-native-unistyles';

import { Avatar } from '@/components/ui/avatar/Avatar';
import { EmptyState } from '@/components/ui/empty/EmptyState';
import { Icon, ICON_SIZE } from '@/components/ui/icons/Icon';
import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { formatRelativeTimeShort } from '@/utils/time/formatShortRelativeTime';
import { useHomePagedList, type HomePageReader } from '@/hooks/home/useHomePagedList';
import { listHomeAudit } from '@/sync/ops/home/homeGovernanceOperations';
import { t } from '@/text';

import { HomeAdministrationSection } from './HomeAdministrationSection';
import type { HomeAdministrationContext } from './homeAdministrationContext';
import { presentHomeAuditEvent, type HomeAuditNames } from './homeAuditPresentation';

const ACTOR_MARK_SIZE = 28;

const readAuditPage: HomePageReader<HomeAdministrationEventV1> = (scope, cursor) => listHomeAudit({
    scope,
    ...(cursor ? { cursor } : {}),
});

/** One administration event: who, what, the changed values, and when. Shared with the person page. */
export const HomeActivityRow = React.memo(function HomeActivityRow(props: Readonly<{
    event: HomeAdministrationEventV1;
    now: number;
    /** The Account reading the list, named "Your account" when it has no name. */
    viewerAccountId: string;
    /** Names only the Home knows (its sign-in methods), from the page's projection. */
    names?: HomeAuditNames;
}>) {
    const { theme } = useUnistyles();
    const row = presentHomeAuditEvent(props.event, props.viewerAccountId, props.names);
    const lines = [row.area, ...row.changes.map((change) => `${change.label}  ${change.from} → ${change.to}`)];
    return (
        <Item
            testID={`home-activity-row:${props.event.id}`}
            leftElement={row.actorAccount
                ? <Avatar id={row.actorAccount.id} size={ACTOR_MARK_SIZE} imageUrl={row.actorAccount.avatarUrl} />
                : <Icon name="terminal" size={ICON_SIZE.md} color={theme.colors.text.secondary} />}
            title={`${row.actor} ${row.verb}`}
            titleLines={0}
            subtitle={lines.join('\n')}
            subtitleLines={0}
            detail={formatRelativeTimeShort(props.event.at, props.now)}
            mode="info"
            showChevron={false}
        />
    );
});

const ActivityList = React.memo(function ActivityList(props: Readonly<{
    context: HomeAdministrationContext;
    targetId?: string;
}>) {
    const { context, targetId } = props;
    const canView = context.projection.capabilities.viewAdministration;
    // Opened from a person's page, the list is about that person only (`home.audit.list{targetId}`).
    const readPage = React.useMemo<HomePageReader<HomeAdministrationEventV1>>(() => (targetId
        ? (scope, cursor) => listHomeAudit({ scope, targetId, ...(cursor ? { cursor } : {}) })
        : readAuditPage), [targetId]);
    const audit = useHomePagedList(context.scope, canView, readPage);
    const now = Date.now();
    const methods = context.projection.authenticationOptions.methods;
    const names = React.useMemo<HomeAuditNames>(() => {
        const byId = new Map(methods.map((method) => [method.id, method.displayName ?? method.id]));
        return { methodName: (id) => byId.get(id) ?? id };
    }, [methods]);

    if (!canView) {
        return (
            <ItemGroup description={t('homeGovernance.forbiddenBody')}>
                <Item testID="home-activity-forbidden" title={t('homeGovernance.forbiddenTitle')} mode="info" showChevron={false} />
            </ItemGroup>
        );
    }

    if (audit.rows.length === 0) {
        if (audit.status === 'loading') {
            return (
                <ItemGroup>
                    <Item testID="home-activity-loading" title={t('homeGovernance.loading')} loading mode="info" showChevron={false} />
                </ItemGroup>
            );
        }
        if (audit.error) {
            return (
                <ItemGroup description={t('homeGovernance.activity.loadFailed')}>
                    <Item testID="home-activity-retry" title={t('homeGovernance.retry')} onPress={audit.reload} showChevron={false} />
                </ItemGroup>
            );
        }
        return (
            <ItemGroup>
                <EmptyState
                    testID="home-activity-empty"
                    layout="inline"
                    iconName="clock-counter-clockwise"
                    title={t('homeGovernance.activity.emptyTitle')}
                    subtitle={t('homeGovernance.activity.emptyBody')}
                />
            </ItemGroup>
        );
    }

    return (
        <>
            <ItemGroup description={t('homeGovernance.activity.footnote')}>
                {audit.rows.map((event) => <HomeActivityRow key={event.id} event={event} now={now} viewerAccountId={context.scope.accountId} names={names} />)}
            </ItemGroup>
            {audit.error ? (
                <ItemGroup description={t('homeGovernance.activity.loadFailed')}>
                    <Item testID="home-activity-retry" title={t('homeGovernance.retry')} onPress={audit.loadMore} showChevron={false} />
                </ItemGroup>
            ) : audit.hasMore ? (
                <ItemGroup>
                    <Item
                        testID="home-activity-show-older"
                        title={t('homeGovernance.activity.showOlder')}
                        loading={audit.status === 'loading_more'}
                        disabled={audit.status === 'loading_more'}
                        onPress={audit.loadMore}
                        showChevron={false}
                    />
                </ItemGroup>
            ) : null}
        </>
    );
});

/**
 * Who changed what on one Home, and when (plan §3.9, lab `hcActivity-*`): the administration audit
 * trail, newest first, paged with "Show older". Owners and admins read it.
 */
export const HomeAdministrationActivityScreen = React.memo(function HomeAdministrationActivityScreen(
    props: Readonly<{ serverId: string; targetId?: string }>,
) {
    return (
        <HomeAdministrationSection
            serverId={props.serverId}
            title={t('homeGovernance.activity.title')}
            description={t('homeGovernance.pages.activity')}
        >
            {(context) => <ActivityList context={context} targetId={props.targetId || undefined} />}
        </HomeAdministrationSection>
    );
});
