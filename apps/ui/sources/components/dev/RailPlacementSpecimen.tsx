import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';

import { resolveCompactAppDestinations } from '@/components/appShell/destinations/compactAppDestinationCatalog';
import type { PluginPage } from '@/components/plugins/pages/pluginPages';
import { AppShellMaterialFrame } from '@/components/navigation/shell/AppShellMaterialFrame';
import { AppRailSurface } from '@/components/navigation/shell/appRail/AppRail';
import { AppRailBadge } from '@/components/navigation/shell/appRail/AppRailBadge';
import { AppRailIcon } from '@/components/navigation/shell/appRail/AppRailIcon';
import { AppRailSlot } from '@/components/navigation/shell/appRail/AppRailSlot';
import { buildAppRailEntries, buildAppRailPlacementItems, type AppRailPlacementItem } from '@/components/navigation/shell/appRail/appRailModel';
import { APP_RAIL_ICON_GLYPH_SIZE_PX, APP_RAIL_ITEM_SIZE_PX, APP_SHELL_TITLE_STRIP_HEIGHT_PX } from '@/components/navigation/shell/appRail/appRailMetrics';
import type { SidebarFooterPopoverTrigger } from '@/components/navigation/shell/sidebarFooter/SidebarFooterPopoverButton';
import { Avatar } from '@/components/ui/avatar/Avatar';
import { IconButton } from '@/components/ui/buttons/IconButton';
import { RoundButton } from '@/components/ui/buttons/RoundButton';
import { ItemList } from '@/components/ui/lists/ItemList';
import { PageHeader } from '@/components/ui/layout/PageHeader';
import { NavigationPlacementCustomizerView } from '@/components/ui/navigation/NavigationPlacementCustomizer';
import { Text } from '@/components/ui/text/Text';
import type { NavigationPlacementPreferences } from '@/sync/domains/settings/mobileSurfacePinning';
import { t } from '@/text';

const PAGES = ['channels', 'inspector', 'triage'].map((id, index): PluginPage => ({
    target: { kind: 'app' },
    visible: true,
    id: `plugin:acme.${id}:${id}`, pluginId: `acme.${id}`, descriptorId: id, localId: id,
    label: id === 'channels' ? 'Channels' : id === 'inspector' ? 'Plugin Inspector' : 'PRs & Issues',
    icon: id === 'channels' ? 'chats-circle' : id === 'inspector' ? 'puzzle-piece' : 'git-pull-request',
    order: index, disabledReason: null, placement: {} as PluginPage['placement'], routePath: `/plugins/acme.${id}/${id}`,
}));
const FIXTURE_SCOPE = Object.freeze({ serverId: 'rail-specimen', accountId: 'rail-specimen' });

/** Geometry and customization through the real owners; all actions and preferences stay in fixture state. */
export function RailPlacementSpecimen(props: Readonly<{ frame?: string | null }>) {
    const [preferences, setPreferences] = React.useState<NavigationPlacementPreferences>({ orderedIds: [], placements: {} });
    const [customizing, setCustomizing] = React.useState(props.frame === 'customize');
    const [selected, setSelected] = React.useState('settings');
    const entries = React.useMemo(() => buildAppRailEntries(resolveCompactAppDestinations({
        builtins: { externalSessions: true, inbox: true, workflows: true, friends: false }, pages: PAGES,
    }), { includeHidden: true }), []);
    const items = React.useMemo(() => buildAppRailPlacementItems(entries, true), [entries]);
    const select = React.useCallback((id: string) => { setSelected(id); setCustomizing(false); }, []);
    const footer = React.useCallback((item: AppRailPlacementItem, renderTrigger?: SidebarFooterPopoverTrigger) =>
        <FixtureFooter item={item} renderTrigger={renderTrigger} onPress={() => select(item.id)} />, [select]);
    return <View testID="rail-placement-specimen" style={styles.root}>
        <AppShellMaterialFrame showChrome dragEnabled={false} leftOffsetPx={0} sidebarWidth={260}
            titleStrip={<View style={styles.titleStrip} />} column={null} peek={null}
            rail={<AppRailSurface entries={entries} activeId={selected} onOpen={entry => select(entry.id)}
                updatesVisible preferences={preferences} renderFooter={footer} onCustomize={() => setCustomizing(true)} />}>
            {customizing ? <NavigationPlacementCustomizerView surfaceId="appRail" items={items} preferences={preferences}
                onChange={setPreferences} scope={FIXTURE_SCOPE} testID="navigation-placement-customizer" />
                : <ItemList><PageHeader title={t('settings.title')} description={t('navigationPlacement.description')}
                    actions={<RoundButton title={t('navigationPlacement.customize')} size="small" display="secondary"
                        testID="rail-placement-customize" onPress={() => setCustomizing(true)} />} />
                    <Text testID="rail-placement-selection">{selected}</Text></ItemList>}
        </AppShellMaterialFrame>
    </View>;
}

function FixtureFooter(props: Readonly<{ item: AppRailPlacementItem; renderTrigger?: SidebarFooterPopoverTrigger; onPress: () => void }>) {
    if (props.renderTrigger) return props.renderTrigger({ onPress: props.onPress, open: false });
    return (
        <AppRailSlot badge={props.item.id === 'app-rail-updates' ? <AppRailBadge testID="app-rail-updates-badge" signal={{ kind: 'count', value: 1, tone: 'accent' }} /> : null}>
            <IconButton testID={props.item.id} variant="plain" size={APP_RAIL_ITEM_SIZE_PX} accessibilityLabel={props.item.title}
                onPress={props.onPress} tooltip={props.item.title} tooltipPlacement="right"
                icon={props.item.id === 'app-rail-account' ? <Avatar id="rail-fixture-person" size={28} />
                    : <AppRailIcon name={props.item.icon} />} />
        </AppRailSlot>
    );
}

const styles = StyleSheet.create({ root: { flex: 1, minHeight: 0 }, titleStrip: { height: APP_SHELL_TITLE_STRIP_HEIGHT_PX } });
