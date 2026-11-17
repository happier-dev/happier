import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createDeferred } from '@/dev/testkit';
import { createHydratedPlainMachineFixture, createMachineReadBatchResponseFixture, createPlainMachineRowFixture } from '@/dev/testkit/fixtures/machineFixtures';
import { installSessionActionRpcBoundary } from '@/dev/testkit/harness/sessionActionRpcBoundary';
import { restoreServerAccountForTest } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { observeMachinePresenceForTest } from '@/dev/testkit/harness/machinePresence';
import { createRootLayoutFeaturesResponse } from '@/dev/testkit/fixtures/featureFixtures';
import { FeaturesResponseSchema} from '@happier-dev/protocol/features/payload/featuresResponseSchema';
import { tryWriteServerEnabledBitInPlace } from '@happier-dev/protocol/features/serverEnabledBit';

vi.mock('socket.io-client', async original => (
  await import('@/dev/testkit/harness/serverAccountConnectionHarness')
).createSocketIoClientBoundary(original));
let daemonReply: () => Promise<unknown>;
const requests = installSessionActionRpcBoundary(() => daemonReply());
const { storage } = await import('@/sync/domains/state/storage');
const { normalizeVoiceSettingsLocalDelta } = await import('@/sync/domains/settings/voiceSettingsPersistence');
const { resolveVoiceExecutionMachineId } = await import('@/voice/settings/executionMachine');
const { persistVoiceAutoTargetMachineId } = await import('@/voice/persistence/voiceAutoTargetMachineSettings');
const { createSelectedVoiceMachineClient } = await import('./selectedMachineClient');
const { publishAppliedActiveServerSnapshot } = await import('@/sync/runtime/orchestration/appliedActiveServerRuntime');
const { recordMachineRequestFailed, clearMachineRequestReachabilityForTest } = await import('@/sync/domains/machines/reachability/machineReachability');
let account: Awaited<ReturnType<typeof restoreServerAccountForTest>> | null = null;
const features = createRootLayoutFeaturesResponse();
if (!tryWriteServerEnabledBitInPlace(features, 'machines.liveStream.serverRouted', true)) throw new Error('Expected relay feature fixture');
const relayFeatures = FeaturesResponseSchema.parse({ ...features,
  capabilities: { ...features.capabilities, machines: { ...features.capabilities.machines,
    liveStream: { serverRouted: { caps: {}, disabledReason: null } } } },
});
const machineIds = ['machine-a', 'machine-b', 'machine-origin', 'machine-replacement'];

function selectMachine(machineId: string | null) {
  storage.getState().applySettingsLocal(normalizeVoiceSettingsLocalDelta({
    voice: { ...storage.getState().settings.voice, executionMachine: { mode: 'fixed', machineId } },
  }, storage.getState().settings));
}

describe('selected Voice machine client', () => {
  beforeEach(async () => {
    clearMachineRequestReachabilityForTest();
    requests.length = 0;
    daemonReply = async () => ({ ok: true });
    account = await restoreServerAccountForTest({
      serverUrl: 'https://selected-voice.test', accountId: 'account-a', credentialScope: 'restored-home',
      request: async (input, init) => {
        const path = new URL(String(input)).pathname;
        if (path === '/v1/account/encryption') return Response.json({ mode: 'plain', updatedAt: 0 });
        if (path === '/v1/features' || path === '/v1/features/authenticated') return Response.json(relayFeatures);
        if (path === '/v2/account/settings') return Response.json({ content: { t: 'plain', v: {} }, version: 1 });
        if (path === '/v1/machines') return Response.json(machineIds.map(id => createPlainMachineRowFixture({ id, accountId: 'account-a' })));
        if (path === '/v1/machines/read-batch' && init?.method === 'POST') return createMachineReadBatchResponseFixture(init.body,
          id => createPlainMachineRowFixture({ id, accountId: 'account-a' }));
        const machine = /^\/v1\/machines\/([^/]+)$/.exec(path);
        if (machine) return Response.json({ machine: createPlainMachineRowFixture({ id: machine[1]!, accountId: 'account-a' }) });
        return null;
      },
    });
    storage.getState().applyMachines(machineIds.map(id => createHydratedPlainMachineFixture({ id, accountId: 'account-a', machine: { activeAt: Date.now() } })));
    observeMachinePresenceForTest({ serverId: account.home.id, accountId: 'account-a' }, machineIds);
    selectMachine('machine-a');
  });
  afterEach(async () => { await account?.dispose(); account = null; });

  it.each(['home', 'account'] as const)('refuses remaining operation phases when the admitted %s retires during dispatch', async replacement => {
    const admittedHome = account!.home;
    const operation = createSelectedVoiceMachineClient().bindOperation();
    daemonReply = async () => {
      if (replacement === 'home') publishAppliedActiveServerSnapshot({
        serverId: 'replacement-home', serverUrl: 'https://replacement-home.test', generation: 2,
      });
      else storage.setState({ profileScope: { serverId: admittedHome.id, accountId: 'replacement-account' } });
      return { ok: true };
    };
    await expect(operation.invoke('daemon.voice.speech.synthesize', {})).rejects.toMatchObject({ code: 'cancelled' });
    await expect(operation.invoke('daemon.voice.speech.download.chunk', {})).rejects.toMatchObject({ code: 'cancelled' });
    expect(requests).toEqual([{ method: 'machine-a:daemon.voice.speech.synthesize', params: {} }]);
  });

  it('fails closed before transport when no Voice execution machine is resolvable', async () => {
    selectMachine(null);
    await expect(createSelectedVoiceMachineClient().invoke('daemon.voice.probe', {}))
      .rejects.toMatchObject({ code: 'machine_unavailable' });
    expect(requests).toEqual([]);
  });

  it('releases an unanswered bound request when its Account retires', async () => {
    const entered = createDeferred<void>();
    daemonReply = async () => { entered.resolve(); return await new Promise(() => {}); };
    let outcome = 'pending';
    const pending = createSelectedVoiceMachineClient().bindOperation().invoke('daemon.voice.probe', {})
      .then(() => { outcome = 'resolved'; }, () => { outcome = 'retired'; });
    await entered.promise;
    expect(requests.length).toBe(1);
    storage.setState({ profileScope: { serverId: account!.home.id, accountId: 'replacement-account' } });
    await pending;
    expect(outcome).toBe('retired');
  });

  it('retains the dispatched answer when the automatic target changes mid-call', async () => {
    storage.getState().applySettingsLocal(normalizeVoiceSettingsLocalDelta({
      voice: { ...storage.getState().settings.voice, executionMachine: { mode: 'auto', machineId: null } },
    }, storage.getState().settings));
    persistVoiceAutoTargetMachineId('machine-a', storage.getState().settingsScope);
    expect(resolveVoiceExecutionMachineId()).toBe('machine-a');
    daemonReply = async () => {
      persistVoiceAutoTargetMachineId('machine-b', storage.getState().settingsScope);
      return { ok: true };
    };
    await expect(createSelectedVoiceMachineClient().invoke('daemon.voice.probe', { v: 1 }))
      .resolves.toEqual({ ok: true });
    expect(resolveVoiceExecutionMachineId()).toBe('machine-b');
    expect(requests).toEqual([{ method: 'machine-a:daemon.voice.probe', params: { v: 1 } }]);
  });

  it('keeps every phase of one bound operation on its originating machine', async () => {
    daemonReply = async () => { selectMachine('machine-b'); return { ok: true }; };
    const operation = createSelectedVoiceMachineClient().bindOperation();
    for (const method of ['transcribeUpload.init', 'transcribeUpload.chunk', 'transcribeUpload.finalize', 'transcribe']) {
      await operation.invoke('daemon.voice.speech.' + method, {});
    }
    expect(operation.machineId).toBe('machine-a');
    expect(resolveVoiceExecutionMachineId()).toBe('machine-b');
    expect(requests.map(request => request.method)).toEqual([
      'machine-a:daemon.voice.speech.transcribeUpload.init', 'machine-a:daemon.voice.speech.transcribeUpload.chunk',
      'machine-a:daemon.voice.speech.transcribeUpload.finalize', 'machine-a:daemon.voice.speech.transcribe',
    ]);
  });

  it('follows the real replacement owner for a captured origin rather than the current selection', async () => {
    storage.getState().applyMachines(machineIds.map(id => createHydratedPlainMachineFixture({ id, accountId: 'account-a', machine: { activeAt: Date.now(),
      ...(id === 'machine-origin' ? { active: false, replacedByMachineId: 'machine-replacement' } : {}),
    } })));
    observeMachinePresenceForTest({ serverId: account!.home.id, accountId: 'account-a' }, machineIds);
    const operation = createSelectedVoiceMachineClient().bindOperation('  machine-origin  ');
    await operation.invoke('daemon.voice.speech.transcribeUpload.init', {});
    expect(resolveVoiceExecutionMachineId()).toBe('machine-a');
    expect(requests).toEqual([{ method: 'machine-replacement:daemon.voice.speech.transcribeUpload.init', params: {} }]);
  });

  it('refuses an unreachable captured origin before any transport effect', () => {
    storage.getState().applyMachines(machineIds.map(id => createHydratedPlainMachineFixture({ id, accountId: 'account-a', machine: {
      active: id !== 'machine-origin', activeAt: id === 'machine-origin' ? 1 : Date.now(),
    } })));
    observeMachinePresenceForTest({ serverId: account!.home.id, accountId: 'account-a' }, machineIds);
    recordMachineRequestFailed({ serverId: account!.home.id, accountId: 'account-a', machineId: 'machine-origin' });
    expect(() => createSelectedVoiceMachineClient().bindOperation('machine-origin'))
      .toThrow(expect.objectContaining({ code: 'machine_unavailable' }));
    expect(requests).toEqual([]);
  });
});
