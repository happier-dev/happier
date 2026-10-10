import * as React from 'react';
import { View } from 'react-native';
import { usePathname, useRouter } from '@/components/appShell/workspace/destinationRoute';
import { useUnistyles } from 'react-native-unistyles';

import { SettingsPageHeader } from '@/components/settings/shell/SettingsPageHeader';
import { RoundButton } from '@/components/ui/buttons/RoundButton';
import { EmptyState } from '@/components/ui/empty/EmptyState';
import { CompactSearchField } from '@/components/ui/forms/CompactSearchField';
import { Icon } from '@/components/ui/icons/Icon';
import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { ItemList } from '@/components/ui/lists/ItemList';
import { useAllMachines } from '@/sync/domains/state/storage';
import { t } from '@/text';
import { runGuardedNavigation } from '@/utils/navigation/runGuardedNavigation';
import { fireAndForget } from '@/utils/system/fireAndForget';

import { describeConfiguredServerEndpoint, resolveTransportIconName, summarizeBindings } from '../mcpServerUi';
import { useMcpServersSettings } from '../useMcpServersSettings';
import { AddMcpServerMenu } from './AddMcpServerMenu';
import {
    buildMcpServerCollection,
    MCP_NEW_SERVER_ROUTE,
    MCP_ON_MACHINE_ROUTE,
    MCP_SESSION_PREVIEW_ROUTE,
    mcpServerDraftTitle,
    mcpServerRoute,
    type McpServerCollectionRow,
} from './mcpServerCollectionModel';
import { CollectionDraftRow, CollectionList, CollectionListGroupLabel, collectionListStyles } from '@/components/ui/lists/collection/CollectionList';
import { HappierCollectionListMark } from '@happier-dev/plugin-ui/presentation';

/** The collection offers a search field only once it no longer fits at a glance. */
const SEARCH_THRESHOLD = 8;

/**
 * The MCP servers collection: the Account's servers, then the two tools that act on a machine
 * (import what other agents configure, preview what a session gets). `rail` is the list beside the
 * selected detail; `page` is the same list as page sections where no rail shows (phones).
 * Selection comes from the route.
 */
export const McpServerCollection = React.memo(function McpServerCollection(props: Readonly<{
    variant: 'rail' | 'page';
    selectedServerId?: string | null;
}>) {
    const { theme } = useUnistyles();
    const router = useRouter();
    const pathname = usePathname().replace(/\/+$/, '');
    const machines = useAllMachines();
    const { settings } = useMcpServersSettings();
    const [query, setQuery] = React.useState('');
    const rows = React.useMemo(() => buildMcpServerCollection(settings, query), [query, settings]);
    const total = settings.servers.length;
    const rail = props.variant === 'rail';

    const navigate = React.useCallback((href: string) => {
        // Beside a detail, choosing another item replaces the shown detail instead of stacking history.
        const result = runGuardedNavigation(() => (rail ? router.replace(href as never) : router.push(href as never)));
        if (result !== true) fireAndForget(result, { tag: 'McpServerCollection.navigate' });
    }, [rail, router]);

    const renderServerRow = (row: McpServerCollectionRow) => {
        const selected = rail && row.server.id === props.selectedServerId;
        return (
            <Item
                key={row.server.id}
                testID={`mcp.server.card.${row.server.id}`}
                title={row.title}
                subtitle={row.unbound ? t('mcpSettings.unbound') : summarizeBindings(row.bindings, machines)}
                subtitleLeading={row.unbound ? <View style={collectionListStyles.troubleDot} /> : undefined}
                accessibilityHint={describeConfiguredServerEndpoint(row.server) || undefined}
                icon={(
                    <HappierCollectionListMark>
                        <Icon name={resolveTransportIconName(row.server.transport)} size={20} color={theme.colors.text.secondary} />
                    </HappierCollectionListMark>
                )}
                selected={rail ? selected : undefined}
                accessibilityCurrent={selected ? 'page' : undefined}
                density={rail ? 'compact' : undefined}
                showChevron={!rail}
                pressableStyle={rail ? collectionListStyles.row : undefined}
                onPress={() => navigate(mcpServerRoute(row.server.id))}
            />
        );
    };

    const renderToolRow = (id: 'onMachine' | 'preview') => {
        const href = id === 'onMachine' ? MCP_ON_MACHINE_ROUTE : MCP_SESSION_PREVIEW_ROUTE;
        const selected = rail && pathname === href;
        return (
            <Item
                key={id}
                testID={`settings.mcpServers.tool.${id}`}
                title={id === 'onMachine' ? t('mcpSettings.onMachineTitle') : t('mcpSettings.previewTitle')}
                icon={(
                    <HappierCollectionListMark>
                        <Icon name={id === 'onMachine' ? 'magnifying-glass' : 'eye'} size={20} color={theme.colors.text.secondary} />
                    </HappierCollectionListMark>
                )}
                selected={rail ? selected : undefined}
                accessibilityCurrent={selected ? 'page' : undefined}
                density={rail ? 'compact' : undefined}
                showChevron={!rail}
                pressableStyle={rail ? collectionListStyles.row : undefined}
                onPress={() => navigate(href)}
            />
        );
    };

    const addMenu = <AddMcpServerMenu onAdd={navigate} />;
    const searchable = total > SEARCH_THRESHOLD;
    const search = {
        testID: 'settings.mcpServers.search',
        value: query,
        onChangeText: setQuery,
        placeholder: t('mcpSettings.searchPlaceholder'),
    };
    const draftOpen = pathname === MCP_NEW_SERVER_ROUTE;

    if (rail) {
        return (
            <CollectionList
                testID="settings.mcpServers.rail"
                title={t('settings.mcpServers')}
                count={total}
                headerAction={addMenu}
                search={searchable ? search : null}
            >
                {draftOpen ? <McpServerDraftRow /> : null}
                {total === 0 && !draftOpen ? (
                    <EmptyState
                        testID="settings.mcpServers.empty"
                        layout="line"
                        title={t('settings.mcpServersEmptyTitle')}
                        lineDensity="compact"
                        lineRowStyle={collectionListStyles.row}
                    />
                ) : null}
                {rows.map(renderServerRow)}
                <CollectionListGroupLabel title={t('mcpSettings.toolsGroup')} first={rows.length === 0 && !draftOpen && total > 0} />
                {renderToolRow('onMachine')}
                {renderToolRow('preview')}
            </CollectionList>
        );
    }

    return (
        <ItemList testID="settings.mcpServers.page">
            <SettingsPageHeader description={t('mcpSettings.purpose')} actions={total > 0 ? addMenu : undefined} />
            {searchable ? (
                <CompactSearchField
                    testID={search.testID}
                    value={search.value}
                    onChangeText={search.onChangeText}
                    placeholder={search.placeholder}
                    placement="page"
                />
            ) : null}
            {total === 0 ? <EmptyState
                testID="settings.mcpServers.invitation"
                layout="page"
                variant="add"
                iconName="plug"
                title={t('mcpSettings.landingTitle')}
                subtitle={t('mcpSettings.landingDescription')}
                action={<AddMcpServerMenu onAdd={navigate} renderTrigger={(toggle) => <RoundButton
                    testID="settings.mcpServers.invitation.add" size="normal" title={t('mcpSettings.add')} onPress={toggle} />} />}
            /> : <ItemGroup title={t('settings.mcpServers')}>
                {rows.map(renderServerRow)}
            </ItemGroup>}
            <ItemGroup title={t('mcpSettings.toolsGroup')}>
                {renderToolRow('onMachine')}
                {renderToolRow('preview')}
            </ItemGroup>
        </ItemList>
    );
});

/** The server being added in the detail pane, at the top of the rail, titled as it is typed. */
const McpServerDraftRow = React.memo(function McpServerDraftRow() {
    const { theme } = useUnistyles();
    return (
        <CollectionDraftRow
            testID="settings.mcpServers.draft"
            titles={mcpServerDraftTitle}
            placeholder={t('mcpSettings.newServer')}
            mark={<HappierCollectionListMark><Icon name="terminal" size={20} color={theme.colors.text.secondary} /></HappierCollectionListMark>}
        />
    );
});
