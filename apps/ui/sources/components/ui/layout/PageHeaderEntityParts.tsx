import * as React from 'react';
import { Platform, View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { DropdownMenu, type DropdownMenuItem } from '@/components/ui/forms/dropdown/DropdownMenu';
import { Switch } from '@/components/ui/forms/Switch';
import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import { ActivitySpinner } from '@/components/ui/feedback/ActivitySpinner';
import { IconButton } from '@/components/ui/buttons/IconButton';
import { t } from '@/text';
import type { PopoverAnchor } from '@/components/ui/popover/_types';

/** The gap between a header's action controls: their finger frames split it, so neighbours never overlap. */
export const HEADER_ACTIONS_GAP_PX = 8;

export type PageHeaderMenuIntent = Readonly<{
    altKey?: boolean;
    /** The menu's ⋯: an operation that opens a surface (Share…) hangs it from the control the menu came from. */
    anchor?: PopoverAnchor;
}>;

/** One rare operation in an entity page's `⋯` menu. */
export type PageHeaderMenuAction = Readonly<{
    id: string;
    title: string;
    testID?: string;
    disabled?: boolean;
    /** An irreversible operation (delete, clear history): shown in the danger tone. */
    destructive?: boolean;
    /** The operation is running: the row shows progress and cannot be chosen again. */
    loading?: boolean;
    /** A policy the menu toggles ("Link new sessions automatically"): shows its current state as a check. */
    checked?: boolean;
    /** `altKey`: the row was chosen with Alt / Option held (desktop), for rows whose alternate does more. */
    onSelect: (intent?: PageHeaderMenuIntent) => void | Promise<void>;
    /** The row's title while Alt / Option is held on desktop ("Copy absolute path"): the alternate is visible, not hidden. */
    alternateTitle?: string;
    /** A chooser one level in ("Move to folder" → its folders): the row opens these instead of selecting itself. */
    children?: readonly PageHeaderMenuAction[];
    /** Why a disabled row can't run now ("MacBook Pro isn't answering"), under its title. */
    subtitle?: string;
    /** Rows of one kind sit together; the menu draws a divider between kinds. */
    category?: string;
}>;

/**
 * An entity page's `⋯` menu of rare operations, placed in `PageHeader` `actions`. `testID` names the
 * menu; its trigger is `<testID>.trigger`.
 */
export const PageHeaderMenu = React.memo(function PageHeaderMenu(props: Readonly<{
    actions: readonly PageHeaderMenuAction[];
    /** Page context controls folded into the same overflow on a phone. */
    content?: React.ReactNode;
    testID?: string;
    /** Overrides the trigger's test id (kept for pages with an established one). */
    triggerTestID?: string;
    /** Names what the menu acts on when one page holds many (a row's "Model 0, More actions"). */
    accessibilityLabel?: string;
    /**
     * Settings search asked the page for one of this menu's entries: the menu opens so the entry is in
     * view. The page wraps the menu in that setting's `SettingAnchor`, which marks the trigger.
     */
    openRequested?: boolean;
    /** Observes the menu lifetime, for operations that demand resources only while it is open. */
    onOpenChange?: (open: boolean) => void;
    /** The gap to the neighbouring header action, when one sits beside it: their finger frames split it. */
    interactiveTargetGapPx?: number;
}>) {
    const { theme } = useUnistyles();
    const [open, setOpen] = React.useState(props.openRequested === true);
    const content = props.content;
    const hasAlternates = props.actions.some((action) => action.alternateTitle !== undefined);
    const altHeld = useAltHeldWhileOpen(open && hasAlternates);
    React.useEffect(() => {
        if (props.openRequested) setOpen(true);
    }, [props.openRequested]);
    const onOpenChange = props.onOpenChange;
    React.useEffect(() => {
        onOpenChange?.(open);
    }, [onOpenChange, open]);
    const toItem = React.useCallback((action: PageHeaderMenuAction): DropdownMenuItem => ({
        id: action.id,
        title: altHeld && action.alternateTitle !== undefined ? action.alternateTitle : action.title,
        ...(action.testID ? { testID: action.testID } : {}),
        ...(action.disabled || action.loading ? { disabled: true } : {}),
        ...(action.destructive ? { destructive: true } : {}),
        ...(action.subtitle ? { subtitle: action.subtitle } : {}),
        ...(action.category ? { category: action.category } : {}),
        ...(action.checked === undefined ? {} : { checked: action.checked }),
        // The menu draws the check of a checked row.
        ...(action.loading
            ? { rightElement: <ActivitySpinner size="small" color={theme.colors.text.secondary} /> }
            : {}),
        ...(action.children && action.children.length > 0
            ? { submenu: { items: action.children.map((child) => toItem(child)), showCategoryTitles: false } }
            : {}),
    }), [altHeld, theme.colors.text.secondary]);
    const items = React.useMemo(() => props.actions.map(toItem), [props.actions, toItem]);
    return (
        <DropdownMenu
            testID={props.testID}
            open={open}
            onOpenChange={setOpen}
            items={items}
            // Operations, not a choice: nothing reads as picked when the menu opens (DESIGN-9 N46).
            // Arrow keys still move to the first row.
            allowEmptySelection
            header={content ? <View style={stylesheet.menuContent}>{content}</View> : undefined}
            emptyLabel={content ? null : undefined}
            onSelect={(id, selection) => {
                setOpen(false);
                return props.actions.flatMap((action) => [action, ...(action.children ?? [])])
                    .find((action) => action.id === id)?.onSelect({ ...(altHeld ? { altKey: true } : {}), ...(selection ? { anchor: selection.anchor } : {}) });
            }}
            placement="bottom"
            popoverAnchorAlign="end"
            variant="slim"
            matchTriggerWidth={false}
            // Room for a checked row's title beside its check ("Don't pause this Discussion ✓") without truncating.
            maxWidthCap={280}
            showCategoryTitles={false}
            // Grouped operations read as groups: a hairline between categories, never a heading.
            separateCategories={new Set(props.actions.map((action) => action.category)).size > 1}
            popoverPortalWebTarget="body"
            trigger={({ toggle }) => (
                <IconButton
                    testID={props.triggerTestID ?? (props.testID ? `${props.testID}.trigger` : undefined)}
                    onPress={toggle}
                    accessibilityLabel={props.accessibilityLabel ?? t('common.moreActions')}
                    iconName="dots-three"
                    iconSize={18}
                    size={32}
                    variant="plain"
                    interactiveTargetGapPx={props.interactiveTargetGapPx}
                    expanded={open}
                    hasPopup="menu"
                />
            )}
        />
    );
});

/**
 * Whether Alt / Option is held while a menu with alternates is open (web and desktop only), so the menu shows
 * and runs the alternate for keyboard and pointer choices alike, as desktop menus do.
 */
function useAltHeldWhileOpen(active: boolean): boolean {
    const [held, setHeld] = React.useState(false);
    React.useEffect(() => {
        if (!active || Platform.OS !== 'web' || typeof window === 'undefined') { setHeld(false); return; }
        // Pointer events carry the modifier too, so Alt held from before the menu opened counts on the next move.
        const update = (event: KeyboardEvent | PointerEvent) => setHeld(event.altKey);
        const release = () => setHeld(false);
        const events = ['keydown', 'keyup', 'pointermove', 'pointerdown'] as const;
        for (const name of events) window.addEventListener(name, update, true);
        window.addEventListener('blur', release);
        return () => {
            for (const name of events) window.removeEventListener(name, update, true);
            window.removeEventListener('blur', release);
        };
    }, [active]);
    return held;
}

/**
 * An entity page's one state control ("Enabled"), placed in `PageHeader` `actions` beside the `⋯` menu:
 * a quiet label and the switch it names.
 */
export const PageHeaderStateSwitch = React.memo(function PageHeaderStateSwitch(props: Readonly<{
    label: string;
    value: boolean | undefined;
    onValueChange: (next: boolean) => void;
    disabled?: boolean;
    /**
     * A change is being saved: the switch keeps its place and value, cannot be flipped again, and
     * announces itself busy (no spinner swapped in, so the header does not move).
     */
    busy?: boolean;
    /** Test id of the switch; the label and switch together are `<testID>.control`. */
    testID?: string;
    /** Names the switch; defaults to the label. */
    accessibilityLabel?: string;
    accessibilityHint?: string;
}>) {
    return (
        <View testID={props.testID ? `${props.testID}.control` : undefined} style={stylesheet.stateSwitch}>
            <Text style={stylesheet.stateSwitchLabel}>{props.label}</Text>
            <Switch
                testID={props.testID}
                value={props.value}
                disabled={props.disabled === true || props.busy === true}
                onValueChange={props.onValueChange}
                accessibilityLabel={props.accessibilityLabel ?? props.label}
                accessibilityHint={props.accessibilityHint}
                accessibilityState={props.busy === undefined ? undefined : {
                    disabled: props.disabled === true || props.busy === true,
                    busy: props.busy,
                }}
            />
        </View>
    );
});

const stylesheet = StyleSheet.create((theme) => ({
    menuContent: {
        padding: theme.space.s12,
        gap: theme.space.s8,
    },
    stateSwitch: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: theme.space.s8,
    },
    // The header's meta line type (`PageHeader` `metaText`): quiet, beside the control it names.
    stateSwitchLabel: {

        ...Typography.variant('body'),

        color: theme.colors.text.secondary,
    },
}));
