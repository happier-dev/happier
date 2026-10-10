import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import type { ComputerGrantStatusV1 } from '@happier-dev/protocol';

import type { BrowserStreamedSurfaceRuntime } from '@/components/browser/adapters/BrowserStreamedTarget';
import { ComputerActionApprovalCard, describeComputerActionApproval } from '@/components/approvals/ComputerActionApprovalCard';
import { ComputerScreenViewer } from '@/components/computer/ComputerScreenViewer';
import { ComputerTargetPicker, computerTargetKey, type ComputerTargetEntry } from '@/components/computer/ComputerTargetPicker';
import { computerTargetPickerChrome } from '@/components/computer/showComputerTargetPicker';
import { LUMEN_LOGIN_FRAME_DARK, LUMEN_LOGIN_FRAME_LIGHT } from '@/components/dev/browser/lumenLoginFrame';
import { SurfaceStateSizeProvider } from '@/components/ui/surfaces/surfaceStateSize';
import { BrowserPresenceCapsule } from '@/components/browser/copresence/BrowserPresenceCapsule';
import { ComputerActionResultReference } from '@/components/sessions/transcript/references/ComputerActionResultReference';
import type { ToolCall } from '@happier-dev/session-core/messages';
import { Modal } from '@/modal';
import { t } from '@/text';
import type { CustomModalInjectedProps } from '@/modal/types';
import type { BrowserCopresence } from '@/sync/domains/browser/automation/copresence';
import { FloatingFrame, resolveFloatingFrameHeight } from '@happier-dev/plugin-ui/presentation';
import {
    useOptionalSessionViewerController,
    usePublishSessionViewerPresence,
    usePublishSessionViewerSourceFacts,
} from '@/components/sessions/viewer/SessionViewerController';
import { SessionViewerControllerProvider } from '@/components/sessions/viewer/SessionViewerControllerProvider';
import { SessionViewerControls } from '@/components/sessions/viewer/SessionViewerControls';
import { SessionViewerPicture } from '@/components/sessions/viewer/SessionViewerPicture';
import { SessionViewerPresenceFooter } from '@/components/sessions/viewer/SessionViewerPresenceFooter';
import { SESSION_VIEWER_DEFAULT_ASPECT } from '@/components/sessions/viewer/sessionViewerGeometry';

/**
 * Dev-only specimen of computer use (lab `computer` TP, OG, CS, LV, K, UN, ST) drawn through the real
 * components at static props, so the lab and the app can be compared side by side without a native
 * driver. The window's pixels are the lab's own page (a fixture); the controller states are the
 * computer owner's (`control.status`) projected through the real presence projection's shapes.
 */
const NOOP = () => undefined;
const AGENT = { agentId: 'claude', name: 'Claude' } as const;
const MACHINE = 'MacBook Pro';
const TITLE = 'Sign in to Lumen';

const TARGETS: readonly ComputerTargetEntry[] = [
    { target: { kind: 'window', displayId: ':0', pid: 101, windowId: 1 }, title: TITLE },
    { target: { kind: 'window', displayId: ':0', pid: 102, windowId: 2 }, title: 'iPhone 16 · Lumen' },
    { target: { kind: 'window', displayId: ':0', pid: 103, windowId: 3 }, title: 'Sign-in v3 — Figma' },
    { target: { kind: 'window', displayId: ':0', pid: 104, windowId: 4 }, title: 'lumen — zsh' },
    { target: { kind: 'display', displayId: ':0' }, title: 'Built-in display' },
];
const GRANTED: ComputerGrantStatusV1 = { capture: 'granted', input: 'granted' };
const DENIED: ComputerGrantStatusV1 = { capture: 'denied', input: 'granted' };

function SpecimenPicker(props: CustomModalInjectedProps & Readonly<{ grants: ComputerGrantStatusV1; chosen: boolean; phone: boolean; suggested?: boolean }>) {
    return (
        <ComputerTargetPicker
            machineName={MACHINE}
            state={{ kind: 'ready', targets: TARGETS, grants: props.grants }}
            // TP opens as the person sees it (nothing chosen, Share disabled); TPc after they tap a window.
            selectedKey={props.chosen || props.suggested ? computerTargetKey(TARGETS[0]!.target) : null}
            onSelect={NOOP}
            access="use"
            onAccessChange={NOOP}
            sharing={false}
            noticeCode={null}
            canStopSharing={false}
            onShare={NOOP}
            onStopSharing={NOOP}
            onCancel={props.onClose}
            onRetry={NOOP}
            onOpenSettings={NOOP}
            openSettings={props.grants === DENIED ? 'opened' : 'idle'}
            agentName={AGENT.name}
            policy={{ asksBeforeScreenshots: true, asksBeforeInput: true }}
            onChangePolicy={NOOP}
            compact={props.phone}
            suggestedKey={props.suggested ? computerTargetKey(TARGETS[0]!.target) : null}
        />
    );
}

/** The picker in its real card chrome (the modal host), opened on mount like the person's press. */
function PickerFrame(props: Readonly<{ grants: ComputerGrantStatusV1; chosen?: boolean; suggested?: boolean; phone: boolean }>) {
    React.useEffect(() => {
        // The modal host registers after the first route effect; open on the next frame it is ready.
        let id = '';
        let timer: ReturnType<typeof setTimeout> | null = null;
        const open = () => {
            id = Modal.show({
                component: SpecimenPicker,
                props: { grants: props.grants, chosen: props.chosen === true, suggested: props.suggested === true, phone: props.phone },
                chrome: computerTargetPickerChrome({ agentName: AGENT.name, machineName: MACHINE, purpose: t('computerUse.picker.purposeIn', { session: 'Check the sign-in flow', project: 'happier' }) }),
            });
            if (!id) timer = setTimeout(open, 250);
        };
        timer = setTimeout(open, 250);
        return () => {
            if (timer) clearTimeout(timer);
            if (id) Modal.hide(id);
        };
    }, [props.chosen, props.grants, props.phone, props.suggested]);
    return null;
}

function ConsentFrame() {
    const presentation = describeComputerActionApproval({
        actionId: 'computer.input',
        actionArgs: { machineId: 'machine_1', captureId: 'capture_1', operation: { kind: 'type', text: 'qa@lumen.dev' } },
        preview: { computerApprovalDisplay: { machineDisplayName: MACHINE, requiresTargetSelection: false, target: { kind: 'window', title: TITLE } } },
    });
    const choose = describeComputerActionApproval({
        actionId: 'computer.capture',
        actionArgs: { machineId: 'machine_1' },
        preview: { computerApprovalDisplay: { machineDisplayName: MACHINE, requiresTargetSelection: true } },
    });
    return (
        <View style={styles.cards}>
            {choose ? <View style={styles.card}><ComputerActionApprovalCard presentation={choose} onChooseTarget={NOOP} /></View> : null}
            {presentation ? <View style={styles.card}><ComputerActionApprovalCard presentation={presentation} /></View> : null}
        </View>
    );
}

type StreamFixture = 'live' | 'connecting' | 'stalled' | 'ended';

function useStream(fixture: StreamFixture): BrowserStreamedSurfaceRuntime {
    const { rt } = useUnistyles();
    const frameUrl = rt.themeName === 'dark' ? LUMEN_LOGIN_FRAME_DARK : LUMEN_LOGIN_FRAME_LIGHT;
    const base = { selectedCodec: 'image.frame.v1', activeRenderer: 'mjpeg', decodedFrames: 1, droppedFrames: 0, bufferedBytes: 0 } as const;
    const input = { sourceId: 'computer:specimen', streamId: 'computer-live:specimen', send: NOOP };
    switch (fixture) {
        case 'connecting': return { machineName: MACHINE, connecting: true, playerState: { ...base, phase: 'opening' }, input };
        case 'stalled': return { machineName: MACHINE, playerState: { ...base, phase: 'reconnecting', lastFrameUrl: frameUrl }, input };
        case 'ended': return { machineName: MACHINE, playerState: { ...base, phase: 'stopped', lastFrameUrl: frameUrl }, input };
        case 'live': return { machineName: MACHINE, playerState: { ...base, phase: 'playing', lastFrameUrl: frameUrl }, input };
    }
}

const PRESENCE = {
    agent: { kind: 'agent', activity: null, target: null, controlEpoch: 1 },
    stopping: { kind: 'stopping', controlEpoch: 1 },
    unconfirmed: { kind: 'unconfirmed', controlEpoch: 2 },
    human: { kind: 'human', controlEpoch: 2, interruptedCompletion: null },
} as const satisfies Record<string, BrowserCopresence>;

function ViewerFrame(props: Readonly<{ presence: keyof typeof PRESENCE; stream: StreamFixture; shared?: boolean; phone: boolean }>) {
    const stream = useStream(props.stream);
    return (
        <ComputerScreenViewer
            agent={AGENT}
            targetTitle={TITLE}
            targetKind="window"
            machineName={MACHINE}
            shared={props.shared !== false}
            stream={stream}
            presence={PRESENCE[props.presence]}
            agentActing={props.presence === 'agent'}
            onTakeControl={NOOP}
            onHandBack={NOOP}
            onCheckAgain={NOOP}
            onChooseWindow={NOOP}
            onStopSharing={NOOP}
            compact={props.phone}
        />
    );
}

/** The viewer's own facts and presence, as the Computer body publishes them. */
function WatchSource(props: Readonly<{ presence: keyof typeof PRESENCE }>) {
    const viewer = useOptionalSessionViewerController();
    const port = viewer?.port;
    React.useEffect(() => { port?.apply({ kind: 'viewer.open', source: 'computer' }); }, [port]);
    const presence = PRESENCE[props.presence];
    usePublishSessionViewerSourceFacts('computer', {
        machineName: MACHINE, personInControl: presence.kind === 'human', watching: presence.kind === 'agent',
        chooseTarget: NOOP, stopSharing: NOOP,
    });
    const published = React.useMemo(() => ({
        presence, agent: AGENT, onTakeControl: NOOP, onHandBack: NOOP, onCheckAgain: NOOP,
        agentTitle: presence.kind === 'agent' ? t('computerUse.viewer.agentUsing', { agent: AGENT.name, target: TITLE }) : undefined,
    }), [presence]);
    usePublishSessionViewerPresence('computer', published);
    return null;
}

/**
 * Lab `b-watch` A/K: the floating viewer as the Session host composes it — the shared frame, its
 * real controls and presence footer, and the chromeless Computer picture — at the lab's 420 width,
 * bottom-right of a reading area, without a native driver.
 */
function WatchFrame(props: Readonly<{ presence: keyof typeof PRESENCE; phone: boolean }>) {
    const stream = useStream('live');
    const width = props.phone ? 358 : 420;
    const height = resolveFloatingFrameHeight(width, SESSION_VIEWER_DEFAULT_ASPECT, { footer: true });
    const area = { x: 0, y: 0, width: props.phone ? 358 : 1000, height: props.phone ? height : 640 };
    const rect = { x: area.width - width, y: area.height - height, width, height };
    const presence = PRESENCE[props.presence];
    return (
        <SessionViewerControllerProvider sessionId="specimen-session" serverId={null} phone={props.phone}
            canPresentSource={() => true} openDocked={NOOP}>
            <WatchSource presence={props.presence} />
            <View style={{ width: area.width, height: area.height }} testID="specimen-watch-area">
                <FloatingFrame
                    testID="session-viewer-frame"
                    mode={props.phone ? 'docked' : 'floating'}
                    rect={rect}
                    availableRect={area}
                    aspectRatio={SESSION_VIEWER_DEFAULT_ASPECT}
                    moveInput={presence.kind === 'agent' ? 'surface' : 'chrome'}
                    onRectChange={NOOP}
                    onModeChange={NOOP}
                    controlsAlwaysVisible
                    accessibilityLabel={t('computerUse.viewer.watchingA11y', { source: t('computerUse.viewer.sourceComputer'), machine: MACHINE })}
                    controls={<SessionViewerControls sessionId="specimen-session" serverId={null} source="computer" />}
                    footer={<SessionViewerPresenceFooter source="computer" compact={props.phone} />}
                >
                    <SessionViewerPicture framed source="computer">
                        <ComputerScreenViewer
                            agent={AGENT}
                            targetTitle={TITLE}
                            targetKind="window"
                            machineName={MACHINE}
                            shared
                            stream={stream}
                            presence={presence}
                            agentActing={presence.kind === 'agent'}
                            onTakeControl={NOOP}
                            onHandBack={NOOP}
                            onCheckAgain={NOOP}
                            onChooseWindow={NOOP}
                            onStopSharing={NOOP}
                            chrome="none"
                            compact={props.phone}
                        />
                    </SessionViewerPicture>
                </FloatingFrame>
            </View>
        </SessionViewerControllerProvider>
    );
}

/** The session-wide strip at the top of the transcript (lab HC), drawn with the real capsule strip. */
function SessionLineFrame(props: Readonly<{ phone: boolean; presence: keyof typeof PRESENCE }>) {
    return (
        <View style={styles.chat}>
            <View style={styles.stripFrame}>
                <BrowserPresenceCapsule
                    testID="specimen-session-computer-presence"
                    placement="strip"
                    compact={props.phone}
                    presence={PRESENCE[props.presence]}
                    agent={AGENT}
                    agentTitle={props.presence === 'agent' ? t('computerUse.strip.using', { target: TITLE }) : undefined}
                    agentDetail={t('computerUse.strip.on', { machine: MACHINE })}
                    humanTitle={t('computerUse.strip.paused', { agent: AGENT.name })}
                    humanDetail={t('computerUse.strip.pausedDetail', { target: TITLE })}
                    takeControlLabel={t('computerUse.strip.stop')}
                    onTakeControl={NOOP}
                    onHandBack={NOOP}
                    onCheckAgain={NOOP}
                    onWatch={NOOP}
                />
            </View>
            <View style={styles.grow} />
        </View>
    );
}

const TX_INPUT = (operation: unknown) => ({ actionId: 'computer.input', input: { machineId: 'machine_1', captureId: 'c', operation } });
const TX_TARGET = { kind: 'window', displayId: ':0', pid: 101, windowId: 1 } as const;
const TX_CALLS = [
    { id: 'choose', state: 'completed', input: { actionId: 'computer.capture', input: { machineId: 'machine_1' } },
        result: JSON.stringify({ status: 'target_selection_required', approvalDisplay: { machineDisplayName: MACHINE, requiresTargetSelection: true } }) },
    { id: 'capture', state: 'completed', input: { actionId: 'computer.capture', input: { machineId: 'machine_1' } },
        result: JSON.stringify({ status: 'captured', target: TX_TARGET, sourceId: 's', captureId: 'c',
            geometry: { captureWidth: 1280, captureHeight: 800, nativeWidth: 1280, nativeHeight: 800, originX: 0, originY: 0, scaleX: 1, scaleY: 1, crop: { x: 0, y: 0, width: 1280, height: 800 } },
            media: { mediaId: 'm', mediaKind: 'image', width: 1280, height: 800, sizeBytes: 1,
                file: { sessionId: 'specimen-session', storage: 'daemon', path: 'media/c.png', sha256: 'a'.repeat(64), mimeType: 'image/png' } } }) },
    { id: 'click', state: 'completed', input: TX_INPUT({ kind: 'click', x: 10, y: 10 }), result: JSON.stringify({ status: 'dispatched', target: TX_TARGET, sourceId: 's' }) },
    { id: 'type', state: 'completed', input: TX_INPUT({ kind: 'type', text: 'never shown' }), result: JSON.stringify({ status: 'verified', property: 'value', target: TX_TARGET, sourceId: 's' }) },
    { id: 'press', state: 'completed', input: TX_INPUT({ kind: 'press', key: 'Return' }), result: JSON.stringify({ status: 'interrupted', completion: 'unknown', target: TX_TARGET, sourceId: 's' }) },
    { id: 'running', state: 'running', input: TX_INPUT({ kind: 'click', x: 10, y: 10 }), result: undefined },
] as const;

/** The transcript's computer rows, through the real reference (the specimen has no Session, so no Watch or thumbnail). */
function TranscriptFrame() {
    return (
        <View style={styles.cards}>
            {TX_CALLS.map((call) => (
                <ComputerActionResultReference
                    key={call.id}
                    sessionId="specimen-session"
                    tool={{ id: call.id, name: 'mcp__happier__action_execute', state: call.state, input: call.input, result: call.result, createdAt: 0, startedAt: 0, completedAt: 0, description: null } as unknown as ToolCall}
                />
            ))}
        </View>
    );
}

type Frame = Readonly<{ id: string; render: (phone: boolean) => React.ReactElement }>;
const FRAMES: readonly Frame[] = [
    { id: 'TP', render: (phone) => <PickerFrame grants={GRANTED} phone={phone} /> },
    { id: 'TPc', render: (phone) => <PickerFrame grants={GRANTED} chosen phone={phone} /> },
    { id: 'TPs', render: (phone) => <PickerFrame grants={GRANTED} suggested phone={phone} /> },
    { id: 'TX', render: () => <TranscriptFrame /> },
    { id: 'HC', render: (phone) => <SessionLineFrame phone={phone} presence="agent" /> },
    { id: 'HCh', render: (phone) => <SessionLineFrame phone={phone} presence="human" /> },
    { id: 'OG', render: (phone) => <PickerFrame grants={DENIED} phone={phone} /> },
    { id: 'CS', render: () => <ConsentFrame /> },
    { id: 'LV', render: (phone) => <ViewerFrame presence="agent" stream="live" phone={phone} /> },
    { id: 'K', render: (phone) => <ViewerFrame presence="stopping" stream="live" phone={phone} /> },
    { id: 'UN', render: (phone) => <ViewerFrame presence="unconfirmed" stream="live" phone={phone} /> },
    { id: 'STh', render: (phone) => <ViewerFrame presence="human" stream="live" phone={phone} /> },
    { id: 'STc', render: (phone) => <ViewerFrame presence="agent" stream="connecting" phone={phone} /> },
    { id: 'STs', render: (phone) => <ViewerFrame presence="agent" stream="stalled" phone={phone} /> },
    { id: 'STe', render: (phone) => <ViewerFrame presence="human" stream="ended" phone={phone} /> },
    { id: 'STn', render: (phone) => <ViewerFrame presence="agent" stream="live" shared={false} phone={phone} /> },
    { id: 'WA', render: (phone) => <WatchFrame presence="agent" phone={phone} /> },
    { id: 'WK', render: (phone) => <WatchFrame presence="human" phone={phone} /> },
];

export function ComputerSpecimen(props: Readonly<{ only: string | null; phone: boolean }>) {
    const frame = FRAMES.find((candidate) => candidate.id === props.only) ?? FRAMES[3]!;
    return (
        <SurfaceStateSizeProvider size={props.phone ? 'phone' : 'details'}>
            <View style={styles.root}>
                <View testID={`computer-specimen-${frame.id}`} style={frame.id.startsWith('W') ? styles.watch : props.phone ? styles.framePhone : styles.frame}>
                    {frame.render(props.phone)}
                </View>
            </View>
        </SurfaceStateSizeProvider>
    );
}

const styles = StyleSheet.create((theme) => ({
    root: { flex: 1, padding: 16, backgroundColor: theme.colors.surface.inset },
    frame: {
        // The lab's Details body is 600 wide inside its hairlines; the frame's border sits outside it.
        width: 602,
        height: 720,
        overflow: 'hidden',
        backgroundColor: theme.colors.surface.base,
        borderWidth: StyleSheet.hairlineWidth,
        borderColor: theme.colors.border.default,
    },
    framePhone: {
        width: '100%',
        height: 760,
        overflow: 'hidden',
        backgroundColor: theme.colors.surface.base,
    },
    cards: { padding: 16, gap: 16 },
    watch: { alignSelf: 'flex-start', padding: 24, backgroundColor: theme.colors.surface.base },
    chat: { flex: 1 },
    stripFrame: { padding: 12 },
    grow: { flex: 1 },
    composer: {
        height: 96,
        margin: 12,
        borderRadius: 18,
        backgroundColor: theme.colors.surface.elevated,
        borderWidth: StyleSheet.hairlineWidth,
        borderColor: theme.colors.border.default,
    },
    card: {
        padding: 14,
        borderRadius: 14,
        borderCurve: 'continuous',
        backgroundColor: theme.colors.surface.elevated,
        borderWidth: StyleSheet.hairlineWidth,
        borderColor: theme.colors.border.default,
    },
}));
