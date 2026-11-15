import type { PluginSurfaceActionControls } from './pluginSurfaceActionControls';
import * as React from 'react';
import { View } from 'react-native';
import type { MenuItem } from '@happier-dev/plugin-ui/components';
import type { PluginUiPresentationHost } from '@happier-dev/plugin-ui/advanced';
import { resolveHappierMenuContent, resolveHappierMenuRadioGroups, resolveHappierMarkColor } from '@happier-dev/plugin-ui/presentation';
import { useHappierUiTheme } from '@happier-dev/plugin-ui/environment';
import { DropdownMenu, type DropdownMenuItem } from '@/components/ui/forms/dropdown/DropdownMenu';
import { Avatar, Icon, TaskStatusGlyph, HappierStatusDot, Text } from '@happier-dev/plugin-ui/components';

type PopoverInput = Parameters<PluginUiPresentationHost['renderPopover']>[0];
type MenuInput = PopoverInput & Readonly<{ menu: NonNullable<PopoverInput['menu']> }>;

/** Data projection only: DropdownMenu retains all submenu interaction, dismissal and phone push state. */
export function PluginUiMenuPresentation({ input, controls }: Readonly<{ input: MenuInput; controls?: PluginSurfaceActionControls }>): React.ReactElement {
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
        disabled: item.disabled || Boolean(item.action && !controls),
        destructive: item.destructive,
        category,
        ...(item.taskStatus !== undefined ? { icon: <TaskStatusGlyph category={item.taskStatus} /> }
            : item.person !== undefined ? { icon: <View aria-hidden importantForAccessibility="no-hide-descendants">
                <Avatar name={item.person} size="small" testID="menu-item-face" />
            </View> }
            : item.swatch !== undefined ? { icon: <HappierStatusDot color={resolveHappierMarkColor(theme, item.swatch)} /> }
                : item.icon ? { icon: <Icon name={item.icon} size="small" tone={item.destructive ? 'danger' : 'secondary'} /> } : {}),
        ...(item.kind === 'checkbox' ? { checked: item.checked, multiSelect: true }
            : item.kind === 'radio' ? { checked: radioGroups.get(item.radioGroupId)?.selectedId === item.id } : {}),
        ...(menu.keepOpen || item.kind === 'checkbox' ? { keepMenuOpen: true } : {}),
        ...(item.action?.accessibilityLabel === undefined ? {} : { accessibilityLabel: item.action.accessibilityLabel }),
        ...(item.meta === undefined ? {} : {
            accessibilityLabel: item.action?.accessibilityLabel ?? [item.label, item.subtitle, item.meta].filter(Boolean).join(' · '),
            rightElement: <Text variant="meta" tone="secondary" value={item.meta} numberOfLines={1} />,
        }),
        ...(item.submenu ? { submenu: { items: item.submenu.items.map(child => project(child)), title: item.submenu.title } } : {}),
    });
    const items = [
        ...source.ungroupedEntries.map(entry => project(entry.item)),
        ...source.groups.flatMap(group => group.entries.map(entry => project(entry.item, group.accessibilityLabel))),
    ];
    // The menu's own search field, keyboard and filtering (the same match the package uses) serve a searchable menu.
    return <DropdownMenu open={input.open} onOpenChange={open => { if (!open) input.onRequestClose(); }}
        trigger={null} items={items} search={menu.search !== undefined} searchControl={menu.search} matchTriggerWidth={input.width === 'anchor'}
        placement={input.placement} popoverAnchorRef={input.anchorRef} popoverFocusReturnRef={input.focusReturnRef}
        popoverFollowScrollRef={input.followScrollRef} popoverAccessibilityLabel={input.sheet?.title ?? menu.accessibilityLabel}
        popoverSheetHeader={input.sheet?.header} popoverSheetFooter={input.sheet?.footer}
        {...(input.sheet ? { popoverPhonePresentation: 'sheet' as const } : {})}
        showCategoryTitles={menu.showGroupLabels}
        onSelect={id => {
            const item = allItems.find(item => item.id === id);
            if (item?.action) {
                if (controls) {
                    const signal = menu.getPreparationSignal?.();
                    void controls.commit(item.action, id, signal === undefined ? undefined : { signal });
                }
                return;
            }
            menu.onSelect(id, { anchorRef: input.anchorRef });
        }} />;
}
