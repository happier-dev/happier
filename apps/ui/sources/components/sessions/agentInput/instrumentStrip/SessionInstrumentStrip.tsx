import * as React from 'react';
import { useServerCredentialAccountScopeResolution } from '@/sync/domains/scope/useServerCredentialAccountScopes';
import { View, type LayoutChangeEvent } from 'react-native';
import Animated, { FadeIn, FadeOut, useAnimatedStyle, useSharedValue, withDelay, withTiming } from 'react-native-reanimated';
import { useUnistyles } from 'react-native-unistyles';

import { INSTRUMENT_DURATIONS, staggerDelayForIndex, useMotionPreferences } from '@/components/instrument';
import { StatusDot } from '@/components/ui/status/StatusDot';
import { TextLinkButton } from '@/components/ui/buttons/TextLinkButton';
import { Text } from '@/components/ui/text/Text';
import { Tooltip } from '@/components/ui/overlays/Tooltip';
import type { Metadata } from '@happier-dev/session-core/state';
import type { CurrentSessionRunnerProcessIdentity } from '@/sync/domains/models/resolveSessionModelSelectionDisposition';
import { useSetting } from '@/sync/domains/state/storage';
import type { ConnectedServiceQuotaGaugeViewModel } from '@/sync/domains/connectedServices/connectedServiceQuotaGauge';
import { t } from '@/text';

import type { AgentInputStatusBadge as AgentInputStatusBadgeDescriptor, AgentInputStatusRegion } from '../agentInputContracts';
import { AgentInputStatusBadge } from '../status/AgentInputStatusBadge';

const EMPTY_STATUS_BADGES: ReadonlyArray<AgentInputStatusBadgeDescriptor> = Object.freeze([]);
import { AgentInputContentPopover } from '../components/AgentInputContentPopover';
import { getContextWarning } from '../contextWarning';
import { resolveContextWarningWindowTokens } from '../resolveContextWarningWindowTokens';
import { ContextGaugeInstrument } from './ContextGaugeInstrument';
import { GitDeltaInstrument } from './GitDeltaInstrument';
import { QuotaRingInstrument } from './QuotaRingInstrument';
import { GuardCountdown } from '@/components/machines/guard/GuardCountdown';
import { motionTokens } from '@/components/ui/motion/motionTokens';

import { instrumentStripStyles } from './instrumentStripStyles';
import { useInstrumentStripModel } from './useInstrumentStripModel';
import { InstrumentFrame } from './InstrumentFrame';
import { HappierPressable } from '@happier-dev/plugin-ui/presentation';

/** Below this available width, instruments drop their labels/icons to icon-only. */
const COMPACT_WIDTH = 360;
/** Below this available width, the cluster collapses behind a "•••" popover. */
const COLLAPSE_WIDTH = 300;

/**
 * One item of the collapsible cluster. A narrow strip takes its width back from the items that
 * `yield` first (plain values and quiet notes) and leaves the rest whole: a
 * prominent badge keeps its label, a gauge its readout.
 */
type StripInstrument = Readonly<{ node: React.ReactNode; yields: boolean }>;

/** One action ending the composer's status line, drawn by the shared text link. */
export type SessionInstrumentStripLineAction = Readonly<{
    label: string;
    onPress: () => void;
    disabled?: boolean;
    testID?: string;
    /** The label is a name (an account's) that gives way first, with an ellipsis, so the line stays one line. */
    truncates?: boolean;
}>;

export type SessionInstrumentStripConnectionStatus = Readonly<{
    text: string;
    color: string;
    dotColor: string;
    isPulsing?: boolean;
    action?: SessionInstrumentStripLineAction;
    /** A second way forward after the action (Sign in beside a connected account's one-tap switch); quiet. */
    secondaryAction?: SessionInstrumentStripLineAction;
    /** The longer explanation behind a short line: the shared tooltip on hover/focus, and read with the line. */
    detail?: string;
    /** A coming stop (plan 50 G3-5): the text is followed by a countdown that ticks in its own leaf. */
    countdownTo?: number;
    /** The line's moment (the guard's warning, stopped, waking); a change cross-fades the line (plan 50 GM). */
    transitionKey?: string;
}>;

/** A line with a detail keeps its short text in place and offers the detail through the shared tooltip. */
function wrapConnectionDetail(line: React.ReactElement, status: SessionInstrumentStripConnectionStatus): React.ReactElement {
    if (!status.detail) return line;
    return (
        <Tooltip testID="agent-input-connection-detail" label={status.detail}
            accessibilityLabel={`${status.text}. ${status.detail}`}
            style={status.action?.truncates ? instrumentStripStyles.connectionTextKept : instrumentStripStyles.connectionTextHost}>
            {line}
        </Tooltip>
    );
}

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
    serverId?: string;
    sessionId?: string;
    agentId?: string | null;
    agentTargetKey?: string | null;
    metadata?: Metadata | null;
    sessionActive?: boolean;
    currentRunnerProcessIdentity?: CurrentSessionRunnerProcessIdentity | null;
    connectionStatus?: SessionInstrumentStripConnectionStatus | null;
    permission?: SessionInstrumentStripPermission | null;
    quota?: SessionInstrumentStripQuota | null;
    statusBadges?: ReadonlyArray<AgentInputStatusBadgeDescriptor>;
    /** Admitted Composer regions; their surfaces own public ComposerStatusBadge items. */
    statusRegions?: readonly AgentInputStatusRegion[];
    statusTrailingActions?: React.ReactNode;
    activeStatusBadgeKey?: string | null;
    onActiveStatusBadgeKeyChange?: (key: string | null) => void;
    onGitPress?: () => void;
    /**
     * With nothing to show, take no height instead of reserving the row. A host that places the
     * composer in a page (Home) uses it so the card sits on the section's edge; `/new` and sessions
     * keep the reserved row so status arriving later does not move the card.
     */
    collapseWhenEmpty?: boolean;
    /**
     * The card's content inset when the host draws its composer narrower than the strip's own (a phone's card puts
     * its content on 28): the line keeps starting over the field's first letter and the chips' first glyph.
     */
    contentInsetX?: number;
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
    const showUsageLabels = useSetting('sessionUsageGaugeLabels') === true;
    const accountScopeResolution = useServerCredentialAccountScopeResolution(props.serverId);
    const accountScope = props.serverId === undefined ? undefined
        : accountScopeResolution.kind === 'bound' ? accountScopeResolution.scope : null;

    const model = useInstrumentStripModel({
        accountScope,
        sessionId: props.sessionId,
        serverId: props.serverId,
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
            accountScope,
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
        accountScope,
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
    const allBadges = props.statusBadges ?? EMPTY_STATUS_BADGES;
    const badges = allBadges.filter((badge) => badge.placement !== 'withStatus');
    const workBadges = allBadges.filter((badge) => badge.placement === 'withStatus');

    const entranceEnabled = motion.entrance.kind === 'travel' && !motion.reduceMotion;

    // The collapsible instruments (context/quota/git/badges). Permission never
    // collapses. Built per compactness so the <300px overflow popover can list
    // the FULL-SIZE variants while the inline row uses the measured compactness.
    const renderBadge = (badge: AgentInputStatusBadgeDescriptor): React.ReactElement => {
        const { key, renderPopover, onPress, placement: _placement, ...rest } = badge;
        return (
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
                // The strip owns whether a badge's popover is open, so it announces that to assistive tech.
                accessibilityState={renderPopover ? { expanded: activeStatusBadgeKey === key } : undefined}
                {...rest}
            />
        );
    };
    const buildCollapsibleInstruments = (compact: boolean): StripInstrument[] => {
        const instruments: StripInstrument[] = [];
        if (showContextGauge && model.context) {
            instruments.push({
                yields: false,
                node: (
                    <ContextGaugeInstrument
                        key="context"
                        model={model.context}
                        showPercentText={!compact}
                        showLabel={showUsageLabels}
                        isStreaming={isStreaming}
                        onRefresh={model.refreshContextUsage}
                    />
                ),
            });
        } else if (contextGaugeStyle === 'text' && contextTextWarning) {
            instruments.push({
                yields: true,
                node: (
                    <Text
                        key="context-text"
                        style={[instrumentStripStyles.instrumentValueText, { color: contextTextWarning.color }]}
                        numberOfLines={1}
                    >
                        {contextTextWarning.text}
                    </Text>
                ),
            });
        }
        if (showQuota && props.quota) {
            instruments.push({
                yields: false,
                node: (
                    <QuotaRingInstrument
                        key="quota"
                        viewModel={props.quota.viewModel}
                        metadata={props.metadata}
                        agentId={props.agentId}
                        onRecoveryCreditPress={props.quota.onRecoveryCreditPress}
                        recoveryCreditPending={props.quota.recoveryCreditPending}
                        showProviderGlyph={!compact}
                        showLabels={showUsageLabels}
                    />
                ),
            });
        }
        if (showGit && model.git) {
            instruments.push({
                yields: false,
                node: (
                    <GitDeltaInstrument
                        key="git"
                        git={model.git}
                        compact={compact}
                        onPress={props.onGitPress}
                    />
                ),
            });
        }
        for (const badge of badges) {
            instruments.push({ yields: badge.emphasis === 'quiet', node: renderBadge(badge) });
        }
        for (const region of props.statusRegions ?? []) instruments.push({ yields: region.emphasis === 'quiet', node: region.node });
        return instruments;
    };
    const collapsibleInstruments = buildCollapsibleInstruments(isCompact);

    const permissionChip = props.permission ? (
        <View style={[instrumentStripStyles.permissionChip, collapsibleInstruments.length > 0 ? instrumentStripStyles.instrumentSpaced : null]}>
            <Text style={[instrumentStripStyles.permissionText, { color: props.permission.color }]} numberOfLines={1}>
                {props.permission.label}
            </Text>
        </View>
    ) : null;

    // The guard's moments (warning ↔ stopped ↔ waking ↔ ordinary) cross-fade the line; the first line a
    // strip shows simply appears, and reduced motion changes the text at once.
    const lineKey = props.connectionStatus?.transitionKey ?? 'status';
    const firstLineKey = React.useRef(lineKey);
    const lineChanged = React.useRef(false);
    if (lineKey !== firstLineKey.current) lineChanged.current = true;
    const reducedMotion = motion.reduceMotion;
    const contentInsetStyle = React.useMemo(() => props.contentInsetX === undefined ? null : { paddingHorizontal: props.contentInsetX },
        [props.contentInsetX]);
    const hasAnything = props.connectionStatus
        || workBadges.length > 0
        || collapsibleInstruments.length > 0
        || permissionChip !== null
        || props.statusTrailingActions != null;
    if (!hasAnything) {
        // Keep a measuring host so overflow can resolve once content appears.
        return (
            <View
                style={[instrumentStripStyles.root, contentInsetStyle, props.collapseWhenEmpty ? instrumentStripStyles.rootCollapsed : null]}
                onLayout={onLayout}
            />
        );
    }

    return (
        <View style={[instrumentStripStyles.root, contentInsetStyle]} onLayout={onLayout}>
            {props.connectionStatus ? (
                <Animated.View key={lineKey} testID="agent-input-connection-line" style={instrumentStripStyles.connectionGroup}
                    entering={lineChanged.current && !reducedMotion ? FadeIn.duration(motionTokens.guardMoment.lineCrossFadeMs) : undefined}>
                    <StatusDot
                        color={props.connectionStatus.dotColor}
                        isPulsing={props.connectionStatus.isPulsing}
                        size={6}
                        style={instrumentStripStyles.connectionDot}
                    />
                    {wrapConnectionDetail(
                        <Text
                            testID="agent-input-connection-status-text"
                            style={[
                                instrumentStripStyles.connectionText,
                                props.connectionStatus.action?.truncates ? instrumentStripStyles.connectionTextKept : null,
                                { color: props.connectionStatus.color },
                            ]}
                            // The status row stays one line (owner 2026-11-11): the sentence gives way with an ellipsis,
                            // its action and the instruments keep their width; its full words stay its accessible text.
                            numberOfLines={1}
                        >
                            {props.connectionStatus.text}
                            {props.connectionStatus.countdownTo !== undefined ? (
                                <>
                                    {' '}
                                    <GuardCountdown testID="agent-input-connection-countdown" stopAt={props.connectionStatus.countdownTo}
                                        style={instrumentStripStyles.connectionCountdown} format={remaining => remaining} />
                                </>
                            ) : null}
                        </Text>,
                        props.connectionStatus,
                    )}
                    {/* The status line's one recovery ends its sentence (lab `b-ask E`), drawn by the shared text link. */}
                    {props.connectionStatus.action ? (
                        <View style={props.connectionStatus.action.truncates ? instrumentStripStyles.connectionActionHost : undefined}>
                            <TextLinkButton
                                testID={props.connectionStatus.action.testID ?? 'agent-input-connection-recovery'}
                                tone="strong"
                                size="meta"
                                label={props.connectionStatus.action.label}
                                onPress={props.connectionStatus.action.onPress}
                                disabled={props.connectionStatus.action.disabled}
                            />
                        </View>
                    ) : null}
                    {props.connectionStatus.action && props.connectionStatus.secondaryAction ? (
                        <TextLinkButton
                            testID={props.connectionStatus.secondaryAction.testID ?? 'agent-input-connection-secondary'}
                            tone="quiet"
                            size="meta"
                            label={props.connectionStatus.secondaryAction.label}
                            onPress={props.connectionStatus.secondaryAction.onPress}
                            disabled={props.connectionStatus.secondaryAction.disabled}
                        />
                    ) : null}
                    {/* Work items stand beside the status they qualify (0.2); the gauges keep the right. */}
                    {workBadges.map(renderBadge)}
                </Animated.View>
            ) : workBadges.length > 0 ? (
                <View style={instrumentStripStyles.connectionGroup}>{workBadges.map(renderBadge)}</View>
            ) : null}

            <View style={[instrumentStripStyles.spacer, props.connectionStatus ? instrumentStripStyles.spacerBesideLine : null]} />

            <View style={instrumentStripStyles.cluster}>
                {isCollapsed && collapsibleInstruments.length > 0 ? (
                    <CollapsedInstrumentsChip instruments={buildCollapsibleInstruments(false)} />
                ) : (
                    collapsibleInstruments.map(({ node, yields }, index) => (
                        <InstrumentEntrance key={(node as React.ReactElement).key ?? index} index={index} enabled={entranceEnabled} yields={yields}
                            leading={index === 0}>
                            {node}
                        </InstrumentEntrance>
                    ))
                )}
                {permissionChip}
            </View>
            {/* The host's own actions are a separate item, so a narrow strip recomposes rather than
                overflowing: they wrap beneath the status, which keeps its own row (lab `m-pick-Aprogp`). */}
            {props.statusTrailingActions != null ? (
                <View style={instrumentStripStyles.trailingActions}>
                    {props.statusTrailingActions}
                </View>
            ) : null}

            {activeStatusBadge?.renderPopover?.({
                open: true,
                anchorRef: statusBadgeAnchorRef,
                onRequestClose: closeStatusBadgePopover,
            })}
        </View>
    );
});

/**
 * One-shot fade + 4px rise entrance, staggered per index via kit tokens (T5.1). Leaving fades over the same
 * duration, so a badge whose work ends (a created machine joining) settles instead of blinking out (lab af-create).
 */
function InstrumentEntrance(props: Readonly<{ index: number; enabled: boolean; yields: boolean; leading: boolean; children: React.ReactNode }>) {
    const progress = useSharedValue(props.enabled ? 0 : 1);
    // An instrument that renders nothing (an empty plugin region) measures zero wide and drops its gap.
    const [hasContent, setHasContent] = React.useState(true);
    const handleLayout = React.useCallback((event: LayoutChangeEvent) => {
        const next = event.nativeEvent.layout.width > 0.5;
        setHasContent((current) => (current === next ? current : next));
    }, []);
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
    return (
        <InstrumentFrame onLayout={handleLayout}
            style={[props.yields ? instrumentStripStyles.instrumentEntranceYielding : instrumentStripStyles.instrumentEntrance,
                !props.leading && hasContent ? instrumentStripStyles.instrumentSpaced : null, style]}
            exiting={props.enabled ? FadeOut.duration(INSTRUMENT_DURATIONS.entrance) : undefined}>
            {props.children}
        </InstrumentFrame>
    );
}

/** Overflow collapse (<300px): a "•••" chip opening a full-size instrument list. */
function CollapsedInstrumentsChip(props: Readonly<{ instruments: StripInstrument[] }>) {
    const { theme } = useUnistyles();
    const anchorRef = React.useRef(null);
    const [open, setOpen] = React.useState(false);
    return (
        <>
            <View ref={anchorRef}>
                <HappierPressable
                    testID="session-instrument-overflow-chip"
                    accessibilityRole="button"
                    accessibilityLabel={t('instrument.strip.moreLabel')}
                    onPress={() => setOpen((previous) => !previous)}
                    style={[instrumentStripStyles.overflowChip, { backgroundColor: theme.colors.surface.pressedOverlay }]}
                >
                    <Text style={instrumentStripStyles.overflowChipText}>•••</Text>
                </HappierPressable>
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
                        {props.instruments.map(({ node }, index) => (
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
