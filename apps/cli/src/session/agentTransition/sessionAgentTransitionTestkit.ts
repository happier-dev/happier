import { vi } from 'vitest';

import { FeaturesResponseSchema, type SessionAgentTransitionRequestV1 } from '@happier-dev/protocol';

import { resolveCliFeatureDecision } from '@/features/featureDecisionService';
import type { StoredCredentials } from '@/persistence';

import type { SessionAgentTransitionDeps } from './sessionAgentTransitionCoordinator';

/**
 * Boundary doubles for the transition coordinator's tests.
 *
 * Only genuine system boundaries are replaced — HTTP transports, the process
 * stop service, session RPC, and the Agent catalog snapshot. The projector, the
 * cutover payload sealing, and the result mapping are the code under test and
 * are never mocked.
 */

/**
 * The admission feature decision every transition test starts from.
 *
 * It is produced by the SHIPPED resolver against a real parsed server snapshot,
 * not a hand-written `{ state: 'enabled' }` literal: a literal would keep
 * passing if the decision shape or the enablement rule changed, which is the
 * only thing this default is here to keep honest. A suite that needs a refusal
 * overrides `resolveCliFeatureDecisionForServer` with its own decision.
 */
export function buildEnabledAgentSwitchingFeatureDecision(): Awaited<
  ReturnType<SessionAgentTransitionDeps['resolveCliFeatureDecisionForServer']>
> {
  const serverSnapshot = {
    status: 'ready' as const,
    features: FeaturesResponseSchema.parse({
      features: { sessions: { enabled: true, agentSwitching: { enabled: true } } },
      capabilities: {},
    }),
  };
  return {
    decision: resolveCliFeatureDecision({
      featureId: 'sessions.agentSwitching',
      env: {} as NodeJS.ProcessEnv,
      serverSnapshot,
    }),
    serverSnapshot,
  };
}

/**
 * The harness Session's transcript head. The divider's `sourceCutoffSeqInclusive`
 * is derived from it, so exact-divider fixtures must reference THIS constant
 * rather than restating a number that silently stops matching.
 */
export const TEST_SESSION_SEQ = 42;

export const TEST_SESSION_ID = 'session-1';
export const TEST_LOCAL_ID = 'local-1';

export const TEST_CREDENTIALS = {
  token: 'token-1',
} as unknown as StoredCredentials;

export function buildTransitionRequest(
  overrides?: Partial<SessionAgentTransitionRequestV1>,
): SessionAgentTransitionRequestV1 {
  return {
    v: 1,
    sessionId: TEST_SESSION_ID,
    expectedCurrentAgentId: 'claude',
    selection: { v: 1, agentId: 'codex' },
    input: { text: 'continue please', localId: TEST_LOCAL_ID, meta: {} },
    ...overrides,
  } as SessionAgentTransitionRequestV1;
}

export const CLAUDE_SOURCE_METADATA: Record<string, unknown> = Object.freeze({
  flavor: 'claude',
  machineId: 'machine-1',
  path: '/home/u/project',
  claudeSessionId: 'claude-1',
  sessionWorkStateV1: { v: 1 },
  slashCommands: ['/compact'],
});

/**
 * A plain-mode layout-0 row. `metadata` carries the real stored payload so the
 * cutover sealing path — which is code under test, not a boundary — decrypts,
 * projects, and re-encodes for real.
 */
export function buildRawSession(overrides?: Record<string, unknown>): Record<string, unknown> {
  return {
    id: TEST_SESSION_ID,
    machineId: 'machine-1',
    seq: TEST_SESSION_SEQ,
    active: false,
    archivedAt: null,
    metadata: JSON.stringify(CLAUDE_SOURCE_METADATA),
    metadataVersion: 3,
    metadataLayoutVersion: 0,
    ownerMetadata: null,
    agentState: null,
    agentStateVersion: 1,
    encryptionMode: 'plain',
    ...overrides,
  };
}

/**
 * A catalog contribution shaped the way the resolved registry really shapes
 * one. The Sessions capability lives on the rich V2 definition, so an Agent
 * whose primary surface is execution runs genuinely declares none — that is the
 * bundled `deepsec`/`coderabbit` shape, not a contrived one.
 */
export function buildAgentCatalogContribution(params: Readonly<{
  id: string;
  primary?: 'sessions' | 'executionRuns';
}>): Record<string, unknown> {
  const primary = params.primary ?? 'sessions';
  return {
    id: params.id,
    identity: { pluginId: params.id, localId: params.id },
    richDefinition: {
      provenance: 'first_party',
      definition: {
        id: params.id,
        runtime: { kind: 'custom' },
        primary,
        capabilities: primary === 'sessions'
          ? { sessions: { open: ['create', 'resume'], checkpoint: false, stop: true } }
          : { executionRuns: { open: ['create'], checkpoint: false, stop: true } },
      },
    },
  };
}

type MutableDeps = { -readonly [K in keyof SessionAgentTransitionDeps]: SessionAgentTransitionDeps[K] };

export type TransitionDepsHarness = Readonly<{
  deps: MutableDeps;
  calls: string[];
  /** Replaces the metadata every decrypt returns from the next call onward. */
  setMetadata: (metadata: Record<string, unknown>) => void;
}>;

export function createTransitionDepsHarness(
  overrides?: Partial<SessionAgentTransitionDeps>,
): TransitionDepsHarness {
  const calls: string[] = [];
  let metadata: Record<string, unknown> = { ...CLAUDE_SOURCE_METADATA };

  const deps: MutableDeps = {
    resolveSessionTransportContext: vi.fn(async () => {
      calls.push('resolveTransport');
      return {
        ok: true as const,
        sessionId: TEST_SESSION_ID,
        rawSession: buildRawSession(),
        accountEncryptionCurrentness: { mode: 'plain' },
        ctx: null,
        mode: 'plain' as const,
      };
    }) as unknown as SessionAgentTransitionDeps['resolveSessionTransportContext'],
    decryptOwnerMetadataView: vi.fn(() => metadata) as unknown as SessionAgentTransitionDeps['decryptOwnerMetadataView'],
    readAgentCatalogSnapshot: vi.fn(() => ({
      agentDefinitionsById: new Map([
        ['codex', buildAgentCatalogContribution({ id: 'codex' })],
        ['claude', buildAgentCatalogContribution({ id: 'claude' })],
      ]),
      catalogEntriesById: {},
    })) as unknown as SessionAgentTransitionDeps['readAgentCatalogSnapshot'],
    resolveCurrentProviderSpawnDefinitiveRejection: vi.fn(async (input: {
      agentTargetKey: string;
      selection: { modelId?: unknown; providerConnectionId?: unknown };
    }) => {
      const modelId = typeof input.selection.modelId === 'string' ? input.selection.modelId : null;
      if (modelId === null) return { ok: true as const, ref: null };
      return {
        ok: true as const,
        ref: {
          agentTargetKey: input.agentTargetKey,
          providerConnectionId: typeof input.selection.providerConnectionId === 'string'
            ? input.selection.providerConnectionId
            : null,
          modelId,
        },
      };
    }) as unknown as SessionAgentTransitionDeps['resolveCurrentProviderSpawnDefinitiveRejection'],
    waitForSessionIdle: vi.fn(async () => {
      calls.push('waitForIdle');
      return { ok: true as const, sessionId: TEST_SESSION_ID, idle: true as const, observedAt: 1 };
    }),
    callSessionProviderInputAdmission: vi.fn(async (input: { action: string }) => {
      calls.push(`admission:${input.action}`);
      return { status: input.action === 'enforce' ? ('enforced' as const) : ('cleared' as const) };
    }) as unknown as SessionAgentTransitionDeps['callSessionProviderInputAdmission'],
    requestSessionStop: vi.fn(async () => {
      calls.push('stop');
      return { ok: true as const, sessionId: TEST_SESSION_ID, stopped: true as const };
    }) as unknown as SessionAgentTransitionDeps['requestSessionStop'],
    applySessionAgentTransitionCutover: vi.fn(async () => {
      calls.push('cutover');
      return { ok: true as const, dividerSeq: 77 };
    }),
    requestInactiveSessionResume: vi.fn(async () => {
      calls.push('resume');
      return { ok: true as const };
    }),
    sendSessionMessage: vi.fn(async (input: { localId?: string; resumeInactiveSession?: boolean }) => {
      calls.push('send');
      // The real owner is enqueue-THEN-RESUME: after a successful enqueue it
      // calls `requestInactiveSessionResume` itself for an inactive Session
      // unless the caller opts out with `resumeInactiveSession: false`
      // (services/sendSessionMessage.ts). A double that never resumes would
      // model a custody-only owner that does not exist, and would hide a caller
      // that leaves target activation to two owners at once.
      if (input.resumeInactiveSession !== false) calls.push('send:resume');
      return {
        ok: true as const,
        sessionId: TEST_SESSION_ID,
        localId: input.localId ?? TEST_LOCAL_ID,
        waited: false,
        admissionResult: { status: 'accepted' as const, localId: input.localId ?? TEST_LOCAL_ID },
      };
    }) as unknown as SessionAgentTransitionDeps['sendSessionMessage'],
    findTranscriptMessageByLocalId: vi.fn(async () => {
      calls.push('dividerLookup');
      return { type: 'not_found' as const };
    }),
    resolveServerHttpBaseUrl: vi.fn(() => 'http://server.test'),
    resolveCliFeatureDecisionForServer: vi.fn(async () => buildEnabledAgentSwitchingFeatureDecision()),
    buildActivationBrief: vi.fn(() => ({ status: 'available' as const, seed: null })),
    // Protected files on this machine are a genuine boundary, and the shipped
    // default would otherwise write into the real active-server directory from
    // every unit test. A Session with no recorded departure is the ordinary
    // first-switch case, so an empty store is the right default.
    localAgentNativeResumeRecordStore: {
      readAgentNativeResumeRecord: vi.fn(async () => null),
      writeAgentNativeResumeRecord: vi.fn(async () => {}),
    },
    // The daemon's live Account snapshot is a process-global the shipped default
    // reads; an empty Account is the neutral unit-test starting point, and a
    // launch-mode case supplies its own settings.
    readAccountSettings: () => ({}),
    // The shipped resolver bootstraps Account settings over HTTP — a genuine
    // boundary. `null` is the ordinary Account with no configured connected
    // account for the target, which leaves the target on native CLI auth.
    resolveSpawnConnectedServicesDefaults: vi.fn(async () => null),
    nowMs: () => 1_000,
    ...overrides,
  };

  return {
    deps,
    calls,
    setMetadata: (next) => {
      metadata = next;
    },
  };
}
