import 'fake-indexeddb/auto';
import { afterEach, describe, expect, it, onTestFinished, vi } from 'vitest';
import { Platform } from 'react-native';
import { ExpoSpeechRecognitionModule } from 'expo-speech-recognition';
import { createDeferred, createMachineFixture, standardCleanup } from '@/dev/testkit';
import { installSessionActionRpcBoundary } from '@/dev/testkit/harness/sessionActionRpcBoundary';
import { publishMachineInventoryForTest } from '@/dev/testkit/harness/machinePresence';
import { createPlainMachineReadHttpResponseFixture, createPlainMachineRowFixture } from '@/dev/testkit/fixtures/machineFixtures';
import { DaemonVoiceInferenceModelStatusSchema } from '@happier-dev/protocol/daemon/voiceInference';
import { getDefaultModelPackId } from '@happier-dev/protocol/voice/modelPacks/catalog';
import type { SettingOperationContext } from '@/components/settings/catalog/settingDeclarations';

vi.mock('socket.io-client', async importOriginal => (
    await import('@/dev/testkit/harness/serverAccountConnectionHarness')
).createSocketIoClientBoundary(importOriginal));
let respond: Parameters<typeof installSessionActionRpcBoundary>[0];
installSessionActionRpcBoundary((request, context) => respond(request, context));
const { createVoiceSettingsAccountTestHarness } = await import('./panels/voiceSettingsAccountTestHarness');
const { settingsParse } = await import('@/sync/domains/settings/settings');
const { TokenStorage } = await import('@/auth/storage/tokenStorage');
const { inspectVoiceSettingsSemanticReadiness } = await import('./voiceProviderReadinessInspection');

afterEach(() => standardCleanup());

describe('Voice semantic readiness independent reads', () => {
    it.each(['web', 'ios'] as const)('starts applicable reads together and preserves the complete %s result', async platform => {
        const platformDescriptor = Object.getOwnPropertyDescriptor(Platform, 'OS')!;
        Object.defineProperty(Platform, 'OS', { ...platformDescriptor, value: platform });
        onTestFinished(() => { Object.defineProperty(Platform, 'OS', platformDescriptor); });
        const machineId = `readiness-parallel-${platform}`;
        const packId = getDefaultModelPackId('tts_sherpa');
        const account = await createVoiceSettingsAccountTestHarness(settingsParse({ experiments: true,
            featureToggles: { voice: true, 'voice.daemonInference': true },
            voice: { providerId: 'local_conversation', executionMachine: { mode: 'fixed', machineId },
                providers: { local_conversation: { schemaVersion: 1, config: {
                    conversationMode: 'direct_session', stt: { provider: 'device' },
                    tts: { provider: 'local_neural', localNeural: { execution: 'daemon', assetId: packId } },
                } } } } }));
        onTestFinished(account.dispose);
        const request = account.request.getMockImplementation()!;
        account.request.mockImplementation(async (input, init) => createPlainMachineReadHttpResponseFixture(
            new URL(String(input)).pathname, init, account.scope.accountId) ?? request(input, init));
        await publishMachineInventoryForTest(account.scope, [createMachineFixture({ id: machineId,
            activeAt: Date.now(), storageMode: 'plain',
            access: createPlainMachineRowFixture({ id: machineId, accountId: account.scope.accountId }).access })]);
        const model = DaemonVoiceInferenceModelStatusSchema.parse({ packId, kind: 'tts_sherpa',
            model: 'kokoro', executionSupport: ['daemon'], installState: 'installed', updatedAtMs: 1 });
        respond = async () => ({ ok: true, models: [model] });
        const context: SettingOperationContext = { isCurrent: () => true,
            isFeatureEnabled: async featureId => featureId === 'voice.daemonInference',
            readSettings: async () => account.settings, mutateSettings: async () => { throw new Error('Readiness must not mutate Settings'); },
            services: { readConnectedAccountPurposes: async () => {
                await account.purposes.hydrate(account.scope);
                return account.purposes.value;
            } } };
        const input = { settings: account.settings, purpose: 'conversation' as const, context,
            machine: { selectedMachineId: machineId, machineId, machineLabel: machineId, selectionKind: 'resolved' as const },
            isCurrent: () => true };
        const baseline = await inspectVoiceSettingsSemanticReadiness(input);
        expect(baseline.models).toEqual([model]);
        const entered = createDeferred<void>();
        const release = createDeferred<void>();
        const releaseCredentials = createDeferred<void>();
        respond = async () => { entered.resolve(); await release.promise; return { ok: true, models: [model] }; };
        let credentialsStarted = 0;
        const readCredentials = TokenStorage.getCredentialsForServerUrl.bind(TokenStorage);
        // Observe the device-storage boundary and retain its real credential lookup.
        vi.spyOn(TokenStorage, 'getCredentialsForServerUrl').mockImplementation(async (...args) => {
            credentialsStarted++;
            await releaseCredentials.promise;
            return readCredentials(...args);
        });
        let purposesStarted = 0;
        const readPurposes = context.services!.readConnectedAccountPurposes!;
        const nativeProbe = vi.spyOn(ExpoSpeechRecognitionModule, 'isRecognitionAvailable');
        const pending = inspectVoiceSettingsSemanticReadiness({ ...input, context: { ...context,
            services: { readConnectedAccountPurposes: async signal => {
                purposesStarted++;
                await release.promise;
                return readPurposes(signal);
            } } } });
        try {
            await vi.waitFor(() => {
                expect(purposesStarted).toBe(1);
                expect(credentialsStarted).toBeGreaterThan(0);
                expect(nativeProbe).toHaveBeenCalledTimes(platform === 'ios' ? 1 : 0);
            });
            releaseCredentials.resolve();
            await entered.promise;
            release.resolve();
            expect(await pending).toEqual(baseline);
            respond = async () => ({ ok: false, errorCode: 'runtime_unavailable', error: 'Inference runtime unavailable' });
            await expect(inspectVoiceSettingsSemanticReadiness(input)).resolves.toMatchObject({ models: [] });
            const purposeFailure = Object.assign(new Error('Purpose catalog unavailable'), { code: 'catalog_unavailable' });
            await expect(inspectVoiceSettingsSemanticReadiness({ ...input, context: { ...context,
                services: { readConnectedAccountPurposes: async () => { throw purposeFailure; } } },
            })).rejects.toBe(purposeFailure);
            const { readLocalConversationVoiceSettings, writeLocalConversationVoiceSettings } = await import('@/sync/domains/settings/voiceSettings');
            const local = readLocalConversationVoiceSettings(account.settings.voice);
            const fallbackInput = { ...input, settings: { ...account.settings,
                voice: writeLocalConversationVoiceSettings(account.settings.voice, { ...local,
                    stt: { ...local.stt, provider: 'happier.voice.google/gemini-stt' } }) },
                context: { ...context, services: undefined } };
            respond = async () => ({ ok: true, models: [model] });
            await expect(inspectVoiceSettingsSemanticReadiness(fallbackInput)).resolves.toMatchObject({ models: [model] });
            const { beginConnectedAccountCatalogLoad } = await import('@/sync/store/settings/connectedAccountCatalogSnapshot');
            beginConnectedAccountCatalogLoad(account.scope, 'purposes', true);
            const fallbackEntered = createDeferred<void>();
            const fallbackRelease = createDeferred<void>();
            respond = async () => { fallbackEntered.resolve(); await fallbackRelease.promise; return { ok: true, models: [model] }; };
            const fallbackPending = inspectVoiceSettingsSemanticReadiness(fallbackInput);
            try {
                await fallbackEntered.promise;
                await account.purposes.hydrate(account.scope);
                fallbackRelease.resolve();
                await expect(fallbackPending).resolves.toMatchObject({ models: [model] });
            } finally {
                fallbackRelease.resolve();
                await fallbackPending.catch(() => {});
            }
            expect(account.writes).toHaveLength(0);
        } finally {
            releaseCredentials.resolve();
            release.resolve();
            await pending;
        }
    });
});
