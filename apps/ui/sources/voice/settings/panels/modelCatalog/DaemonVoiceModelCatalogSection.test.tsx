import * as React from 'react';
import { act, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import 'fake-indexeddb/auto';
import { getDefaultModelPackId, listModelPackCatalogEntries } from '@happier-dev/protocol/voice/modelPacks/catalog';
import { createRpcCallError, RPC_ERROR_CODES } from '@happier-dev/protocol/rpcErrors';
import {
    DaemonVoiceInferenceModelStatusSchema, DaemonVoiceInferenceModelsListResponseSchema,
    DaemonVoiceInferenceModelsStatusResponseSchema, DaemonVoiceInferenceModelsInstallResponseSchema,
    DaemonVoiceInferenceModelsRemoveResponseSchema, DaemonVoiceInferenceModelLicenseAcceptResponseSchema,
    DaemonVoiceInferenceModelLicenseAcceptRequestSchema, type DaemonVoiceInferenceModelStatus,
} from '@happier-dev/protocol/daemon/voiceInference';
import { pressTestInstanceAsync, renderScreen, createDeferred, waitForTestEvent } from '@/dev/testkit';
import { createProviderSettingsAccountHarness } from '@/dev/testkit/harness/providerSettingsHarness';
import { installSessionActionRpcBoundary } from '@/dev/testkit/harness/sessionActionRpcBoundary';
import { answerVoiceModelCatalogRpcRequest } from '@/dev/testkit/harness/voiceModelCatalogRpcBoundary';
import { createMachineFixture, createPlainMachineRowFixture } from '@/dev/testkit/fixtures/machineFixtures';
import { createRootLayoutFeaturesResponse } from '@/dev/testkit/fixtures/featureFixtures';
import { createAccountSettingsHttpBoundary } from '@/dev/testkit/harness/actionHomesHttpHarness';
import { AccountSettingsV2UpdateRequestSchema } from '@happier-dev/protocol/account/settings/accountSettingsApiV2';

vi.mock('socket.io-client', async (importOriginal) => (
    await import('@/dev/testkit/harness/serverAccountConnectionHarness')
).createSocketIoClientBoundary(importOriginal));
const nativeAlert = vi.hoisted(() => vi.fn<(typeof import('react-native'))['Alert']['alert']>());
vi.mock('react-native', async () => (await import('@/dev/testkit/mocks/reactNative')).createReactNativeNativeMock(
    { platformOS: 'ios' }, { Alert: { alert: nativeAlert } },
));
const account = createProviderSettingsAccountHarness();
let respond: Parameters<typeof installSessionActionRpcBoundary>[0];
const requests = installSessionActionRpcBoundary((request, context) => respond(request, context));
const { DaemonVoiceModelCatalogSection } = await import('./DaemonVoiceModelCatalogSection');
const { useDaemonVoiceModelCatalogState } = await import('./useDaemonVoiceModelCatalogState');
const { VoiceSpeechModelsSection } = await import('../VoiceSpeechModelsSection');
const { storage } = await import('@/sync/domains/state/storage');
const { settingsParse } = await import('@/sync/domains/settings/settings');
const { readLocalConversationVoiceSettings, writeLocalConversationVoiceSettings } = await import('@/sync/domains/settings/voiceSettings');
const { parseLocalVoiceSttSettings } = await import('@/voice/local/localVoiceSettings');
const { normalizeVoiceSettingsLocalDelta } = await import('@/sync/domains/settings/voiceSettingsPersistence');
const { useApplyVoiceSettingsEdit } = await import('@/sync/store/settingsWriters');
const { createDefaultActionExecutor } = await import('@/sync/ops/actions/defaultActionExecutor');
const MACHINE = 'catalog-section-machine';

function chooseNativeConfirmation(accepted: boolean) {
    const buttons = nativeAlert.mock.calls.at(-1)?.[2];
    const button = buttons?.find(candidate => accepted ? candidate.style !== 'cancel' : candidate.style === 'cancel');
    if (!button?.onPress) throw new Error('Expected an actual native confirmation button');
    button.onPress();
}

function status(packId: string, overrides: Partial<DaemonVoiceInferenceModelStatus> = {}) {
    const entry = listModelPackCatalogEntries().find(candidate => candidate.packId === packId);
    return DaemonVoiceInferenceModelStatusSchema.parse({
        packId, pluginIdentity: null, kind: entry?.kind ?? 'stt_sherpa', model: entry?.model ?? packId,
        version: null, executionSupport: ['daemon'], runtimeFamily: entry?.runtimeFamily ?? null,
        runtimeSupported: true, installState: 'installed', progress: null, lastError: null,
        updatedAtMs: 0, runtimeState: 'cold', ...overrides,
    });
}

function catalogReply(models: readonly DaemonVoiceInferenceModelStatus[]) {
    respond = request => {
        const catalog = answerVoiceModelCatalogRpcRequest(request, models);
        if (catalog) return catalog;
        if (request.method.endsWith(':daemon.voiceInference.models.remove')) return DaemonVoiceInferenceModelsRemoveResponseSchema.parse({ ok: true });
        throw new Error(`Unexpected model RPC: ${request.method}`);
    };
}

function renderSection(props: Partial<React.ComponentProps<typeof DaemonVoiceModelCatalogSection>> = {}) {
    return renderScreen(<DaemonVoiceModelCatalogSection selectedSttPackId={null} selectedTtsPackId={null}
        onSelectDefault={() => undefined} {...props} />).then(result => result.tree);
}

function modelRows(tree: ReactTestRenderer) {
    return tree.root.findAll(node => typeof node.props.testID === 'string'
        && node.props.testID.startsWith('voice-model-row-') && typeof node.type !== 'string');
}

describe('DaemonVoiceModelCatalogSection', () => {
    beforeEach(async () => {
        nativeAlert.mockReset();
        requests.length = 0;
        catalogReply([]);
        const scope = await account.restore({
            settings: { experiments: true, featureToggles: { 'voice.agent': true, 'execution.runs': true, 'voice.daemonInference': true },
                actionsSettingsV1: { v: 1, approvalWaivedSurfaces: { 'settings.invoke': ['ui'] } },
                voice: { executionMachine: { mode: 'fixed', machineId: MACHINE } } },
            machines: [createMachineFixture({ id: MACHINE, activeAt: Date.now() })],
            features: createRootLayoutFeaturesResponse({ features: {
                voice: { enabled: true },
                machines: { enabled: true, liveStream: { ...createRootLayoutFeaturesResponse().features.machines.liveStream, enabled: true, serverRouted: { enabled: true } } },
            }, capabilities: { machines: { ...createRootLayoutFeaturesResponse().capabilities.machines, liveStream: { serverRouted: { disabledReason: null, caps: {
                maxBitrateBps: 64_000, maxFramesPerSecond: 50, maxFrameBytes: 16_000, maxDurationMs: 60_000,
                maxTotalBytes: 1_000_000, maxConcurrentStreamsPerAccount: 2, maxConcurrentStreamsPerSocket: 1,
                maxConcurrentStreamsPerMachine: 1,
            } } } } } }),
        });
        const machine = createPlainMachineRowFixture({ id: MACHINE, accountId: scope.accountId });
        account.home.answer(scope.serverId, `/v1/machines/${MACHINE}`, { body: { machine } });
        account.home.answer(scope.serverId, `/v1/machines/${MACHINE}/access`, { body: { machineId: MACHINE,
            custodian: machine.access!.custodian, access: machine.access, canManage: true,
            grants: [], ownDirectGrant: false, ownAccessSources: [] } });
    });
    afterEach(async () => { await account.reset(); vi.restoreAllMocks(); });

    it('refuses a manual default-pack choice when settings.invoke is disabled', async () => {
        const packId = listModelPackCatalogEntries('stt_sherpa')[0]!.packId;
        catalogReply([status(packId)]);
        const scope = storage.getState().settingsScope!;
        const before = storage.getState().settings;
        const local = readLocalConversationVoiceSettings(before.voice);
        const voice = writeLocalConversationVoiceSettings({ ...before.voice, providerId: 'local_conversation' }, {
            ...local, stt: { ...local.stt, provider: 'local_neural', localNeural: {
                ...parseLocalVoiceSttSettings(local.stt).localNeural, assetId: 'another-selected-pack', execution: 'daemon',
            } },
        });
        const settings = settingsParse({ ...before, ...normalizeVoiceSettingsLocalDelta({ voice }, before), actionsSettingsV1: { v: 1,
            actions: { 'settings.invoke': { disabledSurfaces: ['ui'] } },
            approvalWaivedSurfaces: { 'settings.set': ['ui'] } } });
        storage.setState({ settings });
        let persisted = settings;
        const defaultSelected = createDeferred<void>();
        const http = createAccountSettingsHttpBoundary({ serverUrl: 'https://provider-settings-account.test',
            initialAccounts: [{ accountId: scope.accountId, snapshot: { version: storage.getState().settingsVersion!,
                content: { t: 'plain', v: settings } } }] });
        account.home.answer(scope.serverId, '/v2/account/settings', { select: async (input, request) => {
            const response = http.handle(request.url, request.init);
            if (!response) throw new Error('Expected Account Settings HTTP request');
            const body = await response.json();
            if (request.init?.method === 'POST' && body.success) {
                const mutation = AccountSettingsV2UpdateRequestSchema.parse(input);
                if (!mutation.content || mutation.content.t !== 'plain') throw new Error('Expected Plain Account Settings');
                persisted = settingsParse(mutation.content.v);
                if (parseLocalVoiceSttSettings(readLocalConversationVoiceSettings(persisted.voice).stt).localNeural.assetId === packId) {
                    defaultSelected.resolve();
                }
            }
            return { status: response.status, body };
        } });
        let pendingEdit: Promise<void> | undefined;
        function MountedSection() {
            const current = React.useSyncExternalStore(storage.subscribe, () => storage.getState().settings.voice);
            const applyEdit = useApplyVoiceSettingsEdit();
            return <VoiceSpeechModelsSection voice={current} setVoice={next => { pendingEdit = applyEdit(current, next); }} />;
        }
        const screen = await renderScreen(<MountedSection />);
        await waitForTestEvent(screen.subscribe, () => modelRows(screen.tree), rows => rows.some(row => row.props.testID === `voice-model-row-${packId}`));
        expect(modelRows(screen.tree).some(row => row.props.testID === `voice-model-row-${packId}`)).toBe(true);
        expect(await createDefaultActionExecutor().execute('settings.set', { anchor: 'voicePrivacy.recentMessagesCount', value: 9 }, {
            surface: 'ui', authority: 'present_user', serverId: scope.serverId, expectedAccountId: scope.accountId,
        })).toMatchObject({ ok: true });
        expect(persisted.voice.privacy.recentMessagesCount).toBe(9);
        const beforeChoice = persisted.voice;
        const row = modelRows(screen.tree).find(row => row.props.testID === `voice-model-row-${packId}`)!;
        await act(async () => { await row.props.onPress(); await pendingEdit; });
        expect(persisted.voice).toEqual(beforeChoice);
        expect(storage.getState().settings.voice).toEqual(beforeChoice);
        expect(requests.filter(request => /\.(install|remove|license\.accept)$/.test(request.method))).toHaveLength(0);
        const allowed = settingsParse({ ...storage.getState().settings, actionsSettingsV1: { v: 1,
            approvalWaivedSurfaces: { 'settings.invoke': ['ui'] } } });
        await act(async () => { storage.setState({ settings: allowed }); });
        http.replaceAccountSettings(scope.accountId, { version: storage.getState().settingsVersion!, content: { t: 'plain', v: allowed } });
        await act(async () => { await row.props.onPress(); });
        await defaultSelected.promise;
        expect(parseLocalVoiceSttSettings(readLocalConversationVoiceSettings(persisted.voice).stt).localNeural.assetId).toBe(packId);
    });

    it('shows a loading status row before the daemon status resolves', async () => {
        const pending = createDeferred<unknown>();
        respond = request => request.method.endsWith(':daemon.voiceInference.models.list')
            ? pending.promise : DaemonVoiceInferenceModelsStatusResponseSchema.parse({ ok: true, models: [] });
        const tree = await renderSection();
        expect(tree.root.findByProps({ testID: 'voice-model-catalog-status' }).props.kind).toBe('loading');
        expect(modelRows(tree)).toHaveLength(0);
        await act(async () => pending.resolve(DaemonVoiceInferenceModelsListResponseSchema.parse({ ok: true, models: [] })));
        await waitForTestEvent(tree.subscribe, () => tree.root.findAllByProps({ testID: 'voice-model-catalog-status' }), rows => rows.length === 0);
        expect(tree.root.findAllByProps({ testID: 'voice-model-catalog-status' })).toHaveLength(0);
    });

    it('leaves loading and renders unavailable when the selected daemon does not serve speech RPCs', async () => {
        respond = () => { throw createRpcCallError({ error: 'RPC method not available', errorCode: RPC_ERROR_CODES.METHOD_NOT_AVAILABLE }); };
        const tree = await renderSection();
        await waitForTestEvent(tree.subscribe, () => tree.root.findAllByProps({ testID: 'voice-model-catalog-status' })[0]?.props.kind, kind => kind === 'error');
        expect(tree.root.findByProps({ testID: 'voice-model-catalog-status' }).props.kind).toBe('error');
        expect(modelRows(tree)).toHaveLength(0);

        catalogReply([]);
        // Reopening after an owner-managed daemon reload uses the normal status path.
        const recovered = await renderSection();
        await waitForTestEvent(recovered.subscribe, () => recovered.root.findAllByProps({ testID: 'voice-model-catalog-status' }), rows => rows.length === 0);
        expect(recovered.root.findAllByProps({ testID: 'voice-model-catalog-status' })).toHaveLength(0);
        expect(modelRows(recovered).length).toBeGreaterThan(0);
    });

    it.each([
        ['machine_unreachable', 'Can’t reach your Voice machine right now.', true],
        ['feature_disabled', 'Speech models are turned off on this server.', false],
        ['runtime_unavailable', 'Speech models couldn’t be loaded.', true],
        ['request_timeout', 'Your Voice machine didn’t answer in time.', true],
        ['internal_error', 'Speech models couldn’t be loaded.', true],
    ] as const)('says once why the catalog is unavailable (%s) instead of an unknown state on every model', async (code, message, retryable) => {
        if (code === 'feature_disabled') {
            await account.publishFeatures(account.serverId, createRootLayoutFeaturesResponse({ features: { voice: { enabled: false } } }));
        } else {
            respond = request => request.method.endsWith(':daemon.voiceInference.models.list')
                ? DaemonVoiceInferenceModelsListResponseSchema.parse({ ok: false, error: 'daemon model request failed', errorCode: code })
                : DaemonVoiceInferenceModelsStatusResponseSchema.parse({ ok: true, models: [] });
        }
        const tree = await renderSection();
        await waitForTestEvent(tree.subscribe, () => tree.root.findAllByProps({ testID: 'voice-model-catalog-status' })[0]?.props.kind, kind => kind !== undefined && kind !== 'loading');
        expect(tree.root.findByProps({ testID: 'voice-model-catalog-status' }).props.kind).not.toBe('loading');
        const line = tree.root.findByProps({ testID: 'voice-model-catalog-status' });
        expect(line.props.title).toBe(message);
        if (code !== 'feature_disabled') expect(line.props.detail).toBe('daemon model request failed');
        expect(modelRows(tree)).toHaveLength(0);
        expect(requests.some(request => request.method.endsWith('.install'))).toBe(false);
        if (!retryable) { expect(line.props.action).toBeUndefined(); return; }
        const before = requests.filter(request => request.method.endsWith('.list')).length;
        const retried = createDeferred<void>();
        const previousReply = respond;
        respond = (request, context) => {
            if (request.method.endsWith('.list')) retried.resolve();
            return previousReply(request, context);
        };
        await act(async () => line.props.action.onPress());
        await retried.promise;
        expect(requests.filter(request => request.method.endsWith('.list')).length).toBeGreaterThan(before);
    });

    it('can render from an already-created catalog controller without opening a second status request', async () => {
        const packId = getDefaultModelPackId('stt_sherpa')!;
        catalogReply([status(packId, { runtimeState: 'ready' })]);
        function SharedOwner() {
            const controller = useDaemonVoiceModelCatalogState();
            return <DaemonVoiceModelCatalogSection selectedSttPackId={packId} selectedTtsPackId={null}
                onSelectDefault={() => undefined} catalogController={controller} />;
        }
        const { tree } = await renderScreen(<SharedOwner />);
        await waitForTestEvent(tree.subscribe, () => tree.root.findAllByProps({ testID: `voice-model-row-${packId}` })[0]?.props.detail, detail => detail === 'Ready');
        expect(tree.root.findByProps({ testID: `voice-model-row-${packId}` }).props.detail).toBe('Ready');
        expect(requests.filter(request => request.method.endsWith('.list'))).toHaveLength(1);
        expect(requests.filter(request => request.method.endsWith('.status'))).toHaveLength(1);
    });

    it('keeps an installed but unavailable non-default pack non-selectable and removable', async () => {
        const ttsDefault = getDefaultModelPackId('tts_sherpa')!;
        const unavailable = listModelPackCatalogEntries('tts_sherpa').find(entry => entry.packId !== ttsDefault && entry.publicationStatus === 'unavailable')!;
        catalogReply([status(ttsDefault), status(unavailable.packId)]);
        const onSelectDefault = vi.fn();
        const tree = await renderSection({ selectedTtsPackId: ttsDefault, onSelectDefault });
        await waitForTestEvent(tree.subscribe, () => tree.root.findAllByProps({ testID: `voice-model-row-${unavailable.packId}` }), rows => rows.length > 0);
        expect(tree.root.findByProps({ testID: `voice-model-row-${unavailable.packId}` })).toBeTruthy();
        const row = tree.root.findByProps({ testID: `voice-model-row-${unavailable.packId}` });
        expect(row.props.onPress ?? row.props.onClick).toBeUndefined();
        expect(onSelectDefault).not.toHaveBeenCalled();
        expect(tree.root.findByProps({ testID: `voice-model-remove-${unavailable.packId}` })).toBeTruthy();
        expect(requests.some(request => request.method.endsWith('.remove'))).toBe(false);
    });

    it('keeps a selected installed unsupported pack inert but removable for recovery', async () => {
        const entry = listModelPackCatalogEntries('stt_sherpa').find(entry => entry.runtimeFamily === 'sherpa_parakeet_offline')!;
        catalogReply([status(entry.packId, { runtimeSupported: false })]);
        const tree = await renderSection({ selectedSttPackId: entry.packId });
        await waitForTestEvent(tree.subscribe, () => tree.root.findAllByProps({ testID: `voice-model-row-${entry.packId}` }), rows => rows.length > 0);
        expect(tree.root.findByProps({ testID: `voice-model-row-${entry.packId}` })).toBeTruthy();
        expect(tree.root.findByProps({ testID: `voice-model-row-${entry.packId}` }).props.onPress).toBeUndefined();
        expect(tree.root.findByProps({ testID: `voice-model-remove-${entry.packId}` })).toBeTruthy();
    });

    it('reviews and accepts the exact external-pack license binding before installing', async () => {
        const packId = 'acme.speech/english-small';
        const review = {
            pluginId: 'acme.speech', packId: 'english-small', pluginVersion: '1.2.3', packVersion: '2026.7.0',
            licenseId: 'acme-model-license-v1', licenseTitle: 'Acme model license', licenseText: 'Review these exact model terms.',
            licenseSourceUrl: 'https://example.com/licenses/acme-v1', licenseTextDigest: `sha256:${'a'.repeat(64)}`,
            artifactBinding: { kind: 'sourceIntegrity', integrity: `sha256:${'b'.repeat(64)}` }, accepted: false,
        } as const;
        const model = status(packId, { pluginIdentity: { pluginId: review.pluginId, packId: review.packId },
            model: 'acme-english-small', version: review.packVersion, runtimeFamily: 'sherpa_zipformer_streaming',
            installState: 'not_installed', licenseReview: review });
        catalogReply([model]);
        const defaultReply = respond;
        const installRequested = createDeferred<void>();
        respond = (request, context) => {
            if (request.method.endsWith('.license.accept')) return DaemonVoiceInferenceModelLicenseAcceptResponseSchema.parse({ ok: true, model });
            if (request.method.endsWith('.install')) {
                installRequested.resolve();
                return DaemonVoiceInferenceModelsInstallResponseSchema.parse({ ok: true, model: { ...model, installState: 'installed' } });
            }
            return defaultReply(request, context);
        };
        const tree = await renderSection();
        await waitForTestEvent(tree.subscribe, () => tree.root.findAllByProps({ testID: `voice-model-row-${packId}` })[0]?.props.onPress, onPress => typeof onPress === 'function');
        expect(tree.root.findByProps({ testID: `voice-model-row-${packId}` }).props.onPress).toBeTypeOf('function');
        const confirmationOpened = createDeferred<void>();
        nativeAlert.mockImplementationOnce(() => confirmationOpened.resolve());
        await pressTestInstanceAsync(tree.root.findByProps({ testID: `voice-model-row-${packId}` }));
        await confirmationOpened.promise;
        expect(nativeAlert).toHaveBeenCalledOnce();
        expect(nativeAlert).toHaveBeenCalledWith(review.licenseTitle, review.licenseText,
            expect.arrayContaining([expect.objectContaining({ style: 'cancel' }), expect.objectContaining({ style: 'default', text: expect.any(String) })]),
            { cancelable: false });
        await act(async () => chooseNativeConfirmation(true));
        await installRequested.promise;
        expect(requests.some(request => request.method.endsWith('.install'))).toBe(true);
        const accepted = requests.find(request => request.method.endsWith('.license.accept'))!;
        expect(DaemonVoiceInferenceModelLicenseAcceptRequestSchema.parse(accepted.params)).toEqual({
            qualifiedPackId: packId, pluginId: review.pluginId, packId: review.packId, pluginVersion: review.pluginVersion,
            packVersion: review.packVersion, licenseId: review.licenseId, licenseSourceUrl: review.licenseSourceUrl,
            licenseTextDigest: review.licenseTextDigest, artifactBinding: review.artifactBinding,
        });
        expect(requests.indexOf(accepted)).toBeLessThan(requests.findIndex(request => request.method.endsWith('.install')));
    });

    it.each([false, true])('removes the installed default pack only after its one confirmation is accepted: %s', async accepted => {
        const packId = getDefaultModelPackId('stt_sherpa')!;
        catalogReply([status(packId)]);
        const tree = await renderSection({ selectedSttPackId: packId });
        await waitForTestEvent(tree.subscribe, () => tree.root.findAllByProps({ testID: `voice-model-remove-${packId}` }), rows => rows.length > 0);
        expect(tree.root.findByProps({ testID: `voice-model-remove-${packId}` })).toBeTruthy();
        const confirmationOpened = createDeferred<void>();
        nativeAlert.mockImplementationOnce(() => confirmationOpened.resolve());
        const removeRequested = createDeferred<void>();
        const previousReply = respond;
        respond = (request, context) => {
            if (request.method.endsWith('.remove')) removeRequested.resolve();
            return previousReply(request, context);
        };
        await pressTestInstanceAsync(tree.root.findByProps({ testID: `voice-model-remove-${packId}` }));
        await confirmationOpened.promise;
        expect(nativeAlert).toHaveBeenCalledOnce();
        expect(nativeAlert).toHaveBeenCalledWith(expect.any(String), expect.any(String),
            expect.arrayContaining([expect.objectContaining({ style: 'destructive' })]), { cancelable: false });
        await act(async () => chooseNativeConfirmation(accepted));
        if (accepted) {
            await removeRequested.promise;
            expect(requests.filter(request => request.method.endsWith('.remove'))).toHaveLength(1);
        }
        expect(requests.filter(request => request.method.endsWith('.remove')).map(request => request.params)).toEqual(accepted ? [{ packId }] : []);
    });

    it('makes every competing model action inert while the catalog mutation owner is active', async () => {
        const sttPack = getDefaultModelPackId('stt_sherpa')!;
        const ttsPack = getDefaultModelPackId('tts_sherpa')!;
        catalogReply([status(sttPack), status(ttsPack)]);
        const tree = await renderSection();
        await waitForTestEvent(tree.subscribe, () => tree.root.findAllByProps({ testID: `voice-model-remove-${sttPack}` }), rows => rows.length > 0);
        expect(tree.root.findByProps({ testID: `voice-model-remove-${sttPack}` })).toBeTruthy();
        const confirmationOpened = createDeferred<void>();
        nativeAlert.mockImplementationOnce(() => confirmationOpened.resolve());
        await act(async () => { void tree.root.findByProps({ testID: `voice-model-remove-${sttPack}` }).props.onPress(); });
        await confirmationOpened.promise;
        expect(nativeAlert).toHaveBeenCalledOnce();
        const row = tree.root.findByProps({ testID: `voice-model-row-${ttsPack}` });
        const remove = tree.root.findByProps({ testID: `voice-model-remove-${ttsPack}` });
        expect(row.props.onPress ?? row.props.onClick).toBeUndefined();
        expect(row.props.disabled).toBe(true);
        expect(remove.props.disabled).toBe(true);
        const control = remove.findAll(node => typeof node.type === 'string' && (node.props.accessibilityRole === 'button' || node.props.role === 'button'))[0];
        expect(control?.props.accessibilityState?.disabled ?? control?.props['aria-disabled']).toBe(true);
        await act(async () => chooseNativeConfirmation(false));
        expect(requests.some(request => request.method.endsWith('.remove'))).toBe(false);
    });
});
