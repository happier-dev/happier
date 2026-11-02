import { afterEach, describe, expect, it, vi } from 'vitest';
import { ManagedMachineV1Schema } from '@happier-dev/protocol/machines/managed/managedMachineV1';
import { resolveHomeTargetFromDescriptor } from '../../homeTarget/homeTarget.js';
import { runManagedMachineEnrollment } from './managedMachineEnrollment.js';

const resource = { contributionRef: { pluginId: 'test.provisioner', localId: 'vm' }, schemaVersion: 1, value: { nativeId: 'retained' } };
const correlation = { homeId: 'srv_managed_home', managedId: 'managed', requestId: 'retry', expectedIntentRevision: 1,
  controller: { machineId: 'controller', installationId: 'installation' }, resource };
const machine = ManagedMachineV1Schema.parse({ id: correlation.managedId, homeId: correlation.homeId, custodianAccountId: 'account',
  launch: { provider: resource.contributionRef, schemaVersion: 1, name: 'Guest', choices: {} }, controller: correlation.controller,
  allocation: 'bound', creationState: 'active', resource, desired: 'start', desiredWhen: 'now', intentRevision: 1,
  retention: { kind: 'until-delete' }, wakeOnAcceptedMessage: false, enrolledMachineId: 'same-machine' });
const target = resolveHomeTargetFromDescriptor({ descriptor: { v: 1, homeServerIdentityId: correlation.homeId,
  canonicalServerUrl: 'https://home.example.test', revision: 1, endpoints: [{ kind: 'https', url: 'https://home.example.test' }] },
  authority: 'trusted_enrollment' });

function retryGuest(operation: AbortController | undefined, readyAtMs: number) {
  let statusReads = 0;
  let installations = 0;
  const result = runManagedMachineEnrollment({ correlation, target, channel: 'stable',
    ...(operation ? { operationId: 'admitted-retry', signal: operation.signal } : {}),
    carrier: { kind: 'native', transport: { contributionRef: resource.contributionRef, schemaVersion: 1 } },
  }, {
    readCurrentManagedRow: async () => machine,
    createPromptId: () => 'unused',
    runTask: async () => { throw new Error('Retained retry must not pair again'); },
    approveLocalAuthRequest: async () => { throw new Error('Retained retry must not approve auth again'); },
    installNativePayload: async () => { installations++; return { binaryPath: '/home/guest/.happier/cli/current/happier' }; },
    native: { putFile: async () => {}, exec: async ({ command, signal }) => {
      signal?.throwIfAborted();
      if (command.startsWith('uname -s;')) return { status: 0, stdout: 'Linux\nx86_64\n/home/guest\n', stderr: '' };
      // Genuine native CLI process boundary: the restarted daemon registers later.
      if (command.includes("'daemon' 'status'")) {
        statusReads++;
        return { status: 0, stderr: '', stdout: JSON.stringify({ daemon: { pid: 5376, running: true, healthy: Date.now() >= readyAtMs },
          service: { installed: true }, auth: { needsAuth: false, machineId: 'same-machine' } }) };
      }
      return { status: 0, stdout: '', stderr: '' };
    } },
  });
  return { result, reads: () => statusReads, installations: () => installations };
}

describe('retained native bootstrap readiness lifetime', () => {
  afterEach(() => vi.useRealTimers());

  it('accepts registration after the standalone cutoff while its admitted operation is still active', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const operation = new AbortController();
    const retry = retryGuest(operation, 56_000);
    let outcome = 'pending';
    const settled = retry.result.then(value => { outcome = 'ready'; return value; }, error => { outcome = 'failed'; return error as unknown; });
    await vi.advanceTimersByTimeAsync(15_000);
    expect(outcome).toBe('pending');
    await vi.advanceTimersByTimeAsync(41_000);
    await expect(settled).resolves.toEqual({ machineId: 'same-machine' });
    expect(operation.signal.aborted).toBe(false);
    expect(retry.installations()).toBe(1);
  });

  it('stops at operation cancellation without further native status reads', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const operation = new AbortController();
    const retry = retryGuest(operation, Infinity);
    const cancelled = retry.result.catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(20_000);
    operation.abort();
    await expect(cancelled).resolves.toMatchObject({ name: 'AbortError' });
    const reads = retry.reads();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(retry.reads()).toBe(reads);
  });

  it('keeps the existing standalone cutoff without a containing operation', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const retry = retryGuest(undefined, 56_000);
    const failed = expect(retry.result).rejects.toMatchObject({ code: 'daemon_service_not_ready' });
    await vi.advanceTimersByTimeAsync(15_000);
    await failed;
    const reads = retry.reads();
    await vi.advanceTimersByTimeAsync(41_000);
    expect(retry.reads()).toBe(reads);
  });
});
