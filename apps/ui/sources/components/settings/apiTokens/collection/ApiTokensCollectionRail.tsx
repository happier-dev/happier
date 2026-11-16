import * as React from 'react';
import { usePathname, useRouter } from '@/components/appShell/workspace/destinationRoute';

import { IconButton } from '@/components/ui/buttons/IconButton';
import { CollectionList, collectionListStyles } from '@/components/ui/lists/collection/CollectionList';
import { Item } from '@/components/ui/lists/Item';
import { ItemLoadStateRows } from '@/components/ui/lists/ItemLoadStateRows';
import { t } from '@/text';
import { useHostActivelyViewed } from '@/utils/runtime/useHostActivelyViewed';
import { runGuardedNavigation } from '@/utils/navigation/runGuardedNavigation';
import { fireAndForget } from '@/utils/system/fireAndForget';

import { ApiTokenRow } from '../ApiTokenRow';
import type { ApiTokenSettingsToken } from '../apiTokenSettingsController';
import { useApiTokenGrantNames } from '../grant/useApiTokenGrantCatalogs';
import { useApiTokenOperations } from '../useApiTokenOperations';
import { useApiTokenSettingsClock } from '../useApiTokenSettingsClock';
import { useApiTokenSettingsControllerState } from '../useApiTokenSettingsControllerState';
import { apiTokenRowHref, resolveSelectedApiTokenId } from './apiTokensCollection';
import { useApiTokenSettingsScopeController } from './ApiTokenSettingsScope';

/**
 * The API tokens rail beside a token's detail: every root token with its access line, "+" to create
 * one, and the collection's one rare operation (revoke all) at its foot. Embed-backed rows open
 * Settings → Embeds instead of a detail here.
 */
export const ApiTokensCollectionRail = React.memo(function ApiTokensCollectionRail() {
    const controller = useApiTokenSettingsScopeController();
    const state = useApiTokenSettingsControllerState(controller);
    const router = useRouter();
    const pathname = usePathname().replace(/\/+$/, '');
    const selectedId = resolveSelectedApiTokenId(pathname);
    const names = useApiTokenGrantNames();
    const nowMs = useApiTokenSettingsClock(state.tokens, useHostActivelyViewed());
    const operations = useApiTokenOperations(controller);
    const busy = state.phase === 'loading' || state.createPending || state.operation !== null;

    const open = React.useCallback((token: ApiTokenSettingsToken) => {
        const href = apiTokenRowHref(token);
        // Switching tokens replaces the open detail; an embed opens in its own collection.
        const result = runGuardedNavigation(() => (token.embedConfig !== null ? router.push(href) : router.replace(href)));
        if (result !== true) fireAndForget(result, { tag: 'ApiTokensCollectionRail.open' });
    }, [router]);

    return (
        <CollectionList
            testID="settings-api-tokens-rail"
            title={t('settingsApiTokens.title')}
            count={state.phase === 'ready' ? state.tokens.length : null}
            headerAction={(
                <IconButton
                    testID="settings-api-tokens-rail-create"
                    iconName="plus"
                    variant="plain"
                    accessibilityLabel={t('settingsApiTokens.create.button')}
                    tooltip={t('settingsApiTokens.create.button')}
                    disabled={busy}
                    onPress={operations.create}
                />
            )}
            footer={state.tokens.length > 0 ? (
                <Item
                    testID="settings-api-tokens-rail-revoke-all"
                    title={t('settingsApiTokens.revokeAll.railAction')}
                    titleStyle={collectionListStyles.dimmedTitle}
                    density="compact"
                    showChevron={false}
                    pressableStyle={collectionListStyles.row}
                    disabled={busy}
                    loading={state.operation === 'revokeAll'}
                    onPress={() => void operations.revokeAll()}
                />
            ) : undefined}
        >
            {state.tokens.length === 0 && (state.phase === 'idle' || state.phase === 'loading') ? (
                <ItemLoadStateRows
                    testID="settings-api-tokens-rail-loading"
                    state={{ kind: 'loading' }}
                    rows={3}
                    accessibilityLabel={t('settingsApiTokens.tokens')}
                />
            ) : null}
            {state.tokens.map((token) => (
                <ApiTokenRow
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
