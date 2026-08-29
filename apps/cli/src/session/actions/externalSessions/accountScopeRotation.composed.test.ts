import { createHash } from 'node:crypto';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import {
  type ExternalSessionOperationRecordV1,
} from '@happier-dev/protocol';

import { createExternalSessionOperationExclusion } from '@/session/external/operationExclusion';
import {
  createExternalSessionOperationPrivateStagingStore,
} from '@/session/external/staging/operationPrivateStaging';

import {
  createExternalSessionMaterializeActionExecutor,
} from './materializeAction';
import {
  createDefaultExternalSessionMaterializeStartActionExecutor,
} from './materializeStartAction';
import {
  abandonExternalSessionOperationsForDeletedSession,
  resolveExternalSessionOperationAccountScope,
  readExternalSessionOperationStoredEntry,
} from './operationRecordStore';
import {
  createExternalSessionSourceGenerationAnchor,
} from './sourceGenerationAnchor';

const accountCredentials = vi.hoisted(() => ({
  current: null as Readonly<{ token: string; encryption: null }> | null,
}));

vi.mock('@/persistence', () => ({
  readStoredCredentials: async () => accountCredentials.current,
}));

const defaultDependencies = vi.hoisted(() => ({
  loadLinkedExternalSession: vi.fn(),
  resolveCurrentAgent: vi.fn(),
  resolveGenerationBoundSurface: vi.fn(),
}));

vi.mock('@/api/session/external/takeover/loadLinkedExternalSession', () => ({
  loadLinkedExternalSession: defaultDependencies.loadLinkedExternalSession,
}));
vi.mock('@/api/session/external/linking/qualifiedLinkIdentityRegistry', () => ({
  resolveCurrentExternalSessionAgentIdentity:
    defaultDependencies.resolveCurrentAgent,
}));
vi.mock('./providerOpsResolution', () => ({
  resolveGenerationBoundExternalSessionFollowSurface:
    defaultDependencies.resolveGenerationBoundSurface,
}));

const encodeJwtPart = (value: unknown): string =>
  Buffer.from(JSON.stringify(value), 'utf8').toString('base64url');

function accountToken(subject: string, marker: string): string {
  return `${encodeJwtPart({ alg: 'none', marker })}.${encodeJwtPart({ sub: subject, marker })}.`;
}

function useAccount(subject: string, marker: string): void {
  accountCredentials.current = {
    token: accountToken(subject, marker),
    encryption: null,
  };
}

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function accountPartitionDirectory(
  activeServerDir: string,
  subject: string,
): string {
  return join(
    activeServerDir,
    'external-session-operations',
    'by-account',
    `sub-${sha256(subject).slice(0, 32)}`,
  );
}

const intent = {
  v: 1,
  idempotencyKey: 'materialize-rotation-1',
  sessionId: 'session-rotation-a',
  plan: 'materialize',
  targetStorageMode: 'external-linked',
  targetRuntimeMode: null,
} as const;

const sourceGeneration = 'source-generation-rotation-1';

const qualifiedIdentity = {
  v: 1,
  agent: { pluginId: 'com.example.agent', localId: 'example' },
  source: { kind: 'jsonl', contractVersion: 1 },
} as const;

// The qualified identity the default Start owner derives from the linked
// session metadata (the persisted metadata narrows the source kind).
const linkedQualifiedIdentity = {
  ...qualifiedIdentity,
  source: { kind: 'claudeConfig', contractVersion: 1 },
} as const;

// Reproduces the exact source-generation anchor the default Start owner
// stamps into the admitted semantic request from its first-page capture.
const derivedSourceGeneration = createExternalSessionSourceGenerationAnchor(
  JSON.stringify({ qualifiedIdentity: linkedQualifiedIdentity, tailCursor: 'tail-1' }),
);

const emptyRequiredItemFailures = {
  total: 0,
  record: 0,
  media: 0,
  conversion: 0,
  diagnosticsTruncated: false,
  diagnostics: [],
};

/**
 * Wires the default linked-source resolution mocks so the default Start
 * executor can derive the private semantic request without network effects.
 */
function configureDefaultLinkedSource(): void {
  const pageTranscript = vi.fn().mockResolvedValue({ tailCursor: 'tail-1' });
  defaultDependencies.loadLinkedExternalSession.mockResolvedValue({
    ok: true,
    session: {
      metadata: {
        externalSessionV1: {
          v: 1,
          agentId: 'example',
          machineId: 'machine-1',
          remoteSessionId: 'remote-rotation-1',
          source: { kind: 'claudeConfig', configDir: '/tmp/claude' },
          linkedAtMs: 1,
          qualifiedIdentity: {
            ...qualifiedIdentity,
            source: { kind: 'claudeConfig', contractVersion: 1 },
          },
        },
      },
      agentId: 'example',
      machineId: 'machine-1',
      remoteSessionId: 'remote-rotation-1',
      linkGeneration: 'link-current',
      source: { kind: 'claudeConfig', configDir: '/tmp/claude' },
      rawSession: { metadataVersion: 7 },
    },
  });
  defaultDependencies.resolveCurrentAgent.mockResolvedValue({
    identity: qualifiedIdentity.agent,
    sourceKinds: ['claudeConfig'],
  });
  defaultDependencies.resolveGenerationBoundSurface.mockResolvedValue({
    providerOps: { pageTranscript },
    resource: {
      pluginGeneration: 'plugin-current',
      retirementSignal: new AbortController().signal,
    },
  });
}

describe('external-session operation account-scope propagation', () => {
  it('keeps an A-admitted materialization in A\u2019s partition after an A\u2192B rotation: late record effects fail closed and deletion cleanup discharges A\u2019s private state without creating a B row', async () => {
    const activeServerDir = await mkdtemp(join(
      tmpdir(),
      'happier-account-scope-rotation-',
    ));
    try {
      // Account A is authenticated at admission time.
      useAccount('account-rotation-a', 'a');
      const pinnedScope = resolveExternalSessionOperationAccountScope(
        activeServerDir,
        accountCredentials.current!.token,
      );
      if (!pinnedScope) throw new Error('expected pinned account scope');
      configureDefaultLinkedSource();

      const exclusion = createExternalSessionOperationExclusion({
        activeServerDir,
        ownerId: 'account-scope-rotation-owner',
      });
      const staging = createExternalSessionOperationPrivateStagingStore({
        activeServerDir,
        limits: {
          perOperation: { maxItems: 20, maxBytes: 50_000 },
          aggregate: { maxItems: 40, maxBytes: 100_000 },
        },
      });
      // The source walk blocks until the test rotates the ambient Account, so
      // the operation's interruption-time record write happens after the
      // A\u2192B rotation while its admission pin still names Account A.
      let releaseInterruptedPages!: () => void;
      const pagesInterrupted = new Promise<void>((resolve) => {
        releaseInterruptedPages = resolve;
      });
      const capturedSource = {
        sourceIdentity: JSON.stringify(linkedQualifiedIdentity),
        sourceGeneration: derivedSourceGeneration,
        revision: 'revision-rotation-1',
        boundary: 'boundary-rotation-1',
      };
      const materializeExecutor = createExternalSessionMaterializeActionExecutor({
        activeServerDir,
        operationExclusion: exclusion,
        staging,
        describeSource: async () => ({
          capturedSource,
          linkedSessionRevision: 7,
        }),
        revalidateSource: async () => undefined,
        readNewestFirstPages: async function* () {
          yield {
            groupId: 'page-0',
            items: [],
            requiredItemFailures: emptyRequiredItemFailures,
            sourceRead: {
              availability: 'reachable' as const,
              sourceIdentity: capturedSource.sourceIdentity,
              sourceGeneration,
              revision: capturedSource.revision,
              relationshipToCapture: 'same' as const,
              eof: false,
            },
          };
          await pagesInterrupted;
          throw new Error('interrupted-rotation-sentinel');
        },
        readFinalCatchUpPages: async function* () {},
        sendHistoricalCommand: async (command) => {
          if (command.kind !== 'inspect') {
            throw new Error(`unexpected historical command ${command.kind}`);
          }
          return {
            v: 1,
            kind: 'authority',
            claim: command.claim,
            revision: command.expectedRevision,
            priorStableStorage: { state: 'machine_only' },
          };
        },
      });

      // A admission through the default Start owner: it captures the exact
      // authenticated Account scope at the admission boundary and carries it
      // into the materialize executor's record and staging effects.
      const startExecutor =
        createDefaultExternalSessionMaterializeStartActionExecutor({
          activeServerDir,
          machineId: 'machine-1',
          materialize: materializeExecutor,
        });
      const startResponse = await startExecutor.start({ request: intent });
      expect(startResponse.ok).toBe(true);
      if (!startResponse.ok) throw new Error('expected admitted operation');
      const operationId = startResponse.progress.operationId;
      expect(operationId.startsWith('external-materialize:')).toBe(true);
      expect(startResponse.progress.revision).toBe(0);

      // The A-admitted record is durable in A's partition.
      const accountAPartition = accountPartitionDirectory(
        activeServerDir,
        'account-rotation-a',
      );
      const admittedStored = await readExternalSessionOperationStoredEntry(
        join(accountAPartition, 'records'),
        operationId,
      );
      expect(admittedStored?.kind).toBe('full_record');
      expect(
        admittedStored?.kind === 'full_record' && admittedStored.record,
      ).toMatchObject({ revision: 0 });

      // Credentials rotate from Account A to Account B mid-operation.
      useAccount('account-rotation-b', 'b');
      releaseInterruptedPages();

      // The in-flight drive settles: its pinned interruption write must fail
      // closed against the rotated ambient Account, never land in B's
      // partition. The exclusion claim's release proves the drive settled.
      await vi.waitFor(
        async () => {
          const probe = await exclusion.acquire({
            kind: 'materialize',
            sessionId: intent.sessionId,
            requestId: intent.idempotencyKey,
            sourceIdentity: capturedSource.sourceIdentity,
            sourceGeneration: derivedSourceGeneration,
          });
          if (probe.status === 'acquired') await probe.claim.release();
          expect(probe.status).toBe('acquired');
        },
        { timeout: 10_000, interval: 20 },
      );
      const interruptedStored = await readExternalSessionOperationStoredEntry(
        join(accountAPartition, 'records'),
        operationId,
      );
      expect(interruptedStored?.kind).toBe('full_record');
      expect(
        interruptedStored?.kind === 'full_record' && interruptedStored.record,
      ).toMatchObject({ revision: 0 });

      // No B partition state exists at all: the late pinned record effect
      // created no B row, and the staged capture stayed in A's partition.
      const accountBPartition = accountPartitionDirectory(
        activeServerDir,
        'account-rotation-b',
      );
      await expect(stat(accountBPartition))
        .rejects.toMatchObject({ code: 'ENOENT' });

      // Authoritative Session deletion for the owning Account: the retirement
      // path consumes the deletion fact with the pinned scope, and the
      // executor's abandoned-operation cleanup discharges A's private staging
      // under that pin instead of resolving the ambient (now B) Account.
      const cleanupDispositions: string[] = [];
      const result = await abandonExternalSessionOperationsForDeletedSession({
        activeServerDir,
        sessionId: intent.sessionId,
        accountScope: pinnedScope,
        withSessionOperationBarrier: async (_input, effect) => ({
          status: 'executed' as const,
          value: await effect(),
        }),
        cleanupPrivateOperation: async (
          record: ExternalSessionOperationRecordV1,
        ) => {
          cleanupDispositions.push(
            await materializeExecutor.cleanupAbandonedOperation!(
              record,
              pinnedScope,
            ),
          );
        },
      });
      expect(result).toEqual({ deleted: 1, deferred: 0, retained: 0 });
      expect(cleanupDispositions).toEqual(['cleaned']);

      // A's private state is fully discharged, and the cleanup never touched
      // B's partition.
      await expect(readExternalSessionOperationStoredEntry(
        join(accountAPartition, 'records'),
        operationId,
      )).resolves.toBeNull();
      await expect(stat(join(
        accountAPartition,
        'staging',
        sha256(operationId),
      ))).rejects.toMatchObject({ code: 'ENOENT' });
      await expect(stat(accountBPartition))
        .rejects.toMatchObject({ code: 'ENOENT' });
    } finally {
      await rm(activeServerDir, { recursive: true, force: true });
    }
  });
});
