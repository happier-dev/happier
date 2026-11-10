import * as React from 'react';
import { PAGE_LIST_METRICS } from '@/components/ui/lists/pageListMetrics';
import { useRouter } from '@/components/appShell/workspace/destinationRoute';
import type { HomeAccountRowV1 } from '@happier-dev/protocol/home/governance';
import { useUnistyles } from 'react-native-unistyles';

import { Avatar } from '@/components/ui/avatar/Avatar';
import { CompactSearchField } from '@/components/ui/forms/CompactSearchField';
import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { SectionButtonRow } from '@/components/ui/lists/SectionButtonRow';
import { RoundButton } from '@/components/ui/buttons/RoundButton';
import { ItemLoadStateRows } from '@/components/ui/lists/ItemLoadStateRows';
import { VirtualizedItemList } from '@/components/ui/lists/VirtualizedItemList';
import { SurfaceStateCard } from '@/components/ui/surfaces/SurfaceStateCard';
import { useHomeAccountRoster } from '@/hooks/home/useHomeAccountRoster';
import {
    useHomeAccountSearch,
} from '@/hooks/home/useHomeAccountSearch';
import { resolveAccountDisplayName } from '@/sync/domains/account/formatAccountDisplayName';
import { t, usePreferredLanguage, type SupportedLanguage } from '@/text';

import { HomeAdministrationSection } from './HomeAdministrationSection';
import { HomeInvitePeopleButton } from './HomeInvitePeopleDialog';
import type { HomeAdministrationContext } from './homeAdministrationContext';
import { homeAdministrationAccountPath } from './homeAdministrationRoutes';
import { HomeAccountStatusPill } from './HomeAccountStatusPill';
import { homeRoleLabel } from './homeGovernanceLabels';
import { segmentHomeAdministrationRows } from './homeAdministrationVirtualizedSegments';

/**
 * Matches for a typed query, as the Home answered them.
 *
 * A picker row carries identity only — no Home role and no lifecycle status —
 * so this deliberately shows neither. Inventing a badge here would claim a
 * state the Home did not report; the account's own page shows the authoritative
 * role and status.
 */
type PeopleVirtualizedRow = Readonly<{
    key: string;
    render: () => React.ReactElement;
}>;

const PEOPLE_CHUNK_SIZE = 12;
/** The person's identity mark on the People list. */

/** Stable admitted row inputs keep refresh/status publications out of unchanged mounted people. */
const PeopleRosterRow = React.memo(function PeopleRosterRow(props: Readonly<{
    row: HomeAccountRowV1;
    viewerAccountId: string;
    onOpen: (accountId: string) => void;
    locale: SupportedLanguage;
}>) {
    const { row, viewerAccountId, onOpen } = props;
    const open = React.useCallback(() => onOpen(row.accountId), [onOpen, row.accountId]);
    const person = resolveAccountDisplayName({
        profile: row.profile,
        accountId: row.accountId,
        signInEmail: row.authentication.signInEmail,
        viewerAccountId,
    });
    return (
        <Item
            testID={`home-people-row:${row.accountId}`}
            title={person.name}
            leftElement={<Avatar id={row.accountId} size={PAGE_LIST_METRICS.rowIdentityMarkPx} imageUrl={row.profile.avatarUrl ?? null} />}
            subtitle={[
                homeRoleLabel(row.homeRole),
                person.viewer && person.named ? t('homeGovernance.person.you') : null,
                person.hint,
            ].filter((part): part is string => part !== null).join(' · ')}
            rightElement={<HomeAccountStatusPill row={row} testID={`home-people-status:${row.accountId}`} locale={props.locale} />}
            keepChevronWithRightElement
            onPress={open}
        />
    );
});

const PeopleRoster = React.memo(function PeopleRoster(
    props: Readonly<{ context: HomeAdministrationContext; header?: React.ReactNode }>,
) {
    const { theme } = useUnistyles();
    const router = useRouter();
    const locale = usePreferredLanguage();
    const { context } = props;
    const canList = context.projection.capabilities.manageAccounts;
    const [query, setQuery] = React.useState('');
    const roster = useHomeAccountRoster(context.scope, canList);
    const search = useHomeAccountSearch(context.scope, query, canList);
    const isSearching = query.trim().length > 0;
    const open = React.useCallback((accountId: string) => {
        router.push(homeAdministrationAccountPath(context.scope.serverId, accountId));
    }, [context.scope.serverId, router]);

    const searchHeader = canList ? (
        <CompactSearchField
            testID="home-people-search"
            value={query}
            onChangeText={setQuery}
            placeholder={t('homeGovernance.searchPlaceholder')}
            placement="page"
        />
    ) : null;

    const rows = React.useMemo<readonly PeopleVirtualizedRow[]>(() => {
        if (!canList) {
            return [{
                key: 'forbidden',
                render: () => (
                    <ItemGroup>
                        <SurfaceStateCard
                            testID="home-admin-viewer-forbidden"
                            kind="denied"
                            size="line"
                            title={t('homeGovernance.forbiddenTitle')}
                            reason={t('homeGovernance.forbiddenBody')}
                        />
                    </ItemGroup>
                ),
            }];
        }

        if (roster.error && roster.rows.length === 0 && roster.error.kind === 'unsupported') {
            return [{
                key: 'unsupported',
                render: () => (
                    <ItemGroup>
                        <SurfaceStateCard
                            testID="home-people-unsupported"
                            kind="unavailable"
                            size="line"
                            title={t('homeGovernance.rosterUnavailableTitle')}
                            reason={t('homeGovernance.rosterUnavailableBody')}
                        />
                    </ItemGroup>
                ),
            }];
        }

        // A typed query asks a different question than the page cursor does, so
        // the answers are never blended into one list.
        if (isSearching) {
            if (search.rows.length === 0) {
                if (search.searching) {
                    return [{
                        key: 'search-loading',
                        render: () => (
                            <ItemGroup>
                                <ItemLoadStateRows
                                    testID="home-people-search-loading"
                                    state={{ kind: 'loading' }}
                                    rows={3}
                                    accessibilityLabel={t('homeGovernance.loading')}
                                />
                            </ItemGroup>
                        ),
                    }];
                }
                if (search.failure) {
                    // Read now: the row renders later, where the narrowing no longer holds.
                    const unsupported = search.failure.kind === 'unsupported';
                    const retry = search.failure.retryable ? search.retry : undefined;
                    return [{
                        key: 'search-failure',
                        render: () => (
                            <ItemGroup>
                                {unsupported ? (
                                    <SurfaceStateCard
                                        testID="home-people-search-unsupported"
                                        kind="unavailable"
                                        size="line"
                                        title={t('homeGovernance.searchUnsupported')}
                                        reason={t('homeGovernance.searchUnsupportedBody')}
                                    />
                                ) : (
                                    <ItemLoadStateRows
                                        testID="home-people-search-failed"
                                        state={{
                                            kind: 'failed',
                                            reason: t('homeGovernance.searchFailed'),
                                            onRetry: retry,
                                            homeServerIds: [context.scope.serverId],
                                        }}
                                    />
                                )}
                            </ItemGroup>
                        ),
                    }];
                }
                return [{
                    key: 'search-empty',
                    render: () => (
                        <ItemGroup>
                            <SurfaceStateCard
                                testID="home-people-search-empty"
                                kind="empty"
                                size="line"
                                title={t('homeGovernance.searchEmpty')}
                            />
                        </ItemGroup>
                    ),
                }];
            }

            const result: PeopleVirtualizedRow[] = [];
            for (const segment of segmentHomeAdministrationRows(search.rows, PEOPLE_CHUNK_SIZE)) {
                const chunk = segment.items;
                const { first, last } = segment;
                result.push({
                    key: `search:${chunk[0]!.accountId}`,
                    render: () => (
                        <ItemGroup virtualizedSegment={{ first, last }}>
                            {chunk.map((row) => {
                                const person = resolveAccountDisplayName({ profile: row.profile, accountId: row.accountId, viewerAccountId: context.scope.accountId });
                                return (
                                    <Item
                                        key={row.accountId}
                                        testID={`home-people-search-row:${row.accountId}`}
                                        title={person.name}
                                        subtitle={person.hint ?? undefined}
                                        onPress={() => router.push(homeAdministrationAccountPath(context.scope.serverId, row.accountId))}
                                    />
                                );
                            })}
                        </ItemGroup>
                    ),
                });
            }
            return result;
        }

        // The roster's rows hold their place while the first page is read.
        if (roster.status === 'loading' && roster.rows.length === 0) {
            return [{
                key: 'loading',
                render: () => (
                    <ItemGroup>
                        <ItemLoadStateRows
                            testID="home-people-loading"
                            state={{ kind: 'loading' }}
                            rows={4}
                            accessibilityLabel={t('homeGovernance.loading')}
                        />
                    </ItemGroup>
                ),
            }];
        }

        if (roster.rows.length === 0 && roster.status === 'ready') {
            return [{
                key: 'empty',
                render: () => (
                    <ItemGroup>
                        <SurfaceStateCard testID="home-people-empty" kind="empty" size="line" title={t('homeGovernance.peopleEmpty')} />
                    </ItemGroup>
                ),
            }];
        }

        const result: PeopleVirtualizedRow[] = [];
        for (const segment of segmentHomeAdministrationRows(roster.rows, PEOPLE_CHUNK_SIZE)) {
            const chunk = segment.items;
            const { first, last } = segment;
            result.push({
                key: `roster:${chunk[0]!.accountId}`,
                render: () => (
                    <ItemGroup virtualizedSegment={{ first, last }}>
                        {chunk.map((row) => <PeopleRosterRow key={row.accountId} row={row}
                            viewerAccountId={context.scope.accountId} onOpen={open} locale={locale} />)}
                    </ItemGroup>
                ),
            });
        }

        if (roster.error) {
            // The pages already read stay; what could not be read is said once, with its Retry.
            result.push({
                key: 'retry',
                render: () => (
                    <ItemGroup>
                        <ItemLoadStateRows
                            testID="home-people"
                            state={{
                                kind: 'failed',
                                reason: t('homeGovernance.overviewPage.peopleFailed'),
                                onRetry: roster.reload,
                                homeServerIds: [context.scope.serverId],
                            }}
                        />
                    </ItemGroup>
                ),
            });
        } else if (roster.hasMore) {
            result.push({
                key: 'load-more',
                render: () => (
                    // The console's one paging control: a quiet button under the list, not a row in it.
                    <ItemGroup surface="none">
                        <SectionButtonRow>
                            <RoundButton
                                testID="home-people-load-more"
                                size="small"
                                display="inverted"
                                title={t('homeGovernance.loadMore')}
                                loading={roster.status === 'loading_more'}
                                disabled={roster.status === 'loading_more'}
                                onPress={roster.loadMore}
                            />
                        </SectionButtonRow>
                    </ItemGroup>
                ),
            });
        }
        return result;
    }, [canList, context.scope.accountId, context.scope.serverId, isSearching, roster, router, search, theme.colors.text.secondary, open, locale]);

    const renderRow = React.useCallback(({ item }: Readonly<{ item: PeopleVirtualizedRow }>) => item.render(), []);

    return (
        <VirtualizedItemList
            testID="home-people-virtualized-list"
            data={rows}
            keyExtractor={(item) => item.key}
            renderItem={renderRow}
            ListHeaderComponent={<>{props.header}{searchHeader}</>}
            initialNumToRender={6}
            maxToRenderPerBatch={4}
            windowSize={7}
            estimatedItemSize={120}
            maintainVisibleContentPosition
        />
    );
});

export const HomeAdministrationPeopleScreen = React.memo(function HomeAdministrationPeopleScreen(
    props: Readonly<{ serverId: string }>,
) {
    return (
        <HomeAdministrationSection
            serverId={props.serverId}
            title={t('homeGovernance.people')}
            description={t('homeGovernance.pages.people')}
            presentation="virtualized-list"
            pageActions={(context) => ({
                actions: <HomeInvitePeopleButton context={context} testID="home-people-invite" />,
            })}
        >
            {/* A credential change here means a different roster and different
                search answers; the shell discards this section for the previous
                Home/Account scope so neither carries over. */}
            {(context, header) => <PeopleRoster context={context} header={header} />}
        </HomeAdministrationSection>
    );
});
