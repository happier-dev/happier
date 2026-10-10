import * as React from 'react';
import { View, type LayoutChangeEvent } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import type { ComputerGrantStatusV1, MachineLiveStreamInputControlKindV1 } from '@happier-dev/protocol';

import {
    buildBrowserStreamSidebandControl,
    containRect,
    resolveBrowserStreamedSurfaceState,
    useFirstFrameSize,
    type BrowserStreamedSurfaceRuntime,
} from '@/components/browser/adapters/BrowserStreamedTarget';
import { BrowserPresenceCapsule, type BrowserPresenceAgent, type BrowserPresenceCapsuleProps } from '@/components/browser/copresence/BrowserPresenceCapsule';
import { BrowserAgentCursor } from '@/components/browser/copresence/BrowserAgentCursor';
import { BrowserFrameStatusCapsule } from '@/components/browser/frame/BrowserFrameStatusCapsule';
import { LiveStreamInputLayer } from '@/components/stream/LiveStreamInputLayer';
import { LiveStreamPlayer } from '@/components/stream/LiveStreamPlayer';
import { IconButton } from '@/components/ui/buttons/IconButton';
import { DropdownMenu } from '@/components/ui/forms/dropdown/DropdownMenu';
import { Icon, ICON_SIZE } from '@/components/ui/icons/Icon';
import { SurfaceStateCard } from '@/components/ui/surfaces/SurfaceStateCard';
import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import type { BrowserCopresence } from '@/sync/domains/browser/automation/copresence';
import type { LiveStreamInputGesture } from '@/sync/domains/machines/peer/mediation/stream/inputGesture';
import { t } from '@/text';

import { ComputerPermissionCard, type ComputerOpenSettingsState } from './ComputerPermissionCard';

/** The person's gestures W7's native source turns into input: click and keys (no drag yet). */
const SCREEN_INPUT_KINDS: ReadonlySet<MachineLiveStreamInputControlKindV1> = new Set(['tap', 'keyboard_text', 'keyboard_key']);
const supportsScreenInput = (kind: MachineLiveStreamInputControlKindV1): boolean => SCREEN_INPUT_KINDS.has(kind);

const stylesheet = StyleSheet.create((theme) => ({
    root: {
        flex: 1,
        minHeight: 0,
        backgroundColor: theme.colors.surface.base,
    },
    bar: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 10,
        minHeight: 44,
        paddingLeft: 14,
        paddingRight: 6,
        borderBottomWidth: StyleSheet.hairlineWidth,
        borderBottomColor: theme.colors.border.subtle,
    },
    barText: {
        flex: 1,
        minWidth: 0,
        // One line, like the lab: the window, then where it is (lab `computer` LV viewer bar).
        flexDirection: 'row',
        alignItems: 'baseline',
        gap: 8,
    },
    barTitle: {
        ...Typography.rowTitle(),
        flexShrink: 1,
        color: theme.colors.text.primary,
    },
    barMeta: {
        ...Typography.rowMeta(),
        flexShrink: 2,
        color: theme.colors.text.secondary,
    },
    stage: {
        flex: 1,
        minHeight: 0,
        backgroundColor: theme.colors.surface.inset,
    },
    fill: {
        ...StyleSheet.absoluteFillObject,
    },
    centered: {
        flex: 1,
        justifyContent: 'center',
    },
    // The last picture stays, dimmed, while the stream is paused: never a blank box.
    pausedScrim: {
        ...StyleSheet.absoluteFillObject,
        backgroundColor: theme.colors.overlay.scrimSoft,
        pointerEvents: 'none',
    },
}));

export type ComputerScreenViewerProps = Readonly<{
    agent: BrowserPresenceAgent;
    /** The shared window's title or the display label, as the computer owner names it. */
    targetTitle: string | null;
    appName?: string | null;
    access?: 'see' | 'use';
    targetKind: 'window' | 'display' | null;
    machineName: string | null;
    /** The Session has a shared target. */
    shared: boolean;
    stream: BrowserStreamedSurfaceRuntime | null;
    presence: BrowserCopresence;
    /** The agent's action is in flight ("is using"), not merely allowed ("can use"). */
    agentActing: boolean;
    checking?: boolean;
    onTakeControl: NonNullable<BrowserPresenceCapsuleProps['onTakeControl']>;
    onHandBack: () => void;
    onCheckAgain: () => void;
    onChooseWindow: () => void;
    onStopSharing: () => void;
    /** Phone and narrow panes: the capsule spans the frame in thumb reach. */
    compact?: boolean;
    /**
     * `bar` names the window above the picture (the Details pane). `none`: the picture is the
     * viewer; its frame's floating controls carry the identity and the window options.
     */
    chrome?: 'bar' | 'none';
    /** The machine allows watching but denies mouse and keyboard (its OS input grant). */
    inputDenied?: boolean;
    /** The machine's presence, when known: an unreachable machine is the cause said in the picture. */
    machineOnline?: boolean;
    /**
     * The machine's OS grants for the shared source. While screen capture is not granted there is no
     * picture to show, and the picture says which permission to allow and where.
     */
    grants?: ComputerGrantStatusV1 | null;
    openSettings?: ComputerOpenSettingsState;
    onOpenSettings?: (permission: 'capture' | 'input') => void;
    /** Re-read the machine's grants and the selection (the permission card's Check again). */
    onRefresh?: () => void;
    /**
     * The viewer presentation draws the presence capsule below the picture itself; the picture then
     * reports whether it is up and its own size, so the viewer can shape and arbitrate around it.
     */
    onPictureChange?: (picture: ComputerScreenPicture) => void;
    testID?: string;
}>;

export type ComputerScreenPicture = Readonly<{
    up: boolean;
    size: Readonly<{ width: number; height: number }> | null;
}>;

/** What the agent is doing on the shared window, in this surface's words. */
export function resolveComputerAgentTitle(props: Pick<ComputerScreenViewerProps, 'presence' | 'agent' | 'agentActing' | 'access' | 'appName' | 'targetTitle'>): string | undefined {
    if (props.presence.kind !== 'agent') return undefined;
    const agentName = props.agent.name;
    const agentTarget = props.appName ?? props.targetTitle ?? t('computerUse.viewer.tabFallback');
    return props.agentActing
        ? t('computerUse.viewer.agentUsing', { agent: agentName, target: agentTarget })
        : t(props.access === 'see' ? 'computerUse.viewer.agentCanSee' : 'computerUse.viewer.agentCanUse', { agent: agentName, target: agentTarget });
}

/** Screen capture is not granted on the machine, so the picture is the permission card. */
export function computerCaptureNeedsPermission(props: Pick<ComputerScreenViewerProps, 'shared' | 'grants'>): boolean {
    return props.shared && props.grants != null && props.grants.capture !== 'granted';
}

/**
 * Who acts on the shared window and the one control that changes it, for the presence capsule
 * wherever it is drawn (over the pane's picture, below the viewer's). While the machine denies input
 * the person can only watch: the capsule says so once and offers no Take control.
 */
export function resolveComputerPresenceCapsule(
    props: Pick<ComputerScreenViewerProps, 'presence' | 'agent' | 'agentActing' | 'access' | 'appName' | 'targetTitle' | 'checking' | 'inputDenied' | 'onTakeControl' | 'onHandBack' | 'onCheckAgain'>,
): Omit<BrowserPresenceCapsuleProps, 'testID' | 'compact' | 'placement'> {
    return {
        presence: props.presence,
        agent: props.agent,
        agentTitle: resolveComputerAgentTitle(props),
        agentNote: props.inputDenied ? t('computerUse.viewer.controlNotAllowed') : undefined,
        checking: props.checking,
        onTakeControl: props.inputDenied ? undefined : props.onTakeControl,
        onHandBack: props.onHandBack,
        onCheckAgain: props.onCheckAgain,
    };
}

function formatFrameTime(atMs: number): string {
    return new Date(atMs).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function ViewerStreamInput(props: Readonly<{
    input: NonNullable<BrowserStreamedSurfaceRuntime['input']>;
    viewport: Readonly<{ width: number; height: number }>;
    content: Readonly<{ x: number; y: number; width: number; height: number }>;
    label: string;
    testID: string;
}>): React.ReactElement {
    const { send, sourceId, streamId } = props.input;
    const onGesture = React.useCallback((gesture: Readonly<{ eventId: string; action: LiveStreamInputGesture }>) => {
        // Points normalized to the drawn picture; the native owner scales them to captured pixels (W7).
        const control = buildBrowserStreamSidebandControl({ sourceId, streamId, eventId: gesture.eventId, gesture: gesture.action });
        if (control) send(control);
    }, [send, sourceId, streamId]);
    return (
        <View style={stylesheet.fill}>
            <LiveStreamInputLayer
                inputAccepted
                supports={supportsScreenInput}
                viewport={props.viewport}
                content={props.content}
                onGesture={onGesture}
                accessibilityLabel={props.label}
                testID={props.testID}
            />
        </View>
    );
}

/**
 * Watching the agent use a shared window (lab `computer` LV/K/UN/ST): the bar names the window and the
 * machine; the picture is the canonical `LiveStreamPlayer` on the `screen` source; the one co-presence
 * capsule (the browser's) says who is in control and holds Take control, Stop's honest stopping state,
 * the unconfirmed stop with Check again, and Hand back. The capsule never depends on frames, so it stays
 * reachable while connecting, stalled or unavailable. The person's click or key on the picture is the
 * same takeover, except while a stop is unconfirmed: then nobody can use the window from Happier.
 */
export function ComputerScreenViewer(props: ComputerScreenViewerProps): React.ReactElement {
    const { theme } = useUnistyles();
    const testID = props.testID ?? 'computer-screen-viewer';
    const playerState = props.stream?.playerState ?? null;
    const surfaceState = props.shared ? resolveBrowserStreamedSurfaceState(playerState) : 'unavailable';
    const pictureUp = surfaceState === 'live' || surfaceState === 'stalled';
    const [viewport, setViewport] = React.useState<Readonly<{ width: number; height: number }> | null>(null);
    const onLayout = React.useCallback((event: LayoutChangeEvent) => {
        const { width, height } = event.nativeEvent.layout;
        if (width > 0 && height > 0) setViewport((current) => (current && current.width === width && current.height === height ? current : { width, height }));
    }, []);
    const frameSize = useFirstFrameSize(pictureUp ? playerState?.lastFrameUrl : null, playerState?.phase);
    const pageRect = pictureUp && viewport ? containRect(viewport, frameSize) : null;
    const inputOpen = props.presence.kind !== 'unconfirmed' && props.presence.kind !== 'stopping';
    const target = props.targetTitle ?? t('computerUse.viewer.tabFallback');
    const machine = props.machineName ?? '';
    const agentName = props.agent.name;
    const [menuOpen, setMenuOpen] = React.useState(false);
    const onPictureChange = props.onPictureChange;
    const frameWidth = frameSize?.width;
    const frameHeight = frameSize?.height;
    React.useEffect(() => {
        onPictureChange?.({ up: pictureUp, size: frameWidth && frameHeight ? { width: frameWidth, height: frameHeight } : null });
    }, [frameHeight, frameWidth, onPictureChange, pictureUp]);

    const pausedAtMs = playerState?.lastFrameAtMs;
    const onRetryStream = props.stream?.onRetry;
    const needsPermission = computerCaptureNeedsPermission(props);
    const stage = !props.shared ? (
        <View style={stylesheet.centered} testID={`${testID}-not-shared`}>
            <SurfaceStateCard
                kind="empty"
                iconName="browsers"
                title={t('computerUse.viewer.notSharedTitle')}
                reason={t('computerUse.viewer.notSharedBody', { agent: agentName })}
                action={{ label: t('computerUse.request.choose'), onPress: props.onChooseWindow }}
            />
        </View>
    ) : needsPermission && props.grants && props.onOpenSettings ? (
        <View style={stylesheet.centered} testID={`${testID}-permission`}>
            <ComputerPermissionCard
                machineName={machine}
                grants={props.grants}
                openSettings={props.openSettings ?? 'idle'}
                onOpenSettings={props.onOpenSettings}
                onCheckAgain={props.onRefresh ?? props.onCheckAgain}
                testID={`${testID}-permission-card`}
            />
        </View>
    ) : props.machineOnline === false && !pictureUp ? (
        // Watching is passive: it never wakes the machine, so the way back is the machine's own.
        <View style={stylesheet.centered} testID={`${testID}-offline`}>
            <SurfaceStateCard
                kind="unavailable"
                iconName="moon"
                title={t('computerUse.viewer.offlineTitle', { machine })}
                reason={t('computerUse.viewer.offlineBody')}
            />
        </View>
    ) : surfaceState === 'connecting' || (props.stream?.connecting && surfaceState === 'unavailable') ? (
        <View style={stylesheet.centered} testID={`${testID}-connecting`}>
            <SurfaceStateCard
                kind="loading"
                title={machine
                    ? t('computerUse.viewer.openingTitle', { target, machine })
                    : t('computerUse.viewer.connectingTitle', { target })}
            />
        </View>
    ) : surfaceState === 'ended' ? (
        <View style={stylesheet.centered} testID={`${testID}-ended`}>
            <SurfaceStateCard
                kind="unavailable"
                iconName="browsers"
                title={t('computerUse.viewer.endedTitle', { target })}
                reason={t('computerUse.viewer.endedBody', { agent: agentName })}
                action={{ label: t('computerUse.request.choose'), onPress: props.onChooseWindow }}
            />
        </View>
    ) : surfaceState === 'unavailable' || !playerState ? (
        <View style={stylesheet.centered} testID={`${testID}-unavailable`}>
            <SurfaceStateCard
                kind="unavailable"
                iconName="eye-slash"
                title={t('computerUse.viewer.unavailableTitle')}
                reason={t('computerUse.viewer.unavailableBody', { agent: agentName })}
                diagnosticCode={playerState?.diagnostic?.reasonCode}
            />
        </View>
    ) : (
        <View style={stylesheet.fill} testID={`${testID}-${surfaceState}`}>
            <LiveStreamPlayer testID={`${testID}-player`} state={playerState} statusOwnedByHost />
            {props.stream?.input && viewport && pageRect && inputOpen ? (
                <ViewerStreamInput
                    input={props.stream.input}
                    viewport={viewport}
                    content={pageRect}
                    label={t('computerUse.viewer.inputA11y', { target })}
                    testID={`${testID}-input`}
                />
            ) : null}
            {surfaceState === 'stalled' ? <View style={stylesheet.pausedScrim} testID={`${testID}-paused-scrim`} /> : null}
            {surfaceState === 'stalled' ? (
                <BrowserFrameStatusCapsule
                    testID={`${testID}-stalled`}
                    text={pausedAtMs
                        ? t('computerUse.viewer.paused', { time: formatFrameTime(pausedAtMs) })
                        : t('computerUse.viewer.stalled')}
                    busy={playerState.phase === 'reconnecting'}
                    action={onRetryStream && playerState.phase !== 'reconnecting'
                        ? { label: t('common.retry'), onPress: onRetryStream }
                        : undefined}
                />
            ) : null}
        </View>
    );

    return (
        <View style={stylesheet.root} testID={testID}>
            {props.chrome === 'none' ? null : <View style={stylesheet.bar}>
                <Icon
                    name={props.targetKind === 'display' ? 'desktop' : 'browsers'}
                    size={ICON_SIZE.md}
                    color={theme.colors.text.secondary}
                />
                <View style={stylesheet.barText}>
                    <Text style={stylesheet.barTitle} numberOfLines={1} testID={`${testID}-title`}>
                        {props.shared ? target : t('computerUse.viewer.notSharedTitle')}
                    </Text>
                    {machine ? <Text style={stylesheet.barMeta} numberOfLines={1}>{t('computerUse.viewer.onMachine', { machine })}</Text> : null}
                </View>
                {props.shared ? (
                    <DropdownMenu
                        open={menuOpen}
                        onOpenChange={setMenuOpen}
                        items={[
                            { id: 'change', title: t('computerUse.request.change'), testID: `${testID}-change-window` },
                            { id: 'stop', title: t('computerUse.picker.stopSharing'), destructive: true, testID: `${testID}-stop-sharing` },
                        ]}
                        onSelect={(id) => {
                            setMenuOpen(false);
                            if (id === 'change') props.onChooseWindow();
                            else props.onStopSharing();
                        }}
                        matchTriggerWidth={false}
                        popoverAnchorAlign="end"
                        trigger={({ toggle }) => (
                            <IconButton
                                testID={`${testID}-more`}
                                variant="plain"
                                accessibilityLabel={t('computerUse.viewer.moreA11y')}
                                iconName="dots-three"
                                iconSize={ICON_SIZE.md}
                                onPress={toggle}
                            />
                        )}
                    />
                ) : null}
            </View>}
            <View style={stylesheet.stage} onLayout={onLayout}>
                {stage}
                {pictureUp && props.presence.kind === 'agent' ? (
                    <BrowserAgentCursor
                        target={props.presence.target}
                        pageRect={pageRect}
                        agentId={props.agent.agentId}
                        testID={`${testID}-agent-cursor`}
                    />
                ) : null}
                {props.shared && props.chrome !== 'none' && !needsPermission ? (
                    <BrowserPresenceCapsule
                        testID={`${testID}-presence`}
                        {...resolveComputerPresenceCapsule(props)}
                        compact={props.compact}
                    />
                ) : null}
            </View>
        </View>
    );
}
