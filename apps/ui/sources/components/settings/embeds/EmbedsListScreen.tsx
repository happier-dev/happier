import * as React from 'react';
import type { AccountApiTokenSummaryV1 } from '@happier-dev/protocol';
import { RefreshControl } from 'react-native';
import { useUnistyles } from 'react-native-unistyles';
import { useRouter } from '@/components/appShell/workspace/destinationRoute';

import { resolveApiTokenListPresentation, resolveApiTokenOperationErrorMessageKey } from '@/components/settings/apiTokens/apiTokenSettingsPresentation';
import { useApiTokenSettingsScopeController } from '@/components/settings/apiTokens/collection/ApiTokenSettingsScope';
import { useApiTokenSettingsClock } from '@/components/settings/apiTokens/useApiTokenSettingsClock';
import { useApiTokenSettingsControllerState } from '@/components/settings/apiTokens/useApiTokenSettingsControllerState';
import { EmbedLivePreview } from './EmbedLivePreview';
import { SettingsPageHeader } from '@/components/settings/shell/SettingsPageHeader';
import { EmptyState } from '@/components/ui/empty/EmptyState';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { ItemList } from '@/components/ui/lists/ItemList';
import { ItemLoadStateRows } from '@/components/ui/lists/ItemLoadStateRows';
import { SurfaceFreshnessLine } from '@/components/ui/surfaces/SurfaceFreshnessLine';
import { SurfaceStateCard } from '@/components/ui/surfaces/SurfaceStateCard';
import { t } from '@/text';
import { runGuardedNavigation } from '@/utils/navigation/runGuardedNavigation';
import { useHostActivelyViewed } from '@/utils/runtime/useHostActivelyViewed';
import { fireAndForget } from '@/utils/system/fireAndForget';

import { EmbedRow } from './EmbedRow';
import { EMBEDS_NEW_PATH, embedDetailPath, isEmbedToken } from './embedsCollection';
import { useEmbedSummaryNames } from './useEmbedSummaryNames';

/**
 * `/settings/embeds` as a page (plan 04 §6.2): the page header with its one primary ("New embed"),
 * the embeds as rows, or the empty state that invites the first one. Refresh keeps the rows; a failed
 * refresh keeps them too and says so in one freshness line with Retry (lab L3).
 */
export const EmbedsListScreen = React.memo(function EmbedsListScreen() {
    const { theme } = useUnistyles();
    const router = useRouter();
    const controller = useApiTokenSettingsScopeController();
    const state = useApiTokenSettingsControllerState(controller);
    const embeds = React.useMemo(() => state.tokens.filter(isEmbedToken), [state.tokens]);
    const presentation = resolveApiTokenListPresentation({ ...state, tokens: embeds });
    const names = useEmbedSummaryNames();
    const nowMs = useApiTokenSettingsClock(embeds, useHostActivelyViewed());

    const push = React.useCallback((href: string, tag: string) => {
        const result = runGuardedNavigation(() => router.push(href as never));
        if (result !== true) fireAndForget(result, { tag });
    }, [router]);
    const openNew = React.useCallback(() => push(EMBEDS_NEW_PATH, 'EmbedsListScreen.new'), [push]);
    const openEmbed = React.useCallback((token: AccountApiTokenSummaryV1) => push(embedDetailPath(token.tokenId), 'EmbedsListScreen.open'), [push]);
    const empty = presentation === 'empty' || presentation === 'emptyWithRetry';
    const stale = presentation === 'listWithRetry' || presentation === 'emptyWithRetry';

    return (
        <ItemList
            refreshControl={(
                <RefreshControl
                    refreshing={state.isRefreshing}
                    onRefresh={() => void controller.refresh()}
                    tintColor={theme.colors.text.secondary}
                />
            )}
        >
            <SettingsPageHeader
                description={t('settingsEmbeds.purpose')}
                primaryAction={empty ? undefined : { title: t('settingsEmbeds.newEmbed'), testID: 'settings-embeds-new', onPress: openNew }}
            />
            {stale ? (
                // Under the header, in the page column, without a sheet of its own.
                <ItemGroup surface="none">
                    <SurfaceFreshnessLine
                        testID="settings-embeds-refresh-stale"
                        reason={t(resolveApiTokenOperationErrorMessageKey(state.listError))}
                        busy={state.isRefreshing}
                        action={state.isRefreshing ? undefined : { label: t('common.retry'), onPress: () => void controller.refresh() }}
                    />
                </ItemGroup>
            ) : null}
            {presentation === 'skeleton' ? (
                <ItemGroup title={t('settingsEmbeds.yourEmbeds')}>
                    <ItemLoadStateRows testID="settings-embeds-skeleton" state={{ kind: 'loading' }} rows={3} lines={2}
                        accessibilityLabel={t('settingsEmbeds.yourEmbeds')} />
                </ItemGroup>
            ) : null}
            {presentation === 'error' ? (
                <SurfaceStateCard
                    testID="settings-embeds-list-error"
                    kind="error"
                    title={t('settingsEmbeds.listError')}
                    diagnosticCode={state.listError}
                    action={{ label: t('common.retry'), onPress: () => void controller.refresh() }}
                />
            ) : null}
            {empty ? (
                <EmptyState
                    testID="settings-embeds-empty"
                    layout="page"
                    variant="add"
                    icon={<EmbedLivePreview presentation="illustration" style={null} ui={{ attachments: false }} newChat={false} />}
                    title={t('settingsEmbeds.emptyTitle')}
                    subtitle={t('settingsEmbeds.emptyBody')}
                    primaryAction={{ label: t('settingsEmbeds.newEmbed'), onPress: openNew, testID: 'settings-embeds-empty-new' }}
                />
            ) : null}
            {embeds.length > 0 ? (
                <ItemGroup title={t('settingsEmbeds.yourEmbeds')}>
                    {embeds.map((token) => (
                        <EmbedRow key={token.tokenId} token={token} names={names} nowMs={nowMs} variant="page" onPress={openEmbed} />
                    ))}
                </ItemGroup>
            ) : null}
        </ItemList>
    );
});
