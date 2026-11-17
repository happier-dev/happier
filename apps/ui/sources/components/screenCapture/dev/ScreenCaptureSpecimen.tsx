import * as React from 'react';
import { Image, Platform, View, type ViewStyle } from 'react-native';
import { useLocalSearchParams } from 'expo-router';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { countBlurMarks, type ImageMarksDocumentV1 } from '@happier-dev/protocol/sessions/media/imageMarksV1';

import { AgentIcon } from '@/agents/registry/AgentIcon';
import { flattenAnnotatedImage, isEmptyEdit, useImageAnnotator, useImageAnnotatorState } from '@/components/ui/media/annotation';
import type { ImageAnnotator } from '@/components/ui/media/annotation';
import { Text } from '@/components/ui/text/Text';
import { GlassSurface } from '@/components/ui/glass/GlassSurface';
import { resolveDesktopGlassMaterialRequest } from '@/components/ui/glass/GlassMaterialRuntime';
import { resolveGlassPresentationVariables } from '@/components/ui/glass/glassDocumentPresentation';
import { GlassRuntimeEnvironmentProvider, useGlassRuntimeEnvironment } from '@/components/ui/glass/glassRuntimeEnvironment';
import { GlassMaterialSettingsProvider, useGlassMaterialSettings } from '@/components/ui/glass/useGlassMaterialSettings';
import { useReduceTransparency } from '@/hooks/ui/useReduceTransparency';
import { t } from '@/text';

import { createCaptureDisclosureState, reduceCaptureDisclosure, type CaptureDisclosureEvent, type CaptureDisclosureState } from '../disclosure/captureDisclosureRule';
import { SessionChooser } from '@/components/sessions/selection/SessionChooser';
import { ScreenCaptureSettingsRows } from '@/components/settings/desktop/ScreenCaptureSettingsRows';
import { ItemList } from '@/components/ui/lists/ItemList';
import { CaptureSelectionLayer, type CaptureSelectionMode, type CaptureSelectionWindow } from '../selection/CaptureSelectionLayer';
import { CaptureWindowKeyboard } from '../window/CaptureWindowKeyboard';
import { CaptureWindowTextChip } from '../window/CaptureWindowTextChip';
import { resolveCaptureWindowTextView } from '../window/captureWindowTextView';
import type { CaptureWindowTextRead } from '../window/useCaptureWindowText';
import { useDismissOnNextInput } from '../window/useDismissOnNextInput';
import { CaptureWindowScreen, type CaptureDelivery, type CaptureDeliveryOutcome, type CaptureWindowMeasure } from '../window/CaptureWindowScreen';
import { CAPTURE_STATE_WINDOW_WIDTH, CaptureWindowStates, type CaptureWindowBlockedState } from '../window/CaptureWindowStates';
import { resolveCaptureWindowFrame, type CaptureRect } from '../window/resolveCaptureWindowFrame';
import { RealRecordingEditorScene, RecentCapturesScene, RecordingControlScene, RecordingEditorScene } from './RecordingSpecimen';
import { BrowserAnnotateSpecimen } from './BrowserAnnotateSpecimen';
import { CHECKOUT_CROP, CHECKOUT_FULL, CHECKOUT_PAGE_URI, CHOOSER_ROWS, TERMINAL_URI, WALLPAPER_URI, WINDOW_TEXT } from './screenCaptureFixtures';

const DESK = { width: 1440, height: 940 };
const APP_ICON = require('@/assets/images/icon-tauri.png');
const MENU_BAR = 30;
const WORK_AREA: CaptureRect = { x: 0, y: MENU_BAR, width: DESK.width, height: DESK.height - MENU_BAR };
const SAFARI: CaptureRect = { x: 70, y: 52, width: 1300, height: 860 };
const WINDOWS: readonly CaptureSelectionWindow[] = [
    { windowId: 2, frame: { x: 706, y: 70, width: 704, height: 594 }, appName: 'Terminal', title: 'storefront — vitest' },
    { windowId: 1, frame: { x: 32, y: 96, width: 650, height: 450 }, appName: 'Safari', title: 'Fieldnote — Checkout' },
];

/** `?slow=10` stretches every animation on the page, to read a motion frame by frame. */
function slowAnimations(factor: number): void {
    const animate = Element.prototype.animate;
    Element.prototype.animate = function slowed(keyframes, options) {
        const timing = typeof options === 'number' ? { duration: options } : { ...options };
        return animate.call(this, keyframes, {
            ...timing, duration: Number(timing.duration ?? 0) * factor, delay: (timing.delay ?? 0) * factor,
        });
    };
}

/** Dev-only: the desktop capture surfaces on a stand-in desktop, credential-free, for side-by-side QA. */
export function ScreenCaptureSpecimen() {
    const { glass } = useLocalSearchParams<{ glass?: string }>();
    const settings = useGlassMaterialSettings();
    // `glass=solid` turns the app's glass off for this page only, without touching the Account.
    const solid = React.useMemo(() => ({ ...settings, glassBlurEnabled: false }), [settings]);
    return (
        <GlassMaterialSettingsProvider value={glass === 'solid' ? solid : null}>
            <ScreenCaptureSpecimenScene />
        </GlassMaterialSettingsProvider>
    );
}

function ScreenCaptureSpecimenScene() {
    const { scene = 'cw-s', slow, phase, real } = useLocalSearchParams<{ scene?: string; slow?: string; phase?: string; real?: string }>();
    React.useState(() => {
        if (slow) slowAnimations(Number(slow));
    });
    if (scene === 'mp' || scene === 'ws') return <SelectionScene scene={scene} />;
    if (scene === 'perm' || scene === 'reopen' || scene === 'fail' || scene === 'allowed' || scene === 'rc-sys' || scene === 'rc-fail' || scene === 'rc-gst' || scene === 'rc-open' || scene === 'rc-open-fail') return <StateScene kind={scene} />;
    if (scene === 'rc-bar') return <Desk><RecordingControlScene phase={phase === 'paused' || phase === 'finalizing' || phase === 'discarded' || phase === 'preparing' ? phase : 'recording'} /></Desk>;
    if (scene === 'rc-rec') return <Desk><RecentCapturesScene phase={phase} /></Desk>;
    if (scene === 'rc-ed') {
        return (
            <CaptureWindowKeyboard>
                <Desk>{real ? <RealRecordingEditorScene workArea={WORK_AREA} /> : <RecordingEditorScene workArea={WORK_AREA} area={null} mediaFailed={phase === 'media-fail'} />}</Desk>
            </CaptureWindowKeyboard>
        );
    }
    if (scene === 'settings') return <SettingsScene reopen={phase === 'reopen'} />;
    if (scene === 'br') return <BrowserAnnotateSpecimen />;
    if (scene === 'scp') return <PhoneChooserScene />;
    return (
        <CaptureWindowKeyboard>
            <WindowScene key={scene} scene={scene} />
        </CaptureWindowKeyboard>
    );
}

/**
 * The stand-in desktop plays the native window backing: where the app's glass would put vibrancy behind a
 * Capture card, the card's web blur samples this wallpaper instead.
 */
function useStandInDesktopGlass() {
    const settings = useGlassMaterialSettings();
    const runtime = useGlassRuntimeEnvironment();
    const reduceTransparency = useReduceTransparency() || runtime.reduceTransparency === true;
    const environment = React.useMemo(() => ({
        ...runtime, desktopWindow: true, reduceTransparency,
        nativeWindowMaterialLive: resolveDesktopGlassMaterialRequest(settings).enabled && !reduceTransparency,
    }), [reduceTransparency, runtime, settings]);
    const variables = React.useMemo(() => Platform.OS === 'web'
        ? resolveGlassPresentationVariables(settings, environment) as unknown as ViewStyle : null, [environment, settings]);
    return { environment, variables };
}

function Desk(props: Readonly<{ children?: React.ReactNode; under?: React.ReactNode; backdrop?: 'safari' | 'windows' }>) {
    // `desk=windows` puts the stacked windows (a dark terminal among them) behind any scene, for contrast checks.
    const { desk } = useLocalSearchParams<{ desk?: string }>();
    const backdrop = props.backdrop ?? (desk === 'windows' ? 'windows' : 'safari');
    const glass = useStandInDesktopGlass();
    return (
        <GlassRuntimeEnvironmentProvider value={glass.environment}>
        <View style={styles.viewport} testID="screen-capture-specimen">
            <View style={[styles.desk, glass.variables]}>
                <Image source={{ uri: WALLPAPER_URI }} style={styles.fill} />
                {backdrop === 'safari' ? (
                    <View style={[styles.appWindow, rectStyle(SAFARI)]}>
                        <Image source={{ uri: CHECKOUT_PAGE_URI }} style={styles.fill} resizeMode="stretch" />
                    </View>
                ) : WINDOWS.slice().reverse().map((window) => (
                    <View key={window.windowId} style={[styles.appWindow, rectStyle(window.frame)]}>
                        <Image source={{ uri: window.windowId === 2 ? TERMINAL_URI : CHECKOUT_PAGE_URI }} style={styles.fill} resizeMode="stretch" />
                    </View>
                ))}
                <View style={styles.menuBar}><Text variant="meta" emphasis="semiBold" style={styles.menuText}>Safari</Text></View>
                {props.children}
            </View>
        </View>
        </GlassRuntimeEnvironmentProvider>
    );
}

const rectStyle = (rect: CaptureRect) => ({ position: 'absolute' as const, left: rect.x, top: rect.y, width: rect.width, height: rect.height });

function SelectionScene(props: Readonly<{ scene: 'mp' | 'ws' }>) {
    const [mode, setMode] = React.useState<CaptureSelectionMode>('still');
    const [run, setRun] = React.useState(0);
    const hitTest = React.useCallback(async (point: Readonly<{ x: number; y: number }>) => WINDOWS.find(({ frame }) =>
        point.x >= frame.x && point.y >= frame.y && point.x <= frame.x + frame.width && point.y <= frame.y + frame.height) ?? null, []);
    return (
        <Desk backdrop="windows">
            <CaptureSelectionLayer
                key={run}
                display={DESK}
                safeAreaTop={props.scene === 'mp' ? 32 : 0}
                windows={WINDOWS}
                hitTest={hitTest}
                mode={mode}
                onModeChange={setMode}
                shortcutLabel={props.scene === 'mp' ? '⇧⌘2' : 'Ctrl+Shift+2'}
                initialPointer={{ x: 900, y: 300 }}
                onCommit={() => setRun((value) => value + 1)}
                onCancel={() => setRun((value) => value + 1)}
            />
        </Desk>
    );
}

const SHORTCUT = { label: '⇧⌘2', note: null, editable: true };
const UNSET = { label: null, note: null, editable: true };

/** The section's rows with their real anatomy; native reads answer only in the desktop app. */
function SettingsScene(props: Readonly<{ reopen: boolean }>) {
    const [sound, setSound] = React.useState(true);
    const [text, setText] = React.useState(false);
    const [shadow, setShadow] = React.useState(false);
    return (
        <View style={styles.settingsPage} testID="screen-capture-specimen">
            <ItemList style={styles.settingsList}>
                <ScreenCaptureSettingsRows
                    shortcuts={{ captureShortcut: SHORTCUT, instantWindowShortcut: UNSET, recordingShortcut: UNSET }}
                    sound={sound}
                    onSoundChange={setSound}
                    includeWindowText={text}
                    onIncludeWindowTextChange={setText}
                    windowShadow={{ enabled: shadow, supported: true }}
                    onIncludeWindowShadowChange={setShadow}
                    folder="~/Pictures/Happier"
                    onChooseFolder={() => {}}
                    onShowFolder={() => {}}
                    onRecordShortcut={() => {}}
                    permissions={{ screen: props.reopen ? 'restart_required' : 'granted', windowText: 'request_required' }}
                    onOpenPermission={() => {}}
                    onReopen={() => {}}
                    onOpenApprovals={() => {}}
                />
            </ItemList>
        </View>
    );
}

/** The chooser as P2's copy mode shows it on a phone (lab `sc` SCp). */
function PhoneChooserScene() {
    const anchor = React.useRef<View>(null);
    return (
        <View ref={anchor} style={styles.settingsPage} testID="screen-capture-specimen">
            <Image source={{ uri: CHECKOUT_CROP.uri }} style={styles.fill} resizeMode="contain" />
            <SessionChooser
                open
                anchorRef={anchor}
                readPage={readSpecimenPage}
                selected={CHOOSER_ROWS[0].address}
                title={t('screenCapture.chooser.attachTo')}
                enterHint={t('screenCapture.chooser.copyHere')}
                onSelect={() => {}}
                onNewSession={() => {}}
                onClose={() => {}}
            />
        </View>
    );
}

function StateScene(props: Readonly<{ kind: 'perm' | 'reopen' | 'fail' | 'allowed' | 'rc-sys' | 'rc-fail' | 'rc-gst' | 'rc-open' | 'rc-open-fail' }>) {
    const { theme } = useUnistyles();
    const state: CaptureWindowBlockedState = props.kind === 'rc-sys' ? { kind: 'systemSelection', onContinue: () => {}, onCancel: () => {} }
        : props.kind === 'rc-open' ? { kind: 'loading', title: t('screenCapture.recording.openingTitle') }
        : props.kind === 'rc-open-fail' ? { kind: 'failed', recording: true, diagnostic: null, title: t('screenCapture.recording.openFailedTitle'),
            reason: t('screenCapture.recording.openFailedReason'), onTryAgain: () => {} }
        : props.kind === 'rc-fail' ? { kind: 'failed', recording: true, diagnostic: 'native_failure', onTryAgain: () => {}, onDiscard: () => {} }
        : props.kind === 'rc-gst' ? { kind: 'failed', recording: true, diagnostic: 'video_encoder_unavailable', reason: t('screenCapture.recording.videoEncoderUnavailable'), onTryAgain: () => {} }
        : props.kind !== 'fail'
        ? { kind: 'permission', shortcutLabel: '⇧⌘2', progress: props.kind === 'allowed' ? 'allowed' : props.kind === 'reopen' ? 'reopen' : 'waiting',
            drag: { standIn: <Image source={APP_ICON} style={styles.fill} /> }, onOpenSettings: () => {}, onReopen: () => {}, onNotNow: () => {} }
        : { kind: 'failed', diagnostic: 'native_failure', onTryAgain: () => {}, onAttachRecent: () => {} };
    return (
        <Desk>
            <View style={[styles.statePaper, { left: 470, top: 230, width: CAPTURE_STATE_WINDOW_WIDTH, borderRadius: theme.borderRadius.xxl }]}>
                <GlassSurface surfaceGroup="content" finishRole={null} style={StyleSheet.absoluteFillObject} children={null} />
                <CaptureWindowStates state={state} onClose={() => {}} />
            </View>
        </Desk>
    );
}

function WindowScene(props: Readonly<{ scene: string }>) {
    const large = props.scene === 'cw-l' || props.scene === 'sc';
    const offline = props.scene === 'off';
    const picture = large ? CHECKOUT_FULL : CHECKOUT_CROP;
    const source = React.useMemo(() => ({ uri: picture.uri, width: picture.width, height: picture.height, scale: 1 }), [picture]);
    const [disclosure, dispatch] = React.useReducer(reduceCaptureDisclosure, props.scene, specimenDisclosure);
    const onDocumentChange = React.useCallback((document: ImageMarksDocumentV1, cause: 'edit' | 'undo' | 'redo') => {
        dispatch({ type: 'document', blurCount: countBlurMarks(document), cause });
    }, []);
    const annotator = useImageAnnotator({ source, onDocumentChange });
    return <WindowSceneBody {...props} annotator={annotator} large={large} offline={offline} picture={picture} disclosure={disclosure} dispatch={dispatch} />;
}

const SPECIMEN_SOURCE = { appName: 'Safari', windowTitle: 'Fieldnote — Checkout', windowId: 1 };
/** Each `wt` scene starts where the rule would have left it. */
function specimenDisclosure(scene: string): CaptureDisclosureState {
    const on = createCaptureDisclosureState(scene !== 'cw-s' && scene !== 'cw-last' && scene !== 'cw-l' && scene !== 'off' && scene !== 'sc');
    if (scene === 'wt-v' || scene === 'wt-p') return on;
    if (scene !== 'wt-b' && scene !== 'wt-bw') return on;
    const blurred = reduceCaptureDisclosure(on, { type: 'document', blurCount: 1, cause: 'edit' });
    return scene === 'wt-b' ? blurred : reduceCaptureDisclosure(reduceCaptureDisclosure(blurred, { type: 'input' }), { type: 'toggle', included: true });
}
const readSpecimenPage = async ({ query }: Readonly<{ query: string }>) => {
    const rows = CHOOSER_ROWS.filter(({ label }) => label.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()));
    return { rows, total: rows.length };
};
const NOTE_S = 'The total is still cut off at 1440 wide, and Pay sits on the card edge.';
const NOTE_L = 'The total is cut off and Pay sits on the card edge at 1440 wide. This is Safari 18 on the MacBook.';
const NOTE_OFF = 'Same clipping on the retry screen: the total drops below the card.';

function WindowSceneBody(props: Readonly<{
    scene: string;
    large: boolean;
    offline: boolean;
    annotator: ImageAnnotator;
    picture: typeof CHECKOUT_CROP;
    disclosure: CaptureDisclosureState;
    dispatch: (event: CaptureDisclosureEvent) => void;
}>) {
    const { theme } = useUnistyles();
    const { annotator, large, offline, picture, disclosure, dispatch } = props;
    const dismiss = React.useCallback(() => dispatch({ type: 'input' }), [dispatch]);
    useDismissOnNextInput(disclosure.showBlurCallout, dismiss);
    const textRead: CaptureWindowTextRead = props.scene === 'wt-p'
        ? { status: 'settled', result: { status: 'unavailable', reason: 'permission_required', source: SPECIMEN_SOURCE } }
        : { status: 'settled', result: { status: 'ready', text: WINDOW_TEXT, source: SPECIMEN_SOURCE } };
    const [note, setNote] = React.useState(offline ? NOTE_OFF : large ? NOTE_L : NOTE_S);
    const [measure, setMeasure] = React.useState<CaptureWindowMeasure | null>(null);
    const [thumbnail, setThumbnail] = React.useState<string | null>(null);
    const [run, setRun] = React.useState(0);
    // `cw-last`: the target was remembered from the previous capture until a Session is chosen here.
    const [chose, setChose] = React.useState(false);
    const [newSession, setNewSession] = React.useState(false);
    const cue = props.scene === 'cw-last' && !chose ? t('screenCapture.window.sameAsLastCapture') : undefined;
    const area: CaptureRect | null = large ? null : { x: 846, y: 466, width: 594, height: 360 };
    const frame = React.useMemo(() => measure ? resolveCaptureWindowFrame({
        picture, origin: area, workArea: WORK_AREA, remembered: null,
        metrics: { gutter: theme.space.s24, screenInset: theme.space.s24, ...measure },
    // `area` follows the scene.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    }) : null, [measure, picture, theme.space.s24]);
    const edited = useImageAnnotatorState(annotator, (state) => !isEmptyEdit(state.document));
    const onDeliver = React.useCallback(async (delivery: CaptureDelivery): Promise<CaptureDeliveryOutcome> => {
        const flat = await flattenAnnotatedImage(annotator.source, annotator.store.getState().document);
        if (flat.ok) setThumbnail(URL.createObjectURL(new Blob([flat.png as BlobPart], { type: 'image/png' })));
        await new Promise((resolve) => setTimeout(resolve, 900));
        if (props.scene === 'send-fail') return { ok: false, cause: 'The upload stopped halfway' };
        return delivery === 'send'
            ? { ok: true, pill: { kind: 'sent', session: 'Fix checkout total clipping', detail: 'Claude · MacBook Pro · with your note' } }
            : { ok: true, pill: { kind: 'added', session: 'Fix checkout total clipping', imageNumber: 2 } };
    }, [annotator, props.scene]);
    return (
        <Desk>
            <CaptureWindowScreen
                key={run}
                frame={frame}
                area={area}
                workArea={WORK_AREA}
                screenInset={theme.space.s24}
                onMeasure={setMeasure}
                annotator={annotator}
                pictureUri={picture.uri}
                caption={{ icon: 'browsers', lead: 'Safari', facts: ['Fieldnote — Checkout', `${picture.width} × ${picture.height}`, t('screenCapture.window.justNow')] }}
                target={newSession ? { kind: 'newSession', title: t('transcript.selection.sendTo.newSession'), machineName: '', mark: null } : offline
                    ? { title: 'Checkout retry states', machineName: 'devbox', mark: <AgentIcon agentId="codex" size={14} /> }
                    : { title: 'Fix checkout total clipping', machineName: 'MacBook Pro', mark: <AgentIcon agentId="claude" size={14} />, ...(cue ? { cue } : {}) }}
                chooser={{
                    readPage: readSpecimenPage,
                    selected: newSession ? null : props.scene === 'sc' || !offline ? CHOOSER_ROWS[0].address : null,
                    onSelect: () => { setChose(true); setNewSession(false); },
                    onNewSession: () => { setChose(true); setNewSession(true); },
                    canStartSession: true,
                    newSessionContext: 'storefront · MacBook Pro',
                }}
                unreachable={offline && !newSession ? { machineName: 'devbox', lastSeen: '10:31' } : null}
                renderWindowText={(surface) => (
                    <CaptureWindowTextChip
                        view={resolveCaptureWindowTextView({ disclosure, read: textRead, appName: 'Safari' })}
                        onToggle={() => dispatch({ type: 'toggle', included: !disclosure.included })}
                        surface={surface}
                        onResolveBlurWarning={(include) => dispatch({ type: 'warning', include })}
                        onOpenPermissionSettings={() => {}}
                        onDeclinePermission={() => dispatch({ type: 'toggle', included: false })}
                    />
                )}
                note={note}
                onNoteChange={setNote}
                onDeliver={onDeliver}
                onRetry={async (delivery) => {
                    await new Promise((resolve) => setTimeout(resolve, 900));
                    return delivery === 'send'
                        ? { ok: true, pill: { kind: 'sent', session: 'Fix checkout total clipping', detail: 'Claude · MacBook Pro · with your note' } }
                        : { ok: true, pill: { kind: 'added', session: 'Fix checkout total clipping', imageNumber: 2 } };
                }}
                thumbnailUri={thumbnail}
                hasWork={edited || note.length > 0}
                onDiscard={() => {}}
                onUndoDiscard={() => {}}
                onClosed={() => setRun((value) => value + 1)}
                onOpenSession={() => {}}
                onCopy={() => {}}
                onShowInFolder={() => {}}
                more={{ onAttachRecent: () => {}, onCopyWindowText: () => {}, onOpenSettings: () => {} }}
                onOpenRecent={() => {}}
            />
        </Desk>
    );
}

const styles = StyleSheet.create((theme) => ({
    viewport: {
        position: 'fixed',
        left: 0,
        top: 0,
        right: 0,
        bottom: 0,
        zIndex: 1000,
        backgroundColor: theme.colors.overlay.stageImmersive,
    } as never,
    desk: {
        width: DESK.width,
        height: DESK.height,
        overflow: 'hidden',
    },
    fill: {
        ...StyleSheet.absoluteFillObject,
        width: '100%',
        height: '100%',
    },
    appWindow: {
        borderRadius: theme.borderRadius.lg,
        overflow: 'hidden',
    },
    menuBar: {
        position: 'absolute',
        left: 0,
        right: 0,
        top: 0,
        height: MENU_BAR,
        paddingHorizontal: theme.space.s16,
        justifyContent: 'center',
        backgroundColor: theme.colors.overlay.scrimStrong,
    },
    menuText: {
        color: theme.colors.text.primary,
    },
    settingsPage: {
        position: 'absolute',
        left: 0,
        right: 0,
        top: 0,
        bottom: 0,
        backgroundColor: theme.colors.surface.base,
    },
    settingsList: {
        flex: 1,
    },
    statePaper: {
        position: 'absolute',
        overflow: 'hidden',
        borderWidth: 1,
        borderColor: theme.colors.border.modal,
        boxShadow: theme.colors.glass.castShadow,
    } as never,
}));
