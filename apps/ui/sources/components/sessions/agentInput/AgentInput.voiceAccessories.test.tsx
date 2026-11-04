import 'fake-indexeddb/auto';
import React from 'react';
import { ActionsSettingsV1Schema } from '@happier-dev/protocol/actions/actionSettings';
import { act } from 'react-test-renderer';
import type { ReactTestInstance } from 'react-test-renderer';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createMachineFixture, createPlainMachineRowFixture, createRootLayoutFeaturesResponse, pressTestInstanceAsync, waitForTestEvent, type RenderScreenResult } from '@/dev/testkit';
import type { RenderWithAppProvidersOptions } from '@/dev/testkit/render/renderWithAppProviders';
import { MachineLiveStreamRelayCapsV1Schema } from '@happier-dev/protocol/machines/peer/mediation/stream/v1';
import { hitAreaOverlap, readHitArea } from '@/dev/testkit/harness/hitFrameReach';
import { createHomeGovernanceHarness, installHomeGovernanceBoundaries, waitForHomeGovernance } from '@/dev/testkit/harness/homeGovernanceHarness';
import { createTransferRecipientKeyPair } from '@/sync/domains/transfers/runtime/transferRuntime/plumbing/transferChunkEncryption';
import { composerRefV1Key } from '@happier-dev/protocol/plugins/ui/composerRef';
import { restoreServerAccountForTest } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { installSessionActionRpcBoundary } from '@/dev/testkit/harness/sessionActionRpcBoundary';
import { installBrowserStorageLockBoundary } from '@/dev/testkit/harness/browserStorageLockBoundary';
import { createPlainAccountEncryptionCurrentnessFixture } from '@/dev/testkit/fixtures/accountEncryptionCurrentness';
import { loadVitestModuleForNodeRequire } from '@/dev/vitestRnShim';
import {
    readReanimatedFrameCallbacks,
    resetReanimatedFrameCallbacks,
} from '@/dev/testkit/mocks/reanimated';

const TRAILING_TEST_ID = 'voice-trailing-accessory';
const FIELD_TEST_ID = 'voice-field-accessory';
const SEND_TEST_ID = 'session-composer-send';
const NEW_SESSION_SEND_TEST_ID = 'new-session-composer-send';
const PLANET_TEST_ID = 'session-composer-voice';
/** The wrapped second chip row — the column's own marker, whatever it holds. */
const SECOND_CHIP_ROW_TEST_ID = 'agentInput-pathResumeRow';

// `AgentInput` renders two structurally distinct panels — a web one and a native
// one — that both have to place these slots identically. A live getter lets one
// file assert both without a second copy of the mock family.
const platformState = vi.hoisted(() => ({ os: 'web' as 'web' | 'ios', width: 900 }));
// Keep the Node source resolver, but give the actual web Modal its DOM/OS
// boundary, as the existing transcript web-scroller testkit does.
const { JSDOM } = await import('jsdom');
const browserDom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'https://composer.test', pretendToBeVisual: true });
function installBrowserDomBoundary() {
    for (const name of ['window', 'document', 'HTMLElement', 'Node', 'MutationObserver', 'CustomEvent'] as const) {
        vi.stubGlobal(name, name === 'window' ? browserDom.window : browserDom.window[name]);
    }
}
installBrowserDomBoundary();
afterAll(() => browserDom.window.close());
// These physical-target contracts exercise touch web as well as native. The
// canonical target owner samples browser pointer capability on first use.
function installBrowserMicrophoneBoundary() {
    vi.stubGlobal('navigator', { maxTouchPoints: 1, userAgent: 'Composer touch browser', language: 'en-US', languages: ['en-US'],
        permissions: { query: async () => ({ state: 'granted' }) },
        mediaDevices: { getUserMedia: async () => ({ getTracks: () => [{ stop() {} }] }) },
    });
}
installBrowserMicrophoneBoundary();
afterAll(() => vi.unstubAllGlobals());
const recording = vi.hoisted(() => ({
    starts: 0,
    stops: 0,
    prepares: 0,
    audioModes: 0,
    snapshots: [] as unknown[],
    setTextAndSelection: vi.fn(),
    focus: vi.fn(),
}));
const machineRpc = vi.hoisted(() => vi.fn());
// The real `voice` setting, so `useVoiceAttemptControl` walks the real provider
// registry rather than being mocked out. `null` is "Voice not configured", which is
// what every test outside the mount block expects.
const voiceSettingState = vi.hoisted(() => ({ current: null as unknown }));

vi.mock('react-native', async () => {
        const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
        return createReactNativeWebMock({
            View: (props: Record<string, unknown> & { children?: React.ReactNode }) =>
                React.createElement('View', props, props.children),
            Text: (props: Record<string, unknown> & { children?: React.ReactNode }) =>
                React.createElement('Text', props, props.children),
            // `Pressable` accepts render-prop children (`({ pressed }) => …`), and the
            // dictation button uses that form. Rendering the function itself as a child
            // silently drops the whole visual subtree, so resolve it the way React Native
            // does before handing children to the host element.
            Pressable: (props: Record<string, unknown> & { children?: React.ReactNode }) =>
                React.createElement(
                    'Pressable',
                    props,
                    typeof props.children === 'function'
                        ? (props.children as (state: { pressed: boolean }) => React.ReactNode)({ pressed: false })
                        : props.children,
                ),
            ScrollView: (props: Record<string, unknown> & { children?: React.ReactNode }) =>
                React.createElement('ScrollView', props, props.children),
            ActivityIndicator: (props: Record<string, unknown>) =>
                React.createElement('ActivityIndicator', props, null),
            Platform: {
                get OS() {
                    return platformState.os;
                },
                select: (v: any) => (platformState.os === 'web' ? v.web : v.ios) ?? v.native ?? v.default ?? null,
            },
            useWindowDimensions: () => ({ width: platformState.width, height: 600 }),
            Dimensions: {
                get: () => ({ width: platformState.width, height: 600, scale: 1, fontScale: 1 }),
            },
        });
});
vi.mock('@expo/vector-icons', () => ({
        Ionicons: (props: Record<string, unknown>) => React.createElement('Ionicons', props, null),
        Octicons: (props: Record<string, unknown>) => React.createElement('Octicons', props, null),
}));
vi.mock('react-native-unistyles', async () => (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock());
vi.mock('react-native-reanimated', async () => (await import('@/dev/testkit/mocks/reanimated')).createReanimatedModuleMock());
vi.mock('react-native-keyboard-controller', () => ({ useFocusedInputHandler: () => {} }));

vi.mock('expo-image', () => ({
    Image: (props: Record<string, unknown>) => React.createElement('Image', props, null),
}));


// Expo's recorder is the native/browser SDK boundary. The host microphone,
// audio-mode lease, artifact custody, capture and Dictation owners stay real.
vi.mock('expo-audio', () => {
    class AudioRecorderWeb {
        uri: string | null = null;
        async prepareToRecordAsync() { recording.prepares += 1; }
        pause() {}
        record() { recording.starts += 1; }
        async stop() { recording.stops += 1; this.uri = 'blob:agentinput-dictation'; }
    }
    return { AudioModule: { AudioRecorderWeb, setAudioModeAsync: async () => { recording.audioModes += 1; },
        requestRecordingPermissionsAsync: async () => ({ granted: true, canAskAgain: true }),
    }, RecordingPresets: { HIGH_QUALITY: { web: { mimeType: 'audio/webm' } } } };
});

const home = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(home);
installSessionActionRpcBoundary(request => machineRpc({
    method: request.method.slice(request.method.indexOf(':') + 1), params: request.params,
}));
const { renderMountedCurrentUiContext } = await import('@/dev/testkit/harness/mountedCurrentUiContext');
const { primeServerFeaturesSnapshot, resetServerFeaturesClientForTests } = await import('@/sync/api/capabilities/serverFeaturesClient');
const { publishAppliedActiveServerSnapshot } = await import('@/sync/runtime/orchestration/appliedActiveServerRuntime');
const { resolveServerProfileScopeIdForIdentifier } = await import('@/sync/domains/server/serverProfiles');
const { resolveRuntimeFeatureDecision } = await import('@/sync/domains/features/featureDecisionInputs');
const { t } = await import('@/text');

function createInputHost(element: Parameters<NonNullable<RenderWithAppProvidersOptions['createNodeMock']>>[0]) {
    // The canonical Expo view shim forwards native commands from this host ref.
    return element.type === 'HappierComposerInput' ? {
        setTextAndSelection: recording.setTextAndSelection,
        focus: recording.focus,
        blur() {},
        measureInWindow(callback: (x: number, y: number, width: number, height: number) => void) { callback(0, 0, 300, 100); },
    } : null;
}

async function renderScreen(element: React.ReactElement) {
    const voiceDecision = await resolveRuntimeFeatureDecision({ featureId: 'voice' });
    expect(voiceDecision).toMatchObject({ state: 'enabled' });
    return renderMountedCurrentUiContext(<ModalProvider>{element}</ModalProvider>, { createNodeMock: createInputHost });
}
function flattenStyle(style: unknown): Record<string, unknown> {
    if (typeof style === 'function') {
        return flattenStyle(style({ pressed: false }));
    }
    if (Array.isArray(style)) {
        return style.reduce<Record<string, unknown>>((acc, entry) => Object.assign(acc, flattenStyle(entry)), {});
    }
    if (style && typeof style === 'object') return style as Record<string, unknown>;
    return {};
}

/** The offset of a control's drawn box from its container's top: the wrappers' top padding between them. */
function readDrawnTopWithin(node: ReactTestInstance, containerTestID: string): number {
    let offset = 0;
    for (let parent = node.parent; parent && parent.props?.testID !== containerTestID; parent = parent.parent) {
        // Composite wrappers repeat their host's style; count the host views only.
        if (typeof parent.type === 'string') offset += Number(flattenStyle(parent.props.style).paddingTop ?? 0);
    }
    return offset;
}

/** The WCAG 2.2 AA minimum target (24 CSS px) every composer control keeps, on every pointer. */
const WCAG_MINIMUM_TARGET = 24;

function findSlotContainer(screen: RenderScreenResult, ...testIDs: readonly string[]): ReactTestInstance {
    const candidates = screen.root.findAll((node) => (
        typeof node.type === 'string'
        && !testIDs.includes(node.props?.testID)
        && testIDs.every((testID) => node.findAllByProps({ testID }).length > 0)
    ));
    const deepest = candidates.at(-1);
    if (!deepest) throw new Error(`No container holds all of ${testIDs.join(', ')}`);
    return deepest;
}

function readSlotOrder(container: ReactTestInstance, ...testIDs: readonly string[]): string[] {
    const seen: string[] = [];
    for (const node of container.findAll((n) => typeof n.type === 'string')) {
        const testID = node.props?.testID;
        if (typeof testID === 'string' && testIDs.includes(testID) && !seen.includes(testID)) {
            seen.push(testID);
        }
    }
    return seen;
}

async function renderComposer(overrides: Record<string, unknown> = {}): Promise<RenderScreenResult> {
    seedComposerSettings();
    const { AgentInput } = await import('./AgentInput');
    return renderScreen(<AgentInput
        sessionId="session-1"
        value=""
        placeholder="Type"
        onChangeText={() => {}}
        onSend={() => {}}
        autocompleteKinds={[]}
        autocompleteSuggestions={async () => []}
        {...overrides}
    />);
}

/**
 * The New Session composer's identifying props.
 *
 * The two-row action bar is **not** a property of having a machine or a path to
 * show: `shouldShowSecondaryControlRow` reads `hasMachine || hasPath ||
 * hasResume`, and each of those is a *handler or popover*, never a label
 * (`AgentInput.tsx:2424-2426`). The in-session composer displays the same
 * machine and path and stays one row — which is why the stacked trailing cluster
 * is reachable only from `NewSessionSimplePanel.tsx:328-336` and
 * `NewSessionWizard.tsx:670-678`, and why a fixture that passes labels alone
 * would silently test the one-row case while claiming to test two rows.
 */
const NEW_SESSION_LABELS = {
    machineName: 'leeroy-mbp',
    currentPath: 'happier/dev',
    resumeSessionId: 'resume-1',
} as const;

const NEW_SESSION_HANDLERS = {
    onMachineClick: () => {},
    onPathClick: () => {},
    onResumeClick: () => {},
} as const;

/**
 * The real composer planet, in the real trailing slot.
 *
 * A `View` fixture proves placement but not composition: the planet is a memo
 * leaf that reads the energy context, and mounting it here is what proves it
 * survives the composer's own mock family and lands in the cluster.
 */
async function renderComposerWithPlanet(
    overrides: Record<string, unknown> = {},
): Promise<RenderScreenResult> {
    seedComposerSettings();
    const { AgentInput } = await import('./AgentInput');
    const { VoiceComposerPlanet } = await import('@/components/voice/composer/VoiceComposerPlanet');
    const { VoiceEnergyProvider } = await import('@/components/voice/light/useVoiceEnergy');
    return renderScreen(
        <VoiceEnergyProvider
            state={{ luminosity: 0.62, energized: true, direction: 'inward' }}
            activation={{ providerReady: true, attemptActive: true, micCaptureActive: true }}
        >
            <AgentInput
                sessionId="session-1"
                value=""
                placeholder="Type"
                onChangeText={() => {}}
                onSend={() => {}}
                autocompleteKinds={[]}
                autocompleteSuggestions={async () => []}
                submitDictation={false}
                trailingAccessory={(
                    <VoiceComposerPlanet
                        pose="ready"
                        muted={false}
                        accessibilityLabel="End the conversation"
                        accessibilityHint="Stops the spoken conversation"
                        onPress={() => {}}
                    />
                )}
                {...overrides}
            />
        </VoiceEnergyProvider>
    );
}

// Resolve the real composer graph during collection, before a behavior test's clock starts.
// Cold source-module loading is harness setup rather than a composer operation.
const nativeRecorderBridge = await loadVitestModuleForNodeRequire(
    new URL('../../../voice/runtime/mic/NativeMicSession.ts', import.meta.url),
    () => import('@/voice/runtime/mic/NativeMicSession'),
);
afterAll(() => nativeRecorderBridge.dispose());
await import('./AgentInput');
const { getStorage } = await import('@/sync/domains/state/storage');
const { voiceSettingsParse } = await import('@/sync/domains/settings/voiceSettings');
const { setVoiceSessionSnapshot } = await import('@/voice/session/voiceSessionStore');
const { MultiTextInput } = await import('@/components/ui/forms/MultiTextInput');
const { SessionAuthoringComposer } = await import('@/components/sessions/authoring/SessionAuthoringComposer');
const { voiceDictationController } = await import('@/voice/dictation/useVoiceDictation');
const { normalizeVoiceSettingsLocalDelta } = await import('@/sync/domains/settings/voiceSettingsPersistence');
const { voiceConversationRuntimeMachine } = await import('@/voice/runtime/machine/VoiceConversationRuntimeMachine');
const { setRuntimeFetch, resetRuntimeFetch } = await import('@/utils/system/runtimeFetch');
const { ModalProvider } = await import('@/modal');
const initialStorageState = getStorage().getState();
let restoredConnection: Awaited<ReturnType<typeof restoreServerAccountForTest>> | undefined;
let composerServerId = '';
let stopObservingDictation: (() => void) | undefined;
let disposeBrowserStorageLocks: (() => void) | undefined;
beforeEach(async () => {
    installBrowserDomBoundary();
    installBrowserMicrophoneBoundary();
    disposeBrowserStorageLocks = installBrowserStorageLockBoundary();
    await home.reset();
    recording.starts = 0;
    recording.stops = 0;
    recording.prepares = 0;
    recording.audioModes = 0;
    recording.snapshots.length = 0;
    stopObservingDictation = voiceDictationController.subscribe(() => {
        recording.snapshots.push(voiceDictationController.getSnapshot());
    });
    recording.setTextAndSelection.mockClear();
    recording.focus.mockClear();
    machineRpc.mockReset();
    getStorage().setState(initialStorageState, true);
    resetServerFeaturesClientForTests();
    const serverId = await home.addHome({ name: 'Composer Home', serverUrl: 'https://composer.test', serverIdentityId: 'composer-home', accountId: 'composer-account', currentAccount: true });
    composerServerId = serverId;
    publishAppliedActiveServerSnapshot({ serverId, serverUrl: 'https://composer.test', generation: 0 });
    const scope = { serverId: resolveServerProfileScopeIdForIdentifier(serverId), accountId: 'composer-account' };
    const features = createRootLayoutFeaturesResponse({ capabilities: { serverIdentity: { serverIdentityId: 'composer-home' } }, features: {
        voice: { enabled: true, happierVoice: { enabled: false } },
        machines: { enabled: true, liveStream: { enabled: true, directPeer: { enabled: false }, serverRouted: { enabled: true } } },
    } });
    features.capabilities.machines.liveStream.serverRouted = { disabledReason: null,
        caps: MachineLiveStreamRelayCapsV1Schema.parse({ maxBitrateBps: 64000, maxFramesPerSecond: 50,
            maxFrameBytes: 16000, maxDurationMs: 60000, maxTotalBytes: 1000000,
            maxConcurrentStreamsPerAccount: 2, maxConcurrentStreamsPerSocket: 1, maxConcurrentStreamsPerMachine: 1 }) };
    home.answer(serverId, '/v1/features', { body: features });
    home.answer(serverId, '/v1/features/authenticated', { body: features });
    home.answer(serverId, '/v1/account/encryption/currentness', { body: createPlainAccountEncryptionCurrentnessFixture() });
    const { TokenStorage } = await import('@/auth/storage/tokenStorage');
    restoredConnection = await restoreServerAccountForTest({ serverUrl: 'https://composer.test',
        accountId: 'composer-account',
        credentials: (await TokenStorage.getCredentialsForServerUrl('https://composer.test'))!,
        request: (url, init) => home.request(url, init),
    });
    await home.selectHomes([serverId]);
    getStorage().setState({ settingsScope: scope, profileScope: scope });
    primeServerFeaturesSnapshot({ serverId, snapshot: { status: 'ready', features } });
    const blob = new Blob(['spoken-words'], { type: 'audio/webm' });
    setRuntimeFetch(async (url, init) => String(url) === 'blob:agentinput-dictation' ? new Response(blob) : home.request(url, init));
    const recipient = createTransferRecipientKeyPair();
    machineRpc.mockImplementation(async ({ method }: { method: string }) => {
        if (method.endsWith('upload.init')) return { success: true, uploadId: 'composer-upload', chunkSizeBytes: 65536, recipientPublicKeyBase64: recipient.recipientPublicKeyBase64 };
        if (method.endsWith('upload.chunk') || method.endsWith('upload.abort')) return { success: true };
        if (method.endsWith('upload.finalize')) return { success: true, uploadId: 'composer-upload', path: '/tmp/composer.webm', sizeBytes: blob.size, sha256: 'abc' };
        if (method.endsWith('stt.transcribe')) return { ok: true, requestId: 'composer-request', text: 'fresh words', language: 'en', modelPackId: null };
        throw new Error(`Unexpected composer RPC: ${method}`);
    });
});
afterEach(async () => {
    await voiceDictationController.cancel();
    stopObservingDictation?.(); stopObservingDictation = undefined;
    const { getVoiceSessionLifecycleController, setVoiceSessionLifecycleController } = await import('@/voice/session/voiceSessionLifecycleControllerStore');
    await getVoiceSessionLifecycleController()?.dispose();
    setVoiceSessionLifecycleController(null);
    voiceConversationRuntimeMachine.reset();
    await restoredConnection?.dispose();
    restoredConnection = undefined;
    disposeBrowserStorageLocks?.(); disposeBrowserStorageLocks = undefined;
    resetRuntimeFetch();
    resetServerFeaturesClientForTests();
    getStorage().setState(initialStorageState, true);
    setVoiceSessionSnapshot({ adapterId: null, sessionId: null, status: 'disconnected', mode: 'idle', canStop: false });
    platformState.width = 900;
});

function seedComposerSettings(): void {
    const machine = createMachineFixture({ id: 'speech-machine', storageMode: 'plain', active: true, activeAt: Date.now() });
    const machineRow = createPlainMachineRowFixture({ id: machine.id, accountId: 'composer-account' });
    home.answer(composerServerId, '/v1/machines', { body: [machineRow] });
    home.answer(composerServerId, `/v1/machines/${machine.id}`, { body: { machine: machineRow } });
    home.answer(composerServerId, `/v1/machines/${machine.id}/access`, { body: {
        machineId: machine.id, custodian: machineRow.access!.custodian, access: machineRow.access,
        canManage: true, grants: [], ownDirectGrant: false, ownAccessSources: [],
    } });
    getStorage().setState({ machines: { [machine.id]: machine }, machineListByServerId: { [composerServerId]: [machine] } });
    const state = getStorage().getState();
    if (!state.settingsScope) throw new Error('Composer Account settings scope is not active');
    // The hydrated client and its Home serve the same configured Account.
    state.applySettingsForScope(state.settingsScope, {
        ...state.settings,
        ...normalizeVoiceSettingsLocalDelta({ voice: voiceSettingsParse({ ...(voiceSettingState.current && typeof voiceSettingState.current === 'object' ? voiceSettingState.current : { providerId: 'off' }),
            executionMachine: { mode: 'fixed', machineId: 'speech-machine' },
            dictation: { sttBinding: 'explicit', stt: { provider: 'local_neural', localNeural: { execution: 'daemon' } } },
        }) }, state.settings),
        experiments: true,
        featureToggles: { ...state.settings.featureToggles, voice: true, 'voice.daemonInference': true, 'voice.agent': true, 'execution.runs': true },
        agentInputEnterToSend: true,
        agentInputActionBarLayout: 'wrap',
        agentInputChipDensity: 'labels',
        sessionPermissionModeApplyTiming: 'immediate',
    }, (state.settingsVersion ?? 0) + 1);
    home.answer(composerServerId, '/v2/account/settings', { body: {
        content: { t: 'plain', v: getStorage().getState().settings }, version: getStorage().getState().settingsVersion,
    } });
}

describe('AgentInput voice accessory slots', () => {
    it('puts a document composer\'s library and mic at the end of its chip row, not the field corner (voiceAffordance dictation; DESIGN-6 P1)', async () => {
        platformState.os = 'web';
        const screen = await renderComposer({ voiceAffordance: 'dictation', trailingAccessory: undefined });
        expect(screen.findByTestId('agent-input-prompt-library')).not.toBeNull();
        expect(screen.findByTestId('agent-input-dictation')).not.toBeNull();
        const cluster = screen.findByTestId('agent-input-field-accessories');
        expect(flattenStyle(cluster?.props.style).position).not.toBe('absolute');
        // The field no longer reserves a corner for them.
        const field = screen.root.findByType(MultiTextInput);
        expect(field.props.paddingRight ?? 0).toBeLessThan(44);
        await screen.unmount();
    });

    it.each(['web', 'ios'] as const)('reserves a distinct library target beside dictation on %s and keeps it with dictation disabled', async (os) => {
        platformState.os = os;
        const screen = await renderComposer();
        const library = screen.findByTestId('agent-input-prompt-library');
        expect(library).not.toBeNull();
        const microphone = screen.findByTestId('agent-input-dictation');
        expect(microphone).not.toBeNull();
        const cluster = screen.findByTestId('agent-input-field-accessories')!;
        const clusterStyle = flattenStyle(cluster.props.style);
        const libraryArea = readHitArea(library!);
        const microphoneArea = readHitArea(microphone!);
        // Both controls are drawn at their design square; a finger reaches them through the hit area.
        expect(libraryArea.drawn).toEqual({ width: 24, height: 24 });
        expect(microphoneArea.drawn).toEqual({ width: 24, height: 24 });
        // The field corner reserves exactly the drawn squares plus its edge inset, never a 44 target each.
        expect(Number(clusterStyle.width)).toBe(libraryArea.drawn.width + microphoneArea.drawn.width);
        const field = screen.root.findByType(MultiTextInput);
        expect(field.props.paddingRight).toBe(Number(clusterStyle.width) + Number(clusterStyle.right));
        // Each hit area clears the WCAG floor, and the two never overlap: they touch sideways, so
        // neither reaches past its drawn edge there.
        for (const area of [libraryArea, microphoneArea]) {
            expect(area.width).toBeGreaterThanOrEqual(WCAG_MINIMUM_TARGET);
            expect(area.height).toBeGreaterThanOrEqual(WCAG_MINIMUM_TARGET);
        }
        const [first, second] = readSlotOrder(cluster, 'agent-input-prompt-library', 'agent-input-dictation')
            .map((id) => (id === 'agent-input-prompt-library' ? libraryArea : microphoneArea));
        expect(hitAreaOverlap(first!, second!, { axis: 'horizontal' })).toBe(0);
        await screen.unmount();

        const quiet = await renderComposer({ submitDictation: false });
        expect(quiet.findByTestId('agent-input-prompt-library')).not.toBeNull();
        expect(quiet.findByTestId('agent-input-dictation')).toBeNull();
        await quiet.unmount();
    });

    it('does not offer the library on a locked composer and preserves custom accessories', async () => {
        const locked = await renderComposer({ disabled: true });
        expect(locked.findByTestId('agent-input-prompt-library')).toBeNull();
        await locked.unmount();
        const custom = await renderComposer({ fieldAccessory: <FieldAccessoryFixture /> });
        expect(custom.findByTestId(FIELD_TEST_ID)).not.toBeNull();
        expect(custom.findByTestId('agent-input-dictation')).toBeNull();
        await custom.unmount();
    });
    afterEach(() => {
        platformState.os = 'web';
        vi.clearAllMocks();
    });

    it('leaves the submit button meaning Send when the host owns dictation', async () => {
        const screen = await renderComposer({ submitDictation: false });

        const send = screen.findByTestId(SEND_TEST_ID);
        if (!send) throw new Error(`${SEND_TEST_ID} not found`);
        expect(send.props.accessibilityLabel).toBe(t('common.send'));
        expect(send.findAllByType('Image' as any)).toHaveLength(0);

        await screen.unmount();
    });

    it('keeps the microphone when Stop is already reachable from the abort chip', async () => {
        // The regression this pins: an earlier fix let the empty-composer Stop take
        // the submit button unconditionally. On the default action bar that buys a
        // *duplicate* Stop — `buildCoreAgentInputControlNodes.tsx:184` already
        // renders a dedicated abort chip — and pays for it with the microphone.
        // Here dictation IS available on the button, so Stop must yield. The host
        // owns the field corner, which is what keeps the microphone on the submit
        // button now that a composer owning that corner moves dictation into it.
        const onAbort = vi.fn();
        const screen = await renderComposer({
            onAbort,
            showAbortButton: true,
            fieldAccessory: <FieldAccessoryFixture />,
        });

        const send = screen.findByTestId(SEND_TEST_ID);
        if (!send) throw new Error(`${SEND_TEST_ID} not found`);
        expect(send.findAllByType('Icon' as any).some((n) => n.props?.name === 'stop')).toBe(false);
        expect(send.props.accessibilityLabel).not.toBe(t('agentInput.stopCodingTurn'));

        await screen.unmount();
    });

    it('leaves the microphone alone when an Agent switch is armed but nothing is typed', async () => {
        // The armed label follows the arm onto the SEND, not onto whatever this
        // button happens to be. Here the host owns the field corner, so the
        // microphone owns the submit button — and "Continue with Codex" on it
        // would name a switch that press starts dictating into instead of taking.
        const screen = await renderComposer({
            fieldAccessory: <FieldAccessoryFixture />,
            armedContinuationTarget: { agentId: 'codex', label: 'Codex' },
        });

        const send = screen.findByTestId(SEND_TEST_ID);
        if (!send) throw new Error(`${SEND_TEST_ID} not found`);
        expect(send.props.accessibilityLabel).toBe(t('voiceAssistant.startDictation'));
        expect(send.findAllByType('Image' as any)).toHaveLength(1);

        await screen.unmount();
    });

    it('names the armed switch on the submit button once the host stops taking it', async () => {
        // The counterpart: with dictation moved off this control there is nothing
        // else holding it, so the empty composer's inert send says what pressing it
        // would do. Without this pair the narrowing above could be "never show the
        // arm on an empty composer" and both tests would still pass.
        const screen = await renderComposer({
            submitDictation: false,
            armedContinuationTarget: { agentId: 'codex', label: 'Codex' },
        });

        const send = screen.findByTestId(SEND_TEST_ID);
        if (!send) throw new Error(`${SEND_TEST_ID} not found`);
        expect(send.props.accessibilityLabel).toBe(t('session.agentContinuation.sendLabel', { agent: 'Codex' }));
        expect(send.findAllByType('Image' as any)).toHaveLength(0);
        expect(send.props.disabled).toBe(true);

        await screen.unmount();
    });

    it('lets the submit button stop the coding turn when the host owns dictation', async () => {
        const onAbort = vi.fn();
        const screen = await renderComposer({
            submitDictation: false,
            onAbort,
            showAbortButton: true,
        });

        const send = screen.findByTestId(SEND_TEST_ID);
        if (!send) throw new Error(`${SEND_TEST_ID} not found`);
        expect(send.props.accessibilityLabel).toBe(t('agentInput.stopCodingTurn'));
        expect(send.findAllByType('Image' as any)).toHaveLength(0);
        expect(send.findAllByType('Icon' as any).some((n) => n.props?.name === 'stop')).toBe(true);

        await screen.pressByTestIdAsync(SEND_TEST_ID);
        expect(onAbort).toHaveBeenCalledTimes(1);

        await screen.unmount();
    });

    it('pins the field accessory to the field corner and drops it below the expand toggle', async () => {
        const screen = await renderComposer({
            fieldAccessory: <FieldAccessoryFixture />,
            inputExpansion: { expanded: false, collapsedMaxHeight: 100, onToggle: () => {} },
        });

        expect(screen.findByTestId('agent-input-expand-toggle')).toBeNull();
        // One 24 square per accessory (library + the host's), in the corner inset the field reserves.
        expect(flattenStyle(screen.findByTestId('agent-input-field-accessories')!.props.style)).toMatchObject({
            position: 'absolute',
            top: 2,
            right: 6,
            width: 48,
            height: 24,
        });

        const input = screen.root.findByType(MultiTextInput);
        await act(async () => {
            input.props.onContentHeightChange?.(240);
        });

        const toggle = screen.findByTestId('agent-input-expand-toggle');
        expect(toggle).not.toBeNull();
        const toggleArea = readHitArea(toggle!);
        expect(toggleArea.drawn).toEqual({ width: 24, height: 24 });
        expect(toggleArea.width).toBeGreaterThanOrEqual(WCAG_MINIMUM_TARGET);
        const fieldTargetStyle = flattenStyle(screen.findByTestId('agent-input-field-accessories')!.props.style);
        expect(fieldTargetStyle).toMatchObject({ position: 'absolute', right: 6, width: 48, height: 24 });
        expect(Number(fieldTargetStyle.top)).toBeGreaterThan(2);

        // The toggle sits above the accessories and the two hit areas share the gap between their
        // drawn squares without overlapping.
        const library = screen.findByTestId('agent-input-prompt-library')!;
        const libraryArea = readHitArea(library);
        const toggleStyle = flattenStyle(toggle!.props.style);
        const toggleBottom = Number(toggleStyle.top) + toggleArea.drawn.height;
        const libraryTop = Number(fieldTargetStyle.top) + readDrawnTopWithin(library, 'agent-input-field-accessories');
        expect(libraryTop).toBeGreaterThan(toggleBottom);
        expect(hitAreaOverlap(toggleArea, libraryArea, { axis: 'vertical', gap: libraryTop - toggleBottom })).toBe(0);

        await screen.unmount();
    });

    it.each([
        ['web', 'web'] as const,
        ['native', 'ios'] as const,
    ])('renders the trailing accessory before the submit button on the %s panel', async (_label, os) => {
        platformState.os = os;
        const screen = await renderComposer({ trailingAccessory: <TrailingAccessoryFixture /> });

        const cluster = findSlotContainer(screen, TRAILING_TEST_ID, SEND_TEST_ID);
        expect(readSlotOrder(cluster, TRAILING_TEST_ID, SEND_TEST_ID)).toEqual([TRAILING_TEST_ID, SEND_TEST_ID]);
        expect(flattenStyle(cluster.props.style)).toMatchObject({ flexDirection: 'row' });

        await screen.unmount();
    });

    it.each([
        ['web', 'web'] as const,
        ['native', 'ios'] as const,
    ])('keeps that reading order on the %s panel when the row stacks', async (_label, os) => {
        platformState.os = os;
        platformState.width = 390;
        const screen = await renderComposer({
            sessionId: undefined,
            trailingAccessory: <TrailingAccessoryFixture />,
            machineName: 'Machine',
            onMachineClick: () => {},
        });

        const { NATIVE_ACTION_BAR_SECTION_GAP_Y } = await import('./AgentInput');
        const cluster = findSlotContainer(screen, TRAILING_TEST_ID, NEW_SESSION_SEND_TEST_ID);
        // column-reverse paints the accessory *under* Send while the tree — and so
        // the screen-reader order — still reads accessory first.
        const clusterStyle = flattenStyle(cluster.props.style);
        expect(clusterStyle).toMatchObject({ flexDirection: 'column-reverse' });
        expect(readSlotOrder(cluster, TRAILING_TEST_ID, NEW_SESSION_SEND_TEST_ID)).toEqual([TRAILING_TEST_ID, NEW_SESSION_SEND_TEST_ID]);

        // The cluster is the chip column's **sibling**, never a passenger inside
        // chip row 1. Nested there it was centred against the chips, so every
        // point it stood taller than a 32pt chip was paid twice — once above the
        // row and once below — as the dead band under the input.
        const bar = findSlotContainer(screen, TRAILING_TEST_ID, SECOND_CHIP_ROW_TEST_ID);
        expect(flattenStyle(bar.props.style)).toMatchObject({
            flexDirection: 'row',
            alignItems: 'flex-end',
            justifyContent: 'space-between',
        });

        // And it rides the column's own row rhythm, so two stacked 32pt controls
        // measure exactly the two 32pt chip rows beside them.
        const column = bar.children.find((child): child is ReactTestInstance => typeof child !== 'string'
            && child !== cluster && child.findAllByProps({ testID: SECOND_CHIP_ROW_TEST_ID }).length > 0);
        expect(column).toBeDefined();
        expect(clusterStyle.gap)
            .toBe(flattenStyle(column!.props.style).gap ?? NATIVE_ACTION_BAR_SECTION_GAP_Y);

        await screen.unmount();
    });
});

describe('AgentInput two-row trailing cluster', () => {
    afterEach(() => {
        platformState.os = 'web';
        vi.clearAllMocks();
    });

    it.each([
        ['web', 'web'] as const,
        ['native', 'ios'] as const,
    ])('keeps Voice inline beside Send on the %s panel while the labels are only labels', async (_label, os) => {
        platformState.os = os;
        const screen = await renderComposerWithPlanet(NEW_SESSION_LABELS);

        const cluster = findSlotContainer(screen, PLANET_TEST_ID, SEND_TEST_ID);
        expect(flattenStyle(cluster.props.style)).toMatchObject({ flexDirection: 'row' });
        expect(readSlotOrder(cluster, PLANET_TEST_ID, SEND_TEST_ID))
            .toEqual([PLANET_TEST_ID, SEND_TEST_ID]);

        await screen.unmount();
    });

    it.each([
        ['web', 'web'] as const,
        ['native', 'ios'] as const,
    ])('stacks Voice under Send on the %s panel once the New Session handlers arrive', async (_label, os) => {
        platformState.os = os;
        platformState.width = 390;
        const screen = await renderComposerWithPlanet({
            sessionId: undefined,
            ...NEW_SESSION_LABELS,
            ...NEW_SESSION_HANDLERS,
        });

        const cluster = findSlotContainer(screen, PLANET_TEST_ID, NEW_SESSION_SEND_TEST_ID);
        // `column-reverse` paints the first child last: Send on top, the planet
        // beneath it, while the tree — and the screen reader — still reads
        // "Voice, then Send". Reversing the JSX to "fix" the stack breaks the row.
        expect(flattenStyle(cluster.props.style)).toMatchObject({ flexDirection: 'column-reverse' });
        expect(readSlotOrder(cluster, PLANET_TEST_ID, NEW_SESSION_SEND_TEST_ID))
            .toEqual([PLANET_TEST_ID, NEW_SESSION_SEND_TEST_ID]);

        await screen.unmount();
    });

    it.each([
        ['web', 'web'] as const,
        ['native', 'ios'] as const,
    ])('draws the planet at the submit button’s own weight on the %s panel', async (_label, os) => {
        platformState.os = os;
        const { VOICE_COMPOSER_PLANET_SLOT } = await import('@/components/voice/composer/VoiceComposerPlanet');
        const screen = await renderComposerWithPlanet({
            ...NEW_SESSION_LABELS,
            ...NEW_SESSION_HANDLERS,
        });

        const planets = screen.root.findAll((node) => (
            typeof node.type === 'string' && node.props?.testID === PLANET_TEST_ID
        ));
        expect(planets).toHaveLength(1);
        const planet = planets[0]!;
        const { IconButton } = await import('@/components/ui/buttons/IconButton');
        // The Voice control is drawn at the submit button's own 32pt weight.
        expect(screen.root.findAllByType(IconButton).find((button) => button.props.testID === PLANET_TEST_ID)?.props.size)
            .toBe(VOICE_COMPOSER_PLANET_SLOT);

        // Nothing between the mark and the cluster may clip: the live planet's atmosphere bleeds
        // past its box and the row's gap is what absorbs it.
        const cluster = findSlotContainer(screen, PLANET_TEST_ID, SEND_TEST_ID);
        for (let node: ReactTestInstance | null = planet; node && node !== cluster; node = node.parent) {
            expect(flattenStyle(node.props?.style).overflow).not.toBe('hidden');
        }
        expect(flattenStyle(cluster.props.style).overflow).not.toBe('hidden');

        await screen.unmount();
    });
});

/**
 * A provider whose settings projection is `ready`, so `useVoiceAttemptControl`
 * reports a startable attempt. The provider registry and settings parser run for real.
 */
const READY_VOICE_SETTING = {
    providerId: 'local_conversation',
    ui: { activityFeedEnabled: false, scopeDefault: 'global', surfaceLocation: 'auto' },
    providers: {
        local_conversation: { schemaVersion: 1, config: { conversationMode: 'agent' } },
    },
} as const;

const DICTATION_TEST_ID = 'agent-input-dictation';

/** Register the same local adapter implementation consumed by the builtin assembly. */
async function registerLocalConversationAdapter(): Promise<void> {
    const { registerVoiceAdapters } = await import('@/voice/session/voiceAdapterRegistry');
    const { createLocalConversationVoiceAdapter } = await import('@/voice/adapters/localConversation/localConversationAdapter');
    registerVoiceAdapters([createLocalConversationVoiceAdapter()]);
}

async function sessionComposerScene(
    overrides: Record<string, unknown> = {},
    energyActive = false,
): Promise<React.ReactElement> {
    const { AgentInput } = await import('./AgentInput');
    const { VoiceEnergyProvider } = await import('@/components/voice/light/useVoiceEnergy');
    return (
        <VoiceEnergyProvider
            state={energyActive
                ? { luminosity: 0.4, energized: true, direction: 'inward' }
                : { luminosity: 0.4, energized: false, direction: 'none' }}
            activation={{ providerReady: true, attemptActive: energyActive, micCaptureActive: energyActive }}
        >
            <AgentInput
                sessionId="session-1"
                sessionAddress={{ serverId: composerServerId, sessionId: 'session-1' }}
                value=""
                placeholder="Type"
                onChangeText={() => {}}
                onSend={() => {}}
                autocompleteKinds={[]}
                autocompleteSuggestions={async () => []}
                {...overrides}
            />
        </VoiceEnergyProvider>
    );
}

async function renderSessionComposer(
    overrides: Record<string, unknown> = {},
    energyActive = false,
): Promise<RenderScreenResult> {
    seedComposerSettings();
    await registerLocalConversationAdapter();
    return renderScreen(await sessionComposerScene(overrides, energyActive));
}

/**
 * §2.3 in the *real* composer.
 *
 * The slots landed first and stayed empty: the only `trailingAccessory` producer in
 * the tree was the design lab, so the planet reached no user. These tests are about
 * the production default — the composer that owns a session mounts both accessories
 * itself, and that is what takes dictation off the submit button.
 */
describe('AgentInput mounts the Voice composer', () => {
    afterEach(() => {
        platformState.os = 'web';
        voiceSettingState.current = null;
        vi.clearAllMocks();
    });

    it.each([
        ['web', 'web'] as const,
        ['native', 'ios'] as const,
    ])('puts Voice in the trailing slot before Send on the %s panel with no host accessory', async (_label, os) => {
        platformState.os = os;
        voiceSettingState.current = READY_VOICE_SETTING;

        const screen = await renderSessionComposer();

        const cluster = findSlotContainer(screen, PLANET_TEST_ID, SEND_TEST_ID);
        expect(readSlotOrder(cluster, PLANET_TEST_ID, SEND_TEST_ID))
            .toEqual([PLANET_TEST_ID, SEND_TEST_ID]);

        await screen.unmount();
    });

    it('moves dictation to the field corner and leaves the submit button meaning Send', async () => {
        voiceSettingState.current = READY_VOICE_SETTING;

        const screen = await renderSessionComposer();

        const mic = screen.findByTestId(DICTATION_TEST_ID);
        expect(mic).not.toBeNull();
        expect(mic!.props.accessibilityLabel).toBe(t('voiceAssistant.startDictation'));
        // Dictation sits in the field corner at its 24 design circle; a finger reaches it through the
        // hit area, which keeps the WCAG floor and never widens the drawn control.
        const micArea = readHitArea(mic!);
        expect(micArea.drawn).toEqual({ width: 24, height: 24 });
        expect(micArea.width).toBeGreaterThanOrEqual(WCAG_MINIMUM_TARGET);
        expect(micArea.height).toBeGreaterThanOrEqual(WCAG_MINIMUM_TARGET);
        const { Icon } = await import('@/components/ui/icons/Icon');
        const icons = mic!.findAllByType(Icon);
        expect(icons).toHaveLength(1);
        expect(icons[0]!.props.name).toBe('microphone');
        const send = screen.findByTestId(SEND_TEST_ID);
        expect(send!.props.accessibilityLabel).toBe(t('common.send'));

        const composerRef = screen.root.findByType(SessionAuthoringComposer).props.composerRef;
        if (!composerRef) throw new Error('Session composer reference missing');
        await screen.pressByTestIdAsync(DICTATION_TEST_ID);
        expect(voiceDictationController.getSnapshot(), JSON.stringify({ snapshots: recording.snapshots, prepares: recording.prepares,
            audioModes: recording.audioModes, starts: recording.starts })).toMatchObject({
            sessionId: composerRefV1Key(composerRef),
            status: 'listening',
        });
        expect(recording.starts).toBe(1);

        await screen.unmount();
    });

    it.each(['composer', 'composer submit', 'plugin'] as const)('reflects disabled Dictation Actions on the %s control and restores availability', async (surface) => {
        voiceSettingState.current = READY_VOICE_SETTING;
        seedComposerSettings();
        await registerLocalConversationAdapter();
        const { PluginDictationButton } = await import('@/components/plugins/surfaces/PluginDictationButton');
        const screen = await renderScreen(surface === 'plugin'
            ? <PluginDictationButton testID={DICTATION_TEST_ID} onTranscription={() => {}} />
            : await sessionComposerScene(surface === 'composer submit' ? { fieldAccessory: <FieldAccessoryFixture /> } : {}));
        const testID = surface === 'composer submit' ? SEND_TEST_ID : DICTATION_TEST_ID;
        expect(screen.findByTestId(testID)?.props.disabled).not.toBe(true);
        const settings = getStorage().getState().settings.actionsSettingsV1;
        await act(async () => { getStorage().getState().applySettingsLocal({ actionsSettingsV1: ActionsSettingsV1Schema.parse({ v: 1,
            actions: { 'ui.voice_global.dictation.start': { disabledSurfaces: ['ui'] } } }) }); });
        expect(screen.findByTestId(testID)?.props.disabled).toBe(true);
        expect(screen.findByTestId(testID)?.props.accessibilityState).toMatchObject({ disabled: true });
        expect(recording.starts).toBe(0);
        await act(async () => { getStorage().getState().applySettingsLocal({ actionsSettingsV1: settings }); });
        expect(screen.findByTestId(testID)?.props.disabled).not.toBe(true);
        // A native gesture publishes focus before awaiting its Action. Awaiting
        // the whole handler inside act would hold the commit that activates it.
        await act(async () => { screen.pressByTestId(testID); });
        await waitForHomeGovernance(() => expect(voiceDictationController.getSnapshot().status).toBe('listening'));
        expect(recording.starts).toBe(1);
        await act(async () => { getStorage().getState().applySettingsLocal({ actionsSettingsV1: ActionsSettingsV1Schema.parse({ v: 1,
            actions: { 'ui.voice_global.dictation.finish': { disabledSurfaces: ['ui'] } } }) }); });
        expect(screen.findByTestId(testID)?.props.disabled).toBe(true);
        expect(voiceDictationController.getSnapshot().status).toBe('listening');
        await screen.unmount();
    });

    it.each([
        ['read-only', { disabled: true }],
        ['edit-and-submit lock', { composerInputLock: { mode: 'editAndSubmit', reasons: ['Held by action'] } }],
    ])('uses the composer edit authority to disable Dictation for %s', async (_label, overrides) => {
        voiceSettingState.current = READY_VOICE_SETTING;

        const screen = await renderSessionComposer(overrides);
        const mic = screen.findByTestId(DICTATION_TEST_ID);

        expect(mic?.props.disabled).toBe(true);
        expect(mic?.props.accessibilityState).toMatchObject({ disabled: true });
        await screen.pressByTestIdAsync(DICTATION_TEST_ID);
        expect(voiceDictationController.getSnapshot().status).toBe('idle');
        expect(recording.starts).toBe(0);
        await screen.unmount();
    });

    it('does not insert a stale transcript after the composer becomes locked, or replay it after unlock', async () => {
        voiceSettingState.current = READY_VOICE_SETTING;
        const screen = await renderSessionComposer();
        await screen.pressByTestIdAsync(DICTATION_TEST_ID);
        let resolveTranscription!: (result: unknown) => void;
        const realRpcBoundary = machineRpc.getMockImplementation()!;
        machineRpc.mockImplementation((request: { method: string }) => request.method.endsWith('stt.transcribe')
            ? new Promise(resolve => { resolveTranscription = resolve; }) : realRpcBoundary(request));
        let pendingPress: Promise<void>;
        await act(async () => {
            pendingPress = screen.findByTestId(DICTATION_TEST_ID)!.props.onPress();
            // Await the actual upload and daemon transcription entry, not a fabricated toggle result.
            await vi.waitFor(() => expect(resolveTranscription).toBeDefined());
        });

        await screen.update(await sessionComposerScene({
            composerInputLock: { mode: 'editAndSubmit', reasons: ['Held by action'] },
        }));
        await act(async () => {
            resolveTranscription({ ok: true, requestId: 'stale-request', text: 'stale words', language: 'en', modelPackId: null });
            await pendingPress!;
        });
        expect(recording.setTextAndSelection).not.toHaveBeenCalled();

        await screen.update(await sessionComposerScene());
        expect(recording.setTextAndSelection).not.toHaveBeenCalled();
        expect(voiceDictationController.getSnapshot().status).toBe('idle');
        await screen.unmount();
    });

    it('still inserts a completed transcript while the same composer remains editable', async () => {
        voiceSettingState.current = READY_VOICE_SETTING;
        const onChangeText = vi.fn();
        const screen = await renderSessionComposer({ onChangeText });
        await screen.pressByTestIdAsync(DICTATION_TEST_ID);
        expect(voiceDictationController.getSnapshot(), JSON.stringify(recording.snapshots)).toMatchObject({ status: 'listening' });
        await screen.pressByTestIdAsync(DICTATION_TEST_ID);
        await waitForHomeGovernance(() => expect(onChangeText).toHaveBeenCalledWith('fresh words'));
        expect(onChangeText, JSON.stringify({ snapshot: voiceDictationController.getSnapshot(), methods: machineRpc.mock.calls.map(([request]) => request.method), nativeWrites: recording.setTextAndSelection.mock.calls })).toHaveBeenCalledWith('fresh words');
        expect(recording.setTextAndSelection).toHaveBeenCalledWith('fresh words', { start: 11, end: 11 }, []);
        expect(recording.focus).toHaveBeenCalledOnce();
        await screen.unmount();
    });

    it('uses the specified mic-off glyph while field dictation is active', async () => {
        voiceSettingState.current = READY_VOICE_SETTING;
        const screen = await renderSessionComposer();
        await screen.pressByTestIdAsync(DICTATION_TEST_ID);

        const mic = screen.findByTestId(DICTATION_TEST_ID);
        expect(mic).not.toBeNull();
        expect(mic!.props.accessibilityLabel).toBe(t('voiceAssistant.endDictation'));
        const { Icon } = await import('@/components/ui/icons/Icon');
        const icons = mic!.findAllByType(Icon);
        expect(icons).toHaveLength(1);
        expect(icons[0]!.props.name).toBe('microphone-slash');

        await screen.unmount();
    });

    it('keeps a host-supplied accessory in charge of both slots', async () => {
        voiceSettingState.current = READY_VOICE_SETTING;

        const screen = await renderSessionComposer({
            trailingAccessory: <TrailingAccessoryFixture />,
            fieldAccessory: <FieldAccessoryFixture />,
        });

        // The props are the seam; the mount is only the default. A host that owns the
        // slots keeps them, and keeps the submit-button microphone with them.
        expect(screen.findByTestId(TRAILING_TEST_ID)).not.toBeNull();
        expect(screen.findByTestId(PLANET_TEST_ID)).toBeNull();
        expect(screen.findByTestId(FIELD_TEST_ID)).not.toBeNull();
        expect(screen.findByTestId(DICTATION_TEST_ID)).toBeNull();
        expect(screen.findByTestId(SEND_TEST_ID)!.props.accessibilityLabel)
            .toBe(t('voiceAssistant.startDictation'));

        await screen.unmount();
    });

    it('offers Voice setup while no provider is usable, and still moves dictation', async () => {
        voiceSettingState.current = null;

        const screen = await renderSessionComposer();

        // Placement must not flicker with provider readiness: the field mic is where
        // dictation lives, whether or not a conversation could start right now.
        expect(screen.findByTestId(PLANET_TEST_ID)?.props.accessibilityLabel).toBe(t('voicePresence.setUp'));
        expect(screen.findByTestId(DICTATION_TEST_ID)).not.toBeNull();

        await screen.unmount();
    });

    it('unmounts the composer Voice leaf while a retained Session is hidden, then restores it when presented', async () => {
        voiceSettingState.current = READY_VOICE_SETTING;
        resetReanimatedFrameCallbacks();
        const { voiceRuntimeLevelStore } = await import('@/voice/runtime/levels/voiceRuntimeLevelStore');
        const source = voiceRuntimeLevelStore.open({ channel: 'input', sourceId: 'composer-presence-test' });
        setVoiceSessionSnapshot({ adapterId: 'local_conversation', sessionId: 'session-1', status: 'connected', mode: 'listening', canStop: true });

        const screen = await renderSessionComposer({ surfacePresented: true }, true);
        await act(async () => { source.write(0.4); });
        const activations = () => {
            const callbacks = readReanimatedFrameCallbacks();
            expect(callbacks).toHaveLength(1);
            return callbacks[0]!.setActiveCalls;
        };

        expect(activations()).toEqual([false, true]);

        await screen.update(await sessionComposerScene({ surfacePresented: false }, true));
        // Retention preserves the draft and the Session owner, not a second mounted
        // Voice runtime. Hidden composers must leave no Voice subscription/leaf behind.
        expect(screen.findByTestId(PLANET_TEST_ID)).toBeNull();
        expect(activations()).toEqual([false, true, false]);
        await screen.pressByTestIdAsync(DICTATION_TEST_ID);
        expect(recording.starts).toBe(0);

        await screen.update(await sessionComposerScene({ surfacePresented: true }, true));
        expect(screen.findByTestId(PLANET_TEST_ID)).not.toBeNull();
        expect(activations()).toEqual([false, true, false, true]);
        await screen.pressByTestIdAsync(DICTATION_TEST_ID);
        expect(recording.starts).toBe(1);
        expect(voiceDictationController.getSnapshot().status).toBe('listening');

        await screen.unmount();
        source.close();
    });
});

/**
 * §2.5 — which conversation each composer's planet starts.
 *
 * Both directions were wrong at once. The New Session composer mounted no planet at all, because
 * the mount was gated on `props.sessionId`; and the planet that did mount hardcoded a **Global**
 * start, so pressing it inside a session opened a conversation bound to nothing.
 *
 * The target is stated by the composer, never inferred by the projection: an existing session ⇒
 * that exact session, New Session ⇒ Global with the unsent draft intact.
 */
describe('AgentInput states the Voice planet’s target', () => {
    afterEach(async () => {
        platformState.os = 'web';
        voiceSettingState.current = null;
        const { registerVoiceAdapters } = await import('@/voice/session/voiceAdapterRegistry');
        registerVoiceAdapters([]);
        vi.clearAllMocks();
    });

    async function observeLifecycleRouting() {
        const { createVoiceSessionLifecycleController } = await import('@/voice/session/voiceSessionLifecycleController');
        const { setVoiceSessionLifecycleController } = await import('@/voice/session/voiceSessionLifecycleControllerStore');
        const lifecycle = createVoiceSessionLifecycleController();
        lifecycle.setConfiguredProviderId('local_conversation');
        setVoiceSessionLifecycleController(lifecycle);
        return {
            lifecycle,
        };
    }

    /**
     * The New Session composer, by its identifying props: no session exists yet, and the
     * machine/path/resume **handlers** are what put it in its two-row layout.
     */
    async function renderNewSessionComposer(
        overrides: Record<string, unknown> = {},
    ): Promise<RenderScreenResult> {
        seedComposerSettings();
        const { AgentInput } = await import('./AgentInput');
        const { VoiceEnergyProvider } = await import('@/components/voice/light/useVoiceEnergy');
        await registerLocalConversationAdapter();
        return renderScreen(
            <VoiceEnergyProvider
                state={{ luminosity: 0.4, energized: false, direction: 'none' }}
                activation={{ providerReady: true, attemptActive: false, micCaptureActive: false }}
            >
                <AgentInput
                    value=""
                    placeholder="Type"
                    onChangeText={() => {}}
                    onSend={() => {}}
                    autocompleteKinds={[]}
                    autocompleteSuggestions={async () => []}
                    {...NEW_SESSION_LABELS}
                    {...NEW_SESSION_HANDLERS}
                    {...overrides}
                />
            </VoiceEnergyProvider>,
        );
    }

    it('starts the composer’s exact qualified session even when another Home owns typing presence', async () => {
        voiceSettingState.current = READY_VOICE_SETTING;
        const routing = await observeLifecycleRouting();

        const screen = await renderSessionComposer({
            sessionId: 'shared-session',
            sessionAddress: { serverId: 'server-b', sessionId: 'shared-session' },
            sessionTypingPresence: { serverId: 'server-a', canSubmitAgentInput: true },
        });

        const planet = screen.findByTestId(PLANET_TEST_ID);
        expect(planet).not.toBeNull();
        expect(planet!.props.accessibilityLabel).toBe(t('voiceAssistant.startVoice'));

        // The manager must reach the mounted lifecycle owner: with that real
        // registration removed, the same control cannot admit any target.
        const { setVoiceSessionLifecycleController } = await import('@/voice/session/voiceSessionLifecycleControllerStore');
        const { VoiceComposerPlanet } = await import('@/components/voice/composer/VoiceComposerPlanet');
        setVoiceSessionLifecycleController(null);
        // Await this refusal at the leaf callback: the IconButton press wrapper
        // intentionally returns void, so restoring the owner immediately would
        // let this first Action race the second press's admission.
        await pressTestInstanceAsync(screen.findByType(VoiceComposerPlanet), 'composer Voice action');
        expect(routing.lifecycle.getAttemptTargetSessionAddress()).toBeNull();
        expect(recording.starts).toBe(0);
        setVoiceSessionLifecycleController(routing.lifecycle);
        await screen.pressByTestIdAsync(PLANET_TEST_ID);
        // A host press starts an asynchronous Action; observe its admitted target.
        await waitForHomeGovernance(() => expect(routing.lifecycle.getAttemptTargetSessionAddress()).toEqual({ serverId: 'server-b', sessionId: 'shared-session' }));

        await screen.unmount();
    });

    it('mounts a Global planet in the New Session composer and keeps the unsent draft', async () => {
        voiceSettingState.current = READY_VOICE_SETTING;
        const routing = await observeLifecycleRouting();
        const onChangeText = vi.fn();

        const screen = await renderNewSessionComposer({
            value: 'unsent draft',
            onChangeText,
        });

        const planet = screen.findByTestId(PLANET_TEST_ID);
        expect(planet).not.toBeNull();
        // A screen-reader user cannot see which composer they are in, so the label says which
        // conversation this starts.
        expect(planet!.props.accessibilityLabel).toBe(t('voiceAssistant.startGlobalVoice'));

        await screen.pressByTestIdAsync(PLANET_TEST_ID);
        const { VOICE_AGENT_GLOBAL_SESSION_ID } = await import('@/voice/agent/voiceAgentGlobalSessionId');
        await waitForHomeGovernance(() => expect(routing.lifecycle.getSnapshot()).toMatchObject({ adapterId: 'local_conversation', sessionId: VOICE_AGENT_GLOBAL_SESSION_ID }));
        expect(routing.lifecycle.getAttemptTargetSessionAddress()).toBeNull();

        // Starting Voice is not sending, discarding, or re-mounting the prompt being written.
        expect(screen.root.findByType(MultiTextInput).props.value).toBe('unsent draft');
        expect(onChangeText).not.toHaveBeenCalled();

        await screen.unmount();
    });

    it('leaves dictation session-scoped in the New Session composer', async () => {
        voiceSettingState.current = READY_VOICE_SETTING;

        const screen = await renderNewSessionComposer();

        // Dictation appends to *this* field through a session-bound transcriber; the planet's
        // arrival in New Session must not drag it along. The two halves of §2.3 are gated on
        // different facts, and one flag for both is what hid the planet here in the first place.
        expect(screen.findByTestId(PLANET_TEST_ID)).not.toBeNull();
        expect(screen.findByTestId(DICTATION_TEST_ID)).toBeNull();

        await screen.unmount();
    });
});

function FieldAccessoryFixture() {
    return React.createElement('View', { testID: FIELD_TEST_ID });
}

function TrailingAccessoryFixture() {
    return React.createElement('View', { testID: TRAILING_TEST_ID });
}
