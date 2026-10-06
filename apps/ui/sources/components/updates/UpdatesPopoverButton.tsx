import * as React from 'react';
import { Platform, Pressable, View } from 'react-native';
import { useRouter } from 'expo-router';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { ActivitySpinner, iconMatchedSpinnerSize } from '@/components/ui/feedback/ActivitySpinner';
import { Icon, ICON_SIZE, type IconName } from '@/components/ui/icons/Icon';
import { TabBadge } from '@/components/ui/navigation/tabBadge/TabBadge';
import { DeferredAnchoredTooltip } from '@/components/ui/overlays/DeferredAnchoredTooltip';
import { ActionListSection } from '@/components/ui/lists/ActionListSection';
import { FloatingOverlay } from '@/components/ui/overlays/FloatingOverlay';
import { Popover } from '@/components/ui/popover';
import { StatusPill } from '@/components/ui/status/StatusPill';
import { t } from '@/text';
import type { UpdatesSummary } from '@/updates/items/buildUpdatesSummary';
import { useUpdatesContentModel } from '@/updates/useUpdatesContentModel';
import { useSharedUpdatesSummary } from '@/updates/useUpdatesSummary';

import { UpdatesContent } from './UpdatesContent';
import { UPDATES_ROUTE } from './updatesRoute';


/** The popover's width: one row per machine (name, one status line, one action), like the account popover. */
const UPDATES_POPOVER_WIDTH = 320;

type PillCopy = Readonly<{ icon: IconName | 'spinner'; label: string; count?: number; a11y: string; warning: boolean }>;

/** The one mapping from the summary to the entry's mark, words and accessible name. */
export function describeUpdatesEntry(summary: UpdatesSummary): PillCopy | null {
    switch (summary.phase) {
        case 'none':
            return null;
        case 'required':
            return { icon: 'warning-circle', label: t('updates.pill.required'), a11y: t('updates.a11y.pillRequired'), warning: true };
        case 'running':
            return { icon: 'spinner', label: t('updates.pill.running'), a11y: t('updates.a11y.pillRunning'), warning: false };
        case 'failed':
            return {
                icon: 'warning-circle',
                label: t('updates.pill.failed'),
                count: summary.failedCount,
                a11y: t('updates.a11y.pillFailed'),
                warning: true,
            };
        case 'ready':
            return { icon: 'arrows-clockwise', label: t('updates.pill.ready'), a11y: t('updates.a11y.pillReady'), warning: false };
        case 'completed':
            return { icon: 'check', label: t('updates.pill.completed'), a11y: t('updates.a11y.pillCompleted'), warning: false };
        case 'available':
            return {
                icon: 'hard-drive-download',
                label: t('updates.pill.updates', { count: summary.actionableCount }),
                count: summary.actionableCount,
                a11y: t('updates.a11y.pillAvailable', { count: summary.actionableCount }),
                warning: false,
            };
    }
}

/** Mounted only while the popover is open: the detail model never runs behind a closed pill. */
const UpdatesPopoverContent = React.memo(function UpdatesPopoverContent(props: Readonly<{ close: () => void }>) {
    const { theme } = useUnistyles();
    const router = useRouter();
    const model = useUpdatesContentModel();
    const openScreen = React.useCallback(() => {
        props.close();
        router.push(UPDATES_ROUTE);
    }, [props, router]);
    return (
        <>
            <UpdatesContent model={model} presentation="popover" />
            {/* The footer link to the full list, a menu row like the rest of the popover. */}
            <ActionListSection
                separatorAbove
                actions={[{
                    id: 'open-updates',
                    testID: 'updates.open_full',
                    label: t('updates.action.openUpdates'),
                    icon: <Icon name="arrow-square-out" size={ICON_SIZE.sm} color={theme.colors.text.secondary} />,
                    onPress: openScreen,
                }]}
            />
        </>
    );
});

type WebRect = Readonly<{ left: number; top: number; width: number; height: number }>;

function readWebRect(event: unknown): WebRect | null {
    if (Platform.OS !== 'web') return null;
    const target = (event as { currentTarget?: { getBoundingClientRect?: () => WebRect } } | undefined)?.currentTarget;
    return target?.getBoundingClientRect?.() ?? null;
}

/**
 * The Updates entry in chrome. It reads only the stable summary; the detail model mounts inside the
 * open popover. `pill` sits after the sidebar title (and in the signed-out desktop shell) and `rail`
 * in the collapsed sidebar: both are the same compact mark with a count, tinted warning when
 * something failed and accent otherwise; the sentence is their accessible name and hover tooltip.
 * `header` is the phone Home header's entry and pushes Settings › Updates instead of opening a
 * popover. `footer` is the sidebar footer's icon: the same mark in the footer's quiet icon colour
 * (warning stays tinted), opening upwards. Hidden when there is nothing to act on.
 */
export const UpdatesPopoverButton = React.memo(function UpdatesPopoverButton(props: Readonly<{
    summary: UpdatesSummary;
    variant: 'pill' | 'rail' | 'header' | 'footer';
    buttonSize?: number;
    /** The mark's size where a host sizes its icons as one (the app rail); else the compact mark. */
    markSize?: number;
    /** Where the host draws the count itself (the app rail's one badge owner), the mark carries none. */
    hostDrawsCount?: boolean;
    testID?: string;
    /** A rail item in More keeps this popover owner and supplies the menu-row trigger. */
    renderTrigger?: (state: Readonly<{ onPress: (event?: unknown) => void; open: boolean; accessibilityLabel: string }>) => React.ReactNode;
}>) {
    const { theme } = useUnistyles();
    const router = useRouter();
    const anchorRef = React.useRef<View>(null);
    const [open, setOpen] = React.useState(false);
    const markRef = React.useRef<View>(null);
    const [hovered, setHovered] = React.useState(false);
    const [focused, setFocused] = React.useState(false);
    const [webAnchorRect, setWebAnchorRect] = React.useState<WebRect | null>(null);
    const close = React.useCallback(() => setOpen(false), []);
    const copy = describeUpdatesEntry(props.summary);
    if (!copy && !open) return null;

    const onPress = (event?: unknown) => {
        if (props.variant === 'header') {
            router.push(UPDATES_ROUTE);
            return;
        }
        if (!open) setWebAnchorRect(readWebRect(event));
        setOpen((current) => !current);
    };

    const mark = (size: number, color: string) => copy?.icon === 'spinner'
        ? <ActivitySpinner size={iconMatchedSpinnerSize(size)} color={color} />
        : <Icon name={(copy?.icon ?? 'hard-drive-download') as IconName} size={size} color={color} />;

    const buttonSize = props.buttonSize ?? 28;
    const opensUpward = props.variant === 'footer';
    const markColor = copy?.warning
        ? theme.colors.state.warning.foreground
        : props.variant === 'footer' ? theme.colors.text.secondary : theme.colors.state.info.foreground;
    const trigger = props.variant !== 'header' ? (
        <Pressable
            ref={markRef}
            testID={props.testID ?? `updates.entry.${props.variant}`}
            accessibilityRole="button"
            accessibilityLabel={copy?.a11y ?? t('updates.title')}
            accessibilityState={{ expanded: open }}
            hitSlop={8}
            onPress={onPress}
            onHoverIn={() => setHovered(true)}
            onHoverOut={() => setHovered(false)}
            onFocus={() => setFocused(true)}
            onBlur={() => setFocused(false)}
            style={[
                styles.railButton,
                { width: buttonSize, height: buttonSize, borderRadius: buttonSize / 2 },
                // The footer's neighbours are plain icon buttons that fill on hover and while open.
                opensUpward && (hovered || open) ? styles.footerButtonActive : null,
            ]}
        >
            <View style={styles.railGlyph}>
                {mark(props.markSize ?? ICON_SIZE.sm, markColor)}
                {copy?.count && !props.hostDrawsCount ? (
                    <TabBadge variant="count" tone={copy.warning ? 'alert' : 'neutral'} value={copy.count} style={styles.railBadge} />
                ) : null}
            </View>
            {/* The sentence the mark stands for, on hover or keyboard focus (web). */}
            {Platform.OS === 'web' && copy && !open && (hovered || focused) ? (
                <DeferredAnchoredTooltip
                    activationKey={`${hovered}:${focused}`}
                    anchorRef={markRef}
                    placement={opensUpward ? 'top' : 'bottom'}
                    label={copy.label}
                    testID={`${props.testID ?? `updates.entry.${props.variant}`}-tooltip`}
                />
            ) : null}
        </Pressable>
    ) : (
        <Pressable
            testID={props.testID ?? `updates.entry.${props.variant}`}
            accessibilityRole="button"
            accessibilityLabel={copy?.a11y ?? t('updates.title')}
            accessibilityState={{ expanded: open }}
            hitSlop={Platform.select({ web: 6, default: 12 })}
            onPress={onPress}
            style={({ pressed }) => [styles.pillPressable, pressed ? styles.pillPressed : null]}
        >
            <StatusPill
                variant={copy?.warning ? 'warning' : 'neutral'}
                labelVariant="phrase"
                leading={mark(ICON_SIZE.xs, copy?.warning ? theme.colors.state.warning.foreground : theme.colors.state.neutral.foreground)}
                count={copy?.count}
                // The phone header keeps the mark and the count; the words only when there is no count.
                label={copy?.count ? '' : (copy?.label ?? '')}
                accessibilityLabel={copy?.a11y}
                labelNumberOfLines={1}
            />
        </Pressable>
    );

    return (
        <View ref={anchorRef} collapsable={false} style={styles.anchor}>
            {props.renderTrigger ? props.renderTrigger({ onPress, open, accessibilityLabel: copy?.a11y ?? t('updates.title') }) : trigger}
            {open ? (
                <Popover
                    open
                    anchorRef={anchorRef}
                    anchor={webAnchorRect ? { kind: 'rect', rect: webAnchorRect, coordinateSpace: 'window' } : undefined}
                    boundaryRef={null}
                    placement={opensUpward ? 'top' : 'bottom'}
                    edgePadding={{ horizontal: 12, vertical: 12 }}
                    portal={{ web: { target: 'body' }, native: true, matchAnchorWidth: false, anchorAlign: props.variant === 'rail' ? 'end' : 'start' }}
                    maxWidthCap={420}
                    maxHeightCap={560}
                    onRequestClose={close}
                >
                    {({ maxHeight, maxWidth }) => (
                        <FloatingOverlay
                            maxHeight={Math.min(maxHeight, 560)}
                            edgeFades={{ top: true, bottom: true, size: 18 }}
                            edgeIndicators
                            surfaceChrome="theme"
                            containerStyle={{ width: Math.min(maxWidth, UPDATES_POPOVER_WIDTH) }}
                        >
                            <UpdatesPopoverContent close={close} />
                        </FloatingOverlay>
                    )}
                </Popover>
            ) : null}
        </View>
    );
});

const styles = StyleSheet.create((theme) => ({
    anchor: {
        alignItems: 'center',
        justifyContent: 'center',
        flexShrink: 0,
    },
    pillPressable: {
        borderRadius: 8,
    },
    pillPressed: {
        opacity: 0.72,
    },
    railButton: {
        alignItems: 'center',
        justifyContent: 'center',
    },
    footerButtonActive: {
        backgroundColor: theme.colors.surface.selected,
    },
    railGlyph: {
        position: 'relative',
        alignItems: 'center',
        justifyContent: 'center',
    },
    railBadge: {
        position: 'absolute',
        top: -6,
        right: -9,
    },
}));

/** Chrome mount point: reads the summary itself, so hosts pass no update plumbing. */
export const UpdatesEntry = React.memo(function UpdatesEntry(props: Readonly<{
    variant: 'pill' | 'rail' | 'header' | 'footer';
    buttonSize?: number;
    testID?: string;
}>) {
    const summary = useSharedUpdatesSummary();
    return <UpdatesPopoverButton summary={summary} {...props} />;
});
