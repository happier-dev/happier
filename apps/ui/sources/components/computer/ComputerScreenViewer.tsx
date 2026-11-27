import type { ComputerRecordingControl } from './useSessionComputerRecording';
import { BrowserRecordingCapsule } from '@/components/browser/recording/BrowserRecordingCapsule';
import * as React from 'react';
import { useCurrentUiContextLocalCommands } from '@/components/appShell/currentUiContext/CurrentUiContextCommands';
import { PixelRatio, ScrollView, View, type LayoutChangeEvent } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import type { ComputerGrantStatusV1} from '@happier-dev/protocol/computer/v1';
import { resolveComputerAccess } from '@happier-dev/protocol/computer/v1';
import type { ActionExecuteFailure } from '@happier-dev/protocol/actions/actionExecutionResult';

import {
    containRect,
    type BrowserStreamedSurfaceRuntime,
} from '@/components/browser/adapters/BrowserStreamedTarget';
import { buildBrowserStreamSidebandControl } from '@/components/browser/adapters/browserStreamSidebandControl';
import { BrowserPresenceFooter, type BrowserPresenceAgent, type BrowserPresenceCapsuleProps } from '@/components/browser/copresence/BrowserPresenceCapsule';
import { BrowserAgentCursor } from '@/components/browser/copresence/BrowserAgentCursor';
import { BrowserFrameStatusCapsule } from '@/components/browser/frame/BrowserFrameStatusCapsule';
import { RemoteViewerStage, remoteViewerFillTransform, useRemoteViewerFillsPane, type RemoteViewerStageControls, type RemoteViewerHostActions } from '@/components/stream/RemoteViewerStage';
import { useRemoteViewerActions } from '@happier-dev/plugin-ui/presentation';
import { RemoteViewerControlBar, RemoteViewerHandBackScope, useRemoteViewerControlsRoom } from '@/components/stream/RemoteViewerControlBar';
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
import { presentActionExecutionFailure } from '@/sync/ops/actions/resolveActionExecutionFailureMessage';
import { showActionFailureDetails } from '@/utils/errors/alertActionFailure';

import { ComputerPermissionCard, type ComputerOpenSettingsState } from './ComputerPermissionCard';
import {
    ComputerScreenStreamOwner,
    ComputerScreenStreamScope,
    useComputerScreenChrome,
    useComputerScreenPicture,
    type ComputerScreenStreamRequest,
} from './ComputerScreenStreamScope';

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
    // A state that is not a picture is centred while it fits and reads from its top while it does not:
    // the stage's aspect box never clips its heading or its way forward.
    stateStage: {
        flex: 1,
        minHeight: 0,
    },
    stateStageContent: {
        flexGrow: 1,
        justifyContent: 'center',
    },
    // The last picture stays, dimmed, while the stream is paused: never a blank box.
    pausedScrim: {
        ...StyleSheet.absoluteFillObject,
        backgroundColor: theme.colors.overlay.scrimSoft,
        pointerEvents: 'none',
    },
}));

function ComputerStateStage(props: React.PropsWithChildren<Readonly<{ testID?: string }>>): React.ReactElement {
    return (
        <ScrollView
            style={stylesheet.stateStage}
            contentContainerStyle={stylesheet.stateStageContent}
            showsVerticalScrollIndicator={false}
            testID={props.testID}
        >
            {props.children}
        </ScrollView>
    );
}

export type ComputerScreenViewerProps = Readonly<{
    /** The Session's recorder for this source; a Machine's own page has none. */
    recording?: ComputerRecordingControl | null;
    agent: BrowserPresenceAgent;
    /** No Session agent to name (a Machine's own Computer page): the sentences speak of agents on the Machine. */
    agentless?: boolean;
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
    /** Live callers leave frame ingestion beneath the control model; specimens may supply `stream`. */
    streamInput?: ComputerScreenStreamRequest;
    onRemoteActionsChange?: (actions: RemoteViewerHostActions | null) => void;
    presence: BrowserCopresence;
    /** The agent's action is in flight ("is using"), not merely allowed ("can use"). */
    agentActing: boolean;
    checking?: boolean;
    /** The person's Stop sharing is in flight. */
    stopping?: boolean;
    failure?: string | null;
    actionFailure?: ActionExecuteFailure;
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
    /** The reachability owner's one explanation for an unavailable Machine. */
    offlineReason?: string | null;
    /**
     * The machine's OS grants for the shared source. While screen capture is not granted there is no
     * picture to show, and the picture says which permission to allow and where.
     */
    grants?: ComputerGrantStatusV1 | null;
    openSettings?: ComputerOpenSettingsState;
    openSettingsFailure?: ActionExecuteFailure;
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
    onControlsLayout(event: LayoutChangeEvent): void;
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
    const actions = useRemoteViewerActions({enabled: props.controlling, sendGesture: sendAction, clipboardShortcut: props.input.clipboardShortcut});
    const keyboard = useBrowserSoftKeyboard({enabled: props.controlling, target: null, manual: true, sendText: actions.sendText, sendKey: actions.sendKey});
    const keyboardActions = React.useMemo(() => ({available: keyboard.available, focused: keyboard.focused,
        showKeyboard: keyboard.showKeyboard, hideKeyboard: keyboard.hideKeyboard}),
        [keyboard.available, keyboard.focused, keyboard.showKeyboard, keyboard.hideKeyboard]);
    const onGesture = React.useCallback((gesture: Readonly<{eventId: string; action: LiveStreamInputGesture}>) => {
        const action = props.controlling ? actions.prepareGesture(gesture.action) : gesture.action;
        if (action) sendGesture({...gesture, action});
    }, [actions.prepareGesture, props.controlling, sendGesture]);
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
                restTransform={props.controls.restTransform}
                dragPansView={props.controls.dragPansView}
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
            <RemoteViewerControlBar actions={published} controls={props.controls} enabled={props.controlling}
                onLayout={props.onControlsLayout} testID={`${props.testID}-controls`} />
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
    const body = <ComputerScreenViewerBody {...props} />;
    return props.streamInput
        ? <ComputerScreenStreamOwner input={props.streamInput}>{body}</ComputerScreenStreamOwner>
        : <ComputerScreenStreamScope runtime={props.stream}>{body}</ComputerScreenStreamScope>;
}

function ComputerStreamPicture(props: Readonly<{ testID: string }>): React.ReactElement | null {
    const runtime = useComputerScreenPicture();
    return runtime?.playerState
        ? <LiveStreamPlayer testID={props.testID} state={runtime.playerState} statusOwnedByHost />
        : null;
}

function ComputerScreenViewerBody(props: ComputerScreenViewerProps): React.ReactElement {
    const { theme } = useUnistyles();
    // The Details pane sits under the phone cockpit's floating tab bar, so its stage (and the presence
    // capsule on it) ends above that bar like every other cockpit pane; the floating frame needs none.
    const bottomChromeHeight = useSessionCockpitBottomChromeHeight();
    const testID = props.testID ?? 'computer-screen-viewer';
    const stream = useComputerScreenChrome();
    const streamSurfaceState = props.shared ? stream.surfaceState : 'unavailable';
    // A stream that stopped on a failure (it carries a reason) did not end because the window closed:
    // say it is unavailable, with its code and Retry, never "closed" (the source may still be shared).
    const surfaceState = streamSurfaceState === 'ended' && stream.diagnosticCode ? 'unavailable' : streamSurfaceState;
    const pictureUp = surfaceState === 'live' || surfaceState === 'stalled';
    const [viewport, setViewport] = React.useState<Readonly<{ width: number; height: number }> | null>(null);
    const onLayout = React.useCallback((event: LayoutChangeEvent) => {
        const { width, height } = event.nativeEvent.layout;
        if (width > 0 && height > 0) setViewport((current) => (current && current.width === width && current.height === height ? current : { width, height }));
    }, []);
    const frameSize = stream.frameSize;
    const failure = props.failure ?? stream.diagnosticCode;
    const actionFailure = props.failure ? props.actionFailure : undefined;
    const recovery = failure ? resolveComputerRecovery({ kind: 'failed', code: failure, details: actionFailure?.details }, resolveComputerAccess(props.access)) : null;
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
    const offlineTitle = props.offlineReason ?? t('computerUse.presentation.offlineTitle', { machine: machineInSentence });
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
        : recovery?.cause === 'offline' || (recovery?.cause === 'failed' && (!props.shared || props.offlineReason != null)) ? offlineTitle
        : recovery?.cause === 'access_removed' || recovery?.cause === 'permission_denied' ? t('errors.permissionDenied')
        : recovery?.cause === 'source_lost' ? t('computerUse.presentation.endedTitle', { target })
        : t('computerUse.presentation.unavailableTitle');
    const recoveryReason = stopFailed ? recoveryTitle
        : needsDriverRepair ? t('computerUse.presentation.driverRepairBody', { machine: machineInSentence })
        : recovery?.cause === 'input_unknown' && recovery.code ? `${recoveryTitle} (${recovery.code})`
        : recovery?.cause === 'headless' ? t('computerUse.picker.noScreenBody')
        : recovery?.cause === 'unsupported' ? t('computerUse.picker.unsupportedBody')
        : recovery?.cause === 'machine_mismatch' ? t('computerUse.picker.otherMachineBody')
        : recovery?.cause === 'offline' ? props.offlineReason ?? t('computerUse.presentation.offlineBody')
        : recovery?.cause === 'source_lost' ? t('computerUse.presentation.endedBody', { agent: agentName })
        : recoveryTitle;
    const failureDetails = React.useMemo(() => {
        if (!actionFailure) return null;
        const { technicalDetails } = presentActionExecutionFailure(actionFailure, recoveryReason, { closedCodesOnly: true });
        const context = technicalDetails.filter(line => line.key !== 'code');
        return {
            code: actionFailure.errorCode,
            context: Object.fromEntries(context.map(line => [line.key, line.value])),
            inline: context.map(line => `${line.label}: ${line.value}`).join('\n'),
        };
    }, [actionFailure, recoveryReason]);
    // "You can still stop {agent} here" only holds while the capsule offers Take control on a shared window.
    const unavailableReason = !props.shared || props.access === 'see' || props.inputDenied ? undefined : props.agentless ? t('computerUse.presentation.unavailableBodyMachine') : t('computerUse.presentation.unavailableBody', { agent: agentName });
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
    // A finger's control bar has its own row: the picture fits above it (the one room rule).
    const { pictureArea, onControlsLayout } = useRemoteViewerControlsRoom(viewport,
        inputOpen && Boolean(stream.input) && props.presence.kind === 'human');
    // A shared window is a small picture: it fits down to the stage but is never drawn past its own
    // pixels, so a small window stays sharp, centred on the neutral stage, instead of being blown up.
    const pageRect = pictureUp && pictureArea ? containRect(pictureArea, frameSize, 1 / PixelRatio.get()) : null;
    // On a phone a viewer who only watches sees the picture fill the stage (the stage owns that view). What is
    // drawn over the picture outside the stage (the paused scrim, the Agent's cursor) follows that resting view.
    const passive = props.presence.kind !== 'human';
    const fillsPane = useRemoteViewerFillsPane(passive);
    // The window's own size at one window pixel per device pixel; the fill is measured against it (see the stage).
    const pictureSize = React.useMemo(() => frameSize ? { width: frameSize.width / PixelRatio.get(), height: frameSize.height / PixelRatio.get() } : null,
        [frameSize]);
    const restView = fillsPane && pageRect && viewport ? remoteViewerFillTransform(viewport, pageRect, pictureSize ?? pageRect) : null;
    const shownRect = restView && pageRect ? { x: pageRect.x * restView.scale + restView.x, y: pageRect.y * restView.scale + restView.y,
        width: pageRect.width * restView.scale, height: pageRect.height * restView.scale } : pageRect;
    const [menuOpen, setMenuOpen] = React.useState(false);
    const onPictureChange = props.onPictureChange;
    const frameWidth = frameSize?.width;
    const frameHeight = frameSize?.height;
    React.useEffect(() => {
        onPictureChange?.({ up: pictureUp, size: frameWidth && frameHeight ? { width: frameWidth, height: frameHeight } : null });
    }, [frameHeight, frameWidth, onPictureChange, pictureUp]);

    const recordingFailure = props.recording?.failure;
    const recordingFailurePresentation = recordingFailure ? presentActionExecutionFailure(recordingFailure,
        t('common.error'), { closedCodesOnly: true }) : null;
    const pausedAtMs = stream.pausedAtMs;
    const onRetryStream = stream.onRetry;
    const needsPermission = computerCaptureNeedsPermission(props);
    const stage = needsPermission && props.grants && props.onOpenSettings ? (
        <ComputerStateStage testID={`${testID}-permission`}>
            <ComputerPermissionCard
                machineName={machineWords}
                grants={props.grants}
                openSettings={props.openSettings ?? 'idle'}
                openSettingsFailure={props.openSettingsFailure}
                onOpenSettings={props.onOpenSettings}
                onCheckAgain={props.onRefresh ?? props.onCheckAgain}
                testID={`${testID}-permission-card`}
            />
        </ComputerStateStage>
    ) : hasRecovery && !pictureUp ? (
        <ComputerStateStage>
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
                    : recovery?.cause === 'failed' && props.offlineReason != null ? undefined
                    : screenUnanswered ? t('computerUse.presentation.screenUnavailableBody')
                    : recovery?.cause === 'failed' ? unavailableReason
                    : recoveryTitle !== recoveryReason ? recoveryReason : undefined}
                // A machine that isn't answering is not a fault: its title says it and the code adds nothing to look up.
                diagnosticCode={recovery?.cause === 'offline' && !stopFailed ? undefined : failure}
                diagnosticDetail={failureDetails?.inline}
                action={recoveryAction}
            />
        </ComputerStateStage>
    ) : props.machineOnline === false && !pictureUp ? (
        // Watching is passive: it never wakes the machine, so the way back is the machine's own.
        <ComputerStateStage testID={`${testID}-offline`}>
            <SurfaceStateCard
                kind="unavailable"
                title={offlineTitle}
                reason={props.offlineReason ? undefined : t('computerUse.presentation.offlineBody')}
                action={checkAgain(props.onRefresh ?? props.onCheckAgain)}
            />
        </ComputerStateStage>
    ) : !props.shared && !props.selectionPending ? (
        <ComputerStateStage testID={`${testID}-not-shared`}>
            <SurfaceStateCard
                kind="empty"
                iconName="browsers"
                title={t('computerUse.presentation.notSharedTitle')}
                reason={props.agentless ? t('computerUse.presentation.notSharedBodyMachine') : t('computerUse.presentation.notSharedBody', { agent: agentName })}
                action={{ label: t('computerUse.request.choose'), onPress: props.onChooseWindow }}
            />
        </ComputerStateStage>
    ) : props.selectionPending || surfaceState === 'connecting' || (stream.connecting && surfaceState === 'unavailable') ? (
        <ComputerStateStage testID={`${testID}-connecting`}>
            <SurfaceStateCard
                kind="loading"
                title={machine
                    ? t('computerUse.presentation.openingTitle', { target, machine: machineWords })
                    : t('computerUse.presentation.connectingTitle', { target })}
                reason={t('computerUse.presentation.openingBody')}
            />
        </ComputerStateStage>
    ) : surfaceState === 'ended' ? (
        <ComputerStateStage testID={`${testID}-ended`}>
            <SurfaceStateCard
                kind="unavailable"
                iconName="browsers"
                title={t('computerUse.presentation.endedTitle', { target })}
                reason={t('computerUse.presentation.endedBody', { agent: agentName })}
                action={{ label: t('computerUse.request.choose'), onPress: props.onChooseWindow }}
            />
        </ComputerStateStage>
    ) : surfaceState === 'unavailable' || !stream.hasPlayer ? (
        <ComputerStateStage testID={`${testID}-unavailable`}>
            <ComputerStreamRetry onRetry={stream.hasPlayer ? onRetryStream : undefined}>{action => (
                <SurfaceStateCard
                    testID={`${testID}-unavailable-card`}
                    kind="unavailable"
                    iconName="eye-slash"
                    title={t('computerUse.presentation.unavailableTitle')}
                    reason={unavailableReason}
                    diagnosticCode={stream.diagnosticCode}
                    action={action}
                />
            )}</ComputerStreamRetry>
        </ComputerStateStage>
    ) : (
        <View style={stylesheet.fill} testID={`${testID}-${surfaceState}`}>
            <RemoteViewerStage key={stream.input?.viewerKey} viewerKey={stream.input?.viewerKey} viewport={viewport ?? {width: 1, height: 1}}
                content={pageRect} pictureSize={pictureSize} passive={passive}
                enabled={Boolean(stream.input && viewport && pageRect && inputOpen)} testID={testID}
                renderInput={controls => stream.input && viewport && pageRect && inputOpen ? (
                    <ViewerStreamInput input={stream.input} viewport={viewport} content={pageRect} controls={controls}
                        controlling={props.presence.kind === 'human'} onRemoteActionsChange={props.onRemoteActionsChange}
                        onControlsLayout={onControlsLayout}
                        label={t('computerUse.presentation.inputA11y', {target})} testID={`${testID}-input`} />
                ) : null}>
            <View
                testID={`${testID}-picture`}
                style={pageRect
                    ? { position: 'absolute', left: pageRect.x, top: pageRect.y, width: pageRect.width, height: pageRect.height }
                    : stylesheet.fill}
            >
                <ComputerStreamPicture testID={`${testID}-player`} />
            </View>
            </RemoteViewerStage>
            {surfaceState === 'stalled' ? (
                // Only the held picture dims: the empty stage around a small window keeps its paint.
                <View
                    style={[stylesheet.pausedScrim, shownRect ? { left: shownRect.x, top: shownRect.y, width: shownRect.width, height: shownRect.height } : null]}
                    testID={`${testID}-paused-scrim`}
                />
            ) : null}
            {surfaceState === 'stalled' && !hasRecovery && !props.stopping ? (
                <ComputerStreamRetry onRetry={stream.phase !== 'reconnecting' ? onRetryStream : undefined}>{action => (
                    <BrowserFrameStatusCapsule
                        testID={`${testID}-stalled`}
                        text={pausedAtMs
                            ? t('computerUse.presentation.paused', { time: formatFrameTime(pausedAtMs) })
                            : t('computerUse.presentation.stalled')}
                        busy={stream.phase === 'reconnecting'}
                        action={action}
                    />
                )}</ComputerStreamRetry>
            ) : null}
        </View>
    );

    return (
        // Its menus, capsules and lines float over the live picture: they take the picture-safe coat.
        <GlassLivePictureBackdropContext.Provider value>
        <RemoteViewerHandBackScope>
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
                {props.shared && props.recording?.recording ? (
                    <BrowserRecordingCapsule recording={props.recording.recording} onStop={props.recording.onStop} testID={`${testID}-recording`} />
                ) : null}
                {props.shared ? (
                    <DropdownMenu
                        open={menuOpen}
                        onOpenChange={setMenuOpen}
                        items={[
                            { id: 'change', title: t('computerUse.request.change'), testID: `${testID}-change-window` },
                            ...(props.onFloat ? [{ id: 'float', title: t('presentation.floatView'), testID: `${testID}-float` }] : []),
                            ...(props.recording ? [props.recording.recording
                                ? { id: 'discard-recording', title: t('browserPresence.recording.discard'), destructive: true, testID: `${testID}-discard-recording` }
                                : { id: 'record', title: t('browserRecording.actions.start'), testID: `${testID}-record` }] : []),
                            { id: 'stop', title: t('computerUse.picker.stopSharing'), testID: `${testID}-stop-sharing` },
                        ]}
                        onSelect={(id) => {
                            setMenuOpen(false);
                            if (id === 'change') props.onChooseWindow();
                            else if (id === 'float') props.onFloat?.();
                            else if (id === 'record') props.recording?.onStart();
                            else if (id === 'discard-recording') props.recording?.onDiscard();
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
            {props.shared && recordingFailure && recordingFailurePresentation ? (
                <ComputerRecoveryLine testID={`${testID}-recording-failure`} reason={recordingFailurePresentation.reason} tone="warning"
                    failureDetails={{ code: recordingFailure.errorCode,
                        context: Object.fromEntries(recordingFailurePresentation.technicalDetails.filter(line => line.key !== 'code')
                            .map(line => [line.key, line.value])) }} />
            ) : null}
            {pictureUp && hasRecovery ? (
                <ComputerRecoveryLine testID={`${testID}-recovery`} reason={recoveryReason} asOf={stopFailed ? undefined : pausedAtMs}
                    busy={stopFailed ? props.stopping : needsDriverRepair ? props.repairingDriver : props.checking} tone="warning" action={recoveryAction}
                    failureDetails={failureDetails} />
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
                        pageRect={shownRect}
                        agentId={props.agent.agentId}
                        testID={`${testID}-agent-cursor`}
                    />
                ) : null}
            </View>
            {props.shared && props.chrome !== 'none' && !needsPermission ? (
                // Reserve the capsule's own height below the picture and its input controls. A dock
                // over the picture can cover Escape and the keyboard toggle when the picture fills it.
                <BrowserPresenceFooter
                    frameTestID={`${testID}-presence-frame`}
                    testID={`${testID}-presence`}
                    {...resolveComputerPresenceCapsule(props)}
                    compact={props.compact}
                />
            ) : null}
        </View>
        </RemoteViewerHandBackScope>
        </GlassLivePictureBackdropContext.Provider>
    );
}


function ComputerRecoveryLine(props: React.ComponentProps<typeof SurfaceFreshnessLine> & Readonly<{
    failureDetails: Parameters<typeof showActionFailureDetails>[0] | null;
}>): React.ReactElement {
    const { failureDetails, ...lineProps } = props;
    const details = failureDetails ? { label: t('common.details'), onPress: () => showActionFailureDetails(failureDetails) } : undefined;
    useCurrentUiContextLocalCommands(details ? [{ key: 'details', title: details.label, invoke: details.onPress }] : []);
    return <SurfaceFreshnessLine {...lineProps} actions={details ? [
        ...(lineProps.action ? [lineProps.action] : []), details,
    ] : undefined} />;
}


function ComputerStreamRetry(props: Readonly<{
    onRetry: (() => void) | undefined;
    children: (action: React.ComponentProps<typeof SurfaceStateCard>['action']) => React.ReactNode;
}>): React.ReactElement {
    const action = props.onRetry ? { label: t('common.retry'), onPress: props.onRetry } : undefined;
    useCurrentUiContextLocalCommands(action ? [{ key: 'retry', title: action.label, invoke: action.onPress }] : []);
    return <>{props.children(action)}</>;
}
