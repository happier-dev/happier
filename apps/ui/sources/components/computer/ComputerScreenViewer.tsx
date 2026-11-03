import * as React from 'react';
import { PixelRatio, View, type LayoutChangeEvent } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import type { ComputerGrantStatusV1} from '@happier-dev/protocol/computer/v1';
import { resolveComputerAccess } from '@happier-dev/protocol/computer/v1';

import {
    containRect,
    resolveBrowserStreamedSurfaceState,
    useFirstFrameSize,
    type BrowserStreamedSurfaceRuntime,
} from '@/components/browser/adapters/BrowserStreamedTarget';
import { buildBrowserStreamSidebandControl } from '@/components/browser/adapters/browserStreamSidebandControl';
import { BrowserPresenceCapsule, type BrowserPresenceAgent, type BrowserPresenceCapsuleProps } from '@/components/browser/copresence/BrowserPresenceCapsule';
import { BrowserAgentCursor } from '@/components/browser/copresence/BrowserAgentCursor';
import { BrowserFrameStatusCapsule } from '@/components/browser/frame/BrowserFrameStatusCapsule';
import { RemoteViewerStage, type RemoteViewerStageControls, type RemoteViewerHostActions } from '@/components/stream/RemoteViewerStage';
import { useRemoteViewerActions } from '@/components/stream/useRemoteViewerActions';
import { useBrowserSoftKeyboard } from '@/components/browser/streamed/useBrowserSoftKeyboard';
import { LiveStreamInputLayer } from '@/components/stream/LiveStreamInputLayer';
import { LiveStreamPlayer } from '@/components/stream/LiveStreamPlayer';
import { IconButton } from '@/components/ui/buttons/IconButton';
import { DropdownMenu } from '@/components/ui/forms/dropdown/DropdownMenu';
import { GlassLivePictureBackdropContext } from '@/components/ui/glass/livePictureBackdrop';
import { Icon, ICON_SIZE } from '@/components/ui/icons/Icon';
import { SurfaceStateCard } from '@/components/ui/surfaces/SurfaceStateCard';
import { SurfaceFreshnessLine } from '@/components/ui/surfaces/SurfaceFreshnessLine';
import { resolveComputerRecovery } from '@/sync/domains/computer/targets';
import { SessionViewerMachineMark } from '@/components/sessions/viewer/SessionViewerMachineMark';
import { Text, TextInput } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import { useSessionCockpitBottomChromeHeight } from '@/components/workspaceCockpit/session/SessionCockpitChromeRegistry';
import type { BrowserCopresence } from '@/sync/domains/browser/automation/copresence';
import type { LiveStreamInputGesture } from '@/sync/domains/machines/peer/mediation/stream/inputGesture';
import { t } from '@/text';
import { keepHyphenatedNameTogether } from '@/utils/sessions/machineDisplayNames';

import { ComputerPermissionCard, type ComputerOpenSettingsState } from './ComputerPermissionCard';

/** Native click, release-time atomic drag, scroll and keys share the registered source relay. */
const SCREEN_INPUT_KINDS: ReadonlySet<LiveStreamInputGesture['kind']> = new Set(['tap', 'drag', 'wheel', 'keyboard_text', 'keyboard_key']);
const supportsScreenInput = (kind: LiveStreamInputGesture['kind']): boolean => SCREEN_INPUT_KINDS.has(kind);

const stylesheet = StyleSheet.create((theme) => ({
    root: {
        flex: 1,
        minHeight: 0,
        backgroundColor: theme.colors.surface.base,
    },
    bar: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: theme.space.s10,
        minHeight: 44,
        paddingLeft: 14,
        paddingRight: theme.space.s6,
        borderBottomWidth: StyleSheet.hairlineWidth,
        borderBottomColor: theme.colors.border.subtle,
    },
    barText: {
        flex: 1,
        minWidth: 0,
        // One line, like the lab: the window, then the Machine it is on (lab `computer` LV viewer bar).
        flexDirection: 'row',
        alignItems: 'center',
        gap: theme.space.s8,
    },
    barTitle: {
        ...Typography.variant('label', 'semiBold'),
        flexShrink: 1,
        color: theme.colors.text.primary,
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
    /** The owner has not answered the initial share-selection read yet. */
    selectionPending?: boolean;
    stream: BrowserStreamedSurfaceRuntime | null;
    onRemoteActionsChange?: (actions: RemoteViewerHostActions | null) => void;
    presence: BrowserCopresence;
    /** The agent's action is in flight ("is using"), not merely allowed ("can use"). */
    agentActing: boolean;
    checking?: boolean;
    /** The person's Stop sharing is in flight. */
    stopping?: boolean;
    failure?: string | null;
    /** `failure` came from the person's Stop sharing: the share is still on and the press can be retried. */
    stopFailed?: boolean;
    repairingDriver?: boolean;
    onRepairDriver?: () => void;
    onTakeControl: NonNullable<BrowserPresenceCapsuleProps['onTakeControl']>;
    onHandBack: () => void;
    onCheckAgain: () => void;
    onChooseWindow: () => void;
    onStopSharing: () => void;
    /** The docked desktop pane's way back to the floating frame, offered only while that frame fits. */
    onFloat?: () => void;
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
    const agentTarget = props.appName ?? props.targetTitle ?? t('computerUse.presentation.tabFallback');
    return props.agentActing
        ? t('computerUse.presentation.agentUsing', { agent: agentName, target: agentTarget })
        : t(props.access === 'see' ? 'computerUse.presentation.agentCanSee' : 'computerUse.presentation.agentCanUse', { agent: agentName, target: agentTarget });
}

/** Screen capture is not granted on the machine, so the picture is the permission card. */
export function computerCaptureNeedsPermission(props: Pick<ComputerScreenViewerProps, 'shared' | 'grants'>): boolean {
    return props.grants != null && props.grants.capture !== 'granted';
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
        agentNote: props.inputDenied ? t('computerUse.presentation.controlNotAllowed')
            : props.access === 'see' ? t('computerUse.presentation.seeOnly') : undefined,
        checking: props.checking,
        // A see-only share gives the agent no mouse or keyboard, so there is no control to take from it.
        onTakeControl: props.inputDenied || props.access === 'see' ? undefined : props.onTakeControl,
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
    controls: RemoteViewerStageControls;
    controlling: boolean;
    onRemoteActionsChange?: (actions: RemoteViewerHostActions | null) => void;
    testID: string;
}>): React.ReactElement {
    const { send, sourceId, streamId } = props.input;
    const sendGesture = React.useCallback((gesture: Readonly<{ eventId: string; action: LiveStreamInputGesture }>) => {
        // Points normalized to the drawn picture; the native owner scales them to captured pixels (W7).
        const control = buildBrowserStreamSidebandControl({ sourceId, streamId, eventId: gesture.eventId, gesture: gesture.action });
        if (control) send(control);
    }, [send, sourceId, streamId]);
    const sequence = React.useRef(0);
    const sendAction = React.useCallback((action: LiveStreamInputGesture) => sendGesture({eventId: `viewer:${Date.now()}:${++sequence.current}`, action}), [sendGesture]);
    const actions = useRemoteViewerActions({enabled: true, sendGesture: sendAction, clipboardShortcut: props.input.clipboardShortcut});
    const keyboard = useBrowserSoftKeyboard({enabled: true, target: null, manual: true, sendText: actions.sendText, sendKey: actions.sendKey});
    const keyboardActions = React.useMemo(() => ({available: keyboard.available, focused: keyboard.focused,
        showKeyboard: keyboard.showKeyboard, hideKeyboard: keyboard.hideKeyboard}),
        [keyboard.available, keyboard.focused, keyboard.showKeyboard, keyboard.hideKeyboard]);
    const onGesture = React.useCallback((gesture: Readonly<{eventId: string; action: LiveStreamInputGesture}>) => {
        const action = actions.prepareGesture(gesture.action);
        if (action) sendGesture({...gesture, action});
    }, [actions.prepareGesture, sendGesture]);
    const supports = React.useCallback((kind: LiveStreamInputGesture['kind']) => kind === 'move' ? props.controlling : supportsScreenInput(kind), [props.controlling]);
    const published = React.useMemo(() => ({...actions, keyboard: keyboardActions, inputMode: {value: props.controls.mode, setMode: props.controls.setMode},
        resetZoom: props.controls.resetZoom}),
        [actions, keyboardActions, props.controls.mode, props.controls.setMode, props.controls.resetZoom]);
    const publishActions = React.useRef(props.onRemoteActionsChange);
    publishActions.current = props.onRemoteActionsChange;
    React.useEffect(() => { publishActions.current?.(published); return () => publishActions.current?.(null); }, [published]);
    return (
        <View style={stylesheet.fill}>
            <LiveStreamInputLayer
                inputAccepted
                supports={supports}
                mode={props.controls.mode}
                localZoom
                zoomReset={props.controls.zoomReset}
                onViewTransformChange={props.controls.onViewTransformChange}
                renderCursor={props.controls.renderCursor}
                renderDragTrail={props.controls.renderDragTrail}
                viewport={props.viewport}
                content={props.content}
                onGesture={onGesture}
                onClipboardShortcut={props.input.clipboardShortcut}
                accessibilityLabel={props.label}
                testID={props.testID}
            />
            <TextInput ref={keyboard.inputRef} {...keyboard.sentinelProps}
                style={{position: 'absolute', left: 0, bottom: 0, width: 1, height: 1, opacity: 0}}
                accessibilityLabel={t('browserPresence.interaction.showKeyboard')} testID={`${props.testID}-keyboard-sentinel`} />
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
    // The Details pane sits under the phone cockpit's floating tab bar, so its stage (and the presence
    // capsule on it) ends above that bar like every other cockpit pane; the floating frame needs none.
    const bottomChromeHeight = useSessionCockpitBottomChromeHeight();
    const testID = props.testID ?? 'computer-screen-viewer';
    const playerState = props.stream?.playerState ?? null;
    const streamSurfaceState = props.shared ? resolveBrowserStreamedSurfaceState(playerState) : 'unavailable';
    // A stream that stopped on a failure (it carries a reason) did not end because the window closed:
    // say it is unavailable, with its code and Retry, never "closed" (the source may still be shared).
    const surfaceState = streamSurfaceState === 'ended' && playerState?.diagnostic?.reasonCode ? 'unavailable' : streamSurfaceState;
    const pictureUp = surfaceState === 'live' || surfaceState === 'stalled';
    const [viewport, setViewport] = React.useState<Readonly<{ width: number; height: number }> | null>(null);
    const onLayout = React.useCallback((event: LayoutChangeEvent) => {
        const { width, height } = event.nativeEvent.layout;
        if (width > 0 && height > 0) setViewport((current) => (current && current.width === width && current.height === height ? current : { width, height }));
    }, []);
    const frameSize = useFirstFrameSize(pictureUp ? playerState?.lastFrameUrl : null, playerState?.phase);
    // A shared window is a small picture: it fits down to the stage but is never drawn past its own
    // pixels, so a small window stays sharp, centred on the neutral stage, instead of being blown up.
    const pageRect = pictureUp && viewport ? containRect(viewport, frameSize, 1 / PixelRatio.get()) : null;
    const failure = props.failure ?? playerState?.diagnostic?.reasonCode;
    const recovery = failure ? resolveComputerRecovery({ kind: 'failed', code: failure }, resolveComputerAccess(props.access)) : null;
    const needsCapture = recovery?.action === 'capture';
    const needsDriverRepair = recovery?.action === 'repair_driver';
    // A failed Stop sharing is told as that press, whatever its code: the share is still on.
    const stopFailed = props.stopFailed === true && props.failure != null;
    const hasRecovery = stopFailed || (recovery != null && (props.failure != null || recovery.cause !== 'failed'));
    const target = props.targetTitle ?? t('computerUse.presentation.tabFallback');
    const machine = props.machineName ?? '';
    // Inside a sentence the name wraps before it, never at one of its hyphens ("NLDW3-" / "5-36-33").
    const machineWords = keepHyphenatedNameTogether(machine);
    // A sentence that must name where the Computer is never leaves a blank while the Machine's name is unreadable.
    const machineInSentence = machineWords || t('computerUse.presentation.tabFallback');
    const agentName = props.agent.name;
    const screenUnanswered = !stopFailed && recovery?.cause === 'failed' && !props.shared && props.machineOnline === true;
    const recoveryTitle = stopFailed ? t('computerUse.presentation.stopFailed')
        : recovery?.cause === 'driver_missing' ? t('computerUse.presentation.driverMissing')
        : recovery?.cause === 'driver_invalid' ? t('computerUse.presentation.driverInvalid')
        : recovery?.cause === 'geometry_changed' ? t('computerUse.presentation.geometryChanged')
        : recovery?.cause === 'input_unknown' ? t('computerUse.presentation.inputUnknown')
        : recovery?.cause === 'headless' ? t('computerUse.picker.noScreenTitle', { machine: machineWords })
        : recovery?.cause === 'unsupported' ? t('computerUse.picker.unsupportedTitle', { machine: machineWords })
        : recovery?.cause === 'machine_mismatch' ? t('computerUse.picker.otherMachineTitle', { machine: machineWords })
        // Before any window is known to be shared, a failed call says which Machine didn't answer, unless
        // the Machine's own presence says it answers: then the cause is its screen, never the Machine.
        : screenUnanswered ? t('computerUse.presentation.screenUnavailableTitle', { machine: machineInSentence })
        : recovery?.cause === 'offline' || (recovery?.cause === 'failed' && !props.shared) ? t('computerUse.presentation.offlineTitle', { machine: machineInSentence })
        : recovery?.cause === 'access_removed' || recovery?.cause === 'permission_denied' ? t('errors.permissionDenied')
        : recovery?.cause === 'source_lost' ? t('computerUse.presentation.endedTitle', { target })
        : t('computerUse.presentation.unavailableTitle');
    const recoveryReason = stopFailed ? recoveryTitle
        : needsDriverRepair ? t('computerUse.presentation.driverRepairBody')
        : recovery?.cause === 'headless' ? t('computerUse.picker.noScreenBody')
        : recovery?.cause === 'unsupported' ? t('computerUse.picker.unsupportedBody')
        : recovery?.cause === 'machine_mismatch' ? t('computerUse.picker.otherMachineBody')
        : recovery?.cause === 'offline' ? t('computerUse.presentation.offlineBody')
        : recovery?.cause === 'source_lost' ? t('computerUse.presentation.endedBody', { agent: agentName })
        : recoveryTitle;
    // "You can still stop {agent} here" only holds while the capsule offers Take control on a shared window.
    const unavailableReason = !props.shared || props.access === 'see' || props.inputDenied ? undefined : t('computerUse.presentation.unavailableBody', { agent: agentName });
    const recoveryPermission = recovery?.permission;
    const checkAgain = (onPress: () => void) => ({ label: t('computerUse.permission.checkAgain'), onPress, busy: props.checking, disabled: props.checking });
    const recoveryAction = stopFailed
        ? { label: t('common.retry'), onPress: props.onStopSharing, busy: props.stopping, disabled: props.stopping }
        : needsDriverRepair
        ? props.onRepairDriver ? { label: t('computerUse.presentation.repairDriver'), onPress: props.onRepairDriver, busy: props.repairingDriver, disabled: props.repairingDriver } : undefined
        : recovery?.action === 'choose_source' ? { label: t('computerUse.request.choose'), onPress: props.onChooseWindow }
        : recovery?.action === 'open_settings' ? props.onOpenSettings && recoveryPermission
            ? { label: t('computerUse.permission.openPrivacy', { machine: machineWords }), onPress: () => props.onOpenSettings?.(recoveryPermission) } : undefined
        : recovery?.action === 'capture' || recovery?.action === 'refresh' || recovery?.action === 'reconnect'
            ? checkAgain(recovery.action === 'capture' ? props.onCheckAgain : props.onRefresh ?? props.onCheckAgain)
            : undefined;
    const inputOpen = surfaceState === 'live' && !hasRecovery
        && props.presence.kind !== 'unconfirmed' && props.presence.kind !== 'stopping';
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
    const stage = needsPermission && props.grants && props.onOpenSettings ? (
        <View style={stylesheet.centered} testID={`${testID}-permission`}>
            <ComputerPermissionCard
                machineName={machineWords}
                grants={props.grants}
                openSettings={props.openSettings ?? 'idle'}
                onOpenSettings={props.onOpenSettings}
                onCheckAgain={props.onRefresh ?? props.onCheckAgain}
                testID={`${testID}-permission-card`}
            />
        </View>
    ) : hasRecovery && !pictureUp ? (
        <View style={stylesheet.centered}>
            <SurfaceStateCard
                testID={`${testID}-recovery`}
                // A call that failed while (re)opening the share is the same state as a lost stream: one
                // calm unavailable card, its code under Details; only a refusal reads as denied.
                kind={stopFailed ? 'error'
                    : recovery?.cause === 'access_removed' || recovery?.cause === 'permission_denied' ? 'denied'
                    : recovery?.action === null || recovery?.cause === 'offline' || recovery?.cause === 'failed' ? 'unavailable' : 'error'}
                iconName={recovery?.cause === 'failed' && props.shared && !stopFailed ? 'eye-slash' : undefined}
                title={recoveryTitle}
                reason={stopFailed ? undefined
                    : screenUnanswered ? t('computerUse.presentation.screenUnavailableBody')
                    : recovery?.cause === 'failed' ? unavailableReason
                    : recoveryTitle !== recoveryReason ? recoveryReason : undefined}
                // A machine that isn't answering is not a fault: its title says it and the code adds nothing to look up.
                diagnosticCode={recovery?.cause === 'offline' && !stopFailed ? undefined : failure}
                action={recoveryAction}
            />
        </View>
    ) : props.machineOnline === false && !pictureUp ? (
        // Watching is passive: it never wakes the machine, so the way back is the machine's own.
        <View style={stylesheet.centered} testID={`${testID}-offline`}>
            <SurfaceStateCard
                kind="unavailable"
                title={t('computerUse.presentation.offlineTitle', { machine: machineInSentence })}
                reason={t('computerUse.presentation.offlineBody')}
                action={checkAgain(props.onRefresh ?? props.onCheckAgain)}
            />
        </View>
    ) : !props.shared && !props.selectionPending ? (
        <View style={stylesheet.centered} testID={`${testID}-not-shared`}>
            <SurfaceStateCard
                kind="empty"
                iconName="browsers"
                title={t('computerUse.presentation.notSharedTitle')}
                reason={t('computerUse.presentation.notSharedBody', { agent: agentName })}
                action={{ label: t('computerUse.request.choose'), onPress: props.onChooseWindow }}
            />
        </View>
    ) : props.selectionPending || surfaceState === 'connecting' || (props.stream?.connecting && surfaceState === 'unavailable') ? (
        <View style={stylesheet.centered} testID={`${testID}-connecting`}>
            <SurfaceStateCard
                kind="loading"
                title={machine
                    ? t('computerUse.presentation.openingTitle', { target, machine: machineWords })
                    : t('computerUse.presentation.connectingTitle', { target })}
                reason={t('computerUse.presentation.openingBody')}
            />
        </View>
    ) : surfaceState === 'ended' ? (
        <View style={stylesheet.centered} testID={`${testID}-ended`}>
            <SurfaceStateCard
                kind="unavailable"
                iconName="browsers"
                title={t('computerUse.presentation.endedTitle', { target })}
                reason={t('computerUse.presentation.endedBody', { agent: agentName })}
                action={{ label: t('computerUse.request.choose'), onPress: props.onChooseWindow }}
            />
        </View>
    ) : surfaceState === 'unavailable' || !playerState ? (
        <View style={stylesheet.centered} testID={`${testID}-unavailable`}>
            <SurfaceStateCard
                testID={`${testID}-unavailable-card`}
                kind="unavailable"
                iconName="eye-slash"
                title={t('computerUse.presentation.unavailableTitle')}
                reason={unavailableReason}
                diagnosticCode={playerState?.diagnostic?.reasonCode}
                action={onRetryStream && playerState ? { label: t('common.retry'), onPress: onRetryStream } : undefined}
            />
        </View>
    ) : (
        <View style={stylesheet.fill} testID={`${testID}-${surfaceState}`}>
            <RemoteViewerStage key={props.stream?.input?.viewerKey} viewerKey={props.stream?.input?.viewerKey} viewport={viewport ?? {width: 1, height: 1}}
                enabled={Boolean(props.stream?.input && viewport && pageRect && inputOpen)} testID={testID}
                renderInput={controls => props.stream?.input && viewport && pageRect && inputOpen ? (
                    <ViewerStreamInput input={props.stream.input} viewport={viewport} content={pageRect} controls={controls}
                        controlling={props.presence.kind === 'human'} onRemoteActionsChange={props.onRemoteActionsChange}
                        label={t('computerUse.presentation.inputA11y', {target})} testID={`${testID}-input`} />
                ) : null}>
            <View
                testID={`${testID}-picture`}
                style={pageRect
                    ? { position: 'absolute', left: pageRect.x, top: pageRect.y, width: pageRect.width, height: pageRect.height }
                    : stylesheet.fill}
            >
                <LiveStreamPlayer testID={`${testID}-player`} state={playerState} statusOwnedByHost />
            </View>
            </RemoteViewerStage>
            {surfaceState === 'stalled' ? (
                // Only the held picture dims: the empty stage around a small window keeps its paint.
                <View
                    style={[stylesheet.pausedScrim, pageRect ? { left: pageRect.x, top: pageRect.y, width: pageRect.width, height: pageRect.height } : null]}
                    testID={`${testID}-paused-scrim`}
                />
            ) : null}
            {surfaceState === 'stalled' && !hasRecovery && !props.stopping ? (
                <BrowserFrameStatusCapsule
                    testID={`${testID}-stalled`}
                    text={pausedAtMs
                        ? t('computerUse.presentation.paused', { time: formatFrameTime(pausedAtMs) })
                        : t('computerUse.presentation.stalled')}
                    busy={playerState.phase === 'reconnecting'}
                    action={onRetryStream && playerState.phase !== 'reconnecting'
                        ? { label: t('common.retry'), onPress: onRetryStream }
                        : undefined}
                />
            ) : null}
        </View>
    );

    return (
        // Its menus, capsules and lines float over the live picture: they take the picture-safe coat.
        <GlassLivePictureBackdropContext.Provider value>
        <View style={[stylesheet.root, props.chrome === 'none' ? null : { paddingBottom: bottomChromeHeight }]} testID={testID}>
            {props.chrome === 'none' ? null : <View style={stylesheet.bar}>
                {/* The pane's tab already says Computer, so the bar names only what isn't said yet:
                    the shared window, when there is one, and the Machine as its identity chip
                    ("● NLDW3"), never a second "Computer On …" line (DA3 D11). */}
                <View style={stylesheet.barText}>
                    {props.targetTitle ? (
                        <>
                            <Icon
                                name={props.targetKind === 'display' ? 'desktop' : 'browsers'}
                                size={ICON_SIZE.md}
                                color={theme.colors.text.secondary}
                            />
                            <Text style={stylesheet.barTitle} numberOfLines={1} testID={`${testID}-title`}>
                                {target}
                            </Text>
                        </>
                    ) : null}
                    {machine ? (
                        <SessionViewerMachineMark name={machine} online={props.machineOnline} testID={`${testID}-machine`} />
                    ) : null}
                </View>
                {props.shared ? (
                    <DropdownMenu
                        open={menuOpen}
                        onOpenChange={setMenuOpen}
                        items={[
                            { id: 'change', title: t('computerUse.request.change'), testID: `${testID}-change-window` },
                            ...(props.onFloat ? [{ id: 'float', title: t('computerUse.presentation.floatView'), testID: `${testID}-float` }] : []),
                            { id: 'stop', title: t('computerUse.picker.stopSharing'), destructive: true, testID: `${testID}-stop-sharing` },
                        ]}
                        onSelect={(id) => {
                            setMenuOpen(false);
                            if (id === 'change') props.onChooseWindow();
                            else if (id === 'float') props.onFloat?.();
                            else props.onStopSharing();
                        }}
                        matchTriggerWidth={false}
                        popoverAnchorAlign="end"
                        trigger={({ toggle }) => (
                            <IconButton
                                testID={`${testID}-more`}
                                variant="plain"
                                accessibilityLabel={t('computerUse.presentation.moreA11y')}
                                iconName="dots-three"
                                iconSize={ICON_SIZE.md}
                                onPress={toggle}
                            />
                        )}
                    />
                ) : null}
            </View>}
            {pictureUp && hasRecovery ? (
                <SurfaceFreshnessLine testID={`${testID}-recovery`} reason={recoveryReason} asOf={stopFailed ? undefined : pausedAtMs}
                    busy={stopFailed ? props.stopping : needsDriverRepair ? props.repairingDriver : props.checking} tone="warning" action={recoveryAction} />
            ) : pictureUp && props.stopping ? (
                // Release waits for the Machine to drain and confirm; until it answers, say the press is under way.
                <SurfaceFreshnessLine testID={`${testID}-stopping`} reason={t('computerUse.presentation.stopping')} busy />
            ) : pictureUp && props.presence.kind === 'unconfirmed' ? (
                // The stop isn't proved: one quiet warning over the picture says what it means (nobody can
                // use the window from Happier) and the one physical thing that helps. Check again stays on
                // the capsule, so the line carries no second control.
                <SurfaceFreshnessLine
                    testID={`${testID}-unconfirmed`}
                    tone="warning"
                    reason={props.compact
                        ? t('computerUse.presentation.unconfirmedWarningCompact', { agent: agentName, machine: machineWords || target })
                        : `${t('computerUse.presentation.unconfirmedWarning', { agent: agentName, target: props.appName ?? target, machine: machineWords || target })} ${t('computerUse.presentation.unconfirmedStuckHint', { machine: machineWords || target })}`}
                />
            ) : null}
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
                    // The capsule docks to the bottom of its frame: when the picture is smaller than the
                    // stage, the frame is the picture's own rect, so the capsule hugs the picture.
                    <View
                        style={pageRect ? { position: 'absolute', left: pageRect.x, top: pageRect.y, width: pageRect.width, height: pageRect.height } : stylesheet.fill}
                        pointerEvents="box-none"
                        testID={`${testID}-presence-frame`}
                    >
                        <BrowserPresenceCapsule
                            testID={`${testID}-presence`}
                            {...resolveComputerPresenceCapsule(props)}
                            compact={props.compact}
                        />
                    </View>
                ) : null}
            </View>
        </View>
        </GlassLivePictureBackdropContext.Provider>
    );
}
