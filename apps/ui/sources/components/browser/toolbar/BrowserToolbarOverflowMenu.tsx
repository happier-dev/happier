import * as React from 'react';
import { View } from 'react-native';
import { useUnistyles } from 'react-native-unistyles';

import { IconButton } from '@/components/ui/buttons/IconButton';
import { Icon, ICON_SIZE, type IconName } from '@/components/ui/icons/Icon';
import { ActionListSection } from '@/components/ui/lists/ActionListSection';
import { FloatingOverlay } from '@/components/ui/overlays/FloatingOverlay';
import { MODAL_AWARE_FLOATING_POPOVER_PORTAL_OPTIONS, Popover } from '@/components/ui/popover';
import { t } from '@/text';

import { BROWSER_CHROME_WIDTH } from '../browserChromeDensity';

/**
 * The trigger sits on the chrome's trailing edge, so the menu hangs from that edge and grows inward:
 * left-aligned it would spill over whatever sits beside the pane.
 */
const TRAILING_EDGE_PORTAL = { ...MODAL_AWARE_FLOATING_POPOVER_PORTAL_OPTIONS, anchorAlign: 'end' } as const;

export type BrowserToolbarOverflowItem = Readonly<{
    id: string;
    iconName: IconName;
    label: string;
    subtitle?: string;
    onPress: () => void;
    /** The item is the applied value of a choice (a page size): menus mark it checked. */
    selected?: boolean;
    /** A labelled set of choices drawn as its own section after the ungrouped tools. */
    group?: Readonly<{ id: string; title: string }>;
    disabled?: boolean;
    disabledReason?: string | null;
    /** A destructive one-shot (discard a recording): drawn in the menu's destructive tone. */
    destructive?: boolean;
}>;

/**
 * The browser chrome's `⋯`: rare one-shot tools (Record, Open in your browser, Devtools, plugin
 * actions). It is the canonical icon-button + popover + menu-row composition — `IconButton` as the
 * trigger, `ActionListSection` rows (`SelectableRow presentation="menu"`) inside `FloatingOverlay`
 * — so the rows, highlight, focus and disabled treatment are the app's, not a local copy. A
 * disabled row keeps its reason on its second line: greyed out with no explanation reads as broken.
 */
export function BrowserToolbarOverflowMenu(props: Readonly<{
    items: readonly BrowserToolbarOverflowItem[];
    onOpenChange?: (open: boolean) => void;
    testID: string;
    /** Visible trigger size and glyph; the dense chrome row by default. */
    size?: number;
    iconSize?: number;
    /** The bar spreads its controls: the trigger's hit area then has the free space around it, not a packed 4 px gap. */
    spread?: boolean;
    /** The phone's bottom bar opens the menu upward, toward the page. */
    placement?: 'top' | 'bottom';
}>): React.ReactElement | null {
    const { theme } = useUnistyles();
    const [open, setOpen] = React.useState(false);
    const onOpenChange = React.useCallback((next: boolean) => {
        setOpen(next);
        props.onOpenChange?.(next);
    }, [props.onOpenChange]);
    const anchorRef = React.useRef<View>(null);

    if (props.items.length === 0) {
        return null;
    }
    // Ungrouped tools first, then each labelled set of choices as its own section, in item order.
    const sections: { id: string; title?: string; items: BrowserToolbarOverflowItem[] }[] = [];
    for (const item of props.items) {
        const id = item.group?.id ?? '';
        let section = sections.find((candidate) => candidate.id === id);
        if (!section) {
            section = { id, ...(item.group ? { title: item.group.title } : {}), items: [] };
            sections.push(section);
        }
        section.items.push(item);
    }

    return (
        <>
            <View ref={anchorRef} collapsable={false}>
                <IconButton
                    testID={props.testID}
                    iconName="dots-three"
                    variant="plain"
                    iconSize={props.iconSize ?? ICON_SIZE.sm}
                    accessibilityLabel={t('browserShell.overflow.open')}
                    tooltip={t('browserShell.overflow.open')}
                    tooltipHidden={open}
                    expanded={open}
                    hasPopup="menu"
                    size={props.size ?? 34}
                    interactiveTargetGapPx={props.spread ? undefined : 4}
                    onPress={() => onOpenChange(!open)}
                />
            </View>
            {open ? (
                <Popover
                    open={open}
                    anchorRef={anchorRef}
                    placement={props.placement ?? 'bottom'}
                    gap={6}
                    maxHeightCap={420}
                    maxWidthCap={BROWSER_CHROME_WIDTH.panel}
                    onRequestClose={() => onOpenChange(false)}
                    backdrop={{ enabled: false }}
                    portal={TRAILING_EDGE_PORTAL}
                >
                    {({ maxHeight }) => (
                        <FloatingOverlay maxHeight={maxHeight} surfaceChrome="theme">
                            <View testID={`${props.testID}-panel`}>
                                {sections.map((section, index) => (
                                    <ActionListSection
                                        key={section.id}
                                        title={section.title}
                                        separatorAbove={index > 0}
                                        actions={section.items.map((item) => ({
                                            id: item.id,
                                            testID: `${props.testID}-item-${item.id}`,
                                            label: item.label,
                                            subtitle: item.disabled === true && item.disabledReason ? item.disabledReason : item.subtitle,
                                            disabled: item.disabled === true,
                                            destructive: item.destructive === true,
                                            selected: item.selected,
                                            icon: (
                                                <Icon
                                                    name={item.iconName}
                                                    size={ICON_SIZE.sm}
                                                    color={item.destructive
                                                        ? theme.colors.state.danger.foreground
                                                        : theme.colors.text.secondary}
                                                />
                                            ),
                                            onPress: () => {
                                                if (item.disabled === true) return;
                                                onOpenChange(false);
                                                item.onPress();
                                            },
                                        }))}
                                    />
                                ))}
                            </View>
                        </FloatingOverlay>
                    )}
                </Popover>
            ) : null}
        </>
    );
}
