import 'fake-indexeddb/auto';
import * as React from 'react';
import { ActionsSettingsV1Schema } from '@happier-dev/protocol/actions/actionSettings';
import { act } from 'react-test-renderer';
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import { createHomeGovernanceHarness, installHomeGovernanceBoundaries, waitForHomeGovernance } from '@/dev/testkit/harness/homeGovernanceHarness';
import { createMachineFixture, createPlainMachineRowFixture, createRootLayoutFeaturesResponse, renderHook, renderScreen, standardCleanup } from '@/dev/testkit';
import { createTransferRecipientKeyPair } from '@/sync/domains/transfers/runtime/transferRuntime/plumbing/transferChunkEncryption';
import { ApprovalRequestSchema } from '@happier-dev/protocol';
import type { ActionExecutorContext } from '@happier-dev/protocol/actions/executor/types';
import { loadVitestModuleForNodeRequire } from '@/dev/vitestRnShim';
import { installSessionActionRpcBoundary } from '@/dev/testkit/harness/sessionActionRpcBoundary';
import { MachineLiveStreamRelayCapsV1Schema } from '@happier-dev/protocol/machines/peer/mediation/stream/v1';
import { restoreServerAccountForTest } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { createPlainAccountEncryptionCurrentnessFixture } from '@/dev/testkit/fixtures/accountEncryptionCurrentness';
import { withPopoverWebGlobals } from '@/dev/testkit/harness/popoverHarness';
import { applyDictationToComposer } from '@/components/sessions/agentInput/applyDictationToComposer';

const recording = vi.hoisted(() => ({ starts: 0, stops: 0 }));
const machineRpc = vi.hoisted(() => vi.fn());
vi.mock('react-native', async () => (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock());
vi.mock('react-native-unistyles', async () => (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock());
// Only the external portal renderer is replaced; confirmation and approval stay real.
vi.mock('@/utils/web/radixCjs', async () => (await import('@/dev/testkit/mocks/radixCjs')).createRadixCjsModuleMock());
vi.mock('@/utils/web/reactDomCjs', () => ({ requireReactDOM: () => ({ createPortal: (children: React.ReactNode) => children }) }));
vi.mock('expo-router', async () => (await import('@/dev/testkit/mocks/router')).createExpoRouterMock({
    pathname: '/session/words', segments: ['(app)', 'session', '[id]'], params: { id: 'words' },
}).module);
// Substitute Expo's recorder SDK; microphone permission, audio-mode leases,
// artifact cleanup, capture admission and field delivery run through their owners.
vi.mock('expo-audio', () => {
    class AudioRecorderWeb {
        uri: string | null = null;
        async prepareToRecordAsync() {}
        pause() {}
        record() { recording.starts += 1; }
        async stop() { recording.stops += 1; this.uri = 'blob:dictation-action'; }
    }
    return { AudioModule: { AudioRecorderWeb, setAudioModeAsync: async () => {} },
        RecordingPresets: { HIGH_QUALITY: { web: { mimeType: 'audio/webm' } } } };
});

const home = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(home);
installSessionActionRpcBoundary(request => machineRpc({
    method: request.method.slice(request.method.indexOf(':') + 1), payload: request.params,
}));
const recordingModule = await loadVitestModuleForNodeRequire(
    new URL('../runtime/mic/NativeMicSession.ts', import.meta.url),
    () => import('@/voice/runtime/mic/NativeMicSession'),
);
afterAll(() => recordingModule.dispose());
const { storage } = await import('@/sync/domains/state/storage');
const { voiceSettingsParse } = await import('@/sync/domains/settings/voiceSettings');
const { normalizeVoiceSettingsLocalDelta } = await import('@/sync/domains/settings/voiceSettingsPersistence');
const { setRuntimeFetch, resetRuntimeFetch } = await import('@/utils/system/runtimeFetch');
const { primeServerFeaturesSnapshot, resetServerFeaturesClientForTests } = await import('@/sync/api/capabilities/serverFeaturesClient');
const { publishAppliedActiveServerSnapshot } = await import('@/sync/runtime/orchestration/appliedActiveServerRuntime');
const { resolveServerProfileScopeIdForIdentifier } = await import('@/sync/domains/server/serverProfiles');
const { resolveRuntimeFeatureDecision } = await import('@/sync/domains/features/featureDecisionInputs');
const { MainAppTabStateProvider } = await import('@/components/navigation/mobile/chrome/MainAppTabStateProvider');
const { AppPaneProvider } = await import('@/components/appShell/panes/AppPaneProvider');
const { CurrentUiContextProvider, useOptionalCurrentUiContextReader } = await import('@/components/appShell/currentUiContext/CurrentUiContextProvider');
const { createCurrentUiContextVoiceToolPort } = await import('@/components/appShell/currentUiContext/currentUiContextVoiceToolPort');
const { registerCurrentUiContextActionPort } = await import('@/components/appShell/currentUiContext/currentUiContextActionRuntime');
const { InjectedAuthProvider } = await import('@/auth/context/AuthContext');
const { ModalProvider } = await import('@/modal');
const { TokenStorage } = await import('@/auth/storage/tokenStorage');
const { createDefaultActionExecutor } = await import('@/sync/ops/actions/defaultActionExecutor');
const { useTextInputDictation } = await import('./useTextInputDictation');
const { voiceDictationController } = await import('./useVoiceDictation');
const { retireActiveServerAccountScopeLifetime } = await import('@/sync/domains/scope/activeServerAccountScope');
let unregister: (() => void) | undefined;
let restoredConnection: Awaited<ReturnType<typeof restoreServerAccountForTest>> | undefined;
let restorePopoverGlobals: (() => void) | undefined;

function ActionPort() {
    const reader = useOptionalCurrentUiContextReader();
    React.useEffect(() => {
        if (!reader) return;
        unregister = registerCurrentUiContextActionPort((surface, hostAction) => createCurrentUiContextVoiceToolPort({
            reader, invocationSurface: surface, hostAction, readProjection: () => null, readNavigationBinding: () => null,
        }));
        return unregister;
    }, [reader]);
    return null;
}

afterEach(async () => {
    await voiceDictationController.cancel();
    await restoredConnection?.dispose(); restoredConnection = undefined;
    unregister?.(); unregister = undefined;
    await standardCleanup(); resetRuntimeFetch(); resetServerFeaturesClientForTests(); vi.unstubAllGlobals();
    restorePopoverGlobals?.(); restorePopoverGlobals = undefined;
    machineRpc.mockReset(); recording.starts = 0; recording.stops = 0;
});

describe('mounted field Dictation Actions', () => {
    it('captures only after approval, retries the same recording into editable text without Send, and refuses an unmounted field', async () => {
        const dictatedWords = `editable words ${'😀'.repeat(8_001)}`;
        restorePopoverGlobals = withPopoverWebGlobals();
        await home.reset();
        const serverUrl = 'https://dictation-action.test';
        const serverId = await home.addHome({ name: 'Dictation Home', serverUrl, serverIdentityId: 'dictation-home', accountId: 'alice', currentAccount: true });
        const scope = { serverId: resolveServerProfileScopeIdForIdentifier(serverId), accountId: 'alice' };
        publishAppliedActiveServerSnapshot({ serverId, serverUrl, generation: 0 });
        const features = createRootLayoutFeaturesResponse({ capabilities: { serverIdentity: { serverIdentityId: 'dictation-home' } }, features: {
            voice: { enabled: true, happierVoice: { enabled: false } },
            machines: { enabled: true, liveStream: { ...createRootLayoutFeaturesResponse().features.machines.liveStream, enabled: true, serverRouted: { enabled: true } } },
        } });
        // Synthetic Home deployment input, rather than a reconstructed client policy.
        features.capabilities.machines.liveStream.serverRouted = { disabledReason: null,
            caps: MachineLiveStreamRelayCapsV1Schema.parse({ maxBitrateBps: 64000, maxFramesPerSecond: 50,
                maxFrameBytes: 16000, maxDurationMs: 60000, maxTotalBytes: 1000000,
                maxConcurrentStreamsPerAccount: 2, maxConcurrentStreamsPerSocket: 1, maxConcurrentStreamsPerMachine: 1 }) };
        primeServerFeaturesSnapshot({ serverId, snapshot: { status: 'ready', features } });
        home.answer(serverId, '/v1/features', { body: features });
        home.answer(serverId, '/v1/features/authenticated', { body: features });
        home.answer(serverId, '/v1/account/encryption/currentness', { body: createPlainAccountEncryptionCurrentnessFixture() });
        home.answer(serverId, '/v1/kv/bulk', { body: { values: [] } });
        restoredConnection = await restoreServerAccountForTest({ serverUrl, accountId: 'alice',
            credentials: (await TokenStorage.getCredentialsForServerUrl(serverUrl))!,
            request: (url, init) => home.request(url, init) });
        await home.selectHomes([serverId]);
        storage.setState({ settingsScope: scope, profileScope: scope });
        storage.getState().applySettingsForScope(scope, { ...storage.getState().settings, experiments: true,
            featureToggles: { ...storage.getState().settings.featureToggles, voice: true, 'voice.agent': true,
                'execution.runs': true, 'voice.daemonInference': true },
            ...normalizeVoiceSettingsLocalDelta({ voice: voiceSettingsParse({ providerId: 'off', executionMachine: { mode: 'fixed', machineId: 'speech-machine' },
                dictation: { sttBinding: 'explicit', stt: { provider: 'local_neural', localNeural: { execution: 'daemon' } } } }) }, storage.getState().settings),
        }, 1);
        // Account refreshes must serve the same configured STT as the mounted field.
        home.answer(serverId, '/v2/account/settings', { body: {
            content: { t: 'plain', v: storage.getState().settings }, version: 1,
        } });
        const speechMachine = createMachineFixture({ id: 'speech-machine', storageMode: 'plain', active: true, activeAt: Date.now() });
        const speechMachineRow = createPlainMachineRowFixture({ id: speechMachine.id, accountId: 'alice' });
        storage.setState({ machines: { [speechMachine.id]: speechMachine },
            machineListByServerId: { [serverId]: [speechMachine] } });
        home.answer(serverId, '/v1/machines', { body: [speechMachineRow] });
        home.answer(serverId, `/v1/machines/${speechMachine.id}`, { body: { machine: speechMachineRow } });
        home.answer(serverId, `/v1/machines/${speechMachine.id}/access`, { body: {
            machineId: speechMachine.id, custodian: speechMachineRow.access!.custodian, access: speechMachineRow.access,
            canManage: true, grants: [], ownDirectGrant: false, ownAccessSources: [],
        } });
        expect(storage.getState().settingsScope).toEqual(scope);
        expect(storage.getState().settings.featureToggles.voice).toBe(true);
        expect(await resolveRuntimeFeatureDecision({ featureId: 'voice.daemonInference' })).toMatchObject({ state: 'enabled' });
        const blob = new Blob(['spoken-words'], { type: 'audio/webm' });
        setRuntimeFetch(async (url, init) => String(url) === 'blob:dictation-action'
            ? new Response(blob) : home.request(url, init));
        let permission: 'prompt' | 'granted' = 'prompt';
        vi.stubGlobal('navigator', { permissions: { query: async () => ({ state: permission }) },
            mediaDevices: { getUserMedia: async () => ({ getTracks: () => [{ stop() {} }] }) } });
        const recipient = createTransferRecipientKeyPair();
        let transcriptionFails = true;
        machineRpc.mockImplementation(async ({ method }: { method: string }) => {
            if (method.endsWith('upload.init')) return { success: true, uploadId: 'dictation-upload', chunkSizeBytes: 65536, recipientPublicKeyBase64: recipient.recipientPublicKeyBase64 };
            if (method.endsWith('upload.chunk') || method.endsWith('upload.abort')) return { success: true };
            if (method.endsWith('upload.finalize')) return { success: true, uploadId: 'dictation-upload', path: '/tmp/dictation.webm', sizeBytes: blob.size, sha256: 'abc' };
            if (method.endsWith('stt.transcribe')) {
                if (transcriptionFails) throw new Error('speech service unavailable');
                return { ok: true, requestId: 'dictation-request', text: dictatedWords, language: 'en', modelPackId: null };
            }
            throw new Error(`Unexpected Dictation RPC: ${method}`);
        });
        const credentials = (await TokenStorage.getCredentialsForServerUrl(serverUrl))!;
        const wrapper = ({ children }: React.PropsWithChildren) => <InjectedAuthProvider credentials={credentials}>
            <MainAppTabStateProvider><AppPaneProvider><CurrentUiContextProvider><ActionPort />{children}</CurrentUiContextProvider></AppPaneProvider></MainAppTabStateProvider>
        </InjectedAuthProvider>;
        // The AppShell modal host outlives the individual field registration.
        const modalScreen = await renderScreen(<ModalProvider>{null}</ModalProvider>);
        let words = 'draft';
        const field = await renderHook(() => useTextInputDictation({ controlId: 'mounted-field', enabled: true,
            presented: true, editable: true, transcriptionSessionId: null, onTranscription: text => {
                words = applyDictationToComposer({ input: null,
                    state: { text: words, selection: { start: words.length, end: words.length } }, text }).text;
            } }), { wrapper });
        let focused: Promise<boolean> | undefined;
        await act(async () => { focused = field.getCurrent().onFocus(); });
        expect(await focused).toBe(true);
        const executor = createDefaultActionExecutor();
        const execute = async (...args: Parameters<typeof executor.execute>) => {
            let result: Awaited<ReturnType<typeof executor.execute>> | undefined;
            await act(async () => { result = await executor.execute(...args); });
            if (!result) throw new Error('Action did not settle');
            return result;
        };
        // The person's own Dictation start is direct (no confirmation); only agent callers need approval.
        const ui = { surface: 'ui' as const, authority: 'present_user' as const, serverId, expectedAccountId: 'alice' };
        const agent = { ...ui, surface: 'agent' as const, authority: 'account_automation' as const,
            actionRequestId: 'dictation-start-request', defaultSessionMachineId: 'speech-machine' } satisfies ActionExecutorContext;
        const read = await execute('ui.current_context.read', {}, ui);
        expect(read).toMatchObject({ ok: true, result: { commands: expect.arrayContaining([expect.objectContaining({ title: expect.any(String) })]) } });
        if (!read.ok || !read.result || typeof read.result !== 'object' || !('commands' in read.result)) throw new Error('Dictation commands absent');
        const commands = read.result.commands as readonly { id: string; title: string }[];
        expect(commands).toHaveLength(5);
        const start = commands[0]!.id;
        const finish = commands[1]!.id;
        const retry = commands[4]!.id;
        const consent = await execute('ui.voice_global.dictation.start', { commandId: start }, ui);
        expect(consent, JSON.stringify(consent))
            .toMatchObject({ ok: true, result: { status: 'unavailable', code: 'dictation_consent_required' } });
        expect(recording.starts).toBe(0);
        permission = 'granted';
        const approvalWait = new AbortController();
        const requested = executor.execute('ui.current_context.command.invoke', { commandId: start }, { ...agent, signal: approvalWait.signal });
        try {
            const approval = await waitForHomeGovernance(() => {
                const row = home.artifacts(serverId).list().find(item => {
                    const body = home.artifacts(serverId).readPlainBody(item.id);
                    return body !== null && ApprovalRequestSchema.safeParse(JSON.parse(body)).success;
                });
                expect(row).toBeDefined();
                return row!;
            });
            expect(JSON.parse(home.artifacts(serverId).readPlainBody(approval.id) ?? 'null'))
                .toMatchObject({ actionId: 'ui.voice_global.dictation.start', status: 'open',
                    executionOriginV1: { machineId: 'speech-machine' } });
            expect(recording.starts).toBe(0);
            const decided = await execute('approval.request.decide', { artifactId: approval.id, decision: 'approve' }, ui);
            expect(decided, JSON.stringify(decided))
                .toMatchObject({ ok: true, result: { status: 'executed', execution: {
                    ok: true, effectAttempted: true,
                    result: { status: 'completed', dictationStatus: 'listening', inserted: false },
                } } });
            const admitted = await requested;
            expect(admitted, JSON.stringify(admitted)).toMatchObject({ ok: true, result: {
                kind: 'approval_request_created', artifactId: approval.id,
                actionId: 'ui.voice_global.dictation.start',
            } });
        } finally {
            approvalWait.abort();
            await requested;
        }
        expect(voiceDictationController.getSnapshot()).toMatchObject({ sessionId: 'mounted-field', status: 'listening' });
        expect(recording.starts).toBe(1);
        const enabledActions = storage.getState().settings.actionsSettingsV1;
        await act(async () => { storage.getState().applySettingsLocal({ actionsSettingsV1: ActionsSettingsV1Schema.parse({ v: 1,
            actions: { 'ui.voice_global.dictation.finish': { disabledSurfaces: ['ui'] } } }) }); });
        expect(await execute('ui.voice_global.dictation.finish', { commandId: finish }, ui)).toMatchObject({ ok: false });
        await act(async () => { await field.getCurrent().onPress(); });
        expect(voiceDictationController.getSnapshot().status).toBe('listening');
        await modalScreen.pressByTestIdAsync('web-modal-button-0');
        await act(async () => { storage.getState().applySettingsLocal({ actionsSettingsV1: enabledActions }); });
        expect(await execute('ui.voice_global.dictation.retry', { commandId: retry }, agent))
            .toMatchObject({ ok: true, result: { status: 'unavailable', code: 'dictation_cancelled' } });
        expect(voiceDictationController.getSnapshot().status).toBe('listening');
        expect(recording.stops).toBe(0);
        expect(await execute('ui.current_context.command.invoke', { commandId: finish }, agent))
            .toMatchObject({ ok: true, result: { status: 'unavailable', code: 'dictation_cancelled' } });
        expect(words).toBe('draft');
        expect(voiceDictationController.getSnapshot()).toMatchObject({ failure: { canRetry: true } });
        expect(await execute('ui.voice_global.dictation.retry', { commandId: retry }, agent))
            .toMatchObject({ ok: true, result: { status: 'unavailable', code: 'dictation_cancelled' } });
        expect(voiceDictationController.getSnapshot()).toMatchObject({ failure: { canRetry: true } });
        transcriptionFails = false;
        const observations: unknown[] = [];
        const unsubscribe = voiceDictationController.subscribe(() => observations.push(voiceDictationController.getSnapshot()));
        let finished: Awaited<ReturnType<typeof execute>> | undefined;
        await act(async () => { finished = await field.getCurrent().onRetry(); });
        unsubscribe();
        expect(finished, JSON.stringify({ finished, snapshot: voiceDictationController.getSnapshot(),
            recording, observations,
            methods: machineRpc.mock.calls.map(([request]) => request.method) }))
            .toMatchObject({ ok: true, result: { status: 'completed', dictationStatus: 'idle', inserted: true } });
        expect(words === `draft ${dictatedWords}`).toBe(true);
        expect(recording.starts).toBe(1);
        expect(home.requests.some(request => request.path.includes('/pending') || request.path.includes('/messages'))).toBe(false);
        await act(async () => { await field.getCurrent().onPress(); });
        expect(voiceDictationController.getSnapshot().status).toBe('listening');
        transcriptionFails = true;
        await execute('ui.current_context.command.invoke', { commandId: finish }, agent);
        expect(voiceDictationController.getSnapshot()).toMatchObject({ failure: { canRetry: true } });
        let discarded: Awaited<ReturnType<typeof execute>> | undefined;
        await act(async () => { discarded = await field.getCurrent().onDiscard(); });
        expect(discarded)
            .toMatchObject({ ok: true, result: { status: 'completed', dictationStatus: 'idle', inserted: false } });
        expect(voiceDictationController.getSnapshot()).toEqual({ sessionId: null, status: 'idle' });
        expect(words === `draft ${dictatedWords}`).toBe(true);
        // Removing the production AppShell registration must disconnect the
        // Action even while the same focused field/controller are still mounted.
        unregister?.(); unregister = undefined;
        const startsBeforeUnregister = recording.starts;
        expect(await execute('ui.voice_global.dictation.start', { commandId: start }, ui))
            .toMatchObject({ ok: true, result: { status: 'unavailable', code: 'dictation_field_unmounted' } });
        expect(recording.starts).toBe(startsBeforeUnregister);
        expect(voiceDictationController.getSnapshot().status).toBe('idle');
        await field.unmount();
        expect(await execute('ui.voice_global.dictation.start', { commandId: start }, ui))
            .toMatchObject({ ok: true, result: { status: 'unavailable', code: 'dictation_field_unmounted' } });
        expect(home.requests.some(request => request.path.includes('/pending') || request.path.includes('/messages'))).toBe(false);
        // The same incumbent retirement signal used by Account reset must
        // dispose a failed recording even while its field stays mounted.
        const accountField = await renderHook(() => useTextInputDictation({ controlId: 'account-retirement-field', enabled: true,
            presented: true, editable: true, transcriptionSessionId: null, onTranscription: text => { words += ` ${text}`; } }), { wrapper });
        // Activation settles at the mounted React commit, as for the first field above.
        let accountFocused: Promise<boolean> | undefined;
        await act(async () => { accountFocused = accountField.getCurrent().onFocus(); });
        expect(await accountFocused).toBe(true);
        await act(async () => {
            await accountField.getCurrent().onPress();
        });
        expect(voiceDictationController.getSnapshot()).toMatchObject({ status: 'listening' });
        await act(async () => { await accountField.getCurrent().onPress(); });
        expect(voiceDictationController.getSnapshot()).toMatchObject({ failure: { sessionId: 'account-retirement-field', canRetry: true } });
        const revoke = vi.spyOn(URL, 'revokeObjectURL');
        try {
            await act(async () => { retireActiveServerAccountScopeLifetime(); });
            await waitForHomeGovernance(() => { expect(revoke).toHaveBeenCalledWith('blob:dictation-action'); });
            expect(voiceDictationController.getSnapshot()).toEqual({ sessionId: null, status: 'idle' });
            expect(words === `draft ${dictatedWords}`).toBe(true);
        } finally {
            revoke.mockRestore();
            await accountField.unmount();
        }
    });
});
