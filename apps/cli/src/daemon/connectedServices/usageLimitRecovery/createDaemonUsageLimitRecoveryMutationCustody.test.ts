import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createSessionRecordFixture } from '@/testkit/backends/sessionFixtures';

const mocks = vi.hoisted(() => ({
  enqueueUsageLimitRecovery: vi.fn(async () => undefined),
  awaitReady: vi.fn(async () => undefined),
  flush: vi.fn(async () => undefined),
  close: vi.fn(async () => undefined),
  createDaemonSessionClientDurableMutationOutbox: vi.fn(),
  updateSessionMetadataWithRetry: vi.fn(async (params: {
    updater: (metadata: Record<string, unknown>) => Record<string, unknown>;
  }) => ({ version: 2, metadata: params.updater({ untouched: true }) })),
}));

vi.mock('@/api/session/client/transport/mutations/createDaemonSessionClientDurableMutationOutbox', () => ({
  createDaemonSessionClientDurableMutationOutbox: mocks.createDaemonSessionClientDurableMutationOutbox,
}));
vi.mock('@/session/metadata/updateSessionMetadataWithRetry', () => ({
  updateSessionMetadataWithRetry: mocks.updateSessionMetadataWithRetry,
}));

import { createDaemonUsageLimitRecoveryMutationCustody } from './createDaemonUsageLimitRecoveryMutationCustody';

const credentials = {
  token: 'token',
  encryption: { type: 'legacy' as const, secret: new Uint8Array(32) },
};

const mutation = {
  v: 1 as const,
  sessionId: 'session-1',
  mutationId: 'mutation-1',
  fieldId: 'runtime.usageLimitRecovery' as const,
  deliveryClass: 'durable_required' as const,
  source: 'daemon' as const,
  observedAt: 1,
  op: {
    kind: 'set' as const,
    value: {
      v: 1,
      status: 'waiting',
      issueFingerprint: 'usage-limit:one',
      armedAtMs: 1,
      resetAtMs: 2,
      nextCheckAtMs: 2,
      attemptCount: 0,
      maxAttempts: 3,
      lastProbeError: null,
      resumePromptMode: 'standard',
      selectedAuth: { kind: 'native' },
    },
  },
};

describe('createDaemonUsageLimitRecoveryMutationCustody', () => {
  beforeEach(() => {
    mocks.enqueueUsageLimitRecovery.mockClear();
    mocks.close.mockClear();
    mocks.awaitReady.mockClear();
    mocks.flush.mockClear();
    mocks.updateSessionMetadataWithRetry.mockClear();
    mocks.createDaemonSessionClientDurableMutationOutbox.mockReset();
    mocks.createDaemonSessionClientDurableMutationOutbox.mockImplementation((params) => ({
      enqueueUsageLimitRecovery: mocks.enqueueUsageLimitRecovery,
      close: mocks.close,
      flush: mocks.flush,
      awaitReady: mocks.awaitReady,
      enqueueExactTurnEnd: vi.fn(async () => undefined),
      deliver: params.deliverUsageLimitRecovery,
    }));
  });

  it('reuses one daemon-custody outbox per session and delivers through the usage-only merge', async () => {
    const custody = createDaemonUsageLimitRecoveryMutationCustody({ credentials });
    const rawSession = createSessionRecordFixture({
      id: 'session-1',
      metadata: '{}',
      encryptionMode: 'plain',
      machineId: 'machine-1',
    });

    await custody.stage({ mutation, rawSession });
    await custody.stage({ mutation: { ...mutation, mutationId: 'mutation-2' }, rawSession });

    expect(mocks.createDaemonSessionClientDurableMutationOutbox).toHaveBeenCalledTimes(1);
    expect(mocks.enqueueUsageLimitRecovery).toHaveBeenCalledTimes(2);

    const adapter = mocks.createDaemonSessionClientDurableMutationOutbox.mock.results[0]?.value;
    await adapter.deliver(mutation);
    expect(mocks.updateSessionMetadataWithRetry).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: 'session-1',
      updater: expect.any(Function),
    }));
  });

  it('binds usage-capable custody after exact raw-session resolution without starting a second scan or engine', async () => {
    const resolveTransport = vi.fn(async () => ({
      ok: true as const,
      sessionId: 'session-1',
      rawSession: createSessionRecordFixture({
        id: 'session-1',
        metadata: '{}',
        encryptionMode: 'plain',
        machineId: 'machine-1',
      }),
      ctx: { encryptionKey: new Uint8Array(32), encryptionVariant: 'legacy' as const },
      mode: 'plain' as const,
    }));
    const custody = createDaemonUsageLimitRecoveryMutationCustody({
      credentials,
      resolveSessionTransportContext: resolveTransport,
    });

    await expect(custody.bindRecoveredJournals(['session-1'])).resolves.toEqual({
      boundSessionIds: ['session-1'],
      retainedSessionIds: [],
    });

    expect(resolveTransport).toHaveBeenCalledWith({ credentials, idOrPrefix: 'session-1' });
    expect(mocks.awaitReady).not.toHaveBeenCalled();
    expect(mocks.flush).not.toHaveBeenCalled();

    await custody.close();
    expect(mocks.close).toHaveBeenCalledTimes(1);
  });

  it('truthfully retains a discovered journal whose exact raw session cannot be resolved', async () => {
    const custody = createDaemonUsageLimitRecoveryMutationCustody({
      credentials,
      resolveSessionTransportContext: async () => ({
        ok: false as const,
        code: 'session_not_found' as const,
      }),
    });

    await expect(custody.bindRecoveredJournals(['session-missing'])).resolves.toEqual({
      boundSessionIds: [],
      retainedSessionIds: ['session-missing'],
    });
    expect(mocks.createDaemonSessionClientDurableMutationOutbox).not.toHaveBeenCalled();
  });

  it('retries retained startup journals on reconnect and binds each session at most once', async () => {
    let transportAvailable = false;
    const resolveTransport = vi.fn(async () => transportAvailable
      ? {
          ok: true as const,
          sessionId: 'session-1',
          rawSession: createSessionRecordFixture({
            id: 'session-1',
            metadata: '{}',
            encryptionMode: 'plain',
            machineId: 'machine-1',
          }),
          ctx: { encryptionKey: new Uint8Array(32), encryptionVariant: 'legacy' as const },
          mode: 'plain' as const,
        }
      : {
          ok: false as const,
          code: 'session_not_found' as const,
        });
    const custody = createDaemonUsageLimitRecoveryMutationCustody({
      credentials,
      resolveSessionTransportContext: resolveTransport,
    });

    await expect(custody.bindRecoveredJournals(['session-1'])).resolves.toEqual({
      boundSessionIds: [],
      retainedSessionIds: ['session-1'],
    });

    transportAvailable = true;
    await expect(custody.bindRecoveredJournals([])).resolves.toEqual({
      boundSessionIds: ['session-1'],
      retainedSessionIds: [],
    });
    await expect(custody.bindRecoveredJournals([])).resolves.toEqual({
      boundSessionIds: [],
      retainedSessionIds: [],
    });

    expect(resolveTransport).toHaveBeenCalledTimes(2);
    expect(mocks.createDaemonSessionClientDurableMutationOutbox).toHaveBeenCalledTimes(1);

    await custody.close();
    await expect(custody.bindRecoveredJournals([])).resolves.toEqual({
      boundSessionIds: [],
      retainedSessionIds: [],
    });
    expect(mocks.createDaemonSessionClientDurableMutationOutbox).toHaveBeenCalledTimes(1);
  });

  it('retains later journals when one exact-session lookup throws', async () => {
    const resolveTransport = vi.fn(async ({ idOrPrefix }: { idOrPrefix: string }) => {
      if (idOrPrefix === 'session-error') throw new Error('server unavailable');
      return {
        ok: false as const,
        code: 'session_not_found' as const,
      };
    });
    const custody = createDaemonUsageLimitRecoveryMutationCustody({
      credentials,
      resolveSessionTransportContext: resolveTransport,
    });

    await expect(custody.bindRecoveredJournals(['session-error', 'session-missing'])).resolves.toEqual({
      boundSessionIds: [],
      retainedSessionIds: ['session-error', 'session-missing'],
    });
  });
});
