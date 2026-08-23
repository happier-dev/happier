import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  readExternalHistoryImportV1FromMetadata,
  readNonAuthoritativeLinkedExternalSessionV1FromMetadata,
  resolveExternalSessionOperationTimelineV1,
  type AccountEncryptionCurrentnessResponse,
  type ExternalSessionOperationRecordV1,
  type ExternalSessionOperationSocketCommandV1,
  type SessionMetadataOwnerPatchV1,
} from '@happier-dev/protocol';
import { describe, expect, it, vi } from 'vitest';

import {
  createPersistedTakeoverAdmissionWaiter,
} from '@/daemon/spawn/persistedTakeoverAdmission';
import {
  buildPersistedTakeoverRetiredMetadata,
  createExternalSessionPersistedTakeoverAdmissionOwner as createAdmissionOwner,
} from '@/session/actions/externalSessions/persistedTakeoverAdmission';
import type {
  ExternalTakeoverSpawnResolution,
} from '@/api/session/external/takeover/resolveExternalTakeoverSpawnOptions';
import {
  isExternalSessionPersistedTakeoverAdmissionReady,
} from '@/session/actions/externalSessions/takeoverAdmissionAction';
import {
  readExternalSessionOperationRecord,
  writeExternalSessionOperationRecord,
} from '@/session/actions/externalSessions/operationRecordStore';
import type {
  PreparedExternalSessionPersistedTakeoverSource,
} from '@/session/actions/externalSessions/takeoverPhaseRunner';
import { SPAWN_SESSION_ERROR_CODES } from '@/session/shared/spawnSessionContract';
import { withJsonOwnerFileLock } from '@/utils/fs/jsonOwnerFileLock';

import { createDaemonControlApp } from './controlServer';

const credentialReaderMocks = vi.hoisted(() => ({
  readCredentials: vi.fn(async () => null),
  readStoredCredentials: vi.fn(async () => ({
    token: 'token-only',
    encryption: null,
  })),
}));

vi.mock('@/persistence', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/persistence')>(),
  readCredentials: credentialReaderMocks.readCredentials,
  readStoredCredentials: credentialReaderMocks.readStoredCredentials,
}));

const accountCurrentnessMocks = vi.hoisted(() => ({
  fetchAccountEncryptionCurrentness: vi.fn(),
}));

vi.mock('@/api/client/connectedServiceCredentialApi', async (importOriginal) => ({
  ...await importOriginal<
    typeof import('@/api/client/connectedServiceCredentialApi')
  >(),
  fetchAccountEncryptionCurrentness:
    accountCurrentnessMocks.fetchAccountEncryptionCurrentness,
}));

const plainAccountEncryptionCurrentness = Object.freeze({
  mode: 'plain' as const,
  version: 1,
  signingKeyFingerprint: null,
  contentKeyFingerprint: null,
  updatedAt: 1,
}) satisfies AccountEncryptionCurrentnessResponse;

accountCurrentnessMocks.fetchAccountEncryptionCurrentness.mockResolvedValue(
  plainAccountEncryptionCurrentness,
);

const publisherPrecondition = Object.freeze({
  machineId: 'machine-1',
  committedFenceMs: 1,
});

function persistedAdmissionWaiterCorrelation<T extends Readonly<{
  operationId: string;
  attemptId: string;
}>>(input: T): T & Readonly<{ mode: 'persisted' }> {
  return { ...input, mode: 'persisted' };
}

function persistedAdmissionCorrelation<T extends Readonly<{
  sessionId: string;
  operationId: string;
  attemptId: string;
}>>(input: T): T & Readonly<{
  mode: 'persisted';
  publisherPrecondition: typeof publisherPrecondition;
}> {
  return {
    ...input,
    mode: 'persisted',
    publisherPrecondition,
  };
}

function metadataPatchFor(
  linked: PreparedExternalSessionPersistedTakeoverSource['linked'],
): SessionMetadataOwnerPatchV1 {
  const metadataVersion = linked.rawSession.metadataVersion;
  const ownerMetadata = {
    t: 'plain' as const,
    v: { v: 1 as const },
  };
  return {
    mode: 'owner',
    metadataLayoutVersion: 1,
    expectedOwnerMetadata: ownerMetadata,
    sharedMetadata: {
      ciphertext: 'recipient-safe-metadata',
      expectedVersion: metadataVersion,
    },
    ownerMetadata,
    agentState: {
      ciphertext: null,
      expectedVersion: 0,
    },
  };
}

const createExternalSessionPersistedTakeoverAdmissionOwner = (
  input: Parameters<typeof createAdmissionOwner>[0],
) => createAdmissionOwner({
  ...input,
  prepareLinkRetirementPatch: input.prepareLinkRetirementPatch
    ?? (async ({ linked }) => metadataPatchFor(linked)),
});

function admittingRecord(): ExternalSessionOperationRecordV1 {
  const publication = {
    materializationPublicationId: 'publication-1',
    materializedThroughSourceAt: 10,
    publishedThroughServerSeq: 3,
  };
  const request = {
    v: 1 as const,
    idempotencyKey: 'takeover-request-1',
    sessionId: 'session-1',
    source: {
      machineId: 'machine-1',
      remoteSessionId: 'remote-1',
      qualifiedIdentity: {
        v: 1 as const,
        agent: { pluginId: 'com.example.agent', localId: 'example' },
        source: { kind: 'jsonl', contractVersion: 1 as const },
      },
      linkGeneration: 'link-1',
      sourceGeneration: 'source-1',
      contributionGeneration: 'contribution-1',
    },
    plan: 'takeover' as const,
    targetStorageMode: 'persisted' as const,
    targetDirectory: '/local/selected/workspace',
    targetRuntimeMode: 'terminal' as const,
  };
  return {
    v: 1,
    operationId: 'external-takeover:operation-1',
    revision: 9,
    request,
    status: 'running',
    phase: 'admitting',
    timeline: resolveExternalSessionOperationTimelineV1(request),
    createdAtMs: 1,
    updatedAtMs: 2,
    priorStableStorage: { state: 'machine_only' },
    currentStorageState: 'snapshot_complete',
    publication,
    checkpoint: {
      sourcePagesRead: 1,
      stagedItemCount: 1,
      importedItemCount: 1,
      acceptedThroughServerSeq: 3,
      acknowledgedBatchId: 'historical-import-complete',
      requiredItemFailures: {
        total: 0,
        record: 0,
        media: 0,
        conversion: 0,
        diagnosticsTruncated: false,
        diagnostics: [],
      },
    },
    bindings: {
      operationClaimId: 'claim-1',
      targetRuntimeAttemptId: 'attempt-1',
    },
    progressProjection: { acknowledgedRevision: null },
    canonicalOwnerEvidence: {
      linkedSessionRevision: 7,
      sourceSnapshotEvidenceRef: 'source-anchor-1',
    },
    fence: { kind: 'none' },
  };
}

function currentSource(
  overrides: Readonly<Record<string, unknown>> = {},
): PreparedExternalSessionPersistedTakeoverSource {
  const defaultMetadataVersion = overrides.currentStorageState === 'hosted'
    ? 8
    : 7;
  return {
    pluginGeneration: 'contribution-1',
    quiescenceIdentity: 'stopped-source-1',
    linked: {
      rawSession: {
        id: 'session-1',
        metadataVersion: defaultMetadataVersion,
        seq: 3,
        pendingVersion: 4,
        pendingCount: 2,
        pendingBlockedCount: 1,
        currentStorageState: 'snapshot_complete',
        acceptedThroughServerSeq: null,
        active: true,
        thinking: false,
        ...overrides,
      },
      metadata: {},
      sessionPath: '/tmp/external-session',
      agentId: 'claude',
      machineId: 'machine-1',
      remoteSessionId: 'remote-1',
      linkGeneration: 'link-1',
      source: { kind: 'claudeConfig', projectId: 'project-1' },
      codexBackendMode: null,
    } as unknown as PreparedExternalSessionPersistedTakeoverSource['linked'],
  };
}

function resolvedSpawn(): ExternalTakeoverSpawnResolution {
  return {
    ok: true,
    value: {
      options: {
        directory: '/tmp/external-session',
        existingSessionId: 'session-1',
      },
      origin: {
        agentId: 'claude',
        pluginId: 'claude',
        generation: 'contribution-1',
      },
    },
  };
}

describe('strict persisted takeover /session-started admission', () => {
  it('retires canonical and released live-link metadata into import provenance', () => {
    const linked = currentSource().linked;
    const retired = buildPersistedTakeoverRetiredMetadata({
      metadata: {
        path: '/tmp/external-session',
        externalSessionV1: { live: 'canonical' },
        directSessionV1: { live: 'released' },
      },
      linked,
      importedAtMs: 123,
    });

    expect(readNonAuthoritativeLinkedExternalSessionV1FromMetadata(retired)).toBeNull();
    expect(retired).not.toHaveProperty('externalSessionV1');
    expect(retired).not.toHaveProperty('directSessionV1');
    expect(retired.path).toBe('/tmp/external-session');
    expect(readExternalHistoryImportV1FromMetadata(retired)).toEqual({
      v: 1,
      agentId: linked.agentId,
      remoteSessionId: linked.remoteSessionId,
      importedAtMs: 123,
      source: linked.source,
    });
  });

  it('admits token-only plaintext credentials to the canonical metadata writer boundary', async () => {
    const activeServerDir = await mkdtemp(join(tmpdir(), 'happier-admission-plain-'));
    const waiter = createPersistedTakeoverAdmissionWaiter({ timeoutMs: 5_000 });
    const record = admittingRecord();
    waiter.register(persistedAdmissionWaiterCorrelation({
      operationId: record.operationId,
      attemptId: 'attempt-1',
    }));
    const sendHistoricalCommand = vi.fn();
    const owner = createAdmissionOwner({
      activeServerDir,
      admissionWaiter: waiter,
      isFollowSuspended: () => true,
      suspendFollow: async () => undefined,
      loadCurrent: async () => currentSource({
        metadataLayoutVersion: 0,
        metadata: JSON.stringify({
          path: '/tmp/external-session',
          externalSessionV1: {
            v: 1,
            agentId: 'claude',
            machineId: 'machine-1',
            remoteSessionId: 'remote-1',
            linkedAtMs: 1,
            source: { kind: 'claudeConfig', projectId: 'project-1' },
          },
        }),
        ownerMetadata: null,
        agentState: null,
        agentStateVersion: 0,
        encryptionMode: 'plain',
        dataEncryptionKey: null,
      }),
      resolveSpawnOptions: async () => resolvedSpawn(),
      sendHistoricalCommand,
    });
    await writeExternalSessionOperationRecord(activeServerDir, record);

    try {
      await expect(owner.admit(persistedAdmissionCorrelation({
        sessionId: 'session-1',
        operationId: record.operationId,
        attemptId: 'attempt-1',
      }))).rejects.toMatchObject({
        message: 'External Session metadata is not eligible for tuple conversion',
        code: 'metadata_privacy_upgrade_required',
      });
      expect(credentialReaderMocks.readStoredCredentials).toHaveBeenCalled();
      expect(credentialReaderMocks.readCredentials).not.toHaveBeenCalled();
      expect(
        accountCurrentnessMocks.fetchAccountEncryptionCurrentness,
      ).toHaveBeenCalledWith({ token: 'token-only' });
      expect(sendHistoricalCommand).not.toHaveBeenCalled();
    } finally {
      await rm(activeServerDir, { recursive: true, force: true });
    }
  });

  it('abandons runtime_bound completion when the reporting request ends before a delayed durable write', async () => {
    const activeServerDir = await mkdtemp(join(tmpdir(), 'happier-runtime-bound-abandoned-'));
    const waiter = createPersistedTakeoverAdmissionWaiter({ timeoutMs: 5_000 });
    const registration = waiter.register(persistedAdmissionWaiterCorrelation({
      operationId: 'external-takeover:operation-1',
      attemptId: 'attempt-1',
    }));
    let resolveReserved!: () => void;
    const reserved = new Promise<void>((resolve) => {
      resolveReserved = resolve;
    });
    const admissionWaiter = {
      ...waiter,
      reserveRuntimeBound(correlation: Readonly<{
        mode: 'persisted';
        operationId: string;
        attemptId: string;
      }>) {
        const result = waiter.reserveRuntimeBound(correlation);
        if (result.status === 'reserved') resolveReserved();
        return result;
      },
    };
    try {
      const base = admittingRecord();
      const {
        publication: _publication,
        retryTargetPhase: _retryTargetPhase,
        error: _error,
        ...withoutPublication
      } = base;
      const {
        acceptedThroughServerSeq: _acceptedThroughServerSeq,
        acknowledgedBatchId: _acknowledgedBatchId,
        ...checkpoint
      } = base.checkpoint;
      await writeExternalSessionOperationRecord(activeServerDir, {
        ...withoutPublication,
        revision: base.revision + 1,
        status: 'running',
        phase: 'spawning',
        currentStorageState: 'hosted',
        checkpoint,
        updatedAtMs: 19,
      });
      const owner = createExternalSessionPersistedTakeoverAdmissionOwner({
        activeServerDir,
        admissionWaiter,
        isFollowSuspended: () => true,
        suspendFollow: async () => undefined,
        sendHistoricalCommand: vi.fn(),
        nowMs: () => 20,
      });
      const operationKey = createHash('sha256')
        .update(base.operationId, 'utf8')
        .digest('hex');
      const mutationLockPath = join(
        activeServerDir,
        'external-session-operations',
        'by-account',
        `sub-${createHash('sha256').update('vitest', 'utf8').digest('hex').slice(0, 32)}`,
        'records',
        `${operationKey}.mutation.lock`,
      );
      const requestLifetime = new AbortController();
      let runtimeBound:
        | Promise<Readonly<{ status: 'resolved' | 'rejected'; error?: unknown }>>
        | null = null;
      let outcomeBeforeWrite: ReturnType<typeof registration.readOutcome> = null;

      await withJsonOwnerFileLock({
        lockPath: mutationLockPath,
        timeoutMs: 1_000,
        staleAfterMs: 30_000,
        pollIntervalMs: 5,
        errorCode: 'test_runtime_bound_lock_timeout',
      }, async () => {
        runtimeBound = owner.runtimeBound(persistedAdmissionCorrelation({
          sessionId: base.request.sessionId,
          operationId: base.operationId,
          attemptId: 'attempt-1',
          signal: requestLifetime.signal,
        })).then(
          () => ({ status: 'resolved' as const }),
          (error: unknown) => ({ status: 'rejected' as const, error }),
        );
        await reserved;
        requestLifetime.abort(new Error('reporting child abandoned startup'));
        await new Promise((resolve) => setTimeout(resolve, 30));
        outcomeBeforeWrite = registration.readOutcome();
      });

      await expect(runtimeBound).resolves.toMatchObject({ status: 'rejected' });
      expect(outcomeBeforeWrite).toEqual({
        status: 'failed',
        errorCode: 'persisted_takeover_runtime_bound_request_ended',
      });
      await expect(readExternalSessionOperationRecord(
        activeServerDir,
        base.operationId,
      )).resolves.toMatchObject({
        status: 'failed',
        phase: 'spawning',
        currentStorageState: 'hosted',
        retryTargetPhase: 'spawning',
        error: { code: 'spawn_failed', retryable: true },
      });
    } finally {
      await rm(activeServerDir, { recursive: true, force: true });
    }
  });

  it('converges hosted-offline when durable completion fails after waiter reservation', async () => {
    const activeServerDir = await mkdtemp(join(tmpdir(), 'happier-runtime-bound-failure-'));
    const waiter = createPersistedTakeoverAdmissionWaiter({ timeoutMs: 5_000 });
    const registration = waiter.register(persistedAdmissionWaiterCorrelation({
      operationId: 'external-takeover:operation-1',
      attemptId: 'attempt-1',
    }));
    try {
      const base = admittingRecord();
      const {
        publication: _publication,
        retryTargetPhase: _retryTargetPhase,
        error: _error,
        ...withoutPublication
      } = base;
      const {
        acceptedThroughServerSeq: _acceptedThroughServerSeq,
        acknowledgedBatchId: _acknowledgedBatchId,
        ...checkpoint
      } = base.checkpoint;
      await writeExternalSessionOperationRecord(activeServerDir, {
        ...withoutPublication,
        revision: base.revision + 1,
        status: 'running',
        phase: 'spawning',
        currentStorageState: 'hosted',
        checkpoint,
        updatedAtMs: 19,
      });
      let clockReads = 0;
      const suspendFollow = vi.fn(async () => {
        throw new Error('hosted retry must not recreate linked follow authority');
      });
      const owner = createExternalSessionPersistedTakeoverAdmissionOwner({
        activeServerDir,
        admissionWaiter: waiter,
        isFollowSuspended: () => false,
        suspendFollow,
        sendHistoricalCommand: vi.fn(),
        loadCanonicalTarget: async () => currentSource({
          currentStorageState: 'hosted',
          materializationPublicationId: null,
          materializedThroughSourceAt: null,
          publishedThroughServerSeq: null,
        }).linked,
        resolveSpawnOptions: async () => resolvedSpawn(),
        nowMs: () => {
          clockReads += 1;
          if (clockReads === 1) {
            throw new Error('runtime-bound durable write failed');
          }
          return 20;
        },
      });
      const hosted = await readExternalSessionOperationRecord(
        activeServerDir,
        'external-takeover:operation-1',
      );
      await expect(owner.prepareSpawn(hosted!)).resolves.toMatchObject({
        options: { existingSessionId: 'session-1' },
      });
      expect(suspendFollow).not.toHaveBeenCalled();

      await expect(owner.runtimeBound(persistedAdmissionCorrelation({
        sessionId: 'session-1',
        operationId: 'external-takeover:operation-1',
        attemptId: 'attempt-1',
      }))).rejects.toThrow('runtime-bound durable write failed');
      await expect(registration.outcome).resolves.toEqual({
        status: 'failed',
        errorCode: 'runtime-bound durable write failed',
      });
      await expect(readExternalSessionOperationRecord(
        activeServerDir,
        'external-takeover:operation-1',
      )).resolves.toMatchObject({
        status: 'failed',
        phase: 'spawning',
        currentStorageState: 'hosted',
        retryTargetPhase: 'spawning',
        error: { code: 'spawn_failed', retryable: true },
      });
    } finally {
      await rm(activeServerDir, { recursive: true, force: true });
    }
  });

  it('requires already-current source continuity before spawn preparation and admission', async () => {
    const activeServerDir = await mkdtemp(join(tmpdir(), 'happier-admission-continuity-'));
    const waiter = createPersistedTakeoverAdmissionWaiter({ timeoutMs: 5_000 });
    waiter.register(persistedAdmissionWaiterCorrelation({
      operationId: 'external-takeover:operation-1',
      attemptId: 'attempt-1',
    }));
    const record = admittingRecord();
    const loadCurrent = vi.fn(async (
      _record: ExternalSessionOperationRecordV1,
      _requirement?: string,
    ) => currentSource());
    const owner = createExternalSessionPersistedTakeoverAdmissionOwner({
      activeServerDir,
      admissionWaiter: waiter,
      isFollowSuspended: () => true,
      suspendFollow: async () => undefined,
      loadCurrent,
      resolveSpawnOptions: async () => resolvedSpawn(),
      sendHistoricalCommand: async (command) => ({
        v: 1,
        kind: 'takeover_admitted',
        mode: 'persisted',
        claim: command.claim,
        revision: command.expectedRevision,
        attemptId: 'attempt-1',
      }),
    });
    await writeExternalSessionOperationRecord(activeServerDir, record);

    try {
      await owner.prepareSpawn(record);
      await owner.admit(persistedAdmissionCorrelation({
        sessionId: 'session-1',
        operationId: record.operationId,
        attemptId: 'attempt-1',
      }));
      expect(loadCurrent).toHaveBeenNthCalledWith(
        1,
        record,
        'already_current_for_admission',
      );
      expect(loadCurrent).toHaveBeenNthCalledWith(
        2,
        expect.objectContaining({ operationId: record.operationId }),
        'already_current_for_admission',
      );
    } finally {
      await rm(activeServerDir, { recursive: true, force: true });
    }
  });

  it('fails closed at both authority reads when exact source continuity is unavailable', async () => {
    const activeServerDir = await mkdtemp(join(tmpdir(), 'happier-admission-continuity-failure-'));
    const waiter = createPersistedTakeoverAdmissionWaiter({ timeoutMs: 5_000 });
    waiter.register(persistedAdmissionWaiterCorrelation({
      operationId: 'external-takeover:operation-1',
      attemptId: 'attempt-1',
    }));
    const record = admittingRecord();
    const resolveSpawnOptions = vi.fn();
    const sendHistoricalCommand = vi.fn();
    const owner = createExternalSessionPersistedTakeoverAdmissionOwner({
      activeServerDir,
      admissionWaiter: waiter,
      isFollowSuspended: () => true,
      suspendFollow: async () => undefined,
      loadCurrent: async () => {
        throw new Error('source advanced after final catch-up');
      },
      resolveSpawnOptions,
      sendHistoricalCommand,
    });
    await writeExternalSessionOperationRecord(activeServerDir, record);

    try {
      await expect(owner.prepareSpawn(record)).rejects.toThrow(
        'source advanced after final catch-up',
      );
      expect(resolveSpawnOptions).not.toHaveBeenCalled();
      await expect(owner.admit(persistedAdmissionCorrelation({
        sessionId: 'session-1',
        operationId: record.operationId,
        attemptId: 'attempt-1',
      }))).rejects.toThrow('source advanced after final catch-up');
      expect(sendHistoricalCommand).not.toHaveBeenCalled();
      await expect(readExternalSessionOperationRecord(
        activeServerDir,
        record.operationId,
      )).resolves.toEqual(record);
    } finally {
      await rm(activeServerDir, { recursive: true, force: true });
    }
  });

  it('commits admission without completing the waiter, then completes only at exact runtime_bound', async () => {
    const activeServerDir = await mkdtemp(join(tmpdir(), 'happier-admission-route-'));
    const waiter = createPersistedTakeoverAdmissionWaiter({ timeoutMs: 5_000 });
    const registration = waiter.register(persistedAdmissionWaiterCorrelation({
      operationId: 'external-takeover:operation-1',
      attemptId: 'attempt-1',
    }));
    const sent: ExternalSessionOperationSocketCommandV1[] = [];
    const reconcilePassiveFollowSession = vi.fn(async () => ({
      status: 'settled' as const,
    }));
    let durableAtAdmissionSend: ExternalSessionOperationRecordV1 | null = null;
    let durableAtTerminalCleanup: ExternalSessionOperationRecordV1 | null = null;
    const cleanupTerminalStaging = vi.fn(async (operationId: string) => {
      durableAtTerminalCleanup = await readExternalSessionOperationRecord(
        activeServerDir,
        operationId,
      );
      throw new Error('injected terminal cleanup failure');
    });
    const owner = createExternalSessionPersistedTakeoverAdmissionOwner({
      activeServerDir,
      admissionWaiter: waiter,
      isFollowSuspended: () => true,
      suspendFollow: async () => undefined,
      reconcilePassiveFollowSession,
      loadCurrent: async () => currentSource({ metadataVersion: 8 }),
      sendHistoricalCommand: async (command) => {
        durableAtAdmissionSend = await readExternalSessionOperationRecord(
          activeServerDir,
          'external-takeover:operation-1',
        );
        sent.push(command);
        return {
          v: 1,
          kind: 'takeover_admitted',
          mode: 'persisted',
          claim: command.claim,
          revision: command.expectedRevision,
          attemptId: command.kind === 'admit_persisted_takeover'
            ? command.attemptId
            : 'wrong-attempt',
        };
      },
      cleanupTerminalStaging,
      nowMs: () => 20,
    });
    const onHappySessionWebhook = vi.fn();
    await writeExternalSessionOperationRecord(activeServerDir, admittingRecord());
    const app = createDaemonControlApp({
      getChildren: () => [],
      machineId: 'machine-1',
      stopSession: vi.fn(async () => ({ status: 'stopped' as const })),
      spawnSession: vi.fn(async () => ({
        type: 'error' as const,
        errorCode: SPAWN_SESSION_ERROR_CODES.UNEXPECTED,
        errorMessage: 'unused',
      })),
      requestShutdown: vi.fn(),
      onHappySessionWebhook,
      admitPersistedTakeover: async (input) => {
        if (input.phase === 'admit') {
          await owner.admit(input);
          return;
        }
        await owner.runtimeBound(input);
      },
      controlToken: 'control-token',
    });

    try {
      const response = await app.inject({
        method: 'POST',
        url: '/session-started',
        headers: { 'x-happier-daemon-token': 'control-token' },
        payload: {
          sessionId: 'session-1',
          metadata: { startedBy: 'daemon' },
          persistedTakeoverAdmission: {
            mode: 'persisted',
            operationId: 'external-takeover:operation-1',
            attemptId: 'attempt-1',
            phase: 'admit',
            publisherPrecondition,
          },
        },
      });

      expect(response.statusCode).toBe(200);
      expect(registration.readOutcome()).toBeNull();
      expect(durableAtAdmissionSend).toMatchObject({
        revision: 10,
        status: 'running',
        phase: 'admitting',
        canonicalOwnerEvidence: {
          linkedSessionRevision: 8,
          transcriptAuthorityRevision: 3,
          pendingAdmissionRevision: 4,
        },
      });
      expect(sent).toEqual([expect.objectContaining({
        kind: 'admit_persisted_takeover',
        expectedRevision: 10,
        attemptId: 'attempt-1',
        expectedSessionMetadataVersion: 8,
        expectedSessionSeq: 3,
        expectedPending: { version: 4, count: 2, blockedCount: 1 },
        expectedPublication: {
          materializationPublicationId: 'publication-1',
          materializedThroughSourceAt: 10,
          publishedThroughServerSeq: 3,
        },
      })]);
      await expect(readExternalSessionOperationRecord(
        activeServerDir,
        'external-takeover:operation-1',
      )).resolves.toMatchObject({
        revision: 11,
        status: 'running',
        phase: 'spawning',
        currentStorageState: 'hosted',
        bindings: { targetRuntimeAttemptId: 'attempt-1' },
      });
      expect((
        await readExternalSessionOperationRecord(
          activeServerDir,
          'external-takeover:operation-1',
        )
      )?.publication).toBeUndefined();
      expect(onHappySessionWebhook).not.toHaveBeenCalled();
      expect(reconcilePassiveFollowSession).toHaveBeenCalledExactlyOnceWith(
        'session-1',
      );

      const runtimeBoundRequest = () => app.inject({
        method: 'POST',
        url: '/session-started',
        headers: { 'x-happier-daemon-token': 'control-token' },
        payload: {
          sessionId: 'session-1',
          metadata: { startedBy: 'daemon' },
          persistedTakeoverAdmission: {
            mode: 'persisted',
            operationId: 'external-takeover:operation-1',
            attemptId: 'attempt-1',
            phase: 'runtime_bound',
            publisherPrecondition,
          },
        },
      });
      const [runtimeBoundResponse, overlappingDuplicateResponse] =
        await Promise.all([
          runtimeBoundRequest(),
          runtimeBoundRequest(),
        ]);
      expect(runtimeBoundResponse.statusCode).toBe(200);
      expect(overlappingDuplicateResponse.statusCode).toBe(200);
      await expect(registration.outcome).resolves.toEqual({ status: 'committed' });
      expect(cleanupTerminalStaging).toHaveBeenCalledOnce();
      expect(cleanupTerminalStaging).toHaveBeenCalledWith(
        'external-takeover:operation-1',
      );
      expect(durableAtTerminalCleanup).toMatchObject({
        revision: 12,
        status: 'completed',
        phase: 'finalizing',
        terminalResult: { kind: 'completed' },
      });
      await expect(readExternalSessionOperationRecord(
        activeServerDir,
        'external-takeover:operation-1',
      )).resolves.toMatchObject({
        revision: 12,
        status: 'completed',
        phase: 'finalizing',
        currentStorageState: 'hosted',
        terminalResult: { kind: 'completed' },
        bindings: { targetRuntimeAttemptId: 'attempt-1' },
      });

      const duplicateResponse = await runtimeBoundRequest();
      expect(duplicateResponse.statusCode).toBe(200);
      expect(reconcilePassiveFollowSession).toHaveBeenCalledTimes(1);
      expect((
        await readExternalSessionOperationRecord(
          activeServerDir,
          'external-takeover:operation-1',
        )
      )?.revision).toBe(12);
    } finally {
      await app.close();
      await rm(activeServerDir, { recursive: true, force: true });
    }
  });

  it.each([
    ['wrong session', { sessionId: 'session-2' }, currentSource(), true],
    ['wrong attempt', { attemptId: 'attempt-2' }, currentSource(), true],
    [
      'wrong generation',
      {},
      { ...currentSource(), pluginGeneration: 'contribution-2' },
      true,
    ],
    ['follow active', {}, currentSource(), false],
  ])('rejects %s without server or operation effects', async (
    _name,
    correlationOverride,
    loaded,
    followSuspended,
  ) => {
    const activeServerDir = await mkdtemp(join(tmpdir(), 'happier-admission-reject-'));
    const waiter = createPersistedTakeoverAdmissionWaiter({ timeoutMs: 5_000 });
    const input = {
      sessionId: 'session-1',
      operationId: 'external-takeover:operation-1',
      attemptId: 'attempt-1',
      ...correlationOverride,
    };
    const registration = waiter.register(persistedAdmissionWaiterCorrelation({
      operationId: input.operationId,
      attemptId: input.attemptId,
    }));
    const sendHistoricalCommand = vi.fn();
    const initial = admittingRecord();
    await writeExternalSessionOperationRecord(activeServerDir, initial);
    const owner = createExternalSessionPersistedTakeoverAdmissionOwner({
      activeServerDir,
      admissionWaiter: waiter,
      isFollowSuspended: () => followSuspended,
      suspendFollow: async () => undefined,
      loadCurrent: async () => loaded,
      sendHistoricalCommand,
    });

    try {
      await expect(owner.admit(persistedAdmissionCorrelation(input))).rejects.toThrow();
      await expect(registration.outcome).resolves.toMatchObject({ status: 'failed' });
      expect(sendHistoricalCommand).not.toHaveBeenCalled();
      await expect(readExternalSessionOperationRecord(
        activeServerDir,
        initial.operationId,
      )).resolves.toEqual(initial);
    } finally {
      await rm(activeServerDir, { recursive: true, force: true });
    }
  });

  it('keeps a committed server admission hosted and offline when claim loss wins the local race', async () => {
    const activeServerDir = await mkdtemp(join(tmpdir(), 'happier-admission-race-'));
    const waiter = createPersistedTakeoverAdmissionWaiter({ timeoutMs: 5_000 });
    const registration = waiter.register(persistedAdmissionWaiterCorrelation({
      operationId: 'external-takeover:operation-1',
      attemptId: 'attempt-1',
    }));
    let resolveServer!: () => void;
    const serverCommitted = new Promise<void>((resolve) => {
      resolveServer = resolve;
    });
    const initial = admittingRecord();
    const requestLifetime = new AbortController();
    await writeExternalSessionOperationRecord(activeServerDir, initial);
    const owner = createExternalSessionPersistedTakeoverAdmissionOwner({
      activeServerDir,
      admissionWaiter: waiter,
      isFollowSuspended: () => true,
      suspendFollow: async () => undefined,
      loadCurrent: async () => currentSource(),
      sendHistoricalCommand: async (command) => {
        await serverCommitted;
        return {
          v: 1,
          kind: 'takeover_admitted',
          mode: 'persisted',
          claim: command.claim,
          revision: command.expectedRevision,
          attemptId: 'attempt-1',
        };
      },
      nowMs: () => 20,
    });

    try {
      const admission = owner.admit(persistedAdmissionCorrelation({
        sessionId: 'session-1',
        operationId: initial.operationId,
        attemptId: 'attempt-1',
        signal: requestLifetime.signal,
      }));
      await vi.waitFor(() => expect(waiter.isPending(persistedAdmissionWaiterCorrelation({
        operationId: initial.operationId,
        attemptId: 'attempt-1',
      }))).toBe(true));

      requestLifetime.abort(new Error('control request ended'));
      resolveServer();

      await expect(admission).rejects.toThrow();
      await expect(registration.outcome).resolves.toMatchObject({ status: 'failed' });
      await expect(readExternalSessionOperationRecord(
        activeServerDir,
        initial.operationId,
      )).resolves.toMatchObject({
        revision: 11,
        status: 'failed',
        phase: 'spawning',
        retryTargetPhase: 'spawning',
        currentStorageState: 'hosted',
        bindings: { targetRuntimeAttemptId: 'attempt-1' },
        error: { code: 'spawn_failed', retryable: true },
      });
    } finally {
      await rm(activeServerDir, { recursive: true, force: true });
    }
  });

  it('continues the exact attempt when an identical retry validates a lost admission ack', async () => {
    const activeServerDir = await mkdtemp(join(tmpdir(), 'happier-admission-ack-loss-'));
    const waiter = createPersistedTakeoverAdmissionWaiter({ timeoutMs: 5_000 });
    const registration = waiter.register(persistedAdmissionWaiterCorrelation({
      operationId: 'external-takeover:operation-1',
      attemptId: 'attempt-1',
    }));
    const initial = admittingRecord();
    await writeExternalSessionOperationRecord(activeServerDir, initial);
    let calls = 0;
    const sent: ExternalSessionOperationSocketCommandV1[] = [];
    const owner = createExternalSessionPersistedTakeoverAdmissionOwner({
      activeServerDir,
      admissionWaiter: waiter,
      isFollowSuspended: () => true,
      suspendFollow: async () => undefined,
      loadCurrent: async () => currentSource(),
      sendHistoricalCommand: async (command) => {
        calls += 1;
        sent.push(command);
        if (calls === 1) {
          throw new Error('External session historical import command timed out.');
        }
        return {
          v: 1,
          kind: 'takeover_admitted',
          mode: 'persisted',
          claim: command.claim,
          revision: command.expectedRevision,
          attemptId: 'attempt-1',
        };
      },
      nowMs: () => 20,
    });

    try {
      await expect(owner.admit(persistedAdmissionCorrelation({
        sessionId: 'session-1',
        operationId: initial.operationId,
        attemptId: 'attempt-1',
      }))).resolves.toBeUndefined();
      expect(calls).toBe(2);
      expect(sent[1]).toEqual(sent[0]);
      expect(registration.readOutcome()).toBeNull();
      await expect(readExternalSessionOperationRecord(
        activeServerDir,
        initial.operationId,
      )).resolves.toMatchObject({
        revision: 11,
        status: 'running',
        phase: 'spawning',
        currentStorageState: 'hosted',
        bindings: { targetRuntimeAttemptId: 'attempt-1' },
      });

      await expect(owner.runtimeBound(persistedAdmissionCorrelation({
        sessionId: 'session-1',
        operationId: initial.operationId,
        attemptId: 'attempt-1',
      }))).resolves.toBeUndefined();
      await expect(registration.outcome).resolves.toEqual({ status: 'committed' });
      await expect(readExternalSessionOperationRecord(
        activeServerDir,
        initial.operationId,
      )).resolves.toMatchObject({
        revision: 12,
        status: 'completed',
        phase: 'finalizing',
        currentStorageState: 'hosted',
        terminalResult: { kind: 'completed' },
        bindings: { targetRuntimeAttemptId: 'attempt-1' },
      });
    } finally {
      await rm(activeServerDir, { recursive: true, force: true });
    }
  });

  it('reconciles canonical hosted authority after both admission acknowledgements are lost', async () => {
    const activeServerDir = await mkdtemp(join(tmpdir(), 'happier-admission-double-ack-loss-'));
    const waiter = createPersistedTakeoverAdmissionWaiter({ timeoutMs: 5_000 });
    const registration = waiter.register(persistedAdmissionWaiterCorrelation({
      operationId: 'external-takeover:operation-1',
      attemptId: 'attempt-1',
    }));
    const initial = admittingRecord();
    await writeExternalSessionOperationRecord(activeServerDir, initial);
    let authorityReads = 0;
    let targetReads = 0;
    const sendHistoricalCommand = vi.fn(async () => {
      throw new Error('External session historical import command timed out.');
    });
    const owner = createExternalSessionPersistedTakeoverAdmissionOwner({
      activeServerDir,
      admissionWaiter: waiter,
      isFollowSuspended: () => true,
      suspendFollow: async () => undefined,
      loadCurrent: async () => {
        authorityReads += 1;
        return currentSource({ metadataVersion: 8 });
      },
      loadCanonicalTarget: async () => {
        targetReads += 1;
        return currentSource({
          metadataVersion: 9,
          currentStorageState: 'hosted',
          acceptedThroughServerSeq: null,
          materializationPublicationId: null,
          materializedThroughSourceAt: null,
          publishedThroughServerSeq: null,
        }).linked;
      },
      sendHistoricalCommand,
      nowMs: () => 20,
    });

    try {
      await expect(owner.admit(persistedAdmissionCorrelation({
        sessionId: 'session-1',
        operationId: initial.operationId,
        attemptId: 'attempt-1',
      }))).rejects.toThrow('persisted_takeover_admission_ack_ambiguous');
      expect(sendHistoricalCommand).toHaveBeenCalledTimes(2);
      expect(authorityReads).toBe(1);
      expect(targetReads).toBe(1);
      await expect(registration.outcome).resolves.toMatchObject({ status: 'failed' });
      await expect(readExternalSessionOperationRecord(
        activeServerDir,
        initial.operationId,
      )).resolves.toMatchObject({
        status: 'failed',
        phase: 'spawning',
        retryTargetPhase: 'spawning',
        currentStorageState: 'hosted',
        error: { code: 'spawn_failed', retryable: true },
      });
    } finally {
      await rm(activeServerDir, { recursive: true, force: true });
    }
  });

  it('keeps explicit reconciliation recoverable when both acknowledgements and the target reread are unavailable', async () => {
    const activeServerDir = await mkdtemp(join(tmpdir(), 'happier-admission-unresolved-'));
    const waiter = createPersistedTakeoverAdmissionWaiter({ timeoutMs: 5_000 });
    waiter.register(persistedAdmissionWaiterCorrelation({
      operationId: 'external-takeover:operation-1',
      attemptId: 'attempt-1',
    }));
    const initial = admittingRecord();
    let targetState: 'unavailable' | 'hosted' = 'unavailable';
    await writeExternalSessionOperationRecord(activeServerDir, initial);
    let authorityReads = 0;
    const owner = createExternalSessionPersistedTakeoverAdmissionOwner({
      activeServerDir,
      admissionWaiter: waiter,
      isFollowSuspended: () => true,
      suspendFollow: async () => undefined,
      loadCurrent: async () => {
        authorityReads += 1;
        return currentSource({ metadataVersion: 8 });
      },
      loadCanonicalTarget: async () => {
        if (targetState === 'unavailable') {
          throw new Error('canonical authority unavailable');
        }
        return currentSource({
          metadataVersion: 9,
          currentStorageState: 'hosted',
          acceptedThroughServerSeq: null,
          materializationPublicationId: null,
          materializedThroughSourceAt: null,
          publishedThroughServerSeq: null,
        }).linked;
      },
      sendHistoricalCommand: async () => {
        throw new Error('External session historical import command timed out.');
      },
      nowMs: () => 20,
    });

    try {
      await expect(owner.admit(persistedAdmissionCorrelation({
        sessionId: 'session-1',
        operationId: initial.operationId,
        attemptId: 'attempt-1',
      }))).rejects.toThrow('persisted_takeover_admission_authority_unresolved');
      const fenced = await readExternalSessionOperationRecord(
        activeServerDir,
        initial.operationId,
      );
      expect(fenced).toMatchObject({
        revision: 11,
        status: 'failed',
        phase: 'admitting',
        retryTargetPhase: 'admitting',
        currentStorageState: 'snapshot_complete',
        fence: { kind: 'none' },
        error: { code: 'admission_failed', retryable: true },
        canonicalOwnerEvidence: {
          linkedSessionRevision: 8,
          transcriptAuthorityRevision: 3,
          pendingAdmissionRevision: 4,
        },
      });
      expect(fenced && isExternalSessionPersistedTakeoverAdmissionReady(fenced))
        .toBe(true);
      await expect(owner.reconcileAuthority(fenced!)).resolves.toBeNull();
      targetState = 'hosted';
      await expect(owner.reconcileAuthority(fenced!)).resolves.toMatchObject({
        revision: 12,
        status: 'failed',
        phase: 'spawning',
        retryTargetPhase: 'spawning',
        currentStorageState: 'hosted',
        fence: { kind: 'none' },
        error: { code: 'spawn_failed', retryable: true },
      });
    } finally {
      await rm(activeServerDir, { recursive: true, force: true });
    }
  });

  it('reconciles an explicit action back to precommit only from the exact canonical snapshot', async () => {
    const activeServerDir = await mkdtemp(join(tmpdir(), 'happier-admission-precommit-reconcile-'));
    const initial = admittingRecord();
    const {
      acceptedThroughServerSeq: _acceptedThroughServerSeq,
      acknowledgedBatchId: _acknowledgedBatchId,
      ...checkpoint
    } = initial.checkpoint;
    const fenced: ExternalSessionOperationRecordV1 = {
      ...initial,
      revision: 10,
      status: 'failed',
      checkpoint,
      retryTargetPhase: 'admitting',
      fence: { kind: 'none' },
      canonicalOwnerEvidence: {
        ...initial.canonicalOwnerEvidence,
        transcriptAuthorityRevision: 3,
        pendingAdmissionRevision: 4,
      },
      error: {
        code: 'admission_failed',
        message: 'Admission authority is unresolved.',
        retryable: true,
        occurredAtMs: 20,
      },
    };
    await writeExternalSessionOperationRecord(activeServerDir, fenced);
    const owner = createExternalSessionPersistedTakeoverAdmissionOwner({
      activeServerDir,
      admissionWaiter: createPersistedTakeoverAdmissionWaiter(),
      isFollowSuspended: () => true,
      suspendFollow: async () => undefined,
      loadCanonicalTarget: async () => currentSource().linked,
      loadCurrent: async () => currentSource(),
      sendHistoricalCommand: vi.fn(),
      nowMs: () => 30,
    });

    try {
      await expect(owner.reconcileAuthority(fenced)).resolves.toMatchObject({
        revision: 11,
        status: 'awaiting_user_resume',
        phase: 'admitting',
        retryTargetPhase: 'admitting',
        currentStorageState: 'snapshot_complete',
        fence: { kind: 'none' },
      });
      expect((
        await readExternalSessionOperationRecord(activeServerDir, initial.operationId)
      )?.error).toBeUndefined();
    } finally {
      await rm(activeServerDir, { recursive: true, force: true });
    }
  });

  it('reconciles a daemon restart after prepared admission to the exact hosted attempt', async () => {
    const activeServerDir = await mkdtemp(join(
      tmpdir(),
      'happier-admission-restart-hosted-reconcile-',
    ));
    const initial: ExternalSessionOperationRecordV1 = {
      ...admittingRecord(),
      revision: 10,
      canonicalOwnerEvidence: {
        ...admittingRecord().canonicalOwnerEvidence,
        transcriptAuthorityRevision: 3,
        pendingAdmissionRevision: 4,
      },
    };
    await writeExternalSessionOperationRecord(activeServerDir, initial);
    const owner = createExternalSessionPersistedTakeoverAdmissionOwner({
      activeServerDir,
      admissionWaiter: createPersistedTakeoverAdmissionWaiter(),
      isFollowSuspended: () => true,
      suspendFollow: async () => undefined,
      loadCanonicalTarget: async () => currentSource({
        currentStorageState: 'hosted',
        acceptedThroughServerSeq: null,
        materializationPublicationId: null,
        materializedThroughSourceAt: null,
        publishedThroughServerSeq: null,
      }).linked,
      loadCurrent: async () => currentSource(),
      sendHistoricalCommand: vi.fn(),
      nowMs: () => 30,
    });

    try {
      await expect(owner.reconcileAuthority(initial)).resolves.toMatchObject({
        revision: 11,
        status: 'failed',
        phase: 'spawning',
        retryTargetPhase: 'spawning',
        currentStorageState: 'hosted',
        error: { code: 'spawn_failed', retryable: true },
      });
    } finally {
      await rm(activeServerDir, { recursive: true, force: true });
    }
  });
});
