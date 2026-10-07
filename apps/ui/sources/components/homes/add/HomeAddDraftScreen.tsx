import * as React from 'react';
import { useLocalSearchParams, useRouter } from '@/components/appShell/workspace/destinationRoute';

import { HOMES_COLLECTION_ROOT, homeCollectionHref } from '@/components/settings/server/collection/homeCollectionModel';
import { useServerAutoAddFromRoute } from '@/components/settings/server/hooks/useServerAutoAddFromRoute';
import { AttentionBanner } from '@/components/ui/lists/AttentionBanner';
import { SurfaceStateCard } from '@/components/ui/surfaces/SurfaceStateCard';
import { resolveServerProfileScopeId } from '@/sync/domains/server/serverProfiles';
import { HOMES_ADD_SETTINGS } from '@/components/settings/server/serverSettings';
import { SettingAnchor } from '@/components/settings/shell/SettingRow';
import { RoundButton } from '@/components/ui/buttons/RoundButton';
import { PageHeader } from '@/components/ui/layout/PageHeader';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { ItemList } from '@/components/ui/lists/ItemList';
import { t } from '@/text';
import { runGuardedNavigation } from '@/utils/navigation/runGuardedNavigation';
import { fireAndForget } from '@/utils/system/fireAndForget';

import type { AddHomePath } from './addHomeFlowModel';
import { HomeAddForm } from './HomeAddForm';
import { homeAddDraftTitle } from './homeAddDraftTitle';

const ADD_HOME_PATHS: readonly AddHomePath[] = ['service', 'other_service', 'direct', 'use_service_as_home', 'server_home'];

function readParam(value: string | string[] | undefined): string | undefined {
    const first = Array.isArray(value) ? value[0] : value;
    const trimmed = typeof first === 'string' ? first.trim() : '';
    return trimmed.length > 0 ? trimmed : undefined;
}

/**
 * Settings → Homes → Add a Home: the collection's draft (lab `add-flows` H1). The same form as Home's
 * "Already use Happier?" block, with its paths as cards above the chosen one. Discard leaves nothing
 * behind; a Home that connects becomes a row of the collection.
 */
export const HomeAddDraftScreen = React.memo(function HomeAddDraftScreen() {
    const router = useRouter();
    const params = useLocalSearchParams<{ address?: string | string[]; path?: string | string[]; auto?: string | string[]; source?: string | string[] }>();
    const initialAddress = readParam(params.address);
    // `/server?url=…&auto=1` (a Personal Home just set up, a link that names its Home): connect it at once.
    const automatic = readParam(params.auto) === '1' && initialAddress !== undefined;
    const autoConnect = useServerAutoAddFromRoute({
        enabled: automatic,
        address: initialAddress,
        source: readParam(params.source) === 'notification' ? 'notification' : 'url',
    });
    const connectedProfile = autoConnect.result?.kind === 'connected' ? autoConnect.result.profile : null;
    React.useEffect(() => {
        if (!connectedProfile) return;
        // The draft becomes the Home: its page in the collection.
        const result = runGuardedNavigation(() => router.replace(homeCollectionHref(resolveServerProfileScopeId(connectedProfile)) as never));
        if (result !== true) fireAndForget(result, { tag: 'HomeAddDraftScreen.autoConnected' });
    }, [connectedProfile, router]);
    const initialPath = ADD_HOME_PATHS.find((path) => path === readParam(params.path));
    // The draft row in the rail is titled by the address being typed; it clears when the draft closes.
    const publishDraftTitle = React.useCallback((address: string) => homeAddDraftTitle.publish(address.trim()), []);
    React.useEffect(() => {
        if (initialAddress) homeAddDraftTitle.publish(initialAddress);
        return () => homeAddDraftTitle.publish('');
    }, [initialAddress]);
    const leave = React.useCallback(() => {
        const result = runGuardedNavigation(() => router.replace(HOMES_COLLECTION_ROOT as never));
        if (result !== true) fireAndForget(result, { tag: 'HomeAddDraftScreen.leave' });
    }, [router]);

    return (
        <ItemList keyboardShouldPersistTaps="handled">
            <PageHeader
                testID="settings.homes.draft.header"
                title={t('addFlows.addHome')}
                description={t('addFlows.addHomeDescription')}
                actions={(
                    <RoundButton
                        testID="settings.homes.draft.discard"
                        size="small"
                        display="inverted"
                        title={t('addFlows.discard')}
                        onPress={leave}
                    />
                )}
            />
            {automatic && (autoConnect.isConnecting || connectedProfile) ? (
                <SurfaceStateCard
                    testID="settings.homes.draft.connecting"
                    kind="loading"
                    title={t('addFlows.connectingToHome', { address: initialAddress ?? '' })}
                    accessibilitySemantics="status"
                />
            ) : null}
            {automatic && autoConnect.error ? (
                <AttentionBanner testID="settings.homes.draft.autoFailed" tone="warning" title={autoConnect.error} />
            ) : null}
            <ItemGroup surface="none">
                <SettingAnchor setting={HOMES_ADD_SETTINGS.settings.addHome}>
                    <HomeAddForm
                        layout="page"
                        testID="settings.homes.draft.form"
                        initialAddress={initialAddress}
                        initialPath={initialPath}
                        onAddressChange={publishDraftTitle}
                        onClose={leave}
                    />
                </SettingAnchor>
            </ItemGroup>
        </ItemList>
    );
});
