import 'fake-indexeddb/auto';
import { afterEach, describe, expect, it, onTestFinished, vi } from 'vitest';
import { createDeferred, createMachineFixture, standardCleanup, waitForTestEvent } from '@/dev/testkit';
import { installSessionActionRpcBoundary } from '@/dev/testkit/harness/sessionActionRpcBoundary';
import { publishMachineInventoryForTest } from '@/dev/testkit/harness/machinePresence';
import { createPlainMachineReadHttpResponseFixture, createPlainMachineRowFixture } from '@/dev/testkit/fixtures/machineFixtures';
import { DaemonVoiceInferenceModelStatusSchema } from '@happier-dev/protocol/daemon/voiceInference';

vi.mock('socket.io-client', async importOriginal => (
    await import('@/dev/testkit/harness/serverAccountConnectionHarness')
).createSocketIoClientBoundary(importOriginal));
let respond: Parameters<typeof installSessionActionRpcBoundary>[0];
installSessionActionRpcBoundary((request, context) => respond(request, context));
const { createVoiceSettingsAccountTestHarness, createElevenLabsSettingsRuntimeTestHarness,
    withVoiceSettingsCredentialResource } = await import('./panels/voiceSettingsAccountTestHarness');
const { settingsParse } = await import('@/sync/domains/settings/settings');
const { storage } = await import('@/sync/domains/state/storage');
const { createDefaultActionExecutor } = await import('@/sync/ops/actions/defaultActionExecutor');
const { createDefaultVoiceProviderRegistry } = await import('@/voice/registry/defaultRegistry');
const { refreshSavedSecretCatalog } = await import('@/sync/engine/settings/savedSecretCatalogEngine');
const { getSavedSecretCatalogSnapshot, subscribeSavedSecretCatalogSnapshots } = await import('@/sync/store/settings/savedSecretCatalogSnapshot');
afterEach(() => standardCleanup());

function observeVoiceReads(settings: ReturnType<typeof settingsParse>) {
    const voice = settings.voice;
    let reads = 0;
    // Observe the real settings snapshot without replacing its parsing or operation logic.
    Object.defineProperty(settings, 'voice', { configurable: true, enumerable: true, get: () => { reads++; return voice; } });
    return () => reads;
}

describe('finite Voice Settings Action admission', () => {
    it('admits a cold provider catalog and releases its runtime demand after delivering rows', async () => {
        const runtime = createElevenLabsSettingsRuntimeTestHarness();
        const descriptor = createDefaultVoiceProviderRegistry().get(runtime.entry.providerId)?.providerSettings;
        if (!descriptor) throw new Error('Expected ElevenLabs provider Settings');
        const account = await createVoiceSettingsAccountTestHarness(settingsParse({ voice: { providerId: runtime.entry.providerId,
            providers: { [runtime.entry.providerId]: { schemaVersion: descriptor.schemaVersion,
                config: { ...descriptor.defaultConfig, billingMode: 'byo' } } } } }));
        onTestFinished(async () => { await runtime.dispose(); await account.dispose(); });
        account.replaceSettings(await withVoiceSettingsCredentialResource(account, { settings: account.settings,
            declaration: runtime.entry.declaration, pluginId: runtime.entry.pluginId, resourceId: 'cold-catalog-secret' }));
        await refreshSavedSecretCatalog(account.scope);
        await waitForTestEvent(subscribeSavedSecretCatalogSnapshots, () => getSavedSecretCatalogSnapshot(account.scope),
            snapshot => snapshot?.status === 'ready' && !snapshot.stale && snapshot.legacyImport?.status === 'complete');
        const demand = await import('@/voice/session/voiceProviderRuntimeDemand');
        // The host consumes the real demand notification and commits the real
        // plugin activation. Only Account/vendor HTTP transports are fixtures.
        let activation: Promise<void> | undefined;
        const unsubscribe = demand.subscribeVoiceProviderSettingsRuntimeDemand(() => {
            if (!activation && demand.getVoiceProviderSettingsRuntimeDemand().has(runtime.entry.providerId)) {
                activation = runtime.register();
                demand.bindVoiceProviderRuntimeDemandActivation(new Set([runtime.entry.providerId]), activation);
            }
        });
        onTestFinished(unsubscribe);
        const result = await createDefaultActionExecutor().execute('settings.invoke', {
            anchor: `voiceConversations.provider.${runtime.entry.providerId}.tts.voiceId.listCatalog`,
        }, { surface: 'agent', authority: 'account_automation', serverId: account.scope.serverId, expectedAccountId: account.scope.accountId });
        expect(result, JSON.stringify(result)).toMatchObject({ ok: true, result: { status: 'completed', value: {
            rows: [{ id: 'hpp4J3VqNfWAUOO0d1Us', name: 'Happier voice' }],
        } } });
        expect(demand.getVoiceProviderSettingsRuntimeDemand().has(runtime.entry.providerId)).toBe(false);
        expect(account.writes).toHaveLength(0);
    });
    it('keeps models_inspect rows across unrelated Voice edits with zero settings re-reads after admission', async () => {
        const machineId = 'admitted-model-machine';
        const account = await createVoiceSettingsAccountTestHarness(settingsParse({ experiments: true,
            featureToggles: { voice: true, 'voice.daemonInference': true },
            voice: { providerId: 'local_conversation', executionMachine: { mode: 'fixed', machineId } } }));
        onTestFinished(account.dispose);
        const request = account.request.getMockImplementation()!;
        account.request.mockImplementation(async (input, init) => createPlainMachineReadHttpResponseFixture(
            new URL(String(input)).pathname, init, account.scope.accountId) ?? request(input, init));
        const machine = createMachineFixture({ id: machineId, activeAt: Date.now(), storageMode: 'plain',
            access: createPlainMachineRowFixture({ id: machineId, accountId: account.scope.accountId }).access });
        await publishMachineInventoryForTest(account.scope, [machine]);
        const entered = createDeferred<void>();
        const release = createDeferred<void>();
        const status = DaemonVoiceInferenceModelStatusSchema.parse({ packId: 'admitted-model', kind: 'stt_sherpa',
            model: 'whisper', executionSupport: ['daemon'], installState: 'installed', updatedAtMs: 1 });
        respond = async () => { entered.resolve(); await release.promise; return { ok: true, models: [status] }; };
        const failures: unknown[] = [];
        const pending = createDefaultActionExecutor({ voiceModelPackPresentation: { isCurrent: () => true,
            onError: error => { failures.push(error); } } }).execute('settings.invoke', { anchor: 'voiceAdvanced.speechModels' }, {
            surface: 'agent', authority: 'account_automation', serverId: account.scope.serverId, expectedAccountId: account.scope.accountId,
        });
        try {
            await Promise.race([entered.promise, pending.then(result => {
                const failure = failures[0];
                throw new Error(`${JSON.stringify(result)}\n${failure instanceof Error ? failure.stack : String(failure)}`);
            })]);
            account.replaceVoice({ ...account.settings.voice, assistantLanguage: 'fr' });
            const reads = observeVoiceReads(account.settings);
            release.resolve();
            expect(await pending).toMatchObject({ ok: true, result: { status: 'completed', value: { models: [status] } } });
            expect(reads()).toBe(0);
            expect(account.writes).toHaveLength(0);
        } finally { release.resolve(); await pending; }
    });

    it.each(['listCatalog', 'retryCatalog'])('keeps provider %s rows across unrelated Voice edits without settings re-reads', async operation => {
        const runtime = createElevenLabsSettingsRuntimeTestHarness();
        const descriptor = createDefaultVoiceProviderRegistry().get(runtime.entry.providerId)?.providerSettings;
        if (!descriptor) throw new Error('Expected ElevenLabs provider Settings');
        const account = await createVoiceSettingsAccountTestHarness(settingsParse({ voice: { providerId: runtime.entry.providerId,
            providers: { [runtime.entry.providerId]: { schemaVersion: descriptor.schemaVersion,
                config: { ...descriptor.defaultConfig, billingMode: 'byo' } } } } }));
        onTestFinished(async () => { await runtime.dispose(); await account.dispose(); });
        const settings = await withVoiceSettingsCredentialResource(account, { settings: account.settings,
            declaration: runtime.entry.declaration, pluginId: runtime.entry.pluginId, resourceId: 'admitted-catalog-secret' });
        account.replaceSettings(settings);
        await refreshSavedSecretCatalog(account.scope);
        await waitForTestEvent(subscribeSavedSecretCatalogSnapshots, () => getSavedSecretCatalogSnapshot(account.scope),
            snapshot => snapshot?.status === 'ready' && !snapshot.stale && snapshot.legacyImport?.status === 'complete');
        await runtime.register();
        const executor = createDefaultActionExecutor();
        const actionContext = { surface: 'agent' as const, authority: 'account_automation' as const,
            serverId: account.scope.serverId, expectedAccountId: account.scope.accountId };
        const actionInput = { anchor: `voiceConversations.provider.${runtime.entry.providerId}.tts.voiceId.${operation}` };
        const baseline = await executor.execute('settings.invoke', actionInput, actionContext);
        expect(baseline, JSON.stringify(baseline)).toMatchObject({ ok: true, result: { status: 'completed' } });
        const entered = createDeferred<void>();
        const release = createDeferred<void>();
        const fetch = runtime.fetch.getMockImplementation()!;
        runtime.fetch.mockImplementation(async (input, init) => {
            if (new URL(String(input)).pathname === '/v2/voices') { entered.resolve(); await release.promise; }
            return fetch(input, init);
        });
        const pending = executor.execute('settings.invoke', actionInput, actionContext);
        try {
            await Promise.race([entered.promise, pending.then(result => { throw new Error(JSON.stringify(result)); })]);
            account.replaceVoice({ ...account.settings.voice, assistantLanguage: 'fr' });
            const reads = observeVoiceReads(account.settings);
            release.resolve();
            const result = await pending;
            expect(result, JSON.stringify(result)).toMatchObject({ ok: true, result: { status: 'completed', value: {
                rows: [{ id: 'hpp4J3VqNfWAUOO0d1Us', name: 'Happier voice' }],
            } } });
            expect(reads()).toBe(0);
            expect(account.writes).toHaveLength(0);
        } finally { release.resolve(); await pending; }
    });
});
