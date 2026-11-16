import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createDeferred, createHydratedPlainMachineFixture } from '@/dev/testkit';
import { installSessionActionRpcBoundary } from '@/dev/testkit/harness/sessionActionRpcBoundary';
import { serveAccountHomes } from '@/dev/testkit/harness/actionHomesHttpHarness';
import { createPlainMachineReadHttpResponseFixture } from '@/dev/testkit/fixtures/machineFixtures';
import { publishMachineInventoryForTest } from '@/dev/testkit/harness/machinePresence';
import { VoiceSpeechDiagnosticsConfigureRequestV1Schema, VoiceSpeechDiagnosticsSettingsV1Schema, VoiceSpeechDiagnosticsStatusResponseV1Schema,
  resolveVoiceSpeechDiagnosticsStoragePolicy } from '@happier-dev/protocol/voice/diagnostics';

vi.mock('socket.io-client', async (importOriginal) => (
  await import('@/dev/testkit/harness/serverAccountConnectionHarness')
).createSocketIoClientBoundary(importOriginal));
let invoke: (method: string, payload: unknown, signal?: AbortSignal) => Promise<unknown>;
const requests = installSessionActionRpcBoundary((request, context) => {
  if (request.method.endsWith('.configure')) VoiceSpeechDiagnosticsConfigureRequestV1Schema.parse(request.params);
  return invoke(request.method.slice(request.method.indexOf(':') + 1), request.params, context.signal);
});
const { storage } = await import('@/sync/domains/state/storage');
const { voiceSettingsParse } = await import('@/sync/domains/settings/voiceSettings');
const { normalizeVoiceSettingsLocalDelta } = await import('@/sync/domains/settings/voiceSettingsPersistence');

import { createVoiceDiagnosticsClient } from './client';

let home: Awaited<ReturnType<typeof serveAccountHomes>>;
let disconnect: (() => Promise<void>) | undefined;
const settings = VoiceSpeechDiagnosticsSettingsV1Schema.parse({ v: 1, enabled: false, consentVersion: null });
beforeEach(async () => {
  requests.length = 0;
  home = await serveAccountHomes({ homes: [{ key: 'diagnostics', serverUrl: 'https://diagnostics-client.test', accountId: 'account-a' }],
      route: ({ path, method, body }) => createPlainMachineReadHttpResponseFixture(path,
        { method, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }, 'account-a') ?? undefined });
  disconnect = await home.restoreActiveConnection();
  const machine = createHydratedPlainMachineFixture({ id: 'diagnostics-machine', accountId: 'account-a', machine: { activeAt: Date.now() } });
  await publishMachineInventoryForTest({ serverId: home.homes.diagnostics!.id, accountId: 'account-a' }, [machine]);
  storage.getState().applySettingsLocal(normalizeVoiceSettingsLocalDelta({ voice: voiceSettingsParse({ executionMachine: { mode: 'fixed', machineId: machine.id } }) }, storage.getState().settings));
});
afterEach(async () => { await disconnect?.(); await home?.dispose(); });

describe('voice diagnostics client', () => {
  it('routes configure/status/delete through the selected voice machine and validates responses', async () => {
    invoke = vi.fn(async (method: string) => {
      if (method.endsWith('.deleteAll')) return { ok: true };
      return VoiceSpeechDiagnosticsStatusResponseV1Schema.parse({
        ok: true,
        root: '/private/happier/voice/diagnostics/v1',
        settings,
        artifacts: [],
        health: {
          captureFailure: false,
          cleanup: { status: 'healthy', code: null, ownedEntryCount: 0 },
        },
        backupPolicy: resolveVoiceSpeechDiagnosticsStoragePolicy('daemon_desktop'),
      });
    });
    const client = createVoiceDiagnosticsClient();

    await expect(client.status()).resolves.toMatchObject({ root: expect.stringContaining('diagnostics') });
    await expect(client.configure(settings)).resolves.toMatchObject({ settings: { enabled: false } });
    await expect(client.deleteAll()).resolves.toBeUndefined();
    expect(requests.map(({ method }) => method)).toEqual([
      'diagnostics-machine:daemon.voiceDiagnostics.status',
      'diagnostics-machine:daemon.voiceDiagnostics.configure',
      'diagnostics-machine:daemon.voiceDiagnostics.deleteAll',
    ]);
  });

  it('starts artifact export only with explicit confirmation intent and the selected artifact id', async () => {
    invoke = vi.fn(async (method: string) => {
      if (method.endsWith('.init')) return { success: false, error: 'transfer_not_found', errorCode: 'transfer_not_found' };
      throw new Error(`unexpected ${method}`);
    });
    const destination = { writeBytes: vi.fn(), close: vi.fn(), cleanup: vi.fn() };

    await expect(createVoiceDiagnosticsClient().downloadArtifact({
      artifactId: 'abcdef12-dead-beef',
      destination,
    })).resolves.toMatchObject({ ok: false, errorCode: 'transfer_not_found' });
    expect(requests).toEqual([expect.objectContaining({
      method: 'diagnostics-machine:daemon.voiceDiagnostics.artifact.download.init',
      params: expect.objectContaining({
        artifactId: 'abcdef12-dead-beef',
        intent: 'user_confirmed_export',
        recipientPublicKeyBase64: expect.any(String),
      }),
    })]);
  });

  it('fails closed on malformed or daemon-error responses', async () => {
    invoke = async () => ({ ok: true, root: '/tmp' });
    await expect(createVoiceDiagnosticsClient().status())
      .rejects.toMatchObject({ code: 'invalid_response' });
    invoke = async () => ({ ok: false, errorCode: 'machine_unavailable' });
    await expect(createVoiceDiagnosticsClient().status())
      .rejects.toMatchObject({ code: 'machine_unavailable' });
  });

  it('releases a cancelled export waiter while keeping its admitted cleanup alive', async () => {
    const cleanupStarted = createDeferred<void>();
    let cleanupSignal: AbortSignal | undefined;
    let releaseCleanup!: () => void;
    const cleanup = new Promise<void>(resolve => { releaseCleanup = resolve; });
    invoke = async (method, _payload, signal) => {
      if (method.endsWith('.init')) return { success: true, downloadId: 'abcdef12-dead-4eef-beef-0123456789ab',
        chunkSizeBytes: 1024, sizeBytes: 0, name: 'diagnostics.wav' };
      if (method.endsWith('.abort')) {
        cleanupSignal = signal;
        cleanupStarted.resolve();
        await cleanup;
        return { success: true };
      }
      throw new Error(`Unexpected method ${method}`);
    };
    const controller = new AbortController();
    const pending = createVoiceDiagnosticsClient().downloadArtifact({ artifactId: 'abcdef12-dead-beef',
      signal: controller.signal,
      destination: { writeBytes: async () => {}, close: async () => {}, cleanup: async () => {} },
      onInit: async () => { throw new Error('destination_unavailable'); },
    });
    await cleanupStarted.promise;
    expect(cleanupSignal).toBeDefined();
    controller.abort();
    await expect(pending).resolves.toMatchObject({ ok: false });
    expect(cleanupSignal?.aborted).toBe(false);
    releaseCleanup();
  });
});
