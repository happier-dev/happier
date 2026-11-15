import * as React from 'react';
import type { ApiTokenSettingsToken } from '@/components/settings/apiTokens/apiTokenSettingsController';
import { usePathname, useRouter } from '@/components/appShell/workspace/destinationRoute';

import { useApiTokenSettingsScopeController } from '@/components/settings/apiTokens/collection/ApiTokenSettingsScope';
import { resolveApiTokenListPresentation, resolveApiTokenOperationErrorMessageKey } from '@/components/settings/apiTokens/apiTokenSettingsPresentation';
import { useApiTokenSettingsClock } from '@/components/settings/apiTokens/useApiTokenSettingsClock';
import { useApiTokenSettingsControllerState } from '@/components/settings/apiTokens/useApiTokenSettingsControllerState';
import { IconButton } from '@/components/ui/buttons/IconButton';
import { CollectionList } from '@/components/ui/lists/collection/CollectionList';
import { SurfaceFreshnessLine } from '@/components/ui/surfaces/SurfaceFreshnessLine';
import { t } from '@/text';
import { runGuardedNavigation } from '@/utils/navigation/runGuardedNavigation';
import { useHostActivelyViewed } from '@/utils/runtime/useHostActivelyViewed';
import { fireAndForget } from '@/utils/system/fireAndForget';

import { EmbedRow } from './EmbedRow';
import { EMBEDS_NEW_PATH, embedDetailPath, isEmbedToken, resolveSelectedEmbedTokenId } from './embedsCollection';
import { useEmbedSummaryNames } from './useEmbedSummaryNames';

/** The embeds rail beside an embed's detail, with "+" to start a new one. */
export const EmbedsCollectionRail = React.memo(function EmbedsCollectionRail() {
    const controller = useApiTokenSettingsScopeController();
    const state = useApiTokenSettingsControllerState(controller);
    const embeds = React.useMemo(() => state.tokens.filter(isEmbedToken), [state.tokens]);
    const presentation = resolveApiTokenListPresentation({ ...state, tokens: embeds });
    const stale = presentation === 'listWithRetry' || presentation === 'emptyWithRetry';
    const router = useRouter();
    const selectedId = resolveSelectedEmbedTokenId(usePathname().replace(/\/+$/, ''));
    const names = useEmbedSummaryNames();
    const nowMs = useApiTokenSettingsClock(embeds, useHostActivelyViewed());

    const navigate = React.useCallback((href: string, tag: string) => {
        const result = runGuardedNavigation(() => router.replace(href as never));
        if (result !== true) fireAndForget(result, { tag });
    }, [router]);
    const open = React.useCallback((token: ApiTokenSettingsToken) => navigate(embedDetailPath(token.tokenId), 'EmbedsCollectionRail.open'), [navigate]);

    return (
        <CollectionList
            testID="settings-embeds-rail"
            title={t('settingsEmbeds.title')}
            count={state.phase === 'ready' ? embeds.length : null}
            headerAction={(
                <IconButton
                    testID="settings-embeds-rail-create"
                    iconName="plus"
                    variant="plain"
                    accessibilityLabel={t('settingsEmbeds.newEmbed')}
                    tooltip={t('settingsEmbeds.newEmbed')}
                    onPress={() => navigate(EMBEDS_NEW_PATH, 'EmbedsCollectionRail.create')}
                />
            )}
        >
            {stale ? (
                <SurfaceFreshnessLine
                    testID="settings-embeds-rail-refresh-stale"
                    reason={t(resolveApiTokenOperationErrorMessageKey(state.listError))}
                    busy={state.isRefreshing}
                    action={state.isRefreshing ? undefined : { label: t('common.retry'), onPress: () => void controller.refresh() }}
                />
            ) : null}
            {embeds.map((token) => (
                <EmbedRow
                    key={token.tokenId}
                    token={token}
                    names={names}
                    nowMs={nowMs}
                    variant="rail"
                    selected={selectedId === token.tokenId}
                    onPress={open}
                />
            ))}
        </CollectionList>
    );
});
