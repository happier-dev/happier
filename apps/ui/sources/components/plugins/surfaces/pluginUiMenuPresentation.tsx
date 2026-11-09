import * as React from 'react';
import type { MenuItem } from '@happier-dev/plugin-ui/components';
import type { PluginUiPresentationHost } from '@happier-dev/plugin-ui/advanced';
import { matchesHappierMenuQuery, resolveHappierMenuContent, resolveHappierMenuRadioGroups, resolveHappierMarkColor } from '@happier-dev/plugin-ui/presentation';
import { useHappierUiTheme } from '@happier-dev/plugin-ui/environment';
import { DropdownMenu, type DropdownMenuItem } from '@/components/ui/forms/dropdown/DropdownMenu';
import { Icon, TaskStatusGlyph, HappierStatusDot } from '@happier-dev/plugin-ui/components';
import { CompactSearchField } from '@/components/ui/forms/CompactSearchField';
import { t } from '@/text';

type PopoverInput = Parameters<PluginUiPresentationHost['renderPopover']>[0];
type MenuInput = PopoverInput & Readonly<{ menu: NonNullable<PopoverInput['menu']> }>;

/** Data projection only: DropdownMenu retains all submenu interaction, dismissal and phone push state. */
export function PluginUiMenuPresentation({ input }: Readonly<{ input: MenuInput }>): React.ReactElement {
    const theme = useHappierUiTheme();
    const menu = input.menu;
    const source = resolveHappierMenuContent(menu);
    const allItems: MenuItem[] = [];
    const collect = (items: readonly MenuItem[]) => {
        for (const item of items) {
            allItems.push(item);
            if (item.submenu) collect(item.submenu.items);
        }
    };
    collect(source.items);
    // IDs address leaf callbacks across the whole tree, and radio state stays public-menu controlled.
    const radioGroups = resolveHappierMenuRadioGroups({ items: resolveHappierMenuContent({ items: allItems }).items, radioGroups: menu.radioGroups ?? [] });
    const project = (item: MenuItem, category?: string): DropdownMenuItem => ({
        id: item.id,
        title: item.label,
        subtitle: item.subtitle,
        disabled: item.disabled,
        destructive: item.destructive,
        category,
        ...(item.taskStatus !== undefined ? { icon: <TaskStatusGlyph category={item.taskStatus} /> }
            : item.swatch !== undefined ? { icon: <HappierStatusDot color={resolveHappierMarkColor(theme, item.swatch)} /> }
                : item.icon ? { icon: <Icon name={item.icon} size="small" tone={item.destructive ? 'danger' : 'secondary'} /> } : {}),
        ...(item.kind === 'checkbox' ? { checked: item.checked, multiSelect: true }
            : item.kind === 'radio' ? { checked: radioGroups.get(item.radioGroupId)?.selectedId === item.id } : {}),
        ...(menu.keepOpen || item.kind === 'checkbox' ? { keepMenuOpen: true } : {}),
        ...(item.submenu ? { submenu: { items: item.submenu.items.map(child => project(child)), title: item.submenu.title } } : {}),
    });
    const matches = (item: MenuItem) => menu.search === undefined || matchesHappierMenuQuery({
        label: item.label, description: item.subtitle, query: menu.search.value,
    });
    const items = [
        ...source.ungroupedEntries.filter(entry => matches(entry.item)).map(entry => project(entry.item)),
        ...source.groups.flatMap(group => group.entries.filter(entry => matches(entry.item)).map(entry => project(entry.item, group.accessibilityLabel))),
    ];
    return <DropdownMenu open={input.open} onOpenChange={open => { if (!open) input.onRequestClose(); }}
        trigger={null} items={items} search={false} matchTriggerWidth={input.width === 'anchor'}
        placement={input.placement} popoverAnchorRef={input.anchorRef} popoverFocusReturnRef={input.focusReturnRef}
        popoverFollowScrollRef={input.followScrollRef} popoverAccessibilityLabel={input.sheet?.title ?? menu.accessibilityLabel}
        popoverSheetHeader={input.sheet?.header} popoverSheetFooter={input.sheet?.footer}
        {...(input.sheet ? { popoverPhonePresentation: 'sheet' as const } : {})}
        showCategoryTitles={menu.showGroupLabels}
        header={menu.search ? <CompactSearchField value={menu.search.value} onChangeText={menu.search.onValueChange}
            placeholder={t('common.search')} accessibilityLabel={t('common.search')} /> : undefined}
        onSelect={id => menu.onSelect(id, { anchorRef: input.anchorRef })} />;
}
