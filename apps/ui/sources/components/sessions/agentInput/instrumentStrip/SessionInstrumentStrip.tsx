import * as React from 'react';
import { Pressable, View, type LayoutChangeEvent } from 'react-native';
import Animated, { useAnimatedStyle, useSharedValue, withDelay, withTiming } from 'react-native-reanimated';
import { useUnistyles } from 'react-native-unistyles';

import type { AgentId } from '@/agents/catalog/catalog';
import { INSTRUMENT_DURATIONS, staggerDelayForIndex, useMotionPreferences } from '@/components/instrument';
import { StatusDot } from '@/components/ui/status/StatusDot';
import { Text } from '@/components/ui/text/Text';
import type { Metadata } from '@/sync/domains/state/storageTypes';
import type { CurrentSessionRunnerProcessIdentity } from '@/sync/domains/models/resolveSessionModelSelectionDisposition';
import { useSetting } from '@/sync/domains/state/storage';
import type { ConnectedServiceQuotaGaugeViewModel } from '@/sync/domains/connectedServices/connectedServiceQuotaGauge';
import { t } from '@/text';

import type { AgentInputStatusBadge as AgentInputStatusBadgeDescriptor } from '../agentInputContracts';
import { AgentInputStatusBadge } from '../status/AgentInputStatusBadge';
import { AgentInputContentPopover } from '../components/AgentInputContentPopover';
import { getContextWarning } from '../contextWarning';
import { resolveContextWarningWindowTokens } from '../resolveContextWarningWindowTokens';
import { ContextGaugeInstrument } from './ContextGaugeInstrument';
import { GitDeltaInstrument } from './GitDeltaInstrument';
import { QuotaRingInstrument } from './QuotaRingInstrument';
import { instrumentStripStyles } from './instrumentStripStyles';
import { useInstrumentStripModel } from './useInstrumentStripModel';

/** Below this available width, instruments drop their labels/icons to icon-only. */
const COMPACT_WIDTH = 360;
/** Below this available width, the cluster collapses behind a "•••" popover. */
const COLLAPSE_WIDTH = 300;

export type SessionInstrumentStripConnectionStatus = Readonly<{
    text: string;
    color: string;
    dotColor: string;
    isPulsing?: boolean;
}>;

export type SessionInstrumentStripPermission = Readonly<{
    label: string;
    color: string;
}>;

export type SessionInstrumentStripQuota = Readonly<{
    viewModel: ConnectedServiceQuotaGaugeViewModel;
    onRecoveryCreditPress?: () => void;
    recoveryCreditPending?: boolean;
}>;

export type SessionInstrumentStripProps = Readonly<{
    sessionId?: string;
    agentId?: AgentId | null;
    agentTargetKey?: string | null;
    metadata?: Metadata | null;
    sessionActive?: boolean;
    currentRunnerProcessIdentity?: CurrentSessionRunnerProcessIdentity | null;
    connectionStatus?: SessionInstrumentStripConnectionStatus | null;
    permission?: SessionInstrumentStripPermission | null;
    quota?: SessionInstrumentStripQuota | null;
    statusBadges?: ReadonlyArray<AgentInputStatusBadgeDescriptor>;
    activeStatusBadgeKey?: string | null;
    onActiveStatusBadgeKeyChange?: (key: string | null) => void;
    onGitPress?: () => void;
}>;

/**
 * The session "instrument strip": connection status on the left, a right-aligned
 * cluster of live instruments (context gauge · quota ring · git ± · extension
 * badges · permission chip). Subscribes to the store directly (F-UI-11): usage
 * ticks re-render only this strip, never the memoized composer.
 */
export const SessionInstrumentStrip = React.memo(function SessionInstrumentStrip(props: SessionInstrumentStripProps) {
    const { theme } = useUnistyles();
    const motion = useMotionPreferences();
    const alwaysShowContextSize = useSetting('alwaysShowContextSize') === true;

    const model = useInstrumentStripModel({
        sessionId: props.sessionId,
        agentId: props.agentId,
        agentTargetKey: props.agentTargetKey,
        metadata: props.metadata,
        sessionActive: props.sessionActive,
        currentRunnerProcessIdentity: props.currentRunnerProcessIdentity,
    });

    // Measured available width drives the overflow modes (never guessed).
    const [availableWidth, setAvailableWidth] = React.useState<number | null>(null);
    const onLayout = React.useCallback((event: LayoutChangeEvent) => {
        const width = event.nativeEvent.layout.width;
        setAvailableWidth((previous) => (previous !== null && Math.abs(previous - width) < 1 ? previous : width));
    }, []);
    const isCompact = availableWidth !== null && availableWidth < COMPACT_WIDTH;
    const isCollapsed = availableWidth !== null && availableWidth < COLLAPSE_WIDTH;

    // Status-badge popover state (moved verbatim from the composer status container).
    const statusBadgeAnchorRef = React.useRef<any>(null);
    const [uncontrolledActiveKey, setUncontrolledActiveKey] = React.useState<string | null>(null);
    const activeStatusBadgeKey = props.activeStatusBadgeKey !== undefined
        ? props.activeStatusBadgeKey
        : uncontrolledActiveKey;
    const setActiveStatusBadgeKey = props.onActiveStatusBadgeKeyChange ?? setUncontrolledActiveKey;
    const closeStatusBadgePopover = React.useCallback(
        () => setActiveStatusBadgeKey(null),
        [setActiveStatusBadgeKey],
    );
    const activeStatusBadge = React.useMemo(
        () => (activeStatusBadgeKey
            ? props.statusBadges?.find((badge) => badge.key === activeStatusBadgeKey) ?? null
            : null),
        [activeStatusBadgeKey, props.statusBadges],
    );

    const contextGaugeStyle = motion.contextGaugeStyle;
    const isStreaming = props.connectionStatus?.isPulsing === true;

    // Legacy "text" context style: render today's colored warning line.
    const contextTextWarning = React.useMemo(() => {
        if (contextGaugeStyle !== 'text' || !props.agentId) return null;
        const windowTokens = resolveContextWarningWindowTokens({
            agentId: props.agentId,
            agentTargetKey: props.agentTargetKey,
            metadata: props.metadata ?? null,
            sessionActive: props.sessionActive,
            currentRunnerProcessIdentity: props.currentRunnerProcessIdentity,
            usageData: model.context
                ? {
                    contextSize: model.context.usedTokens,
                    ...(typeof model.context.windowTokens === 'number'
                        ? { contextWindowTokens: model.context.windowTokens }
                        : {}),
                }
                : undefined,
        });
        return getContextWarning({
            contextSize: model.context?.usedTokens ?? 0,
            contextWindowTokens: windowTokens,
            contextSnapshotStale: model.context?.stale ?? false,
            alwaysShow: alwaysShowContextSize,
            theme,
        });
    }, [
        alwaysShowContextSize,
        contextGaugeStyle,
        model.context,
        props.agentId,
        props.agentTargetKey,
        props.metadata,
        props.currentRunnerProcessIdentity,
        props.sessionActive,
        theme,
    ]);

    const showContextGauge = contextGaugeStyle === 'gauge' && model.context !== null;
    // T3.1 gate: visible whenever the session is a repo (useHasMeaningfulScmStatus
    // semantics — summary !== null); a clean repo renders the lone branch icon.
    const showGit = model.git !== null;
    const showQuota = props.quota != null;
    const badges = props.statusBadges ?? [];

    const entranceEnabled = motion.entrance.kind === 'travel' && !motion.reduceMotion;

    // The collapsible instruments (context/quota/git/badges). Permission never
    // collapses. Built per compactness so the <300px overflow popover can list
    // the FULL-SIZE variants while the inline row uses the measured compactness.
    const buildCollapsibleInstruments = (compact: boolean): React.ReactNode[] => {
        const instruments: React.ReactNode[] = [];
        if (showContextGauge && model.context) {
            instruments.push(
                <ContextGaugeInstrument
                    key="context"
                    model={model.context}
                    showPercentText={!compact}
                    isStreaming={isStreaming}
                    onRefresh={model.refreshContextUsage}
                />,
            );
        } else if (contextGaugeStyle === 'text' && contextTextWarning) {
            instruments.push(
                <Text
                    key="context-text"
                    style={[instrumentStripStyles.instrumentValueText, { color: contextTextWarning.color }]}
                    numberOfLines={1}
                >
                    {contextTextWarning.text}
                </Text>,
            );
        }
        if (showQuota && props.quota) {
            instruments.push(
                <QuotaRingInstrument
                    key="quota"
                    viewModel={props.quota.viewModel}
                    onRecoveryCreditPress={props.quota.onRecoveryCreditPress}
                    recoveryCreditPending={props.quota.recoveryCreditPending}
                    showProviderGlyph={!compact}
                />,
            );
        }
        if (showGit && model.git) {
            instruments.push(
                <GitDeltaInstrument
                    key="git"
                    git={model.git}
                    compact={compact}
                    onPress={props.onGitPress}
                />,
            );
        }
        for (const badge of badges) {
            const { key, renderPopover, onPress, ...rest } = badge;
            instruments.push(
                <AgentInputStatusBadge
                    key={`badge-${key}`}
                    anchorRef={renderPopover ? statusBadgeAnchorRef : undefined}
                    onPress={renderPopover
                        ? () => {
                            setActiveStatusBadgeKey(activeStatusBadgeKey === key ? null : key);
                            onPress?.();
                        }
                        : onPress}
                    renderPopover={renderPopover}
                    {...rest}
                />,
            );
        }
        return instruments;
    };
    const collapsibleInstruments = buildCollapsibleInstruments(isCompact);

    const permissionChip = props.permission ? (
        <View style={instrumentStripStyles.permissionChip}>
            <Text style={[instrumentStripStyles.permissionText, { color: props.permission.color }]} numberOfLines={1}>
                {props.permission.label}
            </Text>
        </View>
    ) : null;

    const hasAnything = props.connectionStatus
        || collapsibleInstruments.length > 0
        || permissionChip !== null;
    if (!hasAnything) {
        // Keep a measuring host so overflow can resolve once content appears.
        return <View style={instrumentStripStyles.root} onLayout={onLayout} />;
    }

    return (
        <View style={instrumentStripStyles.root} onLayout={onLayout}>
            {props.connectionStatus ? (
                <View style={instrumentStripStyles.connectionGroup}>
                    <StatusDot
                        color={props.connectionStatus.dotColor}
                        isPulsing={props.connectionStatus.isPulsing}
                        size={6}
                        style={instrumentStripStyles.connectionDot}
                    />
                    <Text
                        testID="agent-input-connection-status-text"
                        style={[instrumentStripStyles.connectionText, { color: props.connectionStatus.color }]}
                        numberOfLines={1}
                    >
                        {props.connectionStatus.text}
                    </Text>
                </View>
            ) : null}

            <View style={instrumentStripStyles.spacer} />

            <View style={instrumentStripStyles.cluster}>
                {isCollapsed && collapsibleInstruments.length > 0 ? (
                    <CollapsedInstrumentsChip instruments={buildCollapsibleInstruments(false)} />
                ) : (
                    collapsibleInstruments.map((node, index) => (
                        <InstrumentEntrance key={(node as React.ReactElement).key ?? index} index={index} enabled={entranceEnabled}>
                            {node}
                        </InstrumentEntrance>
                    ))
                )}
                {permissionChip}
            </View>

            {activeStatusBadge?.renderPopover?.({
                open: true,
                anchorRef: statusBadgeAnchorRef,
                onRequestClose: closeStatusBadgePopover,
            })}
        </View>
    );
});

/** One-shot fade + 4px rise entrance, staggered per index via kit tokens (T5.1). */
function InstrumentEntrance(props: Readonly<{ index: number; enabled: boolean; children: React.ReactNode }>) {
    const progress = useSharedValue(props.enabled ? 0 : 1);
    React.useEffect(() => {
        if (props.enabled) {
            progress.value = withDelay(
                staggerDelayForIndex(props.index),
                withTiming(1, { duration: INSTRUMENT_DURATIONS.entrance }),
            );
        } else {
            progress.value = 1;
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);
    const style = useAnimatedStyle(() => ({
        opacity: progress.value,
        transform: [{ translateY: (1 - progress.value) * 4 }],
    }));
    return <Animated.View style={style}>{props.children}</Animated.View>;
}

/** Overflow collapse (<300px): a "•••" chip opening a full-size instrument list. */
function CollapsedInstrumentsChip(props: Readonly<{ instruments: React.ReactNode[] }>) {
    const { theme } = useUnistyles();
    const anchorRef = React.useRef(null);
    const [open, setOpen] = React.useState(false);
    return (
        <>
            <View ref={anchorRef}>
                <Pressable
                    testID="session-instrument-overflow-chip"
                    accessibilityRole="button"
                    accessibilityLabel={t('instrument.strip.moreLabel')}
                    hitSlop={10}
                    onPress={() => setOpen((previous) => !previous)}
                    style={[instrumentStripStyles.overflowChip, { backgroundColor: theme.colors.surface.pressedOverlay }]}
                >
                    <Text style={instrumentStripStyles.overflowChipText}>•••</Text>
                </Pressable>
            </View>
            <AgentInputContentPopover
                open={open}
                anchorRef={anchorRef}
                onRequestClose={() => setOpen(false)}
                maxWidthCap={280}
                scrollEnabled={false}
                testID="session-instrument-overflow-popover"
                content={(
                    <View style={instrumentStripStyles.overflowPopover}>
                        {props.instruments.map((node, index) => (
                            <View key={index} style={instrumentStripStyles.overflowPopoverRow}>
                                {node}
                            </View>
                        ))}
                    </View>
                )}
            />
        </>
    );
}
