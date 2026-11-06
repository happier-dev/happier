import * as React from 'react';
import { act, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import 'fake-indexeddb/auto';
import { listModelPackCatalogEntries } from '@happier-dev/protocol/voice/modelPacks/catalog';
import {
    DaemonVoiceInferenceModelStatusSchema, DaemonVoiceInferenceModelsListResponseSchema,
    DaemonVoiceInferenceModelsStatusResponseSchema, DaemonVoiceInferenceModelsInstallResponseSchema,
    DaemonVoiceInferenceModelsRemoveResponseSchema, DaemonVoiceInferenceModelsInstallRequestSchema,
    DaemonVoiceInferenceModelLicenseAcceptResponseSchema,
    DaemonVoiceInferenceModelLicenseAcceptRequestSchema, type DaemonVoiceInferenceModelStatus,
} from '@happier-dev/protocol/daemon/voiceInference';
import { createDeferred, flushHookEffects, renderScreen, waitForTestEvent } from '@/dev/testkit';
import { createProviderSettingsAccountHarness } from '@/dev/testkit/harness/providerSettingsHarness';
import { installSessionActionRpcBoundary } from '@/dev/testkit/harness/sessionActionRpcBoundary';
import { answerVoiceModelCatalogRpcRequest } from '@/dev/testkit/harness/voiceModelCatalogRpcBoundary';
import { createMachineFixture, createPlainMachineRowFixture } from '@/dev/testkit/fixtures/machineFixtures';
import { createRootLayoutFeaturesResponse } from '@/dev/testkit/fixtures/featureFixtures';
import { CurrentUiContextSnapshotV1Schema } from '@happier-dev/protocol/plugins/ui';

vi.mock('socket.io-client', async (importOriginal) => (
    await import('@/dev/testkit/harness/serverAccountConnectionHarness')
).createSocketIoClientBoundary(importOriginal));
const nativeAlert = vi.hoisted(() => vi.fn<(typeof import('react-native'))['Alert']['alert']>());
vi.mock('react-native', async () => (await import('@/dev/testkit/mocks/reactNative')).createReactNativeNativeMock(
    { platformOS: 'ios' }, { Alert: { alert: nativeAlert } },
));
const account = createProviderSettingsAccountHarness();
let respond: Parameters<typeof installSessionActionRpcBoundary>[0];
const observedSignals: AbortSignal[] = [];
const requests = installSessionActionRpcBoundary((request, context) => {
    if (request.method.endsWith('.install')) observedSignals.push(context.signal);
    return respond(request, context);
});
const { useDaemonVoiceModelCatalogState } = await import('./useDaemonVoiceModelCatalogState');
const { useVoiceSettingsReadinessInputs } = await import('../../useVoiceSettingsReadinessInputs');
const { buildModelCatalogRows } = await import('./buildModelCatalogRows');
const { storage } = await import('@/sync/domains/state/storage');
const { settingsParse } = await import('@/sync/domains/settings/settings');
const { normalizeVoiceSettingsLocalDelta } = await import('@/sync/domains/settings/voiceSettingsPersistence');
const { captureActiveServerAccountScopeLifetime, retireActiveServerAccountScopeLifetime } = await import('@/sync/domains/scope/activeServerAccountScope');
const { publishMachineContributionRegistryProjectionInvalidation } = await import('@/sync/ops/machineContributionRegistryProjectionRevision');
const { renderMountedCurrentUiContext } = await import('@/dev/testkit/harness/mountedCurrentUiContext');
const { createDefaultActionExecutor } = await import('@/sync/ops/actions/defaultActionExecutor');
const { AuthProvider } = await import('@/auth/context/AuthContext');
// Load the declaration's operation leaf before the timed confirmation flow.
await import('../../voiceSettingsOperationInvoker');
const STT_PACK = listModelPackCatalogEntries('stt_sherpa')[0]!.packId;
const EXTERNAL_PACK = 'acme.speech/english-small';

function chooseNativeConfirmation(accepted: boolean) {
    const buttons = nativeAlert.mock.calls.at(-1)?.[2];
    const button = buttons?.find(candidate => accepted ? candidate.style !== 'cancel' : candidate.style === 'cancel');
    if (!button?.onPress) throw new Error('Expected an actual native confirmation button');
    button.onPress();
}

function status(packId = STT_PACK, overrides: Partial<DaemonVoiceInferenceModelStatus> = {}) {
    const entry = listModelPackCatalogEntries().find(candidate => candidate.packId === packId);
    return DaemonVoiceInferenceModelStatusSchema.parse({
        packId, pluginIdentity: null, kind: entry?.kind ?? 'stt_sherpa', model: entry?.model ?? packId,
        version: null, executionSupport: ['daemon'], runtimeFamily: entry?.runtimeFamily ?? null,
        runtimeSupported: true, installState: 'not_installed', progress: null, lastError: null, updatedAtMs: 0, ...overrides,
    });
}
const modelList = (models: readonly DaemonVoiceInferenceModelStatus[]) => DaemonVoiceInferenceModelsListResponseSchema.parse({ ok: true, models });
const modelStatus = (models: readonly DaemonVoiceInferenceModelStatus[]) => DaemonVoiceInferenceModelsStatusResponseSchema.parse({ ok: true, models });
const installed = () => DaemonVoiceInferenceModelsInstallResponseSchema.parse({ ok: true, model: status(STT_PACK, { installState: 'installed' }) });
const listingRequests = () => requests.filter(request => request.method.endsWith('.list'));
const mutations = () => requests.filter(request => /\.(install|remove|license\.accept)$/.test(request.method));
const settle = () => flushHookEffects({ cycles: 20, turns: 5 });

function catalogReply(models: readonly DaemonVoiceInferenceModelStatus[] = [status()]) {
    respond = request => {
        const catalog = answerVoiceModelCatalogRpcRequest(request, models);
        if (catalog) return catalog;
        if (request.method.endsWith('.install')) {
            const { packId } = DaemonVoiceInferenceModelsInstallRequestSchema.parse(request.params);
            return DaemonVoiceInferenceModelsInstallResponseSchema.parse({ ok: true, model: status(packId, { installState: 'installed' }) });
        }
        if (request.method.endsWith('.remove')) return DaemonVoiceInferenceModelsRemoveResponseSchema.parse({ ok: true });
        if (request.method.endsWith('.license.accept')) return DaemonVoiceInferenceModelLicenseAcceptResponseSchema.parse({ ok: true, model: status(EXTERNAL_PACK) });
        throw new Error(`Unexpected model RPC: ${request.method}`);
    };
}
function setMachine(machineId: string) {
    const current = storage.getState().settings;
    storage.setState({ settings: settingsParse({ ...current,
        ...normalizeVoiceSettingsLocalDelta({ voice: { ...current.voice,
            executionMachine: { mode: 'fixed', machineId } } }, current) }) });
}
function externalStatus(materialization = false) {
    return status(EXTERNAL_PACK, { pluginIdentity: { pluginId: 'acme.speech', packId: 'english-small' },
        runtimeFamily: 'sherpa_zipformer_streaming', licenseReview: {
            pluginId: 'acme.speech', packId: 'english-small', pluginVersion: '1.2.3', packVersion: '2026.7.0',
            licenseId: 'acme-model-license-v1', licenseTitle: 'Acme model license', licenseText: 'Review these exact model terms.',
            licenseSourceUrl: 'https://example.test/licenses/acme-v1', licenseTextDigest: `sha256:${'a'.repeat(64)}`,
            artifactBinding: materialization
                ? { kind: 'materialization', sourceCustody: { kind: 'development', registeredRootId: 'voice-model-test-root' } }
                : { kind: 'sourceIntegrity', integrity: `sha256:${'b'.repeat(64)}` },
            accepted: false,
        } });
}
function TestHarness(props: Readonly<{ enabled?: boolean; refreshKey?: string; suspendAfterHook?: Promise<never> }>) {
    const owner = useDaemonVoiceModelCatalogState({ enabled: props.enabled, refreshKey: props.refreshKey, pollIntervalMs: 100 });
    if (props.suspendAfterHook) throw props.suspendAfterHook;
    const rows = buildModelCatalogRows({ statuses: owner.state.statuses, selectedSttPackId: null, selectedTtsPackId: null });
    const current = owner.state.statuses.find(candidate => candidate.packId === STT_PACK);
    return React.createElement('State', {
        ...owner.state, catalogState: owner.state, installState: current?.installState ?? null, count: owner.state.statuses.length,
        canonicalCanInstall: rows.stt.find(row => row.packId === STT_PACK)?.canInstall ?? false,
        externalVisible: rows.stt.some(row => row.packId === EXTERNAL_PACK),
        install: owner.install, remove: owner.remove, refresh: owner.refresh, cancel: owner.cancel,
    });
}
function ReadinessHarness(props: Readonly<{ purpose: 'conversation' | 'dictation'; probeMachine: boolean }>) {
    const voice = storage(state => state.settings.voice);
    const inputs = useVoiceSettingsReadinessInputs(voice, props);
    return React.createElement('Readiness', {
        purpose: props.purpose, ...inputs.localAvailability.daemon,
        catalogState: inputs.daemonModelCatalog.state,
    });
}
const state = (tree: ReactTestRenderer) => tree.root.findByType('State').props;
async function mount(props: React.ComponentProps<typeof TestHarness> = {}) {
    const { tree } = await renderScreen(<TestHarness {...props} />);
    await settle();
    return tree;
}
async function start(tree: ReactTestRenderer, operation: 'install' | 'remove' = 'install', packId = STT_PACK) {
    let action!: Promise<void>;
    await act(async () => { action = state(tree)[operation](packId); });
    await settle();
    return { action };
}

describe('useDaemonVoiceModelCatalogState', () => {
    beforeEach(async () => {
        nativeAlert.mockReset();
        vi.useRealTimers();
        requests.length = 0;
        observedSignals.length = 0;
        catalogReply();
        const scope = await account.restore({
            settings: { experiments: true, featureToggles: { 'voice.agent': true, 'execution.runs': true, 'voice.daemonInference': true },
                actionsSettingsV1: { v: 1, approvalWaivedSurfaces: { 'settings.invoke': ['ui'] } },
                voice: { executionMachine: { mode: 'fixed', machineId: 'machine-a' } } },
            machines: ['machine-a', 'machine-b'].map(id => createMachineFixture({ id, activeAt: Date.now() })),
            features: createRootLayoutFeaturesResponse({ features: {
                voice: { enabled: true },
                machines: { enabled: true, liveStream: { ...createRootLayoutFeaturesResponse().features.machines.liveStream, enabled: true, serverRouted: { enabled: true } } },
            }, capabilities: { machines: { ...createRootLayoutFeaturesResponse().capabilities.machines, liveStream: { serverRouted: { disabledReason: null, caps: {
                maxBitrateBps: 64_000, maxFramesPerSecond: 50, maxFrameBytes: 16_000, maxDurationMs: 60_000,
                maxTotalBytes: 1_000_000, maxConcurrentStreamsPerAccount: 2, maxConcurrentStreamsPerSocket: 1,
                maxConcurrentStreamsPerMachine: 1,
            } } } } } }),
        });
        for (const machineId of ['machine-a', 'machine-b']) {
            const machine = createPlainMachineRowFixture({ id: machineId, accountId: scope.accountId });
            account.home.answer(scope.serverId, `/v1/machines/${machineId}`, { body: { machine } });
            account.home.answer(scope.serverId, `/v1/machines/${machineId}/access`, { body: { machineId,
                custodian: machine.access!.custodian, access: machine.access, canManage: true,
                grants: [], ownDirectGrant: false, ownAccessSources: [] } });
        }
    });
    afterEach(async () => { vi.useRealTimers(); await account.reset(); vi.restoreAllMocks(); });

    it.each(['local_direct', 'local_conversation'])(
        'keeps Conversations, Dictation and Advanced on the same model-status input through %s failure and recovery', async (providerId) => {
        const ttsPack = listModelPackCatalogEntries('tts_sherpa')[0]!.packId;
        const selectedPacks = [STT_PACK, ttsPack];
        const voice = settingsParse({ voice: { providerId,
            executionMachine: { mode: 'fixed', machineId: 'machine-a' },
            dictation: { sttBinding: 'same_as_local' },
            providers: { [providerId]: { schemaVersion: 1, config: {
                stt: { provider: 'local_neural', localNeural: { execution: 'daemon', assetId: STT_PACK } },
                tts: { provider: 'local_neural', localNeural: { execution: 'daemon', assetId: ttsPack } },
            } } },
        } }).voice;
        storage.setState({ settings: { ...storage.getState().settings, voice } });
        catalogReply(selectedPacks.map(packId => status(packId, { installState: 'installed', runtimeState: 'cold' })));
        const screen = await renderScreen(<AuthProvider initialCredentials={{ token: 'token-1', secret: 'secret-1' }}>
            <ReadinessHarness purpose="conversation" probeMachine />
            <ReadinessHarness purpose="dictation" probeMachine />
            <TestHarness />
        </AuthProvider>);
        await settle();
        const catalogs = () => [
            ...screen.tree.root.findAllByType('Readiness').map(node => node.props.catalogState),
            state(screen.tree),
        ];
        const expectSharedStatus = (errorCode: string | null, runtimeState: string) => {
            const inputs = catalogs();
            for (const input of inputs) {
                expect(input.errorCode).toBe(errorCode);
                expect(input.statuses).toBe(inputs[0].statuses);
                for (const packId of selectedPacks) {
                    expect(input.statuses.find((model: DaemonVoiceInferenceModelStatus) => model.packId === packId))
                        .toMatchObject({ installState: 'installed', runtimeState });
                }
            }
        };
        expectSharedStatus(null, 'cold');
        expect(listingRequests()).toHaveLength(1);

        respond = request => request.method.endsWith('.list')
            ? DaemonVoiceInferenceModelsListResponseSchema.parse({
                ok: false, error: 'Computer unavailable', errorCode: 'machine_unreachable',
            })
            : modelStatus([]);
        await act(async () => { await state(screen.tree).refresh(); });
        await settle();
        expectSharedStatus('machine_unreachable', 'cold');

        catalogReply(selectedPacks.map(packId => status(packId, { installState: 'installed', runtimeState: 'ready' })));
        await act(async () => { await state(screen.tree).refresh(); });
        await settle();
        expectSharedStatus(null, 'ready');
        expect(listingRequests()).toHaveLength(3);
        await screen.unmount();
    });

    it('keeps an explicit successful install when an unrelated Voice preference changes', async () => {
        const pending = createDeferred<ReturnType<typeof installed>>();
        const started = createDeferred<void>();
        const reply = respond;
        respond = (request, context) => {
            if (request.method.endsWith('.install')) { started.resolve(); return pending.promise; }
            return reply(request, context);
        };
        const action = createDefaultActionExecutor().execute('settings.invoke', {
            anchor: 'voiceAdvanced.installSpeechModel', input: { kind: 'model_pack', packId: STT_PACK, machineId: 'machine-a' },
        }, { surface: 'ui', authority: 'present_user', serverId: storage.getState().settingsScope!.serverId,
            presentUserConfirmation: { actionId: 'settings.invoke' } });
        await started.promise;
        const current = storage.getState().settings;
        storage.getState().applySettingsLocal(normalizeVoiceSettingsLocalDelta({ voice: {
            ...current.voice, audibleWaitingCue: !current.voice.audibleWaitingCue,
        } }, current));
        expect(storage.getState().settings.voice.audibleWaitingCue).toBe(!current.voice.audibleWaitingCue);
        pending.resolve(installed());
        expect(await action).toMatchObject({ ok: true, result: { status: 'completed', value: { packId: STT_PACK } } });
    });

    it('refuses an installed batch-only pack as the streaming conversation default through the existing Action', async () => {
        const packId = 'sherpa-onnx-nemo-parakeet-tdt-0.6b-v3-int8';
        catalogReply([status(packId, { installState: 'installed' })]);
        const result = await createDefaultActionExecutor().execute('settings.invoke', {
            anchor: 'voiceAdvanced.defaultSpeechModel', input: { kind: 'model_pack', packId, machineId: 'machine-a' },
        }, { surface: 'ui' });
        expect(result).toMatchObject({ ok: true, result: { status: 'unavailable', reason: 'model_pack_unavailable' } });
        expect(mutations()).toHaveLength(0);
    });

    it('shares selected-role model facts between passive hubs and pages without probing from the hub', async () => {
        const voice = settingsParse({ voice: { providerId: 'local_conversation',
            executionMachine: { mode: 'fixed', machineId: 'machine-a' },
            dictation: { sttBinding: 'same_as_local' },
            providers: { local_conversation: { schemaVersion: 1, config: {
                stt: { provider: 'local_neural', localNeural: { execution: 'daemon', assetId: STT_PACK } },
                tts: { provider: 'local_neural', localNeural: { execution: 'daemon' } },
            } } },
        } }).voice;
        storage.setState({ settings: { ...storage.getState().settings, voice } });
        const screen = await renderScreen(<AuthProvider initialCredentials={{ token: 'token-1', secret: 'secret-1' }}>
            <ReadinessHarness purpose="conversation" probeMachine={false} />
            <ReadinessHarness purpose="dictation" probeMachine={false} />
        </AuthProvider>);
        await settle();
        expect(screen.tree.root.findAllByType('Readiness').map(node => node.props.modelState)).toEqual(['unknown', 'unknown']);
        expect(listingRequests()).toHaveLength(0);
        catalogReply([status(STT_PACK, { installState: 'installed' })]);
        const page = await renderScreen(<AuthProvider initialCredentials={{ token: 'token-1', secret: 'secret-1' }}>
            <ReadinessHarness purpose="dictation" probeMachine />
        </AuthProvider>);
        await settle();
        expect(page.tree.root.findByType('Readiness').props.modelState).toBe('ready');
        expect(screen.tree.root.findAllByType('Readiness').map(node => node.props.modelState)).toEqual(['unknown', 'ready']);
        expect(listingRequests()).toHaveLength(1);
        await page.unmount();
        await settle();
        expect(screen.tree.root.findAllByType('Readiness').map(node => node.props.modelState)).toEqual(['unknown', 'ready']);
        expect(listingRequests()).toHaveLength(1);
        await screen.unmount();
    });

    it('shows the same settled daemon Dictation readiness on the actual hub and page for web', async () => {
        const { Platform } = await import('react-native');
        const nativePlatform = { ...Platform };
        const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
        Object.assign(Platform, (await createReactNativeWebMock()).Platform);
        try {
            const { VoiceSettingsIntentIndexScreen } = await import('../../VoiceSettingsIntentIndexScreen');
            const { VoiceDictationSettingsScreen } = await import('../../screens/VoiceDictationSettingsScreen');
            const current = storage.getState().settings;
            const voice = settingsParse({ voice: { providerId: 'local_conversation',
                executionMachine: { mode: 'fixed', machineId: 'machine-a' },
                dictation: { sttBinding: 'same_as_local' },
                providers: { local_conversation: { schemaVersion: 1, config: {
                    stt: { provider: 'local_neural', localNeural: { execution: 'daemon', assetId: STT_PACK } },
                    tts: { provider: 'device' },
                } } },
            } }).voice;
            storage.setState({ settings: settingsParse({ ...current,
                featureToggles: { ...current.featureToggles, voice: true },
                ...normalizeVoiceSettingsLocalDelta({ voice }, current) }) });
            const hub = await renderScreen(<AuthProvider initialCredentials={{ token: 'token-1', secret: 'secret-1' }}>
                <VoiceSettingsIntentIndexScreen />
            </AuthProvider>);
            const readiness = (tree: ReactTestRenderer, testID: string) => tree.root.findAll(node =>
                node.props.testID === testID && node.props.pipeline)[0]?.props.pipeline.readiness;
            await settle();
            expect(readiness(hub.tree, 'settings.voice.intent.dictation'))
                .toMatchObject({ status: 'unavailable', code: 'runtime_unknown' });
            expect(listingRequests()).toHaveLength(0);
            catalogReply([status(STT_PACK, { installState: 'installed' })]);
            const page = await renderScreen(<AuthProvider initialCredentials={{ token: 'token-1', secret: 'secret-1' }}>
                <VoiceDictationSettingsScreen />
            </AuthProvider>);
            await settle();
            expect(readiness(page.tree, 'settings.voice.dictation.pipeline')?.status).toBe('ready');
            expect(readiness(hub.tree, 'settings.voice.intent.dictation')).toEqual(readiness(page.tree, 'settings.voice.dictation.pipeline'));
            expect(listingRequests()).toHaveLength(1);
            await page.unmount();
            await settle();
            expect(readiness(hub.tree, 'settings.voice.intent.dictation')?.status).toBe('ready');
            expect(listingRequests()).toHaveLength(1);
            await hub.unmount();
        } finally {
            Object.assign(Platform, nativePlatform);
        }
    });

    it('exposes the same sourced model facts through the existing model inspection Action without per-row reads', async () => {
        catalogReply([status(STT_PACK, { installState: 'installed', runtimeState: 'ready', inUse: true })]);
        const result = await createDefaultActionExecutor().execute('settings.invoke', {
            anchor: 'voiceAdvanced.speechModels',
        }, { surface: 'ui' });
        expect(result).toMatchObject({ ok: true, result: { status: 'completed', value: {
            machineId: 'machine-a', catalog: { stt: expect.arrayContaining([
                expect.objectContaining({ packId: STT_PACK, languages: ['en'], archiveBytes: null, inUse: true }),
            ]) },
        } } });
        expect(listingRequests()).toHaveLength(1);
        expect(requests.filter(request => request.method.endsWith('.status'))).toHaveLength(1);
        expect(mutations()).toHaveLength(0);
    });

    it('refuses manual model mutations when settings.invoke is disabled while settings.set remains admitted', async () => {
        const scope = storage.getState().settingsScope!;
        const settings = settingsParse({ ...storage.getState().settings, actionsSettingsV1: { v: 1,
            actions: { 'settings.invoke': { disabledSurfaces: ['ui'] } },
            approvalWaivedSurfaces: { 'settings.set': ['ui'] } } });
        storage.setState({ settings });
        account.home.answer(scope.serverId, 'GET /v2/account/settings', { body: { version: 1, content: { t: 'plain', v: settings } } });
        const tree = await mount({ refreshKey: 'machine-a' });
        await act(async () => { await state(tree).install(STT_PACK); });
        expect(mutations()).toHaveLength(0);
        expect(nativeAlert).not.toHaveBeenCalled();
        const adjacent = await createDefaultActionExecutor().execute('settings.set', {
            anchor: 'voicePrivacy.recentMessagesCount', value: 7,
        }, { surface: 'ui', authority: 'present_user', serverId: scope.serverId, expectedAccountId: scope.accountId });
        expect(adjacent, JSON.stringify(adjacent)).toMatchObject({ ok: true });
        expect(storage.getState().settings.voice.privacy.recentMessagesCount).toBe(7);
        await act(async () => { tree.unmount(); });
    });

    it('retires unanswered catalog reads on unmount and can load the same Machine again', async () => {
        const signals: AbortSignal[] = [];
        const requested = createDeferred<void>();
        respond = (_request, context) => {
            signals.push(context.signal);
            requested.resolve();
            return new Promise(() => {});
        };
        const first = await mount({ refreshKey: 'machine-a' });
        expect(state(first).loading).toBe(true);
        await requested.promise;
        expect(signals.length).toBeGreaterThan(0);
        await act(async () => { first.unmount(); });
        await Promise.all(signals.map(signal => waitForTestEvent(notify => {
            signal.addEventListener('abort', notify);
            return () => signal.removeEventListener('abort', notify);
        }, () => signal.aborted, aborted => aborted)));
        expect(signals.every(signal => signal.aborted)).toBe(true);
        catalogReply();
        const retry = await mount({ refreshKey: 'machine-a' });
        expect(state(retry)).toMatchObject({ loading: false, errorCode: null, count: 1 });
        await act(async () => { retry.unmount(); });
    });

    it('does not let another saved Home cancel the active Account model operation', async () => {
        const pending = createDeferred<unknown>();
        const defaultReply = respond;
        respond = (request, context) => request.method.endsWith('.install') ? pending.promise : defaultReply(request, context);
        const screen = await renderMountedCurrentUiContext(<TestHarness refreshKey="machine-a" />);
        await settle();
        const { action } = await start(screen.tree);
        try {
            const otherServerId = await account.addHome({ name: 'Other Voice Account',
                serverUrl: 'https://other-voice-account.test', serverIdentityId: 'other-voice-home',
                accountId: 'account-b', active: false,
                features: createRootLayoutFeaturesResponse({ features: { voice: { enabled: true } } }) });
            account.home.answer(otherServerId, '/v2/account/settings', { body: {
                version: 1, content: { t: 'plain', v: storage.getState().settings },
            } });
            const result = await createDefaultActionExecutor().execute('settings.invoke', {
                anchor: 'voiceAdvanced.cancelSpeechModel',
                input: { kind: 'model_pack', packId: STT_PACK, machineId: 'machine-a' },
            }, { surface: 'ui', authority: 'present_user', serverId: otherServerId, expectedAccountId: 'account-b',
                presentUserConfirmation: { actionId: 'settings.invoke' } });
            expect(result, JSON.stringify(result)).toMatchObject({ ok: true, result: {
                status: 'unavailable', reason: 'model_operation_changed',
            } });
            expect(observedSignals[0].aborted).toBe(false);
        } finally {
            pending.resolve(installed());
            await action;
            screen.unmount();
        }
    });

    it('cancels a UI-started install through the declared settings Action and refuses the retired command', async () => {
        const pending = createDeferred<unknown>();
        const defaultReply = respond;
        respond = (request, context) => request.method.endsWith('.install') ? pending.promise : defaultReply(request, context);
        const screen = await renderMountedCurrentUiContext(<TestHarness refreshKey="machine-a" />);
        await settle();
        const { action } = await start(screen.tree);
        const executor = createDefaultActionExecutor();
        const context = { surface: 'agent' as const, serverId: storage.getState().settingsScope!.serverId };
        try {
            const read = await executor.execute('ui.current_context.read', {}, context);
            expect(read).toMatchObject({ ok: true });
            if (!read.ok) throw new Error(read.errorCode);
            const snapshot = CurrentUiContextSnapshotV1Schema.parse(read.result);
            expect(snapshot.commands).toHaveLength(1);
            expect(await executor.execute('settings.invoke', { anchor: 'voiceAdvanced.cancelSpeechModel',
                input: { kind: 'model_pack', packId: 'other-model', machineId: 'machine-a' } }, context))
                .toMatchObject({ ok: true, result: { status: 'unavailable' } });
            expect(await executor.execute('settings.invoke', { anchor: 'voiceAdvanced.cancelSpeechModel',
                input: { kind: 'model_pack', packId: STT_PACK, machineId: 'machine-b' } }, context))
                .toMatchObject({ ok: true, result: { status: 'unavailable', reason: 'execution_machine_changed' } });
            expect(observedSignals[0].aborted).toBe(false);
            const result = await executor.execute('settings.invoke', { anchor: 'voiceAdvanced.cancelSpeechModel',
                input: { kind: 'model_pack', packId: STT_PACK, machineId: 'machine-a' } }, context);
            expect(result).toMatchObject({ ok: true, result: { status: 'completed' } });
            await act(async () => { await action; });
            await settle();
            expect(observedSignals[0].aborted).toBe(true);
            expect(state(screen.tree)).toMatchObject({ actionPackId: null, actionError: null });
            expect(await executor.execute('settings.invoke', { anchor: 'voiceAdvanced.cancelSpeechModel',
                input: { kind: 'model_pack', packId: STT_PACK, machineId: 'machine-a' } }, context))
                .toMatchObject({ ok: true, result: { status: 'unavailable' } });
            const replacement = createDeferred<unknown>();
            respond = (request, rpcContext) => request.method.endsWith('.install') ? replacement.promise : defaultReply(request, rpcContext);
            const next = await start(screen.tree);
            try {
                expect(await executor.execute('ui.current_context.command.invoke', { commandId: snapshot.commands[0]!.id }, context))
                    .toMatchObject({ ok: false });
                expect(observedSignals[1].aborted).toBe(false);
                expect(await executor.execute('settings.invoke', { anchor: 'voiceAdvanced.cancelSpeechModel',
                    input: { kind: 'model_pack', packId: STT_PACK, machineId: 'machine-a' } }, context))
                    .toMatchObject({ ok: true, result: { status: 'completed' } });
                await act(async () => { await next.action; });
                expect(observedSignals[1].aborted).toBe(true);
            } finally { replacement.resolve(installed()); await next.action; }
        } finally {
            pending.resolve(installed());
            await action;
            await screen.unmount();
        }
    });

    it('refuses an ambiguous Cancel when two mounted controllers own the same pack', async () => {
        const pending = createDeferred<unknown>();
        const defaultReply = respond;
        respond = (request, context) => request.method.endsWith('.install') ? pending.promise : defaultReply(request, context);
        const screen = await renderMountedCurrentUiContext(<><TestHarness refreshKey="machine-a" /><TestHarness refreshKey="machine-a" /></>);
        await settle();
        const owners = () => screen.tree.root.findAllByType('State').map(node => node.props);
        const actions: Promise<void>[] = [];
        for (const [index, owner] of owners().entries()) {
            const entered = createDeferred<void>();
            respond = (request, context) => {
                if (request.method.endsWith('.install')) { entered.resolve(); return pending.promise; }
                return defaultReply(request, context);
            };
            await act(async () => { actions.push(owner.install(STT_PACK)); });
            await entered.promise;
            expect(observedSignals).toHaveLength(index + 1);
        }
        await settle();
        const executor = createDefaultActionExecutor();
        const context = { surface: 'agent' as const, serverId: storage.getState().settingsScope!.serverId };
        try {
            const read = await executor.execute('ui.current_context.read', {}, context);
            if (!read.ok) throw new Error(read.errorCode);
            expect(CurrentUiContextSnapshotV1Schema.parse(read.result).commands).toHaveLength(2);
            expect(await executor.execute('settings.invoke', { anchor: 'voiceAdvanced.cancelSpeechModel',
                input: { kind: 'model_pack', packId: STT_PACK, machineId: 'machine-a' } }, context))
                .toMatchObject({ ok: true, result: { status: 'unavailable', reason: 'model_operation_changed' } });
            expect(observedSignals).toHaveLength(2);
            expect(observedSignals.every(signal => !signal.aborted)).toBe(true);
        } finally {
            await act(async () => { for (const owner of owners()) owner.cancel(); await Promise.all(actions); });
            pending.resolve(installed());
            await screen.unmount();
        }
    });

    it('cancels pending removal consent after Account retirement with the same execution machine', async () => {
        catalogReply([status(STT_PACK, { installState: 'installed' })]);
        const lifetime = captureActiveServerAccountScopeLifetime();
        expect(lifetime?.isCurrent()).toBe(true);
        const tree = await mount({ refreshKey: 'machine-a' });
        const { action } = await start(tree, 'remove');
        expect(nativeAlert).toHaveBeenCalledOnce();
        expect(state(tree).actionPackId).toBe(STT_PACK);
        await act(async () => retireActiveServerAccountScopeLifetime());
        expect(lifetime?.isCurrent()).toBe(false);
        await act(async () => { chooseNativeConfirmation(true); await action; });
        expect(mutations()).toHaveLength(0);
        expect(state(tree).actionPackId).toBeNull();
    });

    it('retains removal custody while consent is pending and cancels after machine replacement', async () => {
        catalogReply([status(STT_PACK, { installState: 'installed' })]);
        const tree = await mount({ refreshKey: 'machine-a' });
        const { action } = await start(tree, 'remove');
        expect(state(tree).actionPackId).toBe(STT_PACK);
        expect(nativeAlert).toHaveBeenCalledOnce();
        setMachine('machine-b');
        await act(async () => tree.update(<TestHarness refreshKey="machine-b" />));
        await settle();
        await act(async () => { chooseNativeConfirmation(true); await action; });
        expect(mutations()).toHaveLength(0);
        expect(state(tree).actionPackId).toBeNull();
    });

    it('keeps discovered external packs while making an uninstalled canonical pack actionable', async () => {
        respond = request => request.method.endsWith('.list')
            ? modelList([externalStatus()]) : modelStatus([status()]);
        const tree = await mount();
        expect(state(tree)).toMatchObject({ installState: 'not_installed', canonicalCanInstall: true, externalVisible: true });
        expect(requests.find(request => request.method.endsWith('.status'))?.params).toEqual({
            packIds: listModelPackCatalogEntries().map(entry => entry.packId),
        });
    });

    it('echoes the exact tagged artifact binding from a license review to the daemon', async () => {
        const model = externalStatus(true);
        catalogReply([model]);
        const tree = await mount();
        const { action } = await start(tree, 'install', EXTERNAL_PACK);
        expect(nativeAlert).toHaveBeenCalledWith(model.licenseReview!.licenseTitle, model.licenseReview!.licenseText,
            expect.arrayContaining([expect.objectContaining({ style: 'cancel' }), expect.objectContaining({ style: 'default' })]),
            { cancelable: false });
        await act(async () => { chooseNativeConfirmation(true); await action; });
        const acceptance = requests.find(request => request.method.endsWith('.license.accept'))!;
        const { licenseTitle: _title, licenseText: _text, accepted: _accepted, ...binding } = model.licenseReview!;
        expect(DaemonVoiceInferenceModelLicenseAcceptRequestSchema.parse(acceptance.params)).toEqual({ qualifiedPackId: EXTERNAL_PACK, ...binding });
        expect(requests.find(request => request.method.endsWith('.install'))?.params).toEqual({ packId: EXTERNAL_PACK });
        expect(requests.indexOf(acceptance)).toBeLessThan(requests.findIndex(request => request.method.endsWith('.install')));
    });

    it('does not open a daemon model status request while disabled', async () => {
        const tree = await mount({ enabled: false });
        expect(requests).toHaveLength(0);
        expect(state(tree)).toMatchObject({ count: 0, loading: false });
    });

    it('shares actual catalog observations with passive readers without asking the machine again', async () => {
        catalogReply([status(STT_PACK, { installState: 'installed' })]);
        const active = await renderScreen(<TestHarness refreshKey="machine-a" />);
        await settle();
        const reads = listingRequests().length;
        const passive = await mount({ enabled: false, refreshKey: 'machine-a' });
        expect(state(passive)).toMatchObject({ installState: 'installed', loading: false });
        await active.unmount();
        const remounted = await mount({ enabled: false, refreshKey: 'machine-a' });
        expect(state(remounted)).toMatchObject({ installState: 'installed', loading: false });
        const otherMachine = await mount({ enabled: false, refreshKey: 'machine-b' });
        expect(state(otherMachine)).toMatchObject({ count: 0, loading: false });
        expect(listingRequests()).toHaveLength(reads);

        await act(async () => publishMachineContributionRegistryProjectionInvalidation({
            machineId: 'machine-a', serverId: storage.getState().settingsScope!.serverId,
        }));
        await settle();
        expect(state(passive)).toMatchObject({ count: 0, loading: false });
        expect(state(remounted)).toMatchObject({ count: 0, loading: false });
        expect(listingRequests()).toHaveLength(reads);
    });

    it.each(['refresh', 'warm'] as const)('publishes no equal %s observations and retains unaffected rows on change', async (operation) => {
        const models = [status(STT_PACK, { installState: 'installed' }), externalStatus()];
        catalogReply(models);
        const tree = await mount({ refreshKey: 'machine-a' });
        const { captureDaemonVoiceModelCatalogObservation } = await import('./daemonVoiceModelCatalogObservation');
        const observation = captureDaemonVoiceModelCatalogObservation('machine-a');
        const initial = observation.getSnapshot();
        const initialState = state(tree).catalogState;
        const listener = vi.fn();
        const unsubscribe = observation.subscribe(listener);
        try {
            for (let refresh = 0; refresh < 5; refresh += 1) {
                await act(async () => {
                    if (operation === 'refresh') await state(tree).refresh();
                    else observation.observeModels(models.map(model => ({ ...model })));
                });
            }
            expect(listener).toHaveBeenCalledTimes(0);
            expect(observation.getSnapshot()).toBe(initial);
            expect(state(tree).catalogState).toBe(initialState);
            const settledReads = requests.length;
            vi.useFakeTimers();
            await act(async () => { await vi.advanceTimersByTimeAsync(60_000); });
            expect(requests).toHaveLength(settledReads);
            expect(mutations()).toHaveLength(0);
            vi.useRealTimers();
            const changed = status(STT_PACK, { installState: 'installed', runtimeState: 'ready' });
            await act(async () => {
                if (operation === 'refresh') {
                    catalogReply([changed, externalStatus()]);
                    await state(tree).refresh();
                } else observation.observeModels([changed]);
            });
            expect(listener).toHaveBeenCalledTimes(1);
            expect(state(tree).statuses.find((model: DaemonVoiceInferenceModelStatus) => model.packId === STT_PACK))
                .toMatchObject({ runtimeState: 'ready' });
            expect(observation.getSnapshot().statuses.find(model => model.packId === EXTERNAL_PACK))
                .toBe(initial.statuses.find(model => model.packId === EXTERNAL_PACK));
        } finally { unsubscribe(); }
    });

    it('shares an in-flight catalog refresh across active readers of the same machine', async () => {
        const pending = createDeferred<unknown>();
        respond = request => request.method.endsWith('.status') ? modelStatus([]) : pending.promise;
        const screen = await renderScreen(<><TestHarness refreshKey="machine-a" /><TestHarness refreshKey="machine-a" /></>);
        await settle();
        expect(listingRequests()).toHaveLength(1);
        await act(async () => pending.resolve(modelList([status(STT_PACK, { installState: 'installed' })])));
        await settle();
        expect(screen.tree.root.findAllByType('State').map(node => node.props.installState)).toEqual(['installed', 'installed']);
    });

    it.each([false, true])('withdraws a settings Action model removal from passive observations and rechecks only active readers (%s)', async (keepActive) => {
        let isInstalled = true;
        respond = request => {
            const models = [status(STT_PACK, { installState: isInstalled ? 'installed' : 'not_installed' })];
            if (request.method.endsWith('.list')) return modelList(models);
            if (request.method.endsWith('.status')) return modelStatus(models);
            if (request.method.endsWith('.remove')) {
                isInstalled = false;
                return DaemonVoiceInferenceModelsRemoveResponseSchema.parse({ ok: true });
            }
            throw new Error(`Unexpected model RPC: ${request.method}`);
        };
        const active = await renderScreen(<TestHarness refreshKey="machine-a" />);
        await settle();
        const passive = await mount({ enabled: false, refreshKey: 'machine-a' });
        expect(state(passive).installState).toBe('installed');
        if (!keepActive) await active.unmount();
        const reads = listingRequests().length;
        let removal!: ReturnType<ReturnType<typeof createDefaultActionExecutor>['execute']>;
        let removalResult: unknown;
        await act(async () => {
            removal = createDefaultActionExecutor().execute('settings.invoke', {
                anchor: 'voiceAdvanced.removeSpeechModel', input: { kind: 'model_pack', packId: STT_PACK, machineId: 'machine-a' },
            }, { surface: 'ui', authority: 'present_user', serverId: storage.getState().settingsScope!.serverId,
                presentUserConfirmation: { actionId: 'settings.invoke' } });
            void removal.then(result => { removalResult = result; });
        });
        await settle();
        expect(nativeAlert, JSON.stringify(removalResult)).toHaveBeenCalled();
        await act(async () => { chooseNativeConfirmation(true); });
        expect(await removal).toMatchObject({ ok: true, result: { status: 'completed' } });
        await settle();
        expect(state(passive).installState).toBe(keepActive ? 'not_installed' : null);
        expect(listingRequests()).toHaveLength(reads + (keepActive ? 1 : 0));
    });

    it('shares actual Action inspection and partial pack checks without certifying unqueried models', async () => {
        catalogReply([status(STT_PACK, { installState: 'installed' }), externalStatus()]);
        const passive = await mount({ enabled: false, refreshKey: 'machine-a' });
        expect(state(passive).count).toBe(0);
        const inspection = await createDefaultActionExecutor().execute('settings.invoke', {
            anchor: 'voiceAdvanced.speechModels',
        }, { surface: 'ui', authority: 'present_user', serverId: storage.getState().settingsScope!.serverId });
        expect(inspection).toMatchObject({ ok: true, result: { status: 'completed' } });
        await settle();
        expect(state(passive)).toMatchObject({ installState: 'installed', externalVisible: true });
        const { captureDaemonVoiceModelCatalogObservation } = await import('./daemonVoiceModelCatalogObservation');
        const { DaemonVoiceInferenceClient } = await import('@/voice/runtime/daemonInference/DaemonVoiceInferenceClient');
        const observation = captureDaemonVoiceModelCatalogObservation('machine-a');
        respond = () => modelStatus([status()]);
        await act(async () => { await observation.read({ client: new DaemonVoiceInferenceClient(), packIds: [STT_PACK] }); });
        expect(state(passive)).toMatchObject({ installState: 'not_installed', externalVisible: true });
        await act(async () => {
            observation.invalidate();
            await observation.read({ client: new DaemonVoiceInferenceClient(), packIds: [STT_PACK] });
        });
        expect(state(passive)).toMatchObject({ installState: 'not_installed', externalVisible: false, count: 1 });
    });

    it('withdraws the current daemon revision observation when Action removal completes after consent', async () => {
        let isInstalled = true;
        respond = request => {
            const models = [status(STT_PACK, { installState: isInstalled ? 'installed' : 'not_installed' })];
            if (request.method.endsWith('.list')) return modelList(models);
            if (request.method.endsWith('.status')) return modelStatus(models);
            if (request.method.endsWith('.remove')) {
                isInstalled = false;
                return DaemonVoiceInferenceModelsRemoveResponseSchema.parse({ ok: true });
            }
            throw new Error(`Unexpected model RPC: ${request.method}`);
        };
        const active = await renderScreen(<TestHarness refreshKey="machine-a" />);
        await settle();
        const passive = await mount({ enabled: false, refreshKey: 'machine-a' });
        let removal!: ReturnType<ReturnType<typeof createDefaultActionExecutor>['execute']>;
        await act(async () => {
            removal = createDefaultActionExecutor().execute('settings.invoke', {
                anchor: 'voiceAdvanced.removeSpeechModel', input: { kind: 'model_pack', packId: STT_PACK, machineId: 'machine-a' },
            }, { surface: 'ui', authority: 'present_user', serverId: storage.getState().settingsScope!.serverId,
                presentUserConfirmation: { actionId: 'settings.invoke' } });
        });
        await settle();
        expect(nativeAlert).toHaveBeenCalled();
        await act(async () => publishMachineContributionRegistryProjectionInvalidation({
            machineId: 'machine-a', serverId: storage.getState().settingsScope!.serverId,
        }));
        await settle();
        expect(state(passive).installState).toBe('installed');
        await active.unmount();
        const reads = listingRequests().length;
        await act(async () => { chooseNativeConfirmation(true); });
        expect(await removal).toMatchObject({ ok: true, result: { status: 'completed' } });
        await settle();
        expect(state(passive).installState).toBeNull();
        expect(listingRequests()).toHaveLength(reads);
    });

    it('refuses a retained non-React reader after the daemon projection is replaced', async () => {
        const { captureDaemonVoiceModelCatalogObservation } = await import('./daemonVoiceModelCatalogObservation');
        const { DaemonVoiceInferenceClient } = await import('@/voice/runtime/daemonInference/DaemonVoiceInferenceClient');
        const observation = captureDaemonVoiceModelCatalogObservation('machine-a');
        publishMachineContributionRegistryProjectionInvalidation({
            machineId: 'machine-a', serverId: storage.getState().settingsScope!.serverId,
        });
        const result = await observation.read({ client: new DaemonVoiceInferenceClient(), packIds: [STT_PACK] });
        expect(result).toBeNull();
        expect(requests).toHaveLength(0);
    });

    it('rechecks a demanded full catalog when a partial Action check supersedes its initial read', async () => {
        const pending = createDeferred<unknown>();
        let lists = 0;
        respond = request => request.method.endsWith('.status') ? modelStatus([status()])
            : ++lists === 1 ? pending.promise : modelList([externalStatus()]);
        const active = await renderScreen(<TestHarness refreshKey="machine-a" />);
        await settle();
        const { captureDaemonVoiceModelCatalogObservation } = await import('./daemonVoiceModelCatalogObservation');
        const { DaemonVoiceInferenceClient } = await import('@/voice/runtime/daemonInference/DaemonVoiceInferenceClient');
        try {
            await act(async () => {
                await captureDaemonVoiceModelCatalogObservation('machine-a').read({
                    client: new DaemonVoiceInferenceClient(), packIds: [STT_PACK], requireNewObservation: true,
                });
            });
            await settle();
            expect(state(active.tree).externalVisible).toBe(true);
        } finally {
            await act(async () => pending.resolve(modelList([])));
        }
    });

    it('does not reuse catalog observations from a retired Account lifetime', async () => {
        catalogReply([status(STT_PACK, { installState: 'installed' })]);
        const active = await renderScreen(<TestHarness refreshKey="machine-a" />);
        await settle();
        await active.unmount();
        await act(async () => retireActiveServerAccountScopeLifetime());
        const passive = await mount({ enabled: false, refreshKey: 'machine-a' });
        expect(state(passive)).toMatchObject({ count: 0, loading: false });
    });

    it('refreshes status when the selected execution-machine identity changes', async () => {
        respond = request => request.method.endsWith('.status') ? modelStatus([])
            : modelList(request.method.startsWith('machine-b:') ? [status(STT_PACK, { installState: 'installed' })] : []);
        const tree = await mount({ refreshKey: 'machine-a' });
        setMachine('machine-b');
        await act(async () => tree.update(<TestHarness refreshKey="machine-b" />));
        await settle();
        expect(listingRequests().map(request => request.method)).toEqual([
            'machine-a:daemon.voiceInference.models.list', 'machine-b:daemon.voiceInference.models.list',
        ]);
        expect(state(tree).installState).toBe('installed');
    });

    it('does not expose the previous machine status while the replacement machine refresh is pending', async () => {
        const pending = createDeferred<unknown>();
        respond = request => request.method.endsWith('.status') ? modelStatus([])
            : request.method.startsWith('machine-b:') ? pending.promise : modelList([status(STT_PACK, { installState: 'installed' })]);
        const tree = await mount({ refreshKey: 'machine-a' });
        expect(state(tree).installState).toBe('installed');
        setMachine('machine-b');
        await act(async () => tree.update(<TestHarness refreshKey="machine-b" />));
        await settle();
        expect(state(tree)).toMatchObject({ installState: null, loading: true });
        expect(listingRequests()).toHaveLength(2);
        await act(async () => pending.resolve(modelList([status()])));
        await settle();
        expect(state(tree).installState).toBe('not_installed');
    });

    it('polls until an installing pack reports installed', async () => {
        vi.useFakeTimers();
        let lists = 0;
        let current = status();
        respond = request => {
            if (request.method.endsWith('.list')) current = status(STT_PACK, ++lists === 1 ? {} : lists === 2
                ? { installState: 'installing', progress: { phase: 'downloading', progress: 0.5, bytesDownloaded: 50, totalBytes: 100, message: null } }
                : { installState: 'installed' });
            const catalog = answerVoiceModelCatalogRpcRequest(request, [current]);
            if (catalog) return catalog;
            if (request.method.endsWith('.install')) return DaemonVoiceInferenceModelsInstallResponseSchema.parse({ ok: true, model: status(STT_PACK, { installState: 'installing' }) });
            throw new Error(`Unexpected model RPC: ${request.method}`);
        };
        const tree = await mount();
        const { action } = await start(tree);
        await act(async () => action);
        await settle();
        expect(state(tree).installState).toBe('installing');
        expect(state(tree).statuses[0].progress.progress).toBe(0.5);
        await act(async () => { await vi.advanceTimersByTimeAsync(100); });
        await settle();
        expect(state(tree).installState).toBe('installed');
    });

    it('never overlaps catalog polls and schedules the next poll after the current one settles', async () => {
        vi.useFakeTimers();
        const pending = createDeferred<unknown>();
        let lists = 0;
        respond = request => request.method.endsWith('.status') ? modelStatus([])
            : ++lists === 2 ? pending.promise : modelList([status(STT_PACK, { installState: lists < 3 ? 'installing' : 'installed' })]);
        const tree = await mount();
        expect(state(tree).installState).toBe('installing');
        await act(async () => { await vi.advanceTimersByTimeAsync(100); });
        await settle();
        expect(listingRequests()).toHaveLength(2);
        await act(async () => { await vi.advanceTimersByTimeAsync(500); });
        await settle();
        expect(listingRequests()).toHaveLength(2);
        await act(async () => pending.resolve(modelList([status(STT_PACK, { installState: 'installing' })])));
        await settle();
        await act(async () => { await vi.advanceTimersByTimeAsync(99); });
        await settle();
        expect(listingRequests()).toHaveLength(2);
        await act(async () => { await vi.advanceTimersByTimeAsync(1); });
        await settle();
        expect(listingRequests()).toHaveLength(3);
        expect(state(tree).installState).toBe('installed');
    });

    it('surfaces the daemon error code when the status request fails', async () => {
        respond = request => request.method.endsWith('.list')
            ? DaemonVoiceInferenceModelsListResponseSchema.parse({ ok: false, error: 'daemon model request failed', errorCode: 'machine_unreachable' }) : modelStatus([]);
        const tree = await mount();
        expect(state(tree).errorCode).toBe('machine_unreachable');
    });

    it('collapses an unrecognized daemon failure code to internal_error', async () => {
        // Deliberately malformed external reply: the real client must refuse it before the hook can display ready.
        respond = request => request.method.endsWith('.list') ? { ok: false, error: 'daemon model request failed', errorCode: 'quota_exceeded' } : modelStatus([]);
        const tree = await mount();
        expect(state(tree)).toMatchObject({ errorCode: 'internal_error', loading: false });
    });

    it('does not let a stale status response overwrite a newer refresh', async () => {
        const pending = createDeferred<unknown>();
        let lists = 0;
        respond = request => request.method.endsWith('.status') ? modelStatus([])
            : ++lists === 1 ? pending.promise : modelList([status(STT_PACK, { installState: 'installed' })]);
        const tree = await mount();
        await act(async () => state(tree).refresh());
        expect(state(tree).installState).toBe('installed');
        await act(async () => pending.resolve(modelList([status()])));
        await settle();
        expect(state(tree).installState).toBe('installed');
    });

    it('keeps known catalog rows stable while a background refresh is pending', async () => {
        const pending = createDeferred<unknown>();
        let lists = 0;
        respond = request => request.method.endsWith('.status') ? modelStatus([])
            : ++lists === 1 ? modelList([status(STT_PACK, { installState: 'installed' })]) : pending.promise;
        const tree = await mount();
        const known = state(tree).statuses;
        let refresh!: Promise<void>;
        await act(async () => { refresh = state(tree).refresh(); });
        await settle();
        expect(state(tree)).toMatchObject({ installState: 'installed', loading: false });
        expect(state(tree).statuses).toBe(known);
        await act(async () => { pending.resolve(modelList([status(STT_PACK, { installState: 'installed' })])); await refresh; });
    });

    it('rejects a second model mutation while the current action is still in flight', async () => {
        const pending = createDeferred<unknown>();
        const defaultReply = respond;
        respond = (request, context) => request.method.endsWith('.install') ? pending.promise : defaultReply(request, context);
        const tree = await mount();
        const { action } = await start(tree);
        await act(async () => state(tree).install(STT_PACK));
        expect(mutations()).toHaveLength(1);
        expect(state(tree).actionPackId).toBe(STT_PACK);
        await act(async () => { pending.resolve(installed()); await action; });
    });

    it('owns the catalog mutation while an install prerequisite is being reviewed', async () => {
        catalogReply([externalStatus(), status(STT_PACK, { installState: 'installed' })]);
        const tree = await mount();
        const { action } = await start(tree, 'install', EXTERNAL_PACK);
        expect(state(tree).actionPackId).toBe(EXTERNAL_PACK);
        await act(async () => state(tree).remove(STT_PACK));
        expect(nativeAlert).toHaveBeenCalledOnce();
        expect(mutations()).toHaveLength(0);
        await act(async () => { chooseNativeConfirmation(false); await action; });
        expect(state(tree).actionPackId).toBeNull();
        expect(mutations()).toHaveLength(0);
    });

    it('does not accept or install through a stale license review after machine replacement', async () => {
        const model = externalStatus(true);
        respond = request => {
            const catalog = answerVoiceModelCatalogRpcRequest(request,
                [request.method.startsWith('machine-b:') ? { ...model, installState: 'installed' } : model]);
            if (catalog) return catalog;
            throw new Error(`Unexpected model RPC: ${request.method}`);
        };
        const tree = await mount({ refreshKey: 'machine-a' });
        const { action } = await start(tree, 'install', EXTERNAL_PACK);
        expect(nativeAlert).toHaveBeenCalledOnce();
        setMachine('machine-b');
        await act(async () => tree.update(<TestHarness refreshKey="machine-b" />));
        await settle();
        expect(state(tree).statuses.find((row: DaemonVoiceInferenceModelStatus) => row.packId === EXTERNAL_PACK).installState).toBe('installed');
        await act(async () => { chooseNativeConfirmation(true); await action; });
        expect(mutations()).toHaveLength(0);
        expect(state(tree).statuses.find((row: DaemonVoiceInferenceModelStatus) => row.packId === EXTERNAL_PACK).installState).toBe('installed');
    });

    it('settles a completed mutation without waiting for a slow status refresh', async () => {
        const pending = createDeferred<unknown>();
        let lists = 0;
        let mutationFailed = false;
        respond = request => {
            if (request.method.endsWith('.status')) return mutationFailed
                ? pending.promise.then(value => DaemonVoiceInferenceModelsStatusResponseSchema.parse(value)) : modelStatus([status()]);
            if (request.method.endsWith('.install')) {
                mutationFailed = true;
                return DaemonVoiceInferenceModelsInstallResponseSchema.parse({ ok: false, error: 'daemon model request failed', errorCode: 'internal_error' });
            }
            return ++lists === 1 ? modelList([status()]) : pending.promise;
        };
        const tree = await mount();
        const { action } = await start(tree);
        let settled = false;
        void action.then(() => { settled = true; });
        await settle();
        expect(settled).toBe(true);
        expect(state(tree)).toMatchObject({ actionPackId: null, actionError: { packId: STT_PACK, operation: 'install', errorCode: 'internal_error' } });
        expect(listingRequests()).toHaveLength(2);
        await act(async () => pending.resolve(modelList([status()])));
        await settle();
        expect(state(tree).actionError.packId).toBe(STT_PACK);
    });

    it('cancels the exact active install through its caller signal without retaining an action error', async () => {
        const pending = createDeferred<unknown>();
        const defaultReply = respond;
        respond = (request, context) => request.method.endsWith('.install') ? pending.promise : defaultReply(request, context);
        const tree = await mount();
        const { action } = await start(tree);
        expect(observedSignals).toHaveLength(1);
        await act(async () => { state(tree).cancel(); await action; });
        expect(observedSignals[0].aborted).toBe(true);
        expect(state(tree)).toMatchObject({ actionPackId: null, actionError: null });
        pending.resolve(installed());
    });

    it('clears a retained install failure when authoritative status later reports installed', async () => {
        const pending = createDeferred<unknown>();
        let lists = 0;
        let mutationFailed = false;
        respond = request => {
            if (request.method.endsWith('.status')) return mutationFailed
                ? pending.promise.then(value => DaemonVoiceInferenceModelsStatusResponseSchema.parse(value)) : modelStatus([status()]);
            if (request.method.endsWith('.install')) {
                mutationFailed = true;
                return DaemonVoiceInferenceModelsInstallResponseSchema.parse({ ok: false, error: 'daemon model request failed', errorCode: 'request_timeout' });
            }
            return ++lists === 1 ? modelList([status()]) : pending.promise;
        };
        const tree = await mount();
        const { action } = await start(tree);
        await act(async () => action);
        expect(state(tree).actionError.packId).toBe(STT_PACK);
        await act(async () => pending.resolve(modelList([status(STT_PACK, { installState: 'installed' })])));
        await settle();
        expect(state(tree).actionError).toBeNull();
    });

    it('ignores a late mutation result from a previously selected execution machine', async () => {
        const pending = createDeferred<unknown>();
        const defaultReply = respond;
        respond = (request, context) => request.method.endsWith('.install') ? pending.promise : defaultReply(request, context);
        const tree = await mount({ refreshKey: 'machine-a' });
        const { action } = await start(tree);
        expect(state(tree).actionPackId).toBe(STT_PACK);
        setMachine('machine-b');
        await act(async () => tree.update(<TestHarness refreshKey="machine-b" />));
        await settle();
        expect(state(tree).actionPackId).toBeNull();
        expect(observedSignals[0].aborted).toBe(true);
        await act(async () => { pending.resolve(DaemonVoiceInferenceModelsInstallResponseSchema.parse({ ok: false, error: 'daemon model request failed', errorCode: 'internal_error' })); await action; });
        expect(state(tree).actionError).toBeNull();
        expect(listingRequests()).toHaveLength(2);
    });

    it('does not refresh daemon status after an in-flight action is disabled', async () => {
        const pending = createDeferred<unknown>();
        const defaultReply = respond;
        respond = (request, context) => request.method.endsWith('.install') ? pending.promise : defaultReply(request, context);
        const tree = await mount({ enabled: true });
        const { action } = await start(tree);
        await act(async () => tree.update(<TestHarness enabled={false} />));
        await act(async () => { pending.resolve(installed()); await action; });
        expect(listingRequests()).toHaveLength(1);
        expect(state(tree).actionPackId).toBeNull();
    });

    it('does not refresh daemon status after an in-flight action owner unmounts', async () => {
        const pending = createDeferred<unknown>();
        const defaultReply = respond;
        respond = (request, context) => request.method.endsWith('.install') ? pending.promise : defaultReply(request, context);
        const tree = await mount();
        const { action } = await start(tree);
        await act(async () => tree.unmount());
        await act(async () => { pending.resolve(installed()); await action; });
        expect(listingRequests()).toHaveLength(1);
        expect(observedSignals[0].aborted).toBe(true);
    });

    it('does not invalidate a committed action from a suspended replacement render that never commits', async () => {
        vi.useFakeTimers();
        const pending = createDeferred<unknown>();
        const defaultReply = respond;
        respond = (request, context) => request.method.endsWith('.install') ? pending.promise : defaultReply(request, context);
        const neverCommits = createDeferred<never>();
        const screen = await renderScreen(<React.Suspense fallback={React.createElement('Fallback')}><TestHarness refreshKey="machine-a" /></React.Suspense>);
        const { tree } = screen;
        await settle();
        const { action } = await start(tree);
        let replacement!: Promise<void>;
        React.startTransition(() => { replacement = screen.update(<React.Suspense fallback={React.createElement('Fallback')}>
            <TestHarness refreshKey="machine-b" suspendAfterHook={neverCommits.promise} />
        </React.Suspense>); });
        await replacement;
        expect(tree.root.findAllByType('Fallback')).toHaveLength(0);
        expect(observedSignals[0].aborted).toBe(false);
        await act(async () => { pending.resolve(installed()); await action; });
        await settle();
        expect(listingRequests()).toHaveLength(2);
        expect(listingRequests().every(request => request.method.startsWith('machine-a:'))).toBe(true);
    });

    it('does not disable a committed action from a suspended disabled render that never commits', async () => {
        vi.useFakeTimers();
        const pending = createDeferred<unknown>();
        const defaultReply = respond;
        respond = (request, context) => request.method.endsWith('.install') ? pending.promise : defaultReply(request, context);
        const neverCommits = createDeferred<never>();
        const screen = await renderScreen(<React.Suspense fallback={React.createElement('Fallback')}><TestHarness refreshKey="machine-a" enabled /></React.Suspense>);
        const { tree } = screen;
        await settle();
        const { action } = await start(tree);
        let replacement!: Promise<void>;
        React.startTransition(() => { replacement = screen.update(<React.Suspense fallback={React.createElement('Fallback')}>
            <TestHarness refreshKey="machine-a" enabled={false} suspendAfterHook={neverCommits.promise} />
        </React.Suspense>); });
        await replacement;
        expect(tree.root.findAllByType('Fallback')).toHaveLength(0);
        expect(observedSignals[0].aborted).toBe(false);
        await act(async () => { pending.resolve(installed()); await action; });
        await settle();
        expect(listingRequests()).toHaveLength(2);
    });
});
