import * as React from 'react';
import { Platform, Pressable, View, type LayoutChangeEvent } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { Typography } from '@/constants/Typography';
import { shadowLevelStyle } from '@/shadowElevation';
import { resolveThemeSurfaceChromeStyle } from '@/components/ui/surfaces/resolveThemeHairlineBorderStyle';
import { Icon } from '@/components/ui/icons/Icon';
import { Text } from '@/components/ui/text/Text';
import { Popover } from '@/components/ui/popover/Popover';
import { MODAL_AWARE_FLOATING_POPOVER_PORTAL_OPTIONS } from '@/components/ui/popover/modalAwareFloatingPopoverPortalOptions';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { MachineResourcesGauge } from '@/components/machines/resources/MachineResourcesGauge';
import {
    formatMachineResourcesByteRange,
    formatMachineResourcesByteRangeCompact,
} from '@/components/machines/resources/machineResourcesFormatting';
import {
    resolveMachineResourcesMetricAlerts,
    resolveMachineResourcesMetricTone,
    resolveMachineResourcesTone,
    resolveMachineResourcesPresenceTint,
    type MachineResourcesMetricAlert,
} from '@/components/machines/resources/machineResourcesTone';
import { getMachineAvatarInitial } from '@/components/machines/resources/machineAvatarInitial';
import {
    MACHINE_STRIP_ROW_HORIZONTAL_PADDING_PX,
    resolveMachineStripMode,
    type MachineStripMode,
} from '@/components/machines/resources/resolveMachineStripMode';
import { useMachineResourcesPolling } from '@/components/machines/resources/useMachineResourcesPolling';
import { renameMachineWithPrompt } from '@/components/machines/renameMachineWithPrompt';
import { fireAndForget } from '@/utils/system/fireAndForget';
import { useFeatureEnabled } from '@/hooks/server/useFeatureEnabled';
import { useAllMachines } from '@/sync/domains/state/storage';
import { useMachineResourcesState } from '@/sync/domains/machines/resources/useMachineResourcesState';
import type { Machine } from '@/sync/domains/state/storageTypes';
import { getMachineDisplayName, isMachineOnline } from '@/utils/sessions/machineUtils';
import { t } from '@/text';

/** Grace period before a hover exit closes the popover: enough for the pointer to cross from
 * the chip onto the popover itself, so the rename control stays reachable. */
const POPOVER_HOVER_CLOSE_DELAY_MS = 260;

/** Industry-standard glyphs for the metric alert badges on the chip's corner. */
const METRIC_ALERT_ICONS: Readonly<Record<MachineResourcesMetricAlert['metric'], React.ComponentProps<typeof Icon>['name']>> = {
    cpu: 'cpu',
    memory: 'memory',
    disk: 'hard-drives',
};

// Web-only DOM hover events on a plain View — the same narrow boundary cast the chip-picker
// option rows use; native never renders these handlers.
type PopoverSurfaceViewProps = React.ComponentPropsWithRef<typeof View> & {
    onMouseEnter?: () => void;
    onMouseLeave?: () => void;
};
const PopoverSurfaceView = View as unknown as React.ComponentType<PopoverSurfaceViewProps>;

const stylesheet = StyleSheet.create((theme) => ({
    group: {
        marginTop: -4,
    },
    row: {
        width: '100%',
        flexDirection: 'row',
        flexWrap: 'wrap',
        alignItems: 'center',
        gap: 6,
        paddingHorizontal: MACHINE_STRIP_ROW_HORIZONTAL_PADDING_PX,
        paddingVertical: 3,
    },
    /** Comfort/compact rows spread their chips evenly across the strip; the single-machine
     * inline form keeps left alignment so its metrics can fill the remainder. */
    rowSpread: {
        justifyContent: 'space-evenly',
    },
    comfortChip: {
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'center',
        // Equal-width chips that always fill the row: short aliases get roomy thirds instead
        // of a left-packed cluster, long ones ellipsize inside their share.
        flexGrow: 1,
        flexBasis: 0,
        gap: 4,
        paddingHorizontal: 6,
        paddingVertical: 3,
        borderRadius: 12,
        borderWidth: 1,
    },
    compactChip: {
        alignItems: 'center',
    },
    inlineChip: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 8,
        flexGrow: 1,
        minWidth: 0,
    },
    glyph: {
        alignItems: 'center',
        justifyContent: 'center',
    },
    glyphLetter: {
        ...Typography.default('semiBold'),
        position: 'absolute',
        left: 0,
        right: 0,
        top: 4,
        textAlign: 'center',
    },
    /** Metric alerts ride the chip's top border: centered on the 1px line, on the straight
     * stretch just before the top-right corner curve begins, first offender nearest the corner.
     * Absolutely positioned, so they may overlap the strip's outer frame without ever
     * stretching it. */
    chipAlerts: {
        position: 'absolute',
        top: -6,
        right: 13,
        flexDirection: 'row-reverse',
        alignItems: 'center',
        gap: 2,
    },
    alias: {
        ...Typography.default(),
        fontSize: 12,
        lineHeight: 14,
        color: theme.colors.text.primary,
    },
    inlineAlias: {
        ...Typography.default('semiBold'),
        fontSize: 13,
        lineHeight: 15,
        color: theme.colors.text.primary,
    },
    inlineMetrics: {
        ...Typography.default(),
        flexShrink: 1,
        fontSize: 12,
        lineHeight: 14,
        color: theme.colors.text.secondary,
    },
    popoverSurface: {
        borderRadius: 12,
        overflow: 'hidden',
        backgroundColor: theme.colors.surface.base,
        ...(() => {
            const chrome = resolveThemeSurfaceChromeStyle({
                borderColor: theme.colors.border.surface,
                highlightColor: theme.colors.effect.surfaceHighlight,
                shadowStyle: shadowLevelStyle(theme.colors.shadowLevels[2]),
            });
            return {
                ...shadowLevelStyle(theme.colors.shadowLevels[2]),
                borderColor: chrome.borderColor,
                borderWidth: chrome.borderWidth,
                borderTopColor: chrome.borderTopColor,
                borderTopWidth: chrome.borderTopWidth,
            };
        })(),
    },
    popoverContent: {
        paddingTop: 12,
        paddingHorizontal: 14,
        paddingBottom: 10,
    },
    popoverHeader: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 8,
    },
    popoverTitle: {
        flexShrink: 1,
        fontSize: 13,
        lineHeight: 16,
        color: theme.colors.text.primary,
        ...Typography.default('semiBold'),
    },
    popoverGauges: {
        flexDirection: 'row',
        alignItems: 'flex-start',
        justifyContent: 'space-between',
        gap: 12,
        paddingTop: 10,
        paddingBottom: 8,
    },
    popoverSampledAt: {
        fontSize: 11,
        lineHeight: 13,
        color: theme.colors.text.tertiary,
    },
}));

function formatPercent(percent: number): string {
    return Number.isFinite(percent) ? `${Math.round(percent)}%` : '—';
}

function formatSampledAt(sampledAt: number): string {
    return new Date(sampledAt).toLocaleTimeString();
}

/**
 * One machine glyph: a monitor outline whose stroke carries the presence color and whose screen
 * carries the machine's initial — identity, status, and "this is a computer" in a single mark,
 * with no separate badge or dot to stack on top of it.
 */
function MachineGlyph(props: Readonly<{
    initial: string;
    size: number;
    strokeColor: string;
    letterColor: string;
    testID: string;
}>): React.ReactElement {
    const styles = stylesheet;
    const letterSize = Math.max(7, Math.round(props.size * 0.36));
    return (
        <View
            testID={props.testID}
            style={[styles.glyph, { width: props.size, height: props.size }]}
        >
            <Icon name="desktop" size={props.size} color={props.strokeColor} />
            <Text
                style={[styles.glyphLetter, { color: props.letterColor, fontSize: letterSize, lineHeight: letterSize }]}
                numberOfLines={1}
            >
                {props.initial}
            </Text>
        </View>
    );
}

const MachineResourcesChip = React.memo(function MachineResourcesChip(props: Readonly<{
    machine: Machine;
    mode: MachineStripMode;
    refresh: (machineId: string) => void;
    testID: string;
}>) {
    const { theme } = useUnistyles();
    const styles = stylesheet;
    const anchorRef = React.useRef<View>(null);
    const [isPinnedOpen, setIsPinnedOpen] = React.useState(false);
    const [isHovered, setIsHovered] = React.useState(false);
    const hoverCloseTimerRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);
    const open = isPinnedOpen || isHovered;
    const entry = useMachineResourcesState(props.machine.id);
    const snapshot = entry.snapshot;
    const online = isMachineOnline(props.machine);
    const tone = online ? resolveMachineResourcesTone(snapshot) : 'unknown';
    const metricAlerts = online ? resolveMachineResourcesMetricAlerts(snapshot) : [];
    // Quiet-normal calibration: the chip (glyph + alias) stays permanently neutral and the
    // corner alert badges carry every color signal, colored by each metric's own severity.
    const glyphStrokeColor = online ? theme.colors.text.secondary : theme.colors.status.disconnected;
    const displayName = getMachineDisplayName(props.machine) ?? props.machine.id;
    const avatarInitial = getMachineAvatarInitial(props.machine);
    const statusLabel = online ? t('status.online') : t('status.offline');
    const inlineMetrics = snapshot
        ? [
            `${t('machine.resources.cpu')} ${formatPercent(snapshot.cpu.usagePercent)}`,
            `${t('machine.resources.memory')} ${formatMachineResourcesByteRangeCompact(snapshot.memory.usedBytes, snapshot.memory.totalBytes)}`,
            `${t('machine.resources.disk')} ${formatPercent(snapshot.disk.usagePercent)}`,
        ].join(' · ')
        : [
            `${t('machine.resources.cpu')} —`,
            `${t('machine.resources.memory')} —`,
            `${t('machine.resources.disk')} —`,
        ].join(' · ');

    // Opening the detail popover forces one immediate sample so the gauges reflect "now",
    // independent of the 30s cadence.
    React.useEffect(() => {
        if (open) props.refresh(props.machine.id);
    }, [open, props.machine.id, props.refresh]);

    const cancelHoverClose = React.useCallback(() => {
        if (hoverCloseTimerRef.current !== null) {
            clearTimeout(hoverCloseTimerRef.current);
            hoverCloseTimerRef.current = null;
        }
    }, []);
    React.useEffect(() => cancelHoverClose, [cancelHoverClose]);

    const scheduleHoverClose = React.useCallback(() => {
        cancelHoverClose();
        hoverCloseTimerRef.current = setTimeout(() => {
            hoverCloseTimerRef.current = null;
            setIsHovered(false);
        }, POPOVER_HOVER_CLOSE_DELAY_MS);
    }, [cancelHoverClose]);

    const chipStyle = props.mode === 'inline-metrics'
        ? styles.inlineChip
        : props.mode === 'comfort'
            ? styles.comfortChip
            : styles.compactChip;

    return (
        <>
            <Pressable
                ref={anchorRef}
                testID={props.testID}
                hitSlop={4}
                accessibilityRole="button"
                accessibilityLabel={`${displayName}, ${statusLabel}`}
                onPress={() => {
                    setIsPinnedOpen((previous) => !previous);
                }}
                onHoverIn={Platform.OS === 'web' ? () => {
                    cancelHoverClose();
                    setIsHovered(true);
                } : undefined}
                onHoverOut={Platform.OS === 'web' ? scheduleHoverClose : undefined}
                style={[
                    chipStyle,
                    props.mode === 'comfort'
                        ? { borderColor: theme.colors.border.surface }
                        : null,
                ]}
            >
                <MachineGlyph
                    initial={avatarInitial}
                    size={props.mode === 'comfort' ? 18 : 22}
                    strokeColor={glyphStrokeColor}
                    letterColor={theme.colors.text.primary}
                    testID={`${props.testID}-glyph`}
                />
                {props.mode === 'comfort' ? (
                    <Text
                        testID={`${props.testID}-alias`}
                        style={styles.alias}
                        numberOfLines={1}
                        ellipsizeMode="tail"
                    >
                        {displayName}
                    </Text>
                ) : null}
                {props.mode === 'inline-metrics' ? (
                    <>
                        <Text style={styles.inlineAlias} numberOfLines={1}>
                            {displayName}
                        </Text>
                        <Text testID={`${props.testID}-metrics`} style={styles.inlineMetrics} numberOfLines={1}>
                            {inlineMetrics}
                        </Text>
                    </>
                ) : null}
                {metricAlerts.length > 0 ? (
                    <View testID={`${props.testID}-alerts`} style={styles.chipAlerts}>
                        {metricAlerts.map((alert) => (
                            <Icon
                                key={alert.metric}
                                name={METRIC_ALERT_ICONS[alert.metric]}
                                size={12}
                                weight="fill"
                                color={alert.tone === 'danger'
                                    ? theme.colors.state.danger.foreground
                                    : theme.colors.state.warning.foreground}
                            />
                        ))}
                    </View>
                ) : null}
            </Pressable>

            <Popover
                open={open}
                anchorRef={anchorRef}
                backdrop={false}
                placement="bottom"
                maxWidthCap={340}
                portal={MODAL_AWARE_FLOATING_POPOVER_PORTAL_OPTIONS}
                onRequestClose={() => {
                    cancelHoverClose();
                    setIsPinnedOpen(false);
                    setIsHovered(false);
                }}
            >
                {() => (
                    <PopoverSurfaceView
                        testID={`${props.testID}-popover`}
                        style={styles.popoverSurface}
                        onMouseEnter={Platform.OS === 'web' ? cancelHoverClose : undefined}
                        onMouseLeave={Platform.OS === 'web' ? scheduleHoverClose : undefined}
                    >
                        <View style={styles.popoverContent}>
                            <View style={styles.popoverHeader}>
                                <Text style={styles.popoverTitle} numberOfLines={1}>
                                    {displayName}
                                </Text>
                                <Pressable
                                    testID={`${props.testID}-rename`}
                                    hitSlop={6}
                                    accessibilityRole="button"
                                    accessibilityLabel={t('machine.renameTitle')}
                                    onPress={() => {
                                        fireAndForget(renameMachineWithPrompt(props.machine), { tag: 'MachineResourcesStrip.renameMachine' });
                                    }}
                                >
                                    <Icon name="pencil" size={14} color={theme.colors.text.secondary} />
                                </Pressable>
                            </View>
                            <View style={styles.popoverGauges}>
                                <MachineResourcesGauge
                                    label={t('machine.resources.cpu')}
                                    usagePercent={snapshot?.cpu.usagePercent ?? null}
                                    tone={snapshot ? resolveMachineResourcesMetricTone(snapshot.cpu.usagePercent) : 'unknown'}
                                    testID={`${props.testID}-gauge-cpu`}
                                    ringTestID={`${props.testID}-ring-cpu`}
                                    progressTestID={`${props.testID}-progress-cpu`}
                                    labelTestID={`${props.testID}-label-cpu`}
                                />
                                <MachineResourcesGauge
                                    label={t('machine.resources.memory')}
                                    usagePercent={snapshot?.memory.usagePercent ?? null}
                                    detail={snapshot
                                        ? formatMachineResourcesByteRange(snapshot.memory.usedBytes, snapshot.memory.totalBytes)
                                        : null}
                                    tone={snapshot ? resolveMachineResourcesMetricTone(snapshot.memory.usagePercent) : 'unknown'}
                                    testID={`${props.testID}-gauge-memory`}
                                    ringTestID={`${props.testID}-ring-memory`}
                                    progressTestID={`${props.testID}-progress-memory`}
                                    labelTestID={`${props.testID}-label-memory`}
                                />
                                <MachineResourcesGauge
                                    label={t('machine.resources.disk')}
                                    usagePercent={snapshot?.disk.usagePercent ?? null}
                                    detail={snapshot
                                        ? formatMachineResourcesByteRange(snapshot.disk.usedBytes, snapshot.disk.totalBytes)
                                        : null}
                                    tone={snapshot ? resolveMachineResourcesMetricTone(snapshot.disk.usagePercent) : 'unknown'}
                                    testID={`${props.testID}-gauge-disk`}
                                    ringTestID={`${props.testID}-ring-disk`}
                                    progressTestID={`${props.testID}-progress-disk`}
                                    labelTestID={`${props.testID}-label-disk`}
                                />
                            </View>
                            {snapshot ? (
                                <Text style={styles.popoverSampledAt} numberOfLines={1}>
                                    {formatSampledAt(snapshot.sampledAt)}
                                </Text>
                            ) : null}
                        </View>
                    </PopoverSurfaceView>
                )}
            </Popover>
        </>
    );
});

/**
 * The fixed machine strip under the sessions-list storage tabs (Hyper and direct surfaces
 * share it): one compact row of machine chips with density that adapts to the measured row
 * width — a lone machine inlines its three metrics, several machines get alias chips whose
 * names ellipsize against the width they can each afford, and only a row that cannot pay for
 * even minimal aliases collapses to glyph-only chips. Rendered only while the
 * `machines.resources` experiment is enabled and at least one machine is visible.
 */
export function MachineResourcesStrip(props: Readonly<{ testID?: string }>) {
    const enabled = useFeatureEnabled('machines.resources');
    const machines = useAllMachines();
    const refresh = useMachineResourcesPolling({
        enabled: enabled && machines.length > 0,
        machines,
    });
    const [containerWidth, setContainerWidth] = React.useState<number | null>(null);

    if (!enabled || machines.length === 0) return null;

    const mode = resolveMachineStripMode({ machineCount: machines.length, containerWidth });
    if (mode === null) return null;

    const handleLayout = (event: LayoutChangeEvent) => {
        const chipsWidth = event.nativeEvent.layout.width - MACHINE_STRIP_ROW_HORIZONTAL_PADDING_PX * 2;
        setContainerWidth((previous) => (previous === chipsWidth ? previous : chipsWidth));
    };

    return (
        <ItemGroup style={stylesheet.group} constrainToContentWidth={false}>
            <MachineResourcesStripRow
                testID={props.testID ?? 'machine-resources-strip'}
                mode={mode}
                machines={machines}
                refresh={refresh}
                onLayoutWidth={handleLayout}
            />
        </ItemGroup>
    );
}

function MachineResourcesStripRow(props: Readonly<{
    testID: string;
    mode: MachineStripMode;
    machines: readonly Machine[];
    refresh: (machineId: string) => void;
    onLayoutWidth: (event: LayoutChangeEvent) => void;
    /** Injected by the ItemGroup divider machinery; a single row never shows one. */
    showDivider?: boolean;
}>) {
    const styles = stylesheet;

    return (
        <View
            testID={props.testID}
            style={[styles.row, props.mode !== 'inline-metrics' ? styles.rowSpread : null]}
            onLayout={props.onLayoutWidth}
        >
            {props.machines.map((machine) => (
                <MachineResourcesChip
                    key={machine.id}
                    machine={machine}
                    mode={props.mode}
                    refresh={props.refresh}
                    testID={`machine-resources-chip:${machine.id}`}
                />
            ))}
        </View>
    );
}
