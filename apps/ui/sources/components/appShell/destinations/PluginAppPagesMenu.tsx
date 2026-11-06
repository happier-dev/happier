import * as React from 'react';

import { DropdownMenu, type DropdownMenuItem } from '@/components/ui/forms/dropdown/DropdownMenu';
import { CollectionNavigationRow } from '@/components/ui/lists/collection/CollectionList';
import { Icon } from '@/components/ui/icons/Icon';
import { resolveReasonCopy } from '@/sync/domains/surfaces/copy';
import { t } from '@/text';
import { CompactAppDestinationBadge } from './CompactAppDestinationBadge';
import {
    isCompactAppDestinationInvokable,
    useActivateAppDestination,
    useCompactAppDestinations,
    type CompactAppPluginDestination,
} from './compactAppDestinationCatalog';

/** Explicit page recovery shares the catalog and activation owner, without changing placement. */
export function usePluginAppPagesMenu(): Readonly<{
    item: DropdownMenuItem | null;
    select(id: string): boolean;
}> {
    const catalog = useCompactAppDestinations();
    const activate = useActivateAppDestination();
    const pages = React.useMemo(() => catalog.filter(
        (destination): destination is CompactAppPluginDestination => destination.kind === 'plugin'
            && destination.container === 'appPage',
    ), [catalog]);
    const item = React.useMemo<DropdownMenuItem | null>(() => pages.length === 0 ? null : ({
        id: 'plugin-app-pages-menu',
        testID: 'plugin-app-pages-menu',
        title: t('pluginSurfaces.appPage.title'),
        icon: <Icon name="puzzle-piece" />,
        submenu: { items: pages.map(page => ({
            id: page.id,
            testID: `plugin-app-pages-menu:${page.id}`,
            title: page.title,
            subtitle: page.availability === 'unavailable'
                ? resolveReasonCopy({ reasonCode: page.unavailableReason, kind: 'pluginRuntime' }).message
                : undefined,
            icon: <Icon name={page.icon} />,
            rightElement: page.badge ? <CompactAppDestinationBadge destination={page} /> : undefined,
            disabled: !isCompactAppDestinationInvokable(page),
        })) },
    }), [pages]);
    const select = React.useCallback((id: string) => {
        const page = pages.find(destination => destination.id === id);
        if (!page) return false;
        activate(page);
        return true;
    }, [activate, pages]);
    return { item, select };
}

export function PluginAppPagesMenu(): React.ReactElement | null {
    const { item, select } = usePluginAppPagesMenu();
    const [open, setOpen] = React.useState(false);
    if (!item) return null;
    return <DropdownMenu
        testID="plugins-column:pages"
        open={open}
        onOpenChange={setOpen}
        items={item.submenu?.items ?? []}
        onSelect={id => { setOpen(false); select(id); }}
        placement="bottom"
        variant="slim"
        matchTriggerWidth={false}
        popoverPortalWebTarget="body"
        trigger={({ toggle }) => <CollectionNavigationRow
            rowRole="item"
            testID="plugins-column:pages.trigger"
            title={item.title}
            icon={item.icon}
            selected={false}
            onPress={toggle}
        />}
    />;
}
