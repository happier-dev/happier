import { beforeEach, describe, expect, it, vi } from 'vitest';

import { SessionStopOutcomeSchema, type SessionStopOutcome } from '@happier-dev/protocol';
import type { SessionAgentTransitionRequestV1 } from '@happier-dev/protocol';

/**
 * Coordinator contract tests.
 *
 * What is mocked is exactly the set of process / HTTP / socket / crypto
 * boundaries the coordinator composes: the stop proof, the idle probe, the
 * cutover and session HTTP calls, the Pending enqueue transport, the machine
 * RPC resume, the encryption context, and the Replay context owner. Everything
 * the coordinator itself decides — ordering, stop-outcome classification,
 * result-arm mapping, divider identity, and the projected target view — runs
 * for real, because that is the logic under test.
 */

const mocks = vi.hoisted(() => ({
  resolveSessionTransportContext: vi.fn(),
  waitForSessionIdle: vi.fn(),
  requestSessionStop: vi.fn(),
  requestInactiveSessionResume: vi.fn(),
  fetchSessionByIdCompat: vi.fn(),
  commitSessionAgentTransitionCutover: vi.fn(),
  enqueuePendingQueueV2MessageViaHttp: vi.fn(),
  resolveReplaySeedDraft: vi.fn(),
  resolveTrustedSessionAttachmentLocalImagePaths: vi.fn(),
  findTranscriptEncryptedMessageByLocalIdV2: vi.fn(),
  callOrder: [] as string[],
}));

vi.mock('@/session/services/resolveSessionTransportContext', () => ({
  resolveSessionTransportContext: mocks.resolveSessionTransportContext,
}));
vi.mock('@/session/services/waitForSessionIdle', () => ({
  waitForSessionIdle: mocks.waitForSessionIdle,
}));
vi.mock('@/session/services/requestSessionStop', () => ({
  requestSessionStop: mocks.requestSessionStop,
}));
vi.mock('@/session/services/requestInactiveSessionResume', () => ({
  requestInactiveSessionResume: mocks.requestInactiveSessionResume,
}));
vi.mock('@/session/transport/http/sessionsHttp', () => ({
  fetchSessionByIdCompat: mocks.fetchSessionByIdCompat,
}));
vi.mock('@/session/transport/http/sessionAgentTransitionHttp', () => ({
  commitSessionAgentTransitionCutover: mocks.commitSessionAgentTransitionCutover,
}));
vi.mock('@/api/session/pendingQueueV2Transport', () => ({
  enqueuePendingQueueV2MessageViaHttp: mocks.enqueuePendingQueueV2MessageViaHttp,
}));
vi.mock('@/session/replay/resolveReplaySeedDraft', () => ({
  resolveReplaySeedDraft: mocks.resolveReplaySeedDraft,
}));
vi.mock('@/session/attachments/resolveTrustedSessionAttachmentLocalImagePaths', () => ({
  resolveTrustedSessionAttachmentLocalImagePaths: mocks.resolveTrustedSessionAttachmentLocalImagePaths,
}));
vi.mock('@/api/session/transcriptMessageLookup', () => ({
  findTranscriptEncryptedMessageByLocalIdV2: mocks.findTranscriptEncryptedMessageByLocalIdV2,
}));
vi.mock('@/session/transport/encryption/sessionEncryptionContext', () => ({
  tryDecryptSessionMetadata: (params: { rawSession: { metadata: string } }) =>
    JSON.parse(params.rawSession.metadata) as Record<string, unknown>,
  encryptStoredSessionPayload: (params: { payload: unknown }) => JSON.stringify(params.payload),
  encryptSessionPayload: (params: { payload: unknown }) => JSON.stringify(params.payload),
  decryptStoredSessionPayload: (params: { mode: string; value: unknown }) =>
    params.mode === 'plain' && typeof params.value === 'string'
      ? (JSON.parse(params.value) as unknown)
      : params.value,
}));

const { runSessionAgentTransition } = await import('./sessionAgentTransitionCoordinator');

const SESSION_ID = 'session-1';
const LOCAL_ID = 'local-42';

/** Flattens a `z.literal` / `z.enum` / `z.union` of those into its string members. */
function readReasonLiterals(schema: unknown): readonly string[] {
  const node = schema as Readonly<{ value?: unknown; options?: unknown }>;
  if (typeof node.value === 'string') return [node.value];
  if (!Array.isArray(node.options)) return [];
  return node.options.flatMap((option: unknown) =>
    typeof option === 'string' ? [option] : readReasonLiterals(option));
}

/**
 * Every `{ status, reason }` an unconfirmed stop can carry, read out of
 * `SessionStopOutcomeSchema` instead of listed here. The union is the producing
 * contract, so nothing in this file has to be kept in step with it by hand.
 */
function everyUnconfirmedStopOutcome(): ReadonlyArray<readonly [string, SessionStopOutcome]> {
  const cases = SessionStopOutcomeSchema.options.flatMap((option) => {
    const shape = (option as unknown as Readonly<{
      shape: Readonly<{ status: Readonly<{ value: string }>; reason: unknown }>;
    }>).shape;
    const status = shape.status.value;
    return readReasonLiterals(shape.reason).map((reason) => [
      `${status}/${reason}`,
      SessionStopOutcomeSchema.parse({ status, reason }),
    ] as const);
  });
  // A zod change that broke the introspection above would silently turn the
  // suite into a no-op. Anchor on one reason that WAS allowlisted as proof of
  // "no applied effect" and one that never was.
  const reasons = new Set(cases.map(([, outcome]) => outcome.reason));
  if (!reasons.has('missing_topology_proof') || !reasons.has('runner_exit_timeout')) {
    throw new Error('SessionStopOutcomeSchema introspection produced no usable stop reasons');
  }
  return cases;
}

function sourceMetadata(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    path: '/work/repo',
    host: 'mac',
    machineId: 'machine-1',
    flavor: 'claude',
    claudeSessionId: 'claude-native-1',
    claudeTranscriptPath: '/Users/dev/.claude/x.jsonl',
    permissionMode: 'default',
    tools: ['Bash'],
    ...overrides,
  };
}

function rawSession(metadata: Record<string, unknown>, overrides: Record<string, unknown> = {}) {
  return {
    id: SESSION_ID,
    seq: 100,
    active: false,
    archivedAt: null,
    metadata: JSON.stringify(metadata),
    metadataVersion: 7,
    agentState: null,
    agentStateVersion: 3,
    machineId: 'machine-1',
    path: '/work/repo',
    ...overrides,
  };
}

function request(overrides: Partial<SessionAgentTransitionRequestV1> = {}): SessionAgentTransitionRequestV1 {
  return {
    v: 1,
    sessionId: SESSION_ID,
    expectedCurrentAgentId: 'claude',
    selection: { v: 1, agentId: 'codex' },
    input: { text: 'keep going', localId: LOCAL_ID, meta: {} },
    ...overrides,
  } as SessionAgentTransitionRequestV1;
}

const credentials = { token: 'token-1' } as never;

function primeHappyPath(metadata: Record<string, unknown> = sourceMetadata()): void {
  const raw = rawSession(metadata);
  mocks.resolveSessionTransportContext.mockResolvedValue({
    ok: true,
    sessionId: SESSION_ID,
    rawSession: raw,
    ctx: { encryptionKey: new Uint8Array(), encryptionVariant: 'dataKey' },
    mode: 'plain',
  });
  mocks.waitForSessionIdle.mockResolvedValue({ ok: true, sessionId: SESSION_ID, idle: true, observedAt: 1 });
  mocks.resolveTrustedSessionAttachmentLocalImagePaths.mockResolvedValue(new Set<string>());
  mocks.fetchSessionByIdCompat.mockResolvedValue(raw);
  mocks.requestSessionStop.mockImplementation(async () => {
    mocks.callOrder.push('stop');
    return { ok: true, sessionId: SESSION_ID, stopped: true };
  });
  mocks.resolveReplaySeedDraft.mockResolvedValue({
    status: 'seeded',
    seedDraft: 'bounded brief',
    dialog: [],
    summaryText: null,
    sourceCutoffSeqInclusive: 100,
  });
  mocks.commitSessionAgentTransitionCutover.mockImplementation(async () => {
    mocks.callOrder.push('cutover');
    return {
      status: 'settled',
      response: {
        ok: true,
        dividerSeq: 101,
        dividerDidWrite: true,
        currentView: { kind: 'legacy_v0', metadataVersion: 8, agentStateVersion: 4 },
      },
    };
  });
  mocks.enqueuePendingQueueV2MessageViaHttp.mockImplementation(async () => {
    mocks.callOrder.push('admit');
    return { didWrite: true, terminal: false, suppressed: false };
  });
  mocks.requestInactiveSessionResume.mockImplementation(async () => {
    mocks.callOrder.push('resume');
    return { ok: true };
  });
}

describe('runSessionAgentTransition', () => {
  beforeEach(() => {
    for (const value of Object.values(mocks)) {
      if (typeof value === 'function' && 'mockReset' in value) (value as { mockReset: () => void }).mockReset();
    }
    mocks.callOrder.length = 0;
  });

  describe('pre-effect rejections leave the source running', () => {
    it('rejects a selection naming the current Agent without stopping anything', async () => {
      primeHappyPath();

      const result = await runSessionAgentTransition({
        credentials,
        request: request({ selection: { v: 1, agentId: 'claude' } }),
      });

      expect(result).toEqual({ type: 'rejected', code: 'same_target', sourceEffect: 'none' });
      expect(mocks.requestSessionStop).not.toHaveBeenCalled();
    });

    it('rejects a selection carrying providerConnectionId instead of silently dropping it', async () => {
      primeHappyPath();

      const result = await runSessionAgentTransition({
        credentials,
        request: request({
          selection: { v: 1, agentId: 'codex', modelId: 'gpt-5.6', providerConnectionId: 'conn-1' },
        }),
      });

      expect(result).toEqual({ type: 'rejected', code: 'target_unavailable', sourceEffect: 'none' });
      expect(mocks.requestSessionStop).not.toHaveBeenCalled();
    });

    it('rejects when the client believed a different current Agent', async () => {
      primeHappyPath();

      const result = await runSessionAgentTransition({
        credentials,
        request: request({ expectedCurrentAgentId: 'codex' }),
      });

      expect(result).toEqual({ type: 'rejected', code: 'stale_selection', sourceEffect: 'none' });
      expect(mocks.requestSessionStop).not.toHaveBeenCalled();
    });

    it('rejects a source that is not strictly idle', async () => {
      primeHappyPath();
      mocks.waitForSessionIdle.mockResolvedValue({ ok: false, code: 'timeout' });

      const result = await runSessionAgentTransition({ credentials, request: request() });

      expect(result).toEqual({ type: 'rejected', code: 'source_not_idle', sourceEffect: 'none' });
      expect(mocks.requestSessionStop).not.toHaveBeenCalled();
    });

    it('rejects when metadata moved between the idle proof and the stop', async () => {
      primeHappyPath();
      mocks.fetchSessionByIdCompat.mockResolvedValue(rawSession(sourceMetadata(), { metadataVersion: 9 }));

      const result = await runSessionAgentTransition({ credentials, request: request() });

      expect(result).toEqual({ type: 'rejected', code: 'stale_selection', sourceEffect: 'none' });
      expect(mocks.requestSessionStop).not.toHaveBeenCalled();
    });

    // A stop request that never dispatched is a FAILED STOP, not an
    // unsupported capability. All four `requestSessionStop` refusal codes are
    // raised while resolving the Session id, before any signal, so the source
    // is provably untouched — the exact state this result union's own doc
    // comment reserves `source_stop_failed` for. Reporting
    // `unsupported_operation` instead rendered "Switching Agents isn't
    // supported for this Session", a permanent-sounding capability claim, for
    // what is a transient stop-dispatch failure.
    it.each([
      ['session_not_found'],
      ['session_id_ambiguous'],
      ['session_lookup_timeout'],
      ['unsupported'],
    ] as const)(
      'reports an undispatched stop (%s) as source_stop_failed, not as unsupported',
      async (code) => {
        primeHappyPath();
        mocks.requestSessionStop.mockResolvedValue({ ok: false, code });

        const result = await runSessionAgentTransition({ credentials, request: request() });

        expect(result).toEqual({ type: 'rejected', code: 'source_stop_failed', sourceEffect: 'none' });
        expect(mocks.commitSessionAgentTransitionCutover).not.toHaveBeenCalled();
        expect(mocks.enqueuePendingQueueV2MessageViaHttp).not.toHaveBeenCalled();
      },
    );

    it('rejects a direct-transcript Session as unsupported', async () => {
      primeHappyPath(sourceMetadata({ directSessionV1: { v: 1 } }));

      const result = await runSessionAgentTransition({ credentials, request: request() });

      expect(result).toEqual({ type: 'rejected', code: 'unsupported_operation', sourceEffect: 'none' });
      expect(mocks.requestSessionStop).not.toHaveBeenCalled();
    });

    it.each([
      { label: 'a cleared marker', directSessionV1: null },
      { label: 'an empty marker', directSessionV1: {} },
      { label: 'an unrecognised marker version', directSessionV1: { v: 2 } },
    ])('treats %s as an ordinary hosted Session, exactly like the canonical storage owner', async ({ directSessionV1 }) => {
      // `directSessionV1 !== undefined` is a SECOND answer to a question the
      // canonical Session-scoped owner already answers — `getSessionStorageKind`
      // requires an object with `v === 1` and defaults to `persisted`. Any other
      // shape (a cleared `null`, a legacy `{}`, a future `{v:2}`) is persisted
      // there and "direct" here, so an ordinary hosted Session becomes
      // untransitionable for a reason the user cannot see. That is the same
      // split-brain class as §1.5b, which blocked 100% of ordinary Sessions.
      primeHappyPath(sourceMetadata({ directSessionV1 }));

      const result = await runSessionAgentTransition({ credentials, request: request() });

      expect(result).toEqual({ type: 'accepted', localId: LOCAL_ID });
    });
  });

  describe('confirmed stop gates every target effect', () => {
    it('performs no cutover, admission or activation until the stop is fully confirmed', async () => {
      primeHappyPath();

      await runSessionAgentTransition({ credentials, request: request() });

      expect(mocks.callOrder).toEqual(['stop', 'cutover', 'admit', 'resume']);
    });

    it('treats an omitted stopOutcome from an older producer as unknown, not untouched', async () => {
      primeHappyPath();
      mocks.requestSessionStop.mockResolvedValue({ ok: true, sessionId: SESSION_ID, stopped: false });

      const result = await runSessionAgentTransition({ credentials, request: request() });

      expect(result).toEqual({ type: 'outcome_unknown', localId: LOCAL_ID });
    });

    // Section 7.2 step 6 is unconditional: `physical_stop_unconfirmed` and
    // `stopped_projection_unconfirmed` "do not permit proceeding and are not
    // reported as a rejection: the source may already be gone, so they surface
    // as outcome_unknown". `source_stop_failed` is reserved for a stop outcome
    // PROVING the source is still running, which no unconfirmed outcome is.
    //
    // A reason-name allowlist cannot re-establish that proof, because the reason
    // strings are a lossy channel: `legacy_attachment`, `attachment_mismatch`,
    // `missing_topology_proof`, `terminal_host_adapter_unavailable` and
    // `disposition_in_progress` are each emitted by `stopSession.ts` BOTH from a
    // pre-signal gate AND from the terminal-host disposition that runs after
    // SIGTERM with `runnersExited === true` — a source that is definitely dead.
    // The same string therefore carries opposite depths, exactly as
    // `target_daemon_unavailable` did.
    //
    // The cases are derived from `SessionStopOutcomeSchema` itself rather than
    // restated, so a reason added to the protocol union is covered here the day
    // it exists instead of defaulting into whichever bucket looks safe.
    it.each(everyUnconfirmedStopOutcome())(
      'reports the unconfirmed stop outcome %s as outcome_unknown, never as a rejection',
      async (_label, stopOutcome) => {
        primeHappyPath();
        mocks.requestSessionStop.mockResolvedValue({
          ok: true,
          sessionId: SESSION_ID,
          stopped: false,
          stopOutcome,
        });

        const result = await runSessionAgentTransition({ credentials, request: request() });

        expect(result).toEqual({ type: 'outcome_unknown', localId: LOCAL_ID });
        expect(mocks.commitSessionAgentTransitionCutover).not.toHaveBeenCalled();
        expect(mocks.enqueuePendingQueueV2MessageViaHttp).not.toHaveBeenCalled();
        expect(mocks.requestInactiveSessionResume).not.toHaveBeenCalled();
      },
    );
  });

  describe('post-stop outcomes never ride the rejected arm', () => {
    it('reports a post-stop session read failure as source_stopped, not as indeterminate', async () => {
      // The stop is CONFIRMED and nothing has been written, so this is a known
      // depth: the Session is still the source Agent and resume-source is safe.
      // `outcome_unknown` would withhold that recovery for a state the daemon
      // can establish.
      primeHappyPath();
      mocks.fetchSessionByIdCompat.mockReset();
      mocks.fetchSessionByIdCompat
        .mockResolvedValueOnce(rawSession(sourceMetadata()))
        .mockResolvedValueOnce(null);

      const result = await runSessionAgentTransition({ credentials, request: request() });

      expect(result).toEqual({
        type: 'partially_applied',
        localId: LOCAL_ID,
        applied: 'source_stopped',
        code: 'context_unavailable',
      });
      expect(mocks.commitSessionAgentTransitionCutover).not.toHaveBeenCalled();
    });


    it('switches Agent on a source with nothing to carry over, instead of stopping it and failing', async () => {
      // The reachable first-run path: start a Session, switch Agent before
      // sending anything. There is no dialog to replay, which is the trivially
      // satisfiable case — yet while an empty source and a failed retrieval
      // shared one nullish answer, the source was stopped and the switch then
      // failed with `context_unavailable`, leaving the Session stopped with
      // nothing to show for it.
      primeHappyPath();
      mocks.resolveReplaySeedDraft.mockResolvedValue({ status: 'no_source_dialog' });

      const result = await runSessionAgentTransition({ credentials, request: request() });

      expect(result).toEqual({ type: 'accepted', localId: LOCAL_ID });
      expect(mocks.commitSessionAgentTransitionCutover).toHaveBeenCalledTimes(1);
      // Nothing to carry means no seed is sealed — not an empty seed, and not a
      // seed carried over from some other source.
      const cutover = mocks.commitSessionAgentTransitionCutover.mock.calls[0]?.[0];
      const written = JSON.parse(cutover.currentView.metadataCiphertext) as Record<string, unknown>;
      expect(written.replaySeedV1).toBeUndefined();
      expect(written.flavor).toBe('codex');
    });

    it('reports a bounded-context failure as source_stopped/context_unavailable', async () => {
      primeHappyPath();
      mocks.resolveReplaySeedDraft.mockResolvedValue({ status: 'unavailable' });

      const result = await runSessionAgentTransition({ credentials, request: request() });

      expect(result).toEqual({
        type: 'partially_applied',
        localId: LOCAL_ID,
        applied: 'source_stopped',
        code: 'context_unavailable',
      });
      expect(mocks.commitSessionAgentTransitionCutover).not.toHaveBeenCalled();
    });

    it('reports a lost cutover precondition as source_stopped/cutover_conflict', async () => {
      primeHappyPath();
      mocks.commitSessionAgentTransitionCutover.mockResolvedValue({
        status: 'settled',
        response: { ok: false, effect: 'none', error: 'version-mismatch' },
      });

      const result = await runSessionAgentTransition({ credentials, request: request() });

      expect(result).toEqual({
        type: 'partially_applied',
        localId: LOCAL_ID,
        applied: 'source_stopped',
        code: 'cutover_conflict',
      });
      expect(mocks.enqueuePendingQueueV2MessageViaHttp).not.toHaveBeenCalled();
    });

    it('reports a conflicting divider row as divider_conflict, not divider_missing', async () => {
      // The divider is PRESENT but names a different transition. Collapsing it
      // into `divider_missing` would send the client down the "resume and send
      // normally" recovery and let a later context pass trust a boundary that
      // names the wrong target.
      primeHappyPath();
      mocks.commitSessionAgentTransitionCutover.mockResolvedValue({
        status: 'settled',
        response: {
          ok: false,
          effect: 'current_view_committed',
          error: 'divider-conflict',
          currentView: { kind: 'legacy_v0', metadataVersion: 8, agentStateVersion: 4 },
        },
      });

      const result = await runSessionAgentTransition({ credentials, request: request() });

      expect(result).toEqual({
        type: 'partially_applied',
        localId: LOCAL_ID,
        applied: 'current_view_committed',
        code: 'divider_conflict',
      });
    });

    it('reports a divider the owner refused for any other reason as divider_missing', async () => {
      primeHappyPath();
      mocks.commitSessionAgentTransitionCutover.mockResolvedValue({
        status: 'settled',
        response: {
          ok: false,
          effect: 'current_view_committed',
          error: 'divider-rejected',
          currentView: { kind: 'legacy_v0', metadataVersion: 8, agentStateVersion: 4 },
        },
      });

      const result = await runSessionAgentTransition({ credentials, request: request() });

      expect(result).toEqual({
        type: 'partially_applied',
        localId: LOCAL_ID,
        applied: 'current_view_committed',
        code: 'divider_missing',
      });
    });

    it('reports an unknown cutover transport as outcome_unknown', async () => {
      primeHappyPath();
      mocks.commitSessionAgentTransitionCutover.mockResolvedValue({ status: 'unknown', reason: 'socket hang up' });

      const result = await runSessionAgentTransition({ credentials, request: request() });

      expect(result).toEqual({ type: 'outcome_unknown', localId: LOCAL_ID });
    });

    it('reports an unconfirmed input admission as current_view_committed/input_admission_failed', async () => {
      primeHappyPath();
      mocks.enqueuePendingQueueV2MessageViaHttp.mockRejectedValue(new Error('ack timeout'));

      const result = await runSessionAgentTransition({ credentials, request: request() });

      expect(result).toEqual({
        type: 'partially_applied',
        localId: LOCAL_ID,
        applied: 'current_view_committed',
        code: 'input_admission_failed',
      });
      expect(mocks.requestInactiveSessionResume).not.toHaveBeenCalled();
    });

    it('reports a failed target activation as current_view_committed/target_start_failed', async () => {
      primeHappyPath();
      mocks.requestInactiveSessionResume.mockResolvedValue({
        ok: false,
        code: 'unsupported',
        message: 'no exact machine target',
      });

      const result = await runSessionAgentTransition({ credentials, request: request() });

      expect(result).toEqual({
        type: 'partially_applied',
        localId: LOCAL_ID,
        applied: 'current_view_committed',
        code: 'target_start_failed',
      });
    });
  });

  describe('committed target view', () => {
    it('names the target Agent, drops every source native key, and carries a bounded brief', async () => {
      primeHappyPath();

      await runSessionAgentTransition({ credentials, request: request() });

      const cutover = mocks.commitSessionAgentTransitionCutover.mock.calls[0]?.[0];
      const written = JSON.parse(cutover.currentView.metadataCiphertext) as Record<string, unknown>;

      expect(written.flavor).toBe('codex');
      expect(written.claudeSessionId).toBeUndefined();
      expect(written.claudeTranscriptPath).toBeUndefined();
      expect(written.tools).toBeUndefined();
      expect(written.path).toBe('/work/repo');
      expect(written.replaySeedV1).toMatchObject({
        v: 1,
        seedText: 'bounded brief',
        sourceSessionId: SESSION_ID,
        sourceCutoffSeqInclusive: 100,
      });
      expect(cutover.currentView).toMatchObject({
        kind: 'legacy_v0',
        expectedMetadataVersion: 7,
        expectedAgentStateVersion: 3,
        agentStateCiphertext: null,
      });
    });

    it('derives the divider identity from the submitted localId and carries the transition sidecar', async () => {
      primeHappyPath();

      await runSessionAgentTransition({ credentials, request: request() });

      const cutover = mocks.commitSessionAgentTransitionCutover.mock.calls[0]?.[0];
      expect(cutover.divider.localId).toBe(`agent-transition:${LOCAL_ID}`);
      const dividerPayload = cutover.divider.content.v as {
        role: string;
        content: { type: string; data: Record<string, unknown> };
      };
      expect(dividerPayload.role).toBe('agent');
      expect(dividerPayload.content.type).toBe('event');
      expect(dividerPayload.content.data).toMatchObject({
        type: 'message',
        sessionAgentTransitionV1: { v: 1, fromAgentId: 'claude', toAgentId: 'codex' },
      });
    });
  });

  describe('exact input custody', () => {
    it('admits the exact submitted localId once, as user intent', async () => {
      primeHappyPath();

      const result = await runSessionAgentTransition({ credentials, request: request() });

      expect(result).toEqual({ type: 'accepted', localId: LOCAL_ID });
      expect(mocks.enqueuePendingQueueV2MessageViaHttp).toHaveBeenCalledTimes(1);
      const enqueue = mocks.enqueuePendingQueueV2MessageViaHttp.mock.calls[0]?.[0];
      expect(enqueue.body.localId).toBe(LOCAL_ID);
      expect(enqueue.body.messageRole).toBe('user');
      const record = JSON.parse(enqueue.body.content.v ? JSON.stringify(enqueue.body.content.v) : '{}') as {
        content: { text: string };
        meta: Record<string, unknown>;
      };
      expect(record.content.text).toBe('keep going');
      expect(record.meta.source).toBe('ui');
    });
  });

  /**
   * Section 7.5. A retry that arrives after the cutover already committed finds
   * the Session already naming the TARGET Agent. That is not a stale client
   * view: the source is confirmed stopped and the current view is committed, so
   * `rejected`'s `sourceEffect: 'none'` — which the UI turns into Keep editing
   * in front of a dead runtime — would be false.
   */
  describe('retry after a committed cutover', () => {
    function primeAlreadyTargeted(overrides: Record<string, unknown> = {}): void {
      primeHappyPath(
        sourceMetadata({
          flavor: 'codex',
          claudeSessionId: undefined,
          claudeTranscriptPath: undefined,
          codexSessionId: 'codex-native-1',
          ...overrides,
        }),
      );
    }

    function dividerLookup(payload: Record<string, unknown> | null) {
      return payload === null
        ? { type: 'not_found' as const }
        : {
            type: 'found' as const,
            message: {
              id: 'row-1',
              seq: 101,
              localId: `agent-transition:${LOCAL_ID}`,
              sidechainId: null,
              createdAt: 1,
              updatedAt: 1,
              content: {
                t: 'plain',
                v: {
                  role: 'agent',
                  content: { type: 'event', id: `agent-transition:${LOCAL_ID}`, data: payload },
                },
              },
            },
          };
    }

    const matchingDivider = {
      type: 'message',
      message: 'Continued with another Agent.',
      sessionAgentTransitionV1: { v: 1, fromAgentId: 'claude', toAgentId: 'codex' },
    };

    it('never reports a no-effect rejection once the Session already is the target', async () => {
      primeAlreadyTargeted();
      mocks.findTranscriptEncryptedMessageByLocalIdV2.mockResolvedValue(dividerLookup(matchingDivider));

      const result = await runSessionAgentTransition({ credentials, request: request() });

      expect(result).not.toMatchObject({ type: 'rejected' });
      expect(mocks.requestSessionStop).not.toHaveBeenCalled();
      expect(mocks.commitSessionAgentTransitionCutover).not.toHaveBeenCalled();
    });

    it('re-admits the same localId idempotently and reports accepted when the divider matches', async () => {
      primeAlreadyTargeted();
      mocks.findTranscriptEncryptedMessageByLocalIdV2.mockResolvedValue(dividerLookup(matchingDivider));

      const result = await runSessionAgentTransition({ credentials, request: request() });

      expect(result).toEqual({ type: 'accepted', localId: LOCAL_ID });
      expect(mocks.enqueuePendingQueueV2MessageViaHttp).toHaveBeenCalledTimes(1);
      expect(mocks.enqueuePendingQueueV2MessageViaHttp.mock.calls[0]?.[0].body.localId).toBe(LOCAL_ID);
    });

    it('does not re-activate a target that is already running, and never calls that target_start_failed', async () => {
      // The likeliest reconcile is a retry after an invocation that fully
      // succeeded and lost only its answer — so the target is already RUNNING.
      // `requestInactiveSessionResume` has no active guard of its own: it goes
      // straight to the machine SPAWN RPC. Issuing that against a live runtime
      // is a lifecycle action nobody asked for, and a daemon that refuses turns
      // a completed transition into a false `target_start_failed`, whose
      // recovery tells the user to start a target that is already up.
      primeAlreadyTargeted();
      mocks.findTranscriptEncryptedMessageByLocalIdV2.mockResolvedValue(dividerLookup(matchingDivider));
      mocks.fetchSessionByIdCompat.mockResolvedValue(
        rawSession(
          sourceMetadata({ flavor: 'codex', claudeSessionId: undefined, claudeTranscriptPath: undefined }),
          { active: true },
        ),
      );
      mocks.requestInactiveSessionResume.mockResolvedValue({
        ok: false,
        code: 'unsupported',
        message: 'Session is already active',
      });

      const result = await runSessionAgentTransition({ credentials, request: request() });

      expect(result).toEqual({ type: 'accepted', localId: LOCAL_ID });
      expect(mocks.requestInactiveSessionResume).not.toHaveBeenCalled();
    });

    it('reports the committed depth with divider_missing when no divider row exists', async () => {
      primeAlreadyTargeted();
      mocks.findTranscriptEncryptedMessageByLocalIdV2.mockResolvedValue(dividerLookup(null));

      const result = await runSessionAgentTransition({ credentials, request: request() });

      expect(result).toEqual({
        type: 'partially_applied',
        localId: LOCAL_ID,
        applied: 'current_view_committed',
        code: 'divider_missing',
      });
      expect(mocks.enqueuePendingQueueV2MessageViaHttp).not.toHaveBeenCalled();
    });

    it('reports divider_conflict for a row carrying a different transition, and never overwrites it', async () => {
      primeAlreadyTargeted();
      mocks.findTranscriptEncryptedMessageByLocalIdV2.mockResolvedValue(
        dividerLookup({
          type: 'message',
          message: 'Continued with another Agent.',
          sessionAgentTransitionV1: { v: 1, fromAgentId: 'opencode', toAgentId: 'codex' },
        }),
      );

      const result = await runSessionAgentTransition({ credentials, request: request() });

      expect(result).toEqual({
        type: 'partially_applied',
        localId: LOCAL_ID,
        applied: 'current_view_committed',
        code: 'divider_conflict',
      });
      expect(mocks.enqueuePendingQueueV2MessageViaHttp).not.toHaveBeenCalled();
    });

    it('reports the committed depth when the divider row cannot be read at all', async () => {
      primeAlreadyTargeted();
      mocks.findTranscriptEncryptedMessageByLocalIdV2.mockResolvedValue({
        type: 'unhealthy',
        reason: 'network',
        error: new Error('offline'),
      });

      const result = await runSessionAgentTransition({ credentials, request: request() });

      // An unreadable row is a fact about the BOUNDARY, not about the switch:
      // the Session observably names the target. `outcome_unknown` would claim
      // the daemon cannot establish whether the cutover happened, which is
      // false here, and the client answers it by keeping the armed switch alive
      // in front of a Session that has already switched.
      expect(result).toEqual({
        type: 'partially_applied',
        localId: LOCAL_ID,
        applied: 'current_view_committed',
        code: 'divider_unknown',
      });
    });

    it('still rejects same_target when the client also expected the target', async () => {
      primeAlreadyTargeted();

      const result = await runSessionAgentTransition({
        credentials,
        request: request({ expectedCurrentAgentId: 'codex' }),
      });

      expect(result).toEqual({ type: 'rejected', code: 'same_target', sourceEffect: 'none' });
      expect(mocks.findTranscriptEncryptedMessageByLocalIdV2).not.toHaveBeenCalled();
    });
  });
});
