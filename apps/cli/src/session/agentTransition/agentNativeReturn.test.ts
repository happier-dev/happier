import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { beforeEach, describe, expect, it, vi } from 'vitest';

const { resolveCurrentExecutionSurfacesForCatalogAgent } = vi.hoisted(() => ({
  resolveCurrentExecutionSurfacesForCatalogAgent: vi.fn(),
}));

vi.mock('@/agent/runtime/bridges/session/SessionHostBridge', () => ({
  getSessionHostBridge: () => ({
    resolveCurrentExecutionSurfacesForCatalogAgent,
  }),
}));

import type { AgentNativeResumeIdentityV1 } from '@happier-dev/protocol';

import {
  captureDepartingAgentNativeResumeRecord,
  hasMatchingAgentNativeReturnIdentity,
  invalidateFailedAgentNativeReturnIdentity,
  resolveObservableAgentNativeTranscriptPath,
  resolveAgentNativeReturnIdentity,
  type LocalAgentNativeResumeRecordStore,
} from './agentNativeReturn';
import type {
  LocalAgentNativeResumeRecordKey,
  LocalAgentNativeResumeRecordV1,
} from '@/session/handoff/metadata/localSessionHandoffMetadataStore';

/**
 * `REQ-STATE-03` — the machine-local (Session, Agent) record's lifecycle.
 *
 * Two ratified obligations, and they are the whole of this file:
 *
 * 1. the recorded boundary advances ONLY once the provider accepted the context
 *    this activation handed the Agent, so a resume that failed before
 *    acceptance leaves the previously recorded boundary where it was;
 * 2. an identity that was offered for a native return and produced no accepted
 *    context is not recapturable as valid by a later departure.
 *
 * Plus the launch-policy split the same record depends on: a departure captures
 * a STRUCTURALLY valid identity, and whether that identity may be resumed is
 * decided at the RETURN, against the Account settings that hold then.
 *
 * The record store is the mocked boundary (protected files on disk). The
 * acceptance reading, the identity resolution and the eligibility decision are
 * code under test and run for real.
 */

const SESSION_ID = 'session-1';
const DEPARTURE_HEAD = 130;

const CLAUDE_IDENTITY: AgentNativeResumeIdentityV1 = { v: 1, vendorResumeId: 'claude-1' };

beforeEach(() => {
  resolveCurrentExecutionSurfacesForCatalogAgent.mockReset();
  resolveCurrentExecutionSurfacesForCatalogAgent.mockResolvedValue(null);
});

describe('resolveObservableAgentNativeTranscriptPath', () => {
  it('uses the current Agent candidate from canonical identity and descriptor, then rejects a symlink escape', async () => {
    const root = await mkdtemp(join(tmpdir(), 'happier-native-transcript-root-'));
    const outsideRoot = await mkdtemp(join(tmpdir(), 'happier-native-transcript-outside-'));
    try {
      const containedPath = join(root, 'sessions', 'rollout.jsonl');
      const escapedPath = join(outsideRoot, 'escaped.jsonl');
      const escapedLink = join(root, 'sessions', 'escaped.jsonl');
      await mkdir(join(root, 'sessions'), { recursive: true });
      await writeFile(containedPath, '{}\n');
      await writeFile(escapedPath, '{}\n');
      await symlink(escapedPath, escapedLink);
      const resolveNativeTranscriptPathCandidate = vi.fn(async () => ({
        path: containedPath,
        containmentRoot: root,
      }));
      resolveCurrentExecutionSurfacesForCatalogAgent.mockResolvedValueOnce({
        agentId: 'codex',
        backendId: 'codex.runtime',
        executionSurfaces: { handoff: { resolveNativeTranscriptPathCandidate } },
      });

      await expect(resolveObservableAgentNativeTranscriptPath({
        agentId: 'codex',
        metadata: {
          codexSessionId: 'thread-1',
          runtimeDescriptorV1: {
            v: 1,
            agentId: 'codex',
            agent: { homePath: root },
          },
        },
      })).resolves.toBe(containedPath);
      expect(resolveCurrentExecutionSurfacesForCatalogAgent).toHaveBeenCalledWith('codex');
      expect(resolveNativeTranscriptPathCandidate).toHaveBeenCalledWith({
        identity: { v: 1, vendorResumeId: 'thread-1' },
        runtimeDescriptorV1: {
          v: 1,
          agentId: 'codex',
          agent: { homePath: root },
        },
      });

      resolveCurrentExecutionSurfacesForCatalogAgent.mockResolvedValueOnce({
        agentId: 'codex',
        backendId: 'codex.runtime',
        executionSurfaces: {
          handoff: {
            resolveNativeTranscriptPathCandidate: async () => ({
              path: escapedLink,
              containmentRoot: root,
            }),
          },
        },
      });
      await expect(resolveObservableAgentNativeTranscriptPath({
        agentId: 'codex',
        metadata: {
          codexSessionId: 'thread-1',
          runtimeDescriptorV1: {
            v: 1,
            agentId: 'codex',
            agent: { homePath: root },
          },
        },
      })).resolves.toBeNull();
    } finally {
      await rm(root, { recursive: true, force: true });
      await rm(outsideRoot, { recursive: true, force: true });
    }
  });
});

/** A departing Claude whose own conversation id is committed in the current view. */
function claudeMetadata(overrides?: Record<string, unknown>): Record<string, unknown> {
  return {
    flavor: 'claude',
    machineId: 'machine-1',
    path: '/home/u/project',
    claudeSessionId: 'claude-1',
    ...overrides,
  };
}

/** The activation brief as the cutover seals it: handed, not yet accepted. */
const PENDING_ACTIVATION_SEED = Object.freeze({
  v: 1 as const,
  seedText: '<session_context>\nAgent: codex\n</session_context>',
  sourceSessionId: SESSION_ID,
  sourceCutoffSeqInclusive: 30,
  createdAtMs: 1_000,
});

/** The same brief after the provider took custody of the prompt it prefixed. */
const ACCEPTED_ACTIVATION_SEED = Object.freeze({
  ...PENDING_ACTIVATION_SEED,
  seedText: '',
  appliedToLocalId: 'local-1',
  appliedAtMs: 2_000,
});

type RecordWrite = LocalAgentNativeResumeRecordKey & Readonly<{
  identity: AgentNativeResumeIdentityV1 | null;
  departureSeqInclusive: number;
}>;

function createRecordStoreDouble(seeded?: LocalAgentNativeResumeRecordV1 | null): Readonly<{
  store: LocalAgentNativeResumeRecordStore;
  writes: readonly RecordWrite[];
}> {
  const writes: RecordWrite[] = [];
  return {
    writes,
    store: {
      readAgentNativeResumeRecord: async () => seeded ?? null,
      writeAgentNativeResumeRecord: async (input) => {
        writes.push(input as RecordWrite);
      },
    },
  };
}

async function captureClaudeDeparture(params: Readonly<{
  metadata: Record<string, unknown>;
  seeded?: LocalAgentNativeResumeRecordV1 | null;
}>): Promise<readonly RecordWrite[]> {
  const { store, writes } = createRecordStoreDouble(params.seeded);
  await captureDepartingAgentNativeResumeRecord({
    store,
    sessionId: SESSION_ID,
    sourceAgentId: 'claude',
    sourceMetadata: params.metadata,
    departureSeqInclusive: DEPARTURE_HEAD,
  });
  return writes;
}

describe('captureDepartingAgentNativeResumeRecord — accepted-context boundary (REQ-STATE-03)', () => {
  it('advances the recorded boundary once the handed context was accepted', async () => {
    // The Agent took custody of the brief, so its own conversation covers this
    // Session up to the departure head. This is the only shape that may move
    // the boundary forward.
    const writes = await captureClaudeDeparture({
      metadata: claudeMetadata({ replaySeedV1: ACCEPTED_ACTIVATION_SEED }),
      seeded: { identity: CLAUDE_IDENTITY, departureSeqInclusive: 30 },
    });

    expect(writes).toEqual([{
      happierSessionId: SESSION_ID,
      agentId: 'claude',
      identity: CLAUDE_IDENTITY,
      departureSeqInclusive: DEPARTURE_HEAD,
    }]);
  });

  it('advances when this activation handed the Agent no context at all', async () => {
    // Nothing was handed, so nothing is unaccepted: an Agent that has simply
    // been running is bounded by the head it reached. Without this the very
    // first departure of a Session could never record a boundary.
    const writes = await captureClaudeDeparture({ metadata: claudeMetadata() });

    expect(writes).toEqual([{
      happierSessionId: SESSION_ID,
      agentId: 'claude',
      identity: CLAUDE_IDENTITY,
      departureSeqInclusive: DEPARTURE_HEAD,
    }]);
  });

  it('leaves an earlier boundary untouched when the handed context was never accepted', async () => {
    // The Agent was handed the brief and never took custody of it, so it
    // reached no new boundary. Advancing here would hand a LATER return a delta
    // measured against history this Agent never received — the skipped-history
    // failure the whole bound exists to avoid.
    const earlier: LocalAgentNativeResumeRecordV1 = {
      identity: { v: 1, vendorResumeId: 'claude-earlier' },
      departureSeqInclusive: 30,
    };
    const writes = await captureClaudeDeparture({
      metadata: claudeMetadata({ replaySeedV1: PENDING_ACTIVATION_SEED }),
      seeded: earlier,
    });

    expect(writes).toEqual([]);
  });

  it('records nothing when an Agent that was handed context never accepted any', async () => {
    // A target activated by this feature and never reached holds nothing, so a
    // later return to it must be fresh plus the FULL replay.
    const writes = await captureClaudeDeparture({
      metadata: claudeMetadata({ replaySeedV1: PENDING_ACTIVATION_SEED }),
    });

    expect(writes).toEqual([]);
  });

  it('does not make a pending replay seed into a second native-resume decision', async () => {
    // Strict native failures are invalidated by the strict-resume owner before
    // capture runs. A replay seed only says that context was handed, not that a
    // requested native identity resumed, so this capture path must leave the
    // existing boundary alone rather than deciding either outcome itself.
    const writes = await captureClaudeDeparture({
      metadata: claudeMetadata({ replaySeedV1: PENDING_ACTIVATION_SEED }),
      seeded: { identity: CLAUDE_IDENTITY, departureSeqInclusive: 30 },
    });

    expect(writes).toEqual([]);
  });

  it('removes a stale record when the departing Agent has no native id at all', async () => {
    // Structural absence, not policy: this Session no longer corresponds to any
    // conversation for that Agent, so an older record must not survive it.
    const writes = await captureClaudeDeparture({
      metadata: claudeMetadata({ claudeSessionId: undefined }),
      seeded: { identity: CLAUDE_IDENTITY, departureSeqInclusive: 30 },
    });

    expect(writes[0]?.identity).toBeNull();
  });
});

describe('invalidateFailedAgentNativeReturnIdentity', () => {
  it('removes only the exact locally offered identity before a later departure can recapture it', async () => {
    const { store, writes } = createRecordStoreDouble({
      identity: CLAUDE_IDENTITY,
      departureSeqInclusive: 30,
    });

    await invalidateFailedAgentNativeReturnIdentity({
      store,
      sessionId: SESSION_ID,
      targetAgentId: 'claude',
      vendorResumeId: 'claude-1',
    });

    expect(writes).toEqual([{
      happierSessionId: SESSION_ID,
      agentId: 'claude',
      identity: null,
      departureSeqInclusive: 30,
    }]);
  });

  it('does not remove a record replaced by a newer native identity', async () => {
    const { store, writes } = createRecordStoreDouble({
      identity: { v: 1, vendorResumeId: 'claude-newer' },
      departureSeqInclusive: 40,
    });

    await invalidateFailedAgentNativeReturnIdentity({
      store,
      sessionId: SESSION_ID,
      targetAgentId: 'claude',
      vendorResumeId: 'claude-1',
    });

    expect(writes).toEqual([]);
  });
});

describe('hasMatchingAgentNativeReturnIdentity', () => {
  it('recognizes only the exact local native-return identity that this launch offered', async () => {
    const { store } = createRecordStoreDouble({
      identity: CLAUDE_IDENTITY,
      departureSeqInclusive: 30,
    });

    await expect(hasMatchingAgentNativeReturnIdentity({
      store,
      sessionId: SESSION_ID,
      targetAgentId: 'claude',
      vendorResumeId: 'claude-1',
    })).resolves.toBe(true);
    await expect(hasMatchingAgentNativeReturnIdentity({
      store,
      sessionId: SESSION_ID,
      targetAgentId: 'claude',
      vendorResumeId: 'claude-2',
    })).resolves.toBe(false);
  });
});

describe('native-return record — launch policy is a RETURN decision', () => {
  const disabledClaude = { backendEnabledByTargetKey: { 'agent:claude': false } };

  it('refuses the recorded identity while disabled and restores it once re-enabled', async () => {
    const { store } = createRecordStoreDouble({
      identity: CLAUDE_IDENTITY,
      departureSeqInclusive: 30,
    });
    const resolveWith = async (accountSettings: Record<string, unknown> | null) =>
      await resolveAgentNativeReturnIdentity({
        store,
        sessionId: SESSION_ID,
        targetAgentId: 'claude',
        sourceMetadata: { flavor: 'codex', codexSessionId: 'codex-1' },
        accountSettings,
      });

    expect(await resolveWith(disabledClaude)).toBeNull();
    expect(await resolveWith({})).toEqual({
      identity: CLAUDE_IDENTITY,
      departureSeqInclusive: 30,
    });
  });
});
