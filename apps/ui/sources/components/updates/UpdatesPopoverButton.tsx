import * as React from 'react';
import { Platform, Pressable, View } from 'react-native';
import { useRouter } from 'expo-router';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { ActivitySpinner, iconMatchedSpinnerSize } from '@/components/ui/feedback/ActivitySpinner';
import { Icon, ICON_SIZE, type IconName } from '@/components/ui/icons/Icon';
import { PressableSurface } from '@/components/ui/interaction/PressableSurface';
import { TabBadge } from '@/components/ui/navigation/tabBadge/TabBadge';
import { FloatingOverlay } from '@/components/ui/overlays/FloatingOverlay';
import { Popover } from '@/components/ui/popover';
import { StatusPill } from '@/components/ui/status/StatusPill';
import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import { t } from '@/text';
import type { UpdatesSummary } from '@/updates/items/buildUpdatesSummary';
import { useUpdatesContentModel } from '@/updates/useUpdatesContentModel';
import { useSharedUpdatesSummary } from '@/updates/useUpdatesSummary';

import { UpdatesContent } from './UpdatesContent';
import { UPDATES_ROUTE } from './updatesRoute';


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
            <Pressable
                testID="updates.open_full"
                accessibilityRole="button"
                accessibilityLabel={t('updates.action.openUpdates')}
                onPress={openScreen}
                style={({ pressed }) => [styles.openButton, pressed ? styles.openButtonPressed : null]}
            >
                <Text style={styles.openText}>{t('updates.action.openUpdates')}</Text>
                <Icon name="arrow-square-out" size={ICON_SIZE.sm} color={theme.colors.text.primary} />
            </Pressable>
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
 * open popover. `icon` is the compact mark with a count that sits among the chrome's other icons (the
 * desktop top rail, the sidebar icon row, the collapsed rail, the signed-out desktop shell), tinted
 * warning when something failed and accent otherwise; the sentence is its accessible name and hover
 * tooltip. `header` is the phone Home header's entry and pushes Settings › Updates instead of opening
 * a popover. Hidden when there is nothing to act on.
 */
export const UpdatesPopoverButton = React.memo(function UpdatesPopoverButton(props: Readonly<{
    summary: UpdatesSummary;
    variant: 'icon' | 'header';
    buttonSize?: number;
    iconSize?: number;
    testID?: string;
}>) {
    const { theme } = useUnistyles();
    const router = useRouter();
    const anchorRef = React.useRef<View>(null);
    const [open, setOpen] = React.useState(false);
    const [webAnchorRect, setWebAnchorRect] = React.useState<WebRect | null>(null);
    const close = React.useCallback(() => setOpen(false), []);
    const copy = describeUpdatesEntry(props.summary);
    if (!copy && !open) return null;

    const onPress = (event: unknown) => {
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
    const accessibilityLabel = copy?.a11y ?? t('updates.title');
    const trigger = props.variant === 'icon' ? (
        <PressableSurface
            testID={props.testID ?? `updates.entry.${props.variant}`}
            accessibilityRole="button"
            accessibilityLabel={accessibilityLabel}
            accessibilityState={{ expanded: open }}
            webTooltip={accessibilityLabel}
            tooltipPlacement="bottom"
            hitSlop={8}
            focusRingRadius={buttonSize / 2}
            onPress={onPress}
            style={[styles.railButton, { width: buttonSize, height: buttonSize, borderRadius: buttonSize / 2 }]}
        >
            <View style={styles.railGlyph}>
                {mark(props.iconSize ?? ICON_SIZE.sm, copy?.warning ? theme.colors.state.warning.foreground : theme.colors.state.info.foreground)}
                {copy?.count ? (
                    <TabBadge variant="count" tone={copy.warning ? 'alert' : 'neutral'} value={copy.count} style={styles.railBadge} />
                ) : null}
            </View>
        </PressableSurface>
    ) : (
        <PressableSurface
            testID={props.testID ?? `updates.entry.${props.variant}`}
            accessibilityRole="button"
            accessibilityLabel={accessibilityLabel}
            accessibilityState={{ expanded: open }}
            hitSlop={Platform.select({ web: 6, default: 12 })}
            focusRingRadius={10}
            onPress={onPress}
            style={styles.pillPressable}
        >
            <StatusPill
                variant={copy?.warning ? 'warning' : 'neutral'}
                labelVariant="phrase"
                leading={mark(ICON_SIZE.xs, copy?.warning ? theme.colors.state.warning.onTint : theme.colors.state.neutral.onTint)}
                count={copy?.count}
                // The phone header keeps the mark and the count; the words only when there is no count.
                label={copy?.count ? '' : (copy?.label ?? '')}
                accessibilityLabel={copy?.a11y}
                labelNumberOfLines={1}
            />
        </PressableSurface>
    );

    return (
        <View ref={anchorRef} collapsable={false} style={styles.anchor}>
            {trigger}
            {open ? (
                <Popover
                    open
                    anchorRef={anchorRef}
                    anchor={webAnchorRect ? { kind: 'rect', rect: webAnchorRect, coordinateSpace: 'window' } : undefined}
                    boundaryRef={null}
                    placement="bottom"
                    edgePadding={{ horizontal: 12, vertical: 12 }}
                    portal={{ web: { target: 'body' }, native: true, matchAnchorWidth: false, anchorAlign: 'end' }}
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
                            containerStyle={{ width: Math.min(maxWidth, 400) }}
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
    railButton: {
        alignItems: 'center',
        justifyContent: 'center',
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
    openButton: {
        minHeight: 48,
        paddingHorizontal: 16,
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'space-between',
        borderTopWidth: 1,
        borderTopColor: theme.colors.border.default,
    },
    openButtonPressed: {
        opacity: 0.72,
    },
    openText: {
        fontSize: 14,
        color: theme.colors.text.primary,
        ...Typography.default('semiBold'),
    },
}));

/** Chrome mount point: reads the summary itself, so hosts pass no update plumbing. */
export const UpdatesEntry = React.memo(function UpdatesEntry(props: Readonly<{
    variant: 'icon' | 'header';
    buttonSize?: number;
    iconSize?: number;
    testID?: string;
}>) {
    const summary = useSharedUpdatesSummary();
    return <UpdatesPopoverButton summary={summary} {...props} />;
});
