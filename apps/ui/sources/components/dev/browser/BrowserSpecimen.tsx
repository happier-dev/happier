import * as React from 'react';
import { ScrollView, View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import type { BrowserContextCapabilities, BrowserEventV1, BrowserRecordingCapabilities, BrowserViewTargetV1 } from '@happier-dev/protocol';

import { BrowserShell } from '@/components/browser/BrowserShell';
import { RoundButton } from '@/components/ui/buttons/RoundButton';
import { SurfaceStateSizeProvider } from '@/components/ui/surfaces/surfaceStateSize';
import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import { buildBrowserAdapterCapabilities } from '@/sync/domains/browser/adapters/capabilities';
import { createBrowserAutomationControlService } from '@/sync/domains/browser/automation';
import type { BrowserLaunchpadRow } from '@/sync/domains/browser/targets';
import { createBrowserContextState } from '@/sync/domains/browser/context';
import { applyBrowserControlEvent, createBrowserControlState, type BrowserControlState } from '@/sync/domains/browser/control';
import { createBrowserRecordingState } from '@/sync/domains/browser/recording';
import { readSessionPresentationAgentId } from '@/sync/domains/session/presentation/readSessionPresentationAgentId';
import { getStorage } from '@/sync/domains/state/storage';
import type { BrowserShellAgentPresence } from '@/components/browser/copresence/BrowserShellPresence';

import { LUMEN_LOGIN_FRAME_DARK, LUMEN_LOGIN_FRAME_LIGHT } from './lumenLoginFrame';

/**
 * Dev-only specimen of the browser surfaces in lab `browser` (Q, A, K/H, ST) drawn through the real
 * `BrowserShell` at static props, so the lab and the app can be compared side by side without a
 * managed Chromium or a live stream. The streamed frame is the lab's own page (a fixture); the
 * controller state is driven through the real automation owner (a registered test owner stands in
 * for the daemon's controller events, W2C).
 */
const NOOP = () => undefined;
const SESSION = 'browser_session_specimen';

const LUMEN_HTML = `<!doctype html><html><head><meta charset="utf-8"><style>
html,body{margin:0;height:100%;font:13px -apple-system,Inter,sans-serif;background:#F4F2EE;color:#1D1B1A}
@media (prefers-color-scheme:dark){html,body{background:#161413;color:#ECE9E6}.f{background:#211E1C!important;box-shadow:inset 0 0 0 1px rgba(255,255,255,.12)!important}}
main{height:100%;display:grid;place-items:center}.c{width:300px;display:flex;flex-direction:column;gap:10px}
.b{display:flex;align-items:center;gap:8px;font-weight:650;font-size:14px}.b i{width:22px;height:22px;border-radius:6px;background:linear-gradient(140deg,#41D1FF,#BD34FE)}
h4{margin:0;font-size:20px;font-weight:660}p{margin:0 0 6px;opacity:.6}.l{font-size:11.5px;font-weight:600;opacity:.75;margin-bottom:-4px}
.f{height:34px;border-radius:8px;background:#fff;box-shadow:inset 0 0 0 1px rgba(0,0,0,.14);display:flex;align-items:center;padding:0 10px;opacity:.6}
.g{height:36px;border-radius:8px;background:#5B3DF5;color:#fff;display:grid;place-items:center;font-weight:620;margin-top:4px}.a{text-align:center;opacity:.55;font-size:11.5px}
</style></head><body><main><div class="c"><div class="b"><i></i>Lumen</div><h4>Sign in</h4><p>Welcome back. Use your work email.</p><span class="l">Email</span><div class="f">you@company.com</div><span class="l">Password</span><div class="f"></div><div class="g">Sign in</div><div class="a">No account? Create one</div></div></main></body></html>`;
const LUMEN_URL = `data:text/html;charset=utf-8,${encodeURIComponent(LUMEN_HTML)}`;

const CONTEXT_CAPABILITIES = {
    enabled: true,
    available: true,
    supportedContextKinds: ['browserPageReference', 'browserAnnotation'],
    supportedAdapterKinds: ['externalUrl', 'localPreview', 'chromiumSidecar'],
    screenshot: { supported: true, requiresAttachmentUploads: true, maxBytes: 5_000_000 },
    text: { maxSelectionChars: 2048, maxSummaryChars: 8192 },
} as unknown as BrowserContextCapabilities;

const RECORDING_CAPABILITIES = {
    enabled: true,
    attachmentsEnabled: true,
    available: true,
    supportedCaptureKinds: ['nativeViewCapture', 'cdpScreencast', 'streamFrameCapture'],
    supportedMimeTypes: ['video/webm'],
    supportedAdapterKinds: ['externalUrl', 'chromiumSidecar'],
    maxDurationMs: 600_000,
    maxBytes: 64_000_000,
    maxFps: 12,
    audioSupported: false,
    cursorOverlaySupported: true,
    actionTimelineChaptersSupported: true,
    supportedRetentionClasses: ['preSend', 'attached'],
    disabledReasons: [],
    policyDeniedReasons: [],
} satisfies BrowserRecordingCapabilities;

type Controller = 'idle' | 'agent' | 'stopping' | 'human' | 'unsure';

/** The "Sign in" button in the stream fixture, normalized to the page (the daemon's `activeTarget`). */
const SIGN_IN_TARGET = { x: 0.5, y: 0.6319, width: 0.5, height: 0.045 } as const;
/** The Email field in the same fixture: the motion frame's second target, so the hand has somewhere to travel. */
const EMAIL_TARGET = { x: 0.5, y: 0.4719, width: 0.5, height: 0.0425 } as const;

/**
 * The daemon controller a streamed view reports (`controllerChanged`, W2C/W9/W10), per frame: the
 * agent clicking Sign in, the takeover still settling, the person driving, and the person driving
 * after an interrupted click whose effect the input owner could not confirm.
 */
function controllerState(controller: Controller, target: 'signIn' | 'email' = 'signIn') {
    const view = { browserSessionId: SESSION, viewId: 'view_1' };
    switch (controller) {
        case 'idle':
            return null;
        case 'agent':
            return target === 'email'
                ? { ...view, controller: 'agent', controlEpoch: 1, activeAutomationRequestId: 'specimen_fill', activeActionKind: 'fill', activeTarget: EMAIL_TARGET }
                : { ...view, controller: 'agent', controlEpoch: 1, activeAutomationRequestId: 'specimen_click', activeActionKind: 'click', activeTarget: SIGN_IN_TARGET };
        case 'stopping':
            return { ...view, controller: 'human', controlEpoch: 2, interruptionSettling: true };
        case 'human':
            return { ...view, controller: 'human', controlEpoch: 2, uncertain: false };
        case 'unsure':
            return { ...view, controller: 'human', controlEpoch: 2, uncertain: true };
    }
}

function buildState(kind: 'external' | 'streamed' | 'none', controller: Controller = 'idle', target: 'signIn' | 'email' = 'signIn'): BrowserControlState {
    if (kind === 'none') return createBrowserControlState();
    const pageUrl = kind === 'external' ? LUMEN_URL : 'http://localhost:5173/login';
    const viewTarget: BrowserViewTargetV1 = {
        kind: 'externalUrl',
        targetId: 'lumen',
        url: pageUrl,
        display: { title: 'Lumen · Sign in', addressLabel: 'localhost:5173' },
    } as BrowserViewTargetV1;
    const adapterKind = kind === 'external' ? 'externalUrl' : 'chromiumSidecar';
    const engineKind = kind === 'external' ? 'webIframe' : 'streamedSurface';
    const controlled = kind === 'streamed' ? controllerState(controller, target) : null;
    const events: readonly BrowserEventV1[] = [
        { kind: 'sessionCreated', eventId: 'e1', browserSessionId: SESSION, profileId: 'profile_1', occurredAt: 1 },
        {
            kind: 'viewOpened',
            eventId: 'e2',
            browserSessionId: SESSION,
            viewId: 'view_1',
            target: viewTarget,
            platform: 'web',
            currentUrl: pageUrl,
            adapterKind,
            engineKind,
            adapterCapabilities: {
                ...buildBrowserAdapterCapabilities({
                    adapterKind,
                    supportedTargetKinds: ['externalUrl'],
                    supportedRenderEngines: [engineKind],
                }),
                navigation: { canNavigate: true, canGoBack: true, canGoForward: false, canReload: true, canStop: false },
            },
            occurredAt: 2,
        },
        { kind: 'viewFocused', eventId: 'e3', browserSessionId: SESSION, viewId: 'view_1', occurredAt: 3 },
        {
            kind: 'navigationFinished',
            eventId: 'e4',
            browserSessionId: SESSION,
            viewId: 'view_1',
            navigationGeneration: 0,
            url: pageUrl,
            occurredAt: 4,
        },
        ...(controlled ? [{ kind: 'controllerChanged', eventId: 'e5', browserSessionId: SESSION, viewId: 'view_1', state: controlled, occurredAt: 5 }] : []),
    ] as unknown as readonly BrowserEventV1[];
    return events.reduce((state, event) => applyBrowserControlEvent(state, event), createBrowserControlState());
}

/** The phone Browser tab's launchpad (lab W): Running previews and Recent pages. */
const LAUNCHPAD_ROWS = [
    { id: 'web', section: 'running', sourceKind: 'localService', title: 'web', subtitle: 'localhost:5173 · Vite', detail: '', target: { kind: 'externalUrl', targetId: 'web', url: 'http://localhost:5173/' }, disabledReason: null, lastSeenAt: 3 },
    { id: 'storybook', section: 'running', sourceKind: 'localService', title: 'storybook', subtitle: 'localhost:6006 · Detected', detail: '', target: { kind: 'externalUrl', targetId: 'storybook', url: 'http://localhost:6006/' }, disabledReason: null, lastSeenAt: 2 },
    { id: 'docs', section: 'recent', sourceKind: 'recent', title: 'Docs · Sessions', subtitle: 'localhost:3000/docs/sessions', detail: '', target: { kind: 'externalUrl', targetId: 'docs', url: 'http://localhost:3000/docs/sessions' }, disabledReason: null, lastSeenAt: 1 },
    { id: 'settings', section: 'recent', sourceKind: 'recent', title: 'Settings · Appearance', subtitle: 'localhost:5173/settings/appearance', detail: '', target: { kind: 'externalUrl', targetId: 'settings', url: 'http://localhost:5173/settings/appearance' }, disabledReason: null, lastSeenAt: 0 },
] as unknown as readonly BrowserLaunchpadRow[];

const DAEMON_CONTROL = { sendCommand: async () => ({ ok: false, reason: 'unavailable' } as const) };

const BROWSER_ENABLED = {
    featureId: 'browser',
    state: 'enabled',
    blockedBy: null,
    blockerCode: 'none',
    diagnostics: [],
    evaluatedAt: 1,
    scope: { scopeKind: 'runtime' },
} satisfies NonNullable<React.ComponentProps<typeof BrowserShell>['browserFeatureDecision']>;

type StreamFixture = 'live' | 'connecting' | 'stalled' | 'ended' | 'unavailable';

function streamRuntime(fixture: StreamFixture, frameUrl: string) {
    if (fixture === 'unavailable') return { machineName: 'MacBook Pro', playerState: null };
    const base = { selectedCodec: 'image.frame.v1', activeRenderer: 'mjpeg', decodedFrames: 1, droppedFrames: 0, bufferedBytes: 0 } as const;
    switch (fixture) {
        case 'connecting':
            return { machineName: 'MacBook Pro', playerState: { ...base, phase: 'opening' as const } };
        case 'stalled':
            return { machineName: 'MacBook Pro', playerState: { ...base, phase: 'reconnecting' as const, lastFrameUrl: frameUrl } };
        case 'ended':
            return { machineName: 'MacBook Pro', playerState: { ...base, phase: 'stopped' as const, lastFrameUrl: frameUrl } };
        case 'live':
            return { machineName: 'MacBook Pro', playerState: { ...base, phase: 'playing' as const, lastFrameUrl: frameUrl } };
    }
}

/**
 * The agent identity the specimen's browser belongs to, through the same `useBrowserSessionAgentIdentity`
 * path production uses: a real Claude Session from this client's store when one is there, else the
 * Claude catalog identity (the capture context has no signed-in account, so its store is empty).
 */
function useSpecimenAgent(): BrowserShellAgentPresence {
    const sessionId = getStorage()((state) => {
        for (const session of Object.values(state.sessions ?? {})) {
            if (session && readSessionPresentationAgentId(session) === 'claude') return session.id;
        }
        return null;
    });
    return React.useMemo(() => ({ sessionId: sessionId ?? 'specimen_session', knownAgentId: 'claude' }), [sessionId]);
}

function SpecimenShell(props: Readonly<{
    kind: 'external' | 'streamed' | 'none';
    controller: Controller;
    stream?: StreamFixture;
    target?: 'signIn' | 'email';
}>) {
    const { theme } = useUnistyles();
    const frameUrl = theme.dark ? LUMEN_LOGIN_FRAME_DARK : LUMEN_LOGIN_FRAME_LIGHT;
    const state = React.useMemo(() => buildState(props.kind, props.controller, props.target), [props.controller, props.kind, props.target]);
    const controlService = React.useMemo(() => createBrowserAutomationControlService({ nowMs: () => 10_000 }), []);
    const [contextState, setContextState] = React.useState(createBrowserContextState);
    const agent = useSpecimenAgent();
    return (
        <BrowserShell
            browserSessionId={SESSION}
            platform="web"
            state={state}
            onCommand={NOOP}
            browserContext={{
                state: contextState,
                contextCapabilities: CONTEXT_CAPABILITIES,
                attachmentsUploadsEnabled: true,
                onStateChange: setContextState,
                nowMs: () => 10_000,
                daemonControl: DAEMON_CONTROL,
            }}
            launchpadRows={LAUNCHPAD_ROWS}
            browserFeatureDecision={BROWSER_ENABLED}
            allowExternalUrlBrowsing
            onOpenTarget={NOOP}
            onNavigateInPlace={NOOP}
            browserRecording={{
                state: createBrowserRecordingState(),
                recordingCapabilities: RECORDING_CAPABILITIES,
                enabled: true,
                onStartRecording: NOOP,
                onStopRecording: NOOP,
                onCancelRecording: NOOP,
            }}
            browserAutomation={{ controlService, enabled: true }}
            agent={agent}
            streamedBrowserRuntime={props.kind === 'streamed' ? streamRuntime(props.stream ?? 'live', frameUrl) : null}
            testID={`browser-specimen-shell`}
        />
    );
}

type Frame = Readonly<{ id: string; title: string; render: () => React.ReactElement }>;

type MotionStep = Readonly<{ id: string; controller: Controller; stream: StreamFixture; target?: 'signIn' | 'email' }>;

/** The motion frame's steps, in the order a takeover happens (agent → stopping → you → hand back). */
const MOTION_STEPS: readonly MotionStep[] = [
    { id: 'idle', controller: 'idle', stream: 'live' },
    { id: 'agent', controller: 'agent', stream: 'live' },
    { id: 'agentEmail', controller: 'agent', stream: 'live', target: 'email' },
    { id: 'stopping', controller: 'stopping', stream: 'live' },
    { id: 'human', controller: 'human', stream: 'live' },
    { id: 'stalled', controller: 'agent', stream: 'stalled' },
    { id: 'connecting', controller: 'agent', stream: 'connecting' },
];

/**
 * M · motion: one mounted shell whose controller and stream move through the takeover, so a capture
 * can record each transition frame by frame (the steps are dev buttons above the frame).
 */
function MotionSpecimen() {
    const [step, setStep] = React.useState<MotionStep>(MOTION_STEPS[1]!);
    return (
        <View style={styles.motion}>
            <View style={styles.motionControls}>
                {MOTION_STEPS.map((candidate) => (
                    <RoundButton
                        key={candidate.id}
                        size="small"
                        display={candidate.id === step.id ? 'default' : 'secondary'}
                        title={candidate.id}
                        testID={`browser-specimen-M-step-${candidate.id}`}
                        onPress={() => setStep(candidate)}
                    />
                ))}
            </View>
            <View style={styles.frameBody}>
                <SpecimenShell kind="streamed" controller={step.controller} stream={step.stream} target={step.target} />
            </View>
        </View>
    );
}

const FRAMES: readonly Frame[] = [
    // Q draws the page as the stream fixture so the address reads like the lab's (an iframe of a
    // data: URL would show `data:` in the field); the chrome is the same shell either way.
    { id: 'Q', title: 'Q · quiet chrome', render: () => <SpecimenShell kind="streamed" controller="idle" /> },
    { id: 'A', title: 'A · the agent is browsing', render: () => <SpecimenShell kind="streamed" controller="agent" /> },
    { id: 'K', title: 'K · stopping', render: () => <SpecimenShell kind="streamed" controller="stopping" /> },
    { id: 'H', title: 'H · you have control', render: () => <SpecimenShell kind="streamed" controller="human" /> },
    { id: 'U', title: 'U · last action uncertain', render: () => <SpecimenShell kind="streamed" controller="unsure" /> },
    { id: 'W', title: 'W · launchpad', render: () => <SpecimenShell kind="none" controller="idle" /> },
    { id: 'STc', title: 'ST · connecting', render: () => <SpecimenShell kind="streamed" controller="agent" stream="connecting" /> },
    { id: 'STs', title: 'ST · stalled', render: () => <SpecimenShell kind="streamed" controller="agent" stream="stalled" /> },
    { id: 'STe', title: 'ST · ended', render: () => <SpecimenShell kind="streamed" controller="idle" stream="ended" /> },
    { id: 'STu', title: 'ST · unavailable', render: () => <SpecimenShell kind="streamed" controller="agent" stream="unavailable" /> },
    { id: 'M', title: 'M · motion (takeover, stream)', render: () => <MotionSpecimen /> },
];

export function BrowserSpecimen(props: Readonly<{ only: string | null; phone: boolean }>) {
    const frames = props.only ? FRAMES.filter((frame) => frame.id === props.only) : FRAMES;
    const grid = (
        <View style={styles.grid}>
            {frames.map((frame) => (
                <View key={frame.id} testID={`browser-specimen-${frame.id}`} style={props.phone ? styles.framePhone : styles.frame}>
                    {props.only ? null : <Text style={styles.caption}>{frame.title}</Text>}
                    <View style={styles.frameBody}>{frame.render()}</View>
                </View>
            ))}
        </View>
    );
    const content = props.only
        ? <View style={[styles.root, styles.content]}>{grid}</View>
        : <ScrollView style={styles.root} contentContainerStyle={styles.content}>{grid}</ScrollView>;
    return (
        <SurfaceStateSizeProvider size={props.phone ? 'phone' : 'details'}>
            {content}
        </SurfaceStateSizeProvider>
    );
}

const styles = StyleSheet.create((theme) => ({
    root: { flex: 1, backgroundColor: theme.colors.surface.inset },
    content: { padding: 16, gap: 24 },
    grid: { flexDirection: 'row', flexWrap: 'wrap', gap: 22 },
    caption: { ...Typography.default('semiBold'), fontSize: 12, color: theme.colors.text.secondary, padding: 8 },
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
    frameBody: { flex: 1, minHeight: 0 },
    motion: { flex: 1, minHeight: 0 },
    motionControls: { flexDirection: 'row', flexWrap: 'wrap', gap: 6, padding: 8 },
}));
