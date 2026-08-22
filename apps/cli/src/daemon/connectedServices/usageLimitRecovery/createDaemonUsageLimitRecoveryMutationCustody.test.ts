import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createSessionRecordFixture } from '@/testkit/backends/sessionFixtures';
import type { StoredCredentials } from '@/persistence';
import type { TranscriptMessageAppendMutationV1 } from '@/api/session/client/transport/mutations/sessionClientDurableMutationTypes';

const mocks = vi.hoisted(() => ({
  enqueueUsageLimitRecovery: vi.fn(async () => undefined),
  enqueueTranscriptMessage: vi.fn<(
    mutation: TranscriptMessageAppendMutationV1,
  ) => Promise<Readonly<{ persisted: boolean; delivered: boolean }>>>(
    async () => ({ persisted: true, delivered: false }),
  ),
  awaitReady: vi.fn(async () => undefined),
  flush: vi.fn(async () => undefined),
  close: vi.fn(async () => undefined),
  createDaemonSessionClientDurableMutationOutbox: vi.fn(),
  commitSessionStoredMessage: vi.fn(async () => ({
    didWrite: true,
    messageId: 'message-1',
    localId: 'legacy-event',
    seq: 1,
    createdAt: 1,
  })),
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
vi.mock('@/session/transport/http/sessionsHttp', () => ({
  commitSessionStoredMessage: mocks.commitSessionStoredMessage,
}));

import { AccountEncryptionMaterialUnavailableError } from '@/api/client/encryptionKey';
import { decryptSessionPayload } from '@/session/transport/encryption/sessionEncryptionContext';
import { createDaemonSessionMutationCustody } from './createDaemonUsageLimitRecoveryMutationCustody';

const credentials = {
  token: 'token',
  encryption: null,
} satisfies StoredCredentials;

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

describe('createDaemonSessionMutationCustody', () => {
  beforeEach(() => {
    mocks.enqueueUsageLimitRecovery.mockClear();
    mocks.enqueueTranscriptMessage.mockClear();
    mocks.close.mockClear();
    mocks.awaitReady.mockClear();
    mocks.flush.mockClear();
    mocks.updateSessionMetadataWithRetry.mockClear();
    mocks.commitSessionStoredMessage.mockClear();
    mocks.createDaemonSessionClientDurableMutationOutbox.mockReset();
    mocks.createDaemonSessionClientDurableMutationOutbox.mockImplementation((params) => ({
      enqueueUsageLimitRecovery: mocks.enqueueUsageLimitRecovery,
      enqueueTranscriptMessage: mocks.enqueueTranscriptMessage,
      close: mocks.close,
      flush: mocks.flush,
      awaitReady: mocks.awaitReady,
      enqueueExactTurnEnd: vi.fn(async () => undefined),
      deliver: params.deliverUsageLimitRecovery,
      deliverTranscript: params.deliverTranscriptMessage,
    }));
  });

  it('reuses one daemon-custody outbox per session and delivers through the usage-only merge', async () => {
    const custody = createDaemonSessionMutationCustody({ credentials });
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
      ctx: null,
      mode: 'plain' as const,
      accountEncryptionCurrentness: {
        mode: 'plain' as const,
        version: 1,
        signingKeyFingerprint: null,
        contentKeyFingerprint: null,
        updatedAt: 1,
      },
    }));
    const custody = createDaemonSessionMutationCustody({
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
    const custody = createDaemonSessionMutationCustody({
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
          ctx: null,
          mode: 'plain' as const,
          accountEncryptionCurrentness: {
            mode: 'plain' as const,
            version: 1,
            signingKeyFingerprint: null,
            contentKeyFingerprint: null,
            updatedAt: 1,
          },
        }
      : {
          ok: false as const,
          code: 'session_not_found' as const,
        });
    const custody = createDaemonSessionMutationCustody({
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
    const custody = createDaemonSessionMutationCustody({
      credentials,
      resolveSessionTransportContext: resolveTransport,
    });

    await expect(custody.bindRecoveredJournals(['session-error', 'session-missing'])).resolves.toEqual({
      boundSessionIds: [],
      retainedSessionIds: ['session-error', 'session-missing'],
    });
  });

  it('builds canonical plaintext transcript content and awaits durable admission through the same session custody', async () => {
    const rawSession = createSessionRecordFixture({
      id: 'session-1',
      metadata: '{}',
      encryptionMode: 'plain',
      machineId: 'machine-1',
    });
    const custody = createDaemonSessionMutationCustody({
      credentials,
      resolveSessionTransportContext: async () => ({
        ok: true as const,
        sessionId: 'session-1',
        rawSession,
        ctx: null,
        mode: 'plain' as const,
        accountEncryptionCurrentness: {
          mode: 'plain' as const,
          version: 1,
          signingKeyFingerprint: null,
          contentKeyFingerprint: null,
          updatedAt: 1,
        },
      }),
    });

    await expect(custody.stageTranscriptEvent({
      sessionId: 'session-1',
      eventId: 'connected-service-account-switch:one',
      data: { type: 'connected-service-account-switch', reason: 'manual' },
      observedAt: 100,
    })).resolves.toEqual({ persisted: true, delivered: false });

    expect(mocks.enqueueTranscriptMessage).toHaveBeenCalledWith(expect.objectContaining({
      mutationId: 'transcript:session-1:connected-service-account-switch:one',
      localId: 'connected-service-account-switch:one',
      messageRole: 'event',
      provenance: { kind: 'non_dependent', source: 'background' },
      content: {
        t: 'plain',
        v: {
          role: 'agent',
          content: {
            type: 'event',
            id: 'connected-service-account-switch:one',
            data: { type: 'connected-service-account-switch', reason: 'manual' },
          },
        },
      },
    }));
  });

  it('normalizes a retained legacy ciphertext before the daemon commits stored content', async () => {
    const rawSession = createSessionRecordFixture({
      id: 'session-1',
      metadata: '{}',
      encryptionMode: 'e2ee',
      machineId: 'machine-1',
    });
    const custody = createDaemonSessionMutationCustody({ credentials });

    await custody.stage({ mutation, rawSession });
    const adapter = mocks.createDaemonSessionClientDurableMutationOutbox.mock.results[0]?.value;
    await adapter.deliverTranscript({
      v: 1,
      sessionId: 'session-1',
      mutationId: 'transcript:session-1:legacy-event',
      source: 'transcript_message_append',
      localId: 'legacy-event',
      messageRole: 'event',
      content: 'legacy-ciphertext',
      createdAt: 1,
      updatedAt: 1,
      provenance: { kind: 'non_dependent', source: 'background' },
    });

    expect(mocks.commitSessionStoredMessage).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: 'session-1',
      localId: 'legacy-event',
      content: { t: 'encrypted', c: 'legacy-ciphertext' },
    }));
  });

  it('retains transcript custody unless the HTTP commit receipt confirms the requested local id', async () => {
    const rawSession = createSessionRecordFixture({
      id: 'session-1',
      metadata: '{}',
      encryptionMode: 'plain',
      machineId: 'machine-1',
    });
    const custody = createDaemonSessionMutationCustody({ credentials });

    await custody.stage({ mutation, rawSession });
    const adapter = mocks.createDaemonSessionClientDurableMutationOutbox.mock.results[0]?.value;
    const transcriptMutation = {
      v: 1 as const,
      sessionId: 'session-1',
      mutationId: 'transcript:session-1:event-1',
      source: 'transcript_message_append' as const,
      localId: 'event-1',
      messageRole: 'event' as const,
      content: { t: 'plain' as const, v: { type: 'event' } },
      createdAt: 1,
      updatedAt: 1,
      provenance: { kind: 'non_dependent' as const, source: 'background' as const },
    };

    mocks.commitSessionStoredMessage.mockResolvedValueOnce({
      didWrite: true,
      messageId: 'message-1',
      localId: 'different-event',
      seq: 1,
      createdAt: 1,
    });
    await expect(adapter.deliverTranscript(transcriptMutation)).resolves.toBe(false);

    mocks.commitSessionStoredMessage.mockResolvedValueOnce({
      didWrite: false,
      messageId: 'message-1',
      localId: 'event-1',
      seq: 1,
      createdAt: 1,
    });
    await expect(adapter.deliverTranscript(transcriptMutation)).resolves.toBe(true);
  });

  it('fails closed before journal admission when an E2EE session key is unavailable', async () => {
    const custody = createDaemonSessionMutationCustody({
      credentials,
      resolveSessionTransportContext: async () => ({
        ok: false as const,
        code: 'encryption_material_unavailable' as const,
        sessionId: 'session-1',
      }),
    });

    await expect(custody.stageTranscriptEvent({
      sessionId: 'session-1',
      eventId: 'connected-service-account-switch:one',
      data: { type: 'connected-service-account-switch' },
    })).rejects.toBeInstanceOf(AccountEncryptionMaterialUnavailableError);
    expect(mocks.createDaemonSessionClientDurableMutationOutbox).not.toHaveBeenCalled();
    expect(mocks.enqueueTranscriptMessage).not.toHaveBeenCalled();
  });

  it('encrypts E2EE transcript content with fresh ciphertext while retaining the stable event id', async () => {
    const ctx = {
      encryptionKey: new Uint8Array(32).fill(7),
      encryptionVariant: 'dataKey' as const,
    };
    const rawSession = createSessionRecordFixture({
      id: 'session-1',
      metadata: '{}',
      encryptionMode: 'e2ee',
      machineId: 'machine-1',
    });
    const custody = createDaemonSessionMutationCustody({
      credentials,
      resolveSessionTransportContext: async () => ({
        ok: true as const,
        sessionId: 'session-1',
        rawSession,
        ctx,
        mode: 'e2ee' as const,
        accountEncryptionCurrentness: {
          mode: 'e2ee' as const,
          version: 1,
          signingKeyFingerprint: 'signing-key',
          contentKeyFingerprint: 'content-key',
          updatedAt: 1,
        },
      }),
    });
    const input = {
      sessionId: 'session-1',
      eventId: 'connected-service-account-switch:encrypted',
      data: { type: 'connected-service-account-switch', reason: 'manual' },
      observedAt: 100,
    } as const;

    await custody.stageTranscriptEvent(input);
    await custody.stageTranscriptEvent(input);

    const firstContent = mocks.enqueueTranscriptMessage.mock.calls[0]?.[0]?.content;
    const secondContent = mocks.enqueueTranscriptMessage.mock.calls[1]?.[0]?.content;
    expect(firstContent).not.toEqual(secondContent);
    expect(firstContent).toMatchObject({ t: 'encrypted', c: expect.any(String) });
    if (!firstContent || typeof firstContent === 'string' || firstContent.t !== 'encrypted') {
      throw new Error('Expected encrypted transcript content');
    }
    expect(decryptSessionPayload({ ctx, ciphertextBase64: firstContent.c })).toEqual({
      role: 'agent',
      content: {
        type: 'event',
        id: input.eventId,
        data: input.data,
      },
    });
    if (!secondContent || typeof secondContent === 'string' || secondContent.t !== 'encrypted') {
      throw new Error('Expected encrypted transcript content');
    }
    expect(decryptSessionPayload({ ctx, ciphertextBase64: secondContent.c })).toEqual({
      role: 'agent',
      content: {
        type: 'event',
        id: input.eventId,
        data: input.data,
      },
    });
  });
});
