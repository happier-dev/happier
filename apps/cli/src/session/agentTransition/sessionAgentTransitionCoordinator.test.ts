import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  FeaturesResponseSchema,
  SessionStopOutcomeSchema,
  isSessionStopConfirmed,
  readSessionAgentTransitionDividerV1,
  type SessionStopOutcome,
} from '@happier-dev/protocol';
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
  bootstrapAccountSettingsContext: vi.fn(),
  fetchAccountMachineReplacements: vi.fn(),
  readAgentNativeResumeRecord: vi.fn(),
  writeAgentNativeResumeRecord: vi.fn(),
  resolveCliFeatureDecisionForServer: vi.fn(),
  callOrder: [] as string[],
}));

vi.mock('@/api/machine/fetchAccountMachineReplacements', () => ({
  fetchAccountMachineReplacements: mocks.fetchAccountMachineReplacements,
}));
vi.mock('@/features/featureDecisionService', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/features/featureDecisionService')>();
  return {
    ...actual,
    resolveCliFeatureDecisionForServer: mocks.resolveCliFeatureDecisionForServer,
  };
});
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
// The account-settings bootstrap is an HTTP boundary. The connected-services
// default resolution beneath it — the canonical creation-time owner the
// transition reuses — runs for real.
vi.mock('@/settings/accountSettings/bootstrapAccountSettingsContext', () => ({
  bootstrapAccountSettingsContext: mocks.bootstrapAccountSettingsContext,
}));
// Protected files on disk are the genuine boundary of the native-return record.
// The eligibility decision, the current-view projection and the seed threading
// above them are code under test and run for real.
vi.mock('@/session/handoff/metadata/localAgentNativeResumeRecordStore', () => ({
  createLocalAgentNativeResumeRecordStoreAt: () => ({
    resolveAgentNativeResumeRecordPath: () => '/dev/null',
    readAgentNativeResumeRecord: mocks.readAgentNativeResumeRecord,
    writeAgentNativeResumeRecord: mocks.writeAgentNativeResumeRecord,
  }),
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
const { resolveCliFeatureDecision } = await import('@/features/featureDecisionService');

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
 * `SessionStopOutcomeSchema` instead of listed here, minus the outcomes the stop
 * owner's own predicate calls CONFIRMED. The union is the producing contract, so
 * nothing in this file has to be kept in step with it by hand; asking
 * `isSessionStopConfirmed` rather than hand-excluding `already_stopped` keeps
 * that true in both directions.
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
  }).filter(([, stopOutcome]) => !isSessionStopConfirmed({
    sessionId: SESSION_ID,
    stopped: false,
    stopOutcome,
  }));
  // A zod change that broke the introspection above would silently turn the
  // suite into a no-op. Anchor on one reason that WAS allowlisted as proof of
  // "no applied effect" and one that never was.
  const reasons = new Set(cases.map(([, outcome]) => outcome.reason));
  if (!reasons.has('missing_topology_proof') || !reasons.has('runner_exit_timeout')) {
    throw new Error('SessionStopOutcomeSchema introspection produced no usable stop reasons');
  }
  // The confirmed arm must really have left, or the filter above is a no-op and
  // the positive case below would be contradicted by this suite.
  if (reasons.has('no_runtime_session_inactive')) {
    throw new Error('a confirmed stop outcome leaked into the unconfirmed cases');
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

function resolveAgentSwitchingDecision(serverSnapshot?: Parameters<typeof resolveCliFeatureDecision>[0]['serverSnapshot']) {
  return resolveCliFeatureDecision({
    featureId: 'sessions.agentSwitching',
    env: {} as NodeJS.ProcessEnv,
    serverSnapshot,
  });
}

const enabledAgentSwitchingFeatures = FeaturesResponseSchema.parse({
  features: {
    sessions: {
      enabled: true,
      agentSwitching: { enabled: true },
    },
  },
  capabilities: {},
});

function primeHappyPath(
  metadata: Record<string, unknown> = sourceMetadata(),
  rawOverrides: Record<string, unknown> = {},
): void {
  const raw = rawSession(metadata, rawOverrides);
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
    return { status: 'settled', response: { ok: true, dividerSeq: 101 } };
  });
  mocks.enqueuePendingQueueV2MessageViaHttp.mockImplementation(async () => {
    mocks.callOrder.push('admit');
    return { didWrite: true, terminal: false, suppressed: false };
  });
  mocks.requestInactiveSessionResume.mockImplementation(async () => {
    mocks.callOrder.push('resume');
    return { ok: true };
  });
  // No configured connected-services default for any Agent unless a test says so.
  mocks.bootstrapAccountSettingsContext.mockResolvedValue({ settings: {} });
}

describe('runSessionAgentTransition', () => {
  beforeEach(() => {
    for (const value of Object.values(mocks)) {
      if (typeof value === 'function' && 'mockReset' in value) (value as { mockReset: () => void }).mockReset();
    }
    mocks.callOrder.length = 0;
    // No machine-local record unless a test writes one: every target is fresh
    // by default, which is the structurally important case.
    mocks.readAgentNativeResumeRecord.mockResolvedValue(null);
    mocks.writeAgentNativeResumeRecord.mockResolvedValue(undefined);
    mocks.fetchAccountMachineReplacements.mockResolvedValue([{ id: 'machine-1' }, { id: 'machine-2' }]);
    mocks.resolveCliFeatureDecisionForServer.mockResolvedValue({
      decision: resolveAgentSwitchingDecision({ status: 'ready', features: enabledAgentSwitchingFeatures }),
    });
  });

  describe('pre-effect rejections leave the source running', () => {
    it.each([
      [
        'the server explicitly disables it',
        {
          status: 'ready' as const,
          features: FeaturesResponseSchema.parse({
            features: { sessions: { enabled: true, agentSwitching: { enabled: false } } },
            capabilities: {},
          }),
        },
      ],
      [
        'the server omits its bit',
        {
          status: 'ready' as const,
          features: FeaturesResponseSchema.parse({
            features: { sessions: { enabled: true } },
            capabilities: {},
          }),
        },
      ],
      ['the server feature payload is malformed', { status: 'unsupported' as const, reason: 'invalid_payload' as const }],
      ['no server feature snapshot is available', undefined],
    ] as const)(
      'rejects before every source effect when %s',
      async (_label, serverSnapshot) => {
        primeHappyPath();
        mocks.resolveCliFeatureDecisionForServer.mockResolvedValue({
          decision: resolveAgentSwitchingDecision(serverSnapshot),
        });

        const result = await runSessionAgentTransition({ credentials, request: request() });

        expect(result).toEqual({ type: 'rejected', code: 'unsupported_operation', sourceEffect: 'none' });
        expect(mocks.resolveCliFeatureDecisionForServer).toHaveBeenCalledWith(expect.objectContaining({
          featureId: 'sessions.agentSwitching',
        }));
        expect(mocks.callOrder).toEqual([]);
        expect(mocks.resolveSessionTransportContext).not.toHaveBeenCalled();
        expect(mocks.waitForSessionIdle).not.toHaveBeenCalled();
        expect(mocks.requestSessionStop).not.toHaveBeenCalled();
        expect(mocks.commitSessionAgentTransitionCutover).not.toHaveBeenCalled();
        expect(mocks.enqueuePendingQueueV2MessageViaHttp).not.toHaveBeenCalled();
      },
    );

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

    // The recorded machine is NOT a gate. A machine-id comparison is only a
    // proxy for continuability, and the components that actually know already
    // answer it: the stop owner reports a Session it holds no process for, an
    // absent DEVICE-LOCAL resume record already degrades to a full replay, and
    // the cutover is server-side. Refusing here removed the capability of a user
    // who had legitimately moved the Session to this host.
    it('runs for a Session recorded against a different machine, without reading the account chain', async () => {
      primeHappyPath(sourceMetadata({ machineId: 'machine-2' }), { machineId: 'machine-2' });

      const result = await runSessionAgentTransition({ credentials, request: request() });

      expect(result).toEqual({ type: 'accepted', localId: LOCAL_ID });
      expect(mocks.fetchAccountMachineReplacements).not.toHaveBeenCalled();
    });

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

    // This tree installs no admission fence, so the strict-idle observation is
    // the ONLY thing standing between a running source and the stop. Attachment
    // preparation resolves every referenced local image path, stats it, reads
    // the whole file and hashes it, so running it between the proof and the
    // stop makes "idle" a claim about an arbitrarily older instant than the one
    // it is acted on. It consumes nothing the idle probe produces, so it belongs
    // ABOVE the proof — where a rejected mention/attachment still fails with the
    // source untouched.
    it('prepares attachments before taking the strict-idle proof, so the proof stays adjacent to the stop', async () => {
      primeHappyPath();
      mocks.waitForSessionIdle.mockImplementation(async () => {
        mocks.callOrder.push('idle');
        return { ok: true, sessionId: SESSION_ID, idle: true, observedAt: 1 };
      });
      mocks.resolveTrustedSessionAttachmentLocalImagePaths.mockImplementation(async () => {
        mocks.callOrder.push('attachments');
        return new Set<string>();
      });

      await runSessionAgentTransition({ credentials, request: request() });

      expect(mocks.callOrder).toEqual(['attachments', 'idle', 'stop', 'cutover', 'admit', 'resume']);
    });

    /**
     * The reproduced user failure: a Session whose runtime is long gone could
     * never be switched. The stop owner answered `not_found`, the coordinator
     * read that as unconfirmed, and the transition ended at `outcome_unknown`
     * before cutover — three times in a row, with no divider and no spawn.
     *
     * A cold Session IS stopped. The owner now says so with a confirmed arm, and
     * the transition must run to completion on it exactly as it does after
     * signalling a live runtime — same order, same effects.
     */
    it('completes the transition for a cold Session the stop owner confirms is already stopped', async () => {
      primeHappyPath();
      mocks.requestSessionStop.mockImplementation(async () => {
        mocks.callOrder.push('stop');
        return {
          ok: true,
          sessionId: SESSION_ID,
          stopped: false,
          stopOutcome: SessionStopOutcomeSchema.parse({
            status: 'already_stopped',
            reason: 'no_runtime_session_inactive',
          }),
        };
      });

      const result = await runSessionAgentTransition({ credentials, request: request() });

      expect(result).toEqual({ type: 'accepted', localId: LOCAL_ID });
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

    it('does not leave an unconsumed seed from an earlier operation in the target view', async () => {
      // A seed the source Agent never consumed is addressed to a runtime that no
      // longer exists. Leaving it in place lets the incoming Agent's first turn
      // be prefixed with an unrelated operation's replay context.
      primeHappyPath(sourceMetadata({
        replaySeedV1: {
          v: 1,
          seedText: 'stale brief from an earlier operation',
          sourceSessionId: 'some-other-session',
          sourceCutoffSeqInclusive: 3,
          createdAtMs: 1,
        },
      }));
      mocks.resolveReplaySeedDraft.mockResolvedValue({ status: 'no_source_dialog' });

      const result = await runSessionAgentTransition({ credentials, request: request() });

      expect(result).toEqual({ type: 'accepted', localId: LOCAL_ID });
      const cutover = mocks.commitSessionAgentTransitionCutover.mock.calls[0]?.[0];
      const written = JSON.parse(cutover.currentView.metadataCiphertext) as Record<string, unknown>;
      expect(written.replaySeedV1).toBeUndefined();
    });

    it('replaces an unconsumed earlier seed with this operation\u2019s own brief', async () => {
      primeHappyPath(sourceMetadata({
        replaySeedV1: {
          v: 1,
          seedText: 'stale brief from an earlier operation',
          sourceSessionId: 'some-other-session',
          sourceCutoffSeqInclusive: 3,
          createdAtMs: 1,
        },
      }));

      await runSessionAgentTransition({ credentials, request: request() });

      const cutover = mocks.commitSessionAgentTransitionCutover.mock.calls[0]?.[0];
      const written = JSON.parse(cutover.currentView.metadataCiphertext) as Record<string, unknown>;
      expect(written.replaySeedV1).toMatchObject({ seedText: 'bounded brief', sourceCutoffSeqInclusive: 100 });
    });

    /**
     * A connected-service binding is Agent-scoped: it names a `serviceId` the
     * SOURCE Agent's catalog declares, and every reader resolves it against the
     * Session's CURRENT Agent. Observed live — `openai-codex`/`codex6` survived a
     * switch to `claude`, so the daemon spawn-preflighted the wrong service's
     * credential and the target's runtime registration reconciled to
     * `generation_application_scope_service_unsupported`; `/session-started`
     * answered 503 twenty times and the freshly started Claude runtime died with
     * the Session already committed to Claude.
     */
    describe('connected-service binding', () => {
      const SOURCE_BOUND = {
        connectedServices: {
          v: 1,
          bindingsByServiceId: {
            'claude-subscription': { source: 'connected', selection: 'profile', profileId: 'team' },
          },
        },
        connectedServicesUpdatedAt: 11,
        connectedServiceMaterializationIdentityV1: { v: 1, id: 'csm_source', createdAtMs: 1 },
      } as const;

      it('rebinds the target Agent from the account default instead of carrying the source binding', async () => {
        primeHappyPath(sourceMetadata({ ...SOURCE_BOUND }));
        mocks.bootstrapAccountSettingsContext.mockResolvedValue({
          settings: {
            connectedServicesDefaultAuthByAgentIdV1: {
              v: 1,
              bindingsByAgentId: {
                codex: {
                  v: 1,
                  bindingsByServiceId: {
                    'openai-codex': { source: 'connected', selection: 'group', groupId: 'happier' },
                  },
                },
              },
            },
          },
        });

        await runSessionAgentTransition({ credentials, request: request() });

        const cutover = mocks.commitSessionAgentTransitionCutover.mock.calls[0]?.[0];
        const written = JSON.parse(cutover.currentView.metadataCiphertext) as Record<string, unknown>;
        const bindings = (written.connectedServices as { bindingsByServiceId: Record<string, unknown> })
          .bindingsByServiceId;
        expect(bindings['claude-subscription']).toBeUndefined();
        expect(bindings['openai-codex']).toEqual({ source: 'connected', selection: 'group', groupId: 'happier' });
        // The materialized credential home is per-binding; reusing the source's
        // id would point the target at the departed Agent's home.
        expect(written.connectedServiceMaterializationIdentityV1).not.toMatchObject({ id: 'csm_source' });
        expect(written.connectedServicesUpdatedAt).not.toBe(11);
      });

      it('leaves the target on native auth when the account configures no default for it', async () => {
        primeHappyPath(sourceMetadata({ ...SOURCE_BOUND }));
        mocks.bootstrapAccountSettingsContext.mockResolvedValue({ settings: {} });

        await runSessionAgentTransition({ credentials, request: request() });

        const cutover = mocks.commitSessionAgentTransitionCutover.mock.calls[0]?.[0];
        const written = JSON.parse(cutover.currentView.metadataCiphertext) as Record<string, unknown>;
        expect(written.connectedServices).toBeUndefined();
        expect(written.connectedServicesUpdatedAt).toBeUndefined();
        expect(written.connectedServiceMaterializationIdentityV1).toBeUndefined();
      });

      it('degrades to native rather than failing a transition whose source is already stopped', async () => {
        // The settings read happens after the confirmed stop. Failing here would
        // strand a Session whose source is gone; native is what a Session created
        // for this Agent gets when no default is readable.
        primeHappyPath(sourceMetadata({ ...SOURCE_BOUND }));
        mocks.bootstrapAccountSettingsContext.mockRejectedValue(new Error('settings unavailable'));

        const result = await runSessionAgentTransition({ credentials, request: request() });

        expect(result).toEqual({ type: 'accepted', localId: LOCAL_ID });
        const cutover = mocks.commitSessionAgentTransitionCutover.mock.calls[0]?.[0];
        const written = JSON.parse(cutover.currentView.metadataCiphertext) as Record<string, unknown>;
        expect(written.connectedServices).toBeUndefined();
      });
    });

    /**
     * Section 8 disposes of `sessionWorkStateV1` in two clauses — capture the snapshot into the
     * brief, THEN clear the current field. The cutover projection owns the clear; this coordinator
     * is the only reader of the source view left before the projection drops it, so the capture can
     * happen nowhere else.
     */
    describe('departing work state', () => {
      const WORK_STATE = {
        v: 1,
        backendId: 'claude',
        updatedAt: 10,
        items: [{
          id: 'i1',
          kind: 'task',
          origin: 'vendor',
          status: 'active',
          title: 'Port the parser to the new decoder',
          updatedAt: 10,
        }],
      };

      const readWorkStateArgument = (): unknown =>
        (mocks.resolveReplaySeedDraft.mock.calls[0]?.[0] as { workState?: unknown }).workState;

      it('hands the departing Agent\u2019s tracked work to the brief owner', async () => {
        // Without this the cutover deletes the in-flight plan and the target continues the same
        // Session unaware of it: the items are a structured projection, so no amount of replayed
        // prose brings them back.
        primeHappyPath(sourceMetadata({ sessionWorkStateV1: WORK_STATE }));

        const result = await runSessionAgentTransition({ credentials, request: request() });

        expect(result).toEqual({ type: 'accepted', localId: LOCAL_ID });
        expect(readWorkStateArgument()).toMatchObject({
          items: [{ status: 'active', title: 'Port the parser to the new decoder' }],
        });
        // ...and the field itself does not survive into the committed target view.
        const cutover = mocks.commitSessionAgentTransitionCutover.mock.calls[0]?.[0];
        const written = JSON.parse(cutover.currentView.metadataCiphertext) as Record<string, unknown>;
        expect(written.sessionWorkStateV1).toBeUndefined();
      });

      it('reads the snapshot through the canonical display-safe reader rather than copying the raw field', async () => {
        // A malformed or placeholder projection is no snapshot, and forwarding it raw would put
        // whatever the departing runtime last wrote into another Agent's prompt.
        primeHappyPath(sourceMetadata({ sessionWorkStateV1: { v: 1 } }));

        await runSessionAgentTransition({ credentials, request: request() });

        expect(readWorkStateArgument()).toBeNull();
      });
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

    // A CAS loss is not automatically a dead end: the metadata version can move
    // for a write that has nothing to do with the switch, and the source is
    // already stopped, so leaving the Session down when the transition is still
    // applicable is the worst outcome this flow can produce. Exactly one
    // refetch-revalidate-rebuild-retry, so a genuinely contested Session still
    // terminates instead of looping.
    it('rebuilds against the current row and retries once after a recoverable CAS loss', async () => {
      primeHappyPath();
      // The post-stop read still shows version 7 (what the first attempt used);
      // the refetch after the loss shows the row a concurrent write moved to 9.
      let read = 0;
      mocks.fetchSessionByIdCompat.mockImplementation(async () => {
        read += 1;
        return read <= 2 ? rawSession(sourceMetadata()) : rawSession(sourceMetadata(), { metadataVersion: 9 });
      });
      mocks.commitSessionAgentTransitionCutover
        .mockImplementationOnce(async () => ({
          status: 'settled',
          response: { ok: false, effect: 'none', error: 'version-mismatch' },
        }))
        .mockImplementationOnce(async () => {
          mocks.callOrder.push('cutover');
          return { status: 'settled', response: { ok: true, dividerSeq: 101 } };
        });

      const result = await runSessionAgentTransition({ credentials, request: request() });

      expect(result).toEqual({ type: 'accepted', localId: LOCAL_ID });
      expect(mocks.commitSessionAgentTransitionCutover).toHaveBeenCalledTimes(2);
      // The retry is a REBUILD, not a resend: it carries the refetched row's
      // version, which is the only thing that can make the second CAS succeed.
      expect(mocks.commitSessionAgentTransitionCutover.mock.calls[0]?.[0]?.currentView)
        .toMatchObject({ expectedMetadataVersion: 7 });
      expect(mocks.commitSessionAgentTransitionCutover.mock.calls[1]?.[0]?.currentView)
        .toMatchObject({ expectedMetadataVersion: 9 });
    });

    it('reports a second cutover loss as source_stopped/cutover_conflict, and does not loop', async () => {
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
      expect(mocks.commitSessionAgentTransitionCutover).toHaveBeenCalledTimes(2);
      expect(mocks.enqueuePendingQueueV2MessageViaHttp).not.toHaveBeenCalled();
    });

    // The retry must never overwrite a concurrent transition that won the race:
    // the version moved BECAUSE another cutover committed, and re-sealing this
    // operation's target view over it would silently revert it.
    it('does not retry over a concurrent cutover that already moved the Session off the source Agent', async () => {
      primeHappyPath();
      let read = 0;
      mocks.fetchSessionByIdCompat.mockImplementation(async () => {
        read += 1;
        return read <= 2
          ? rawSession(sourceMetadata())
          : rawSession(sourceMetadata({ flavor: 'codex' }), { metadataVersion: 9 });
      });
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
      expect(mocks.commitSessionAgentTransitionCutover).toHaveBeenCalledTimes(1);
    });

    // Every other no-effect refusal is terminal: nothing a refetch could change.
    it('does not retry a cutover the server refused for a reason a refetch cannot fix', async () => {
      primeHappyPath();
      mocks.commitSessionAgentTransitionCutover.mockResolvedValue({
        status: 'settled',
        response: { ok: false, effect: 'none', error: 'session-active' },
      });

      const result = await runSessionAgentTransition({ credentials, request: request() });

      expect(result).toMatchObject({ applied: 'source_stopped', code: 'cutover_conflict' });
      expect(mocks.commitSessionAgentTransitionCutover).toHaveBeenCalledTimes(1);
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
      // This Session is not its own predecessor. Asking through `fork_chain`
      // made the seed tell the target Agent it was continuing from a previous
      // Happy session and print this Session's own id as that predecessor.
      const seedRequest = mocks.resolveReplaySeedDraft.mock.calls[0]?.[0] as {
        source: { kind: string; sessionId?: string; previousSessionId?: string };
      };
      expect(seedRequest.source).toMatchObject({ kind: 'same_session_agent_change', sessionId: SESSION_ID });
      expect(seedRequest.source.previousSessionId).toBeUndefined();
      expect(cutover.currentView).toMatchObject({
        kind: 'legacy_v0',
        expectedMetadataVersion: 7,
        expectedAgentStateVersion: 3,
        agentStateCiphertext: null,
      });
    });

    // A metadata write accepted while the source was stopping is a silent LOST
    // UPDATE when the sealed bytes come from the pre-stop read and the CAS
    // version comes from the post-stop one: the version says "this is current"
    // about content that is not. Bytes and the version they are checked against
    // must be one observation.
    it('seals the metadata observed after the stop, not the pre-stop bytes it pairs the post-stop version with', async () => {
      primeHappyPath();
      const postStop = rawSession(
        sourceMetadata({ permissionMode: 'bypassPermissions' }),
        { metadataVersion: 8, agentStateVersion: 4 },
      );
      mocks.fetchSessionByIdCompat.mockReset();
      mocks.fetchSessionByIdCompat
        // Pre-stop currentness recheck: still the version preflight observed.
        .mockResolvedValueOnce(rawSession(sourceMetadata()))
        // Post-stop seal basis, and the post-cutover activation refetch.
        .mockResolvedValue(postStop);

      const result = await runSessionAgentTransition({ credentials, request: request() });

      expect(result).toEqual({ type: 'accepted', localId: LOCAL_ID });
      const cutover = mocks.commitSessionAgentTransitionCutover.mock.calls[0]?.[0];
      const written = JSON.parse(cutover.currentView.metadataCiphertext) as Record<string, unknown>;
      expect(written.permissionMode).toBe('bypassPermissions');
      expect(cutover.currentView).toMatchObject({
        expectedMetadataVersion: 8,
        expectedAgentStateVersion: 4,
      });
      // The same stale read also decided the Session-global safety intent the
      // exact submitted input is admitted under.
      const enqueue = mocks.enqueuePendingQueueV2MessageViaHttp.mock.calls[0]?.[0];
      expect((enqueue.body.content.v as { meta: Record<string, unknown> }).meta.permissionMode).toBe('yolo');
    });

    // With bytes and version taken from one post-stop observation, the CAS can
    // no longer catch a transition that committed during the stop window — it
    // would adopt that operation's version and overwrite its committed target.
    // Section 7.3: a concurrent second transition loses the current-target or
    // metadata-version check.
    it('refuses to overwrite a transition that committed its own cutover during the stop window', async () => {
      primeHappyPath();
      mocks.fetchSessionByIdCompat.mockReset();
      mocks.fetchSessionByIdCompat
        .mockResolvedValueOnce(rawSession(sourceMetadata()))
        .mockResolvedValue(rawSession(
          sourceMetadata({ flavor: 'gemini', claudeSessionId: undefined, claudeTranscriptPath: undefined }),
          { metadataVersion: 8 },
        ));

      const result = await runSessionAgentTransition({ credentials, request: request() });

      expect(result).toEqual({
        type: 'partially_applied',
        localId: LOCAL_ID,
        applied: 'source_stopped',
        code: 'cutover_conflict',
      });
      expect(mocks.commitSessionAgentTransitionCutover).not.toHaveBeenCalled();
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
      expect(dividerPayload.content.data).toMatchObject({ type: 'message' });
      // Asserted through the CANONICAL reader, not a literal key. The sidecar key
      // and its schema have one owner; a writer that spells either of them itself
      // seals a row nothing downstream can recognize as a divider.
      expect(readSessionAgentTransitionDividerV1(dividerPayload.content.data)).toEqual({
        v: 1,
        fromAgentId: 'claude',
        toAgentId: 'codex',
        // The exact bound the brief was built from, recorded on the boundary it
        // created. Nothing else records it once the cutover lands — the seed
        // text is blanked the instant the target accepts it — so without it the
        // boundary can never be explained after the fact. This is a FRESH
        // target, so there is no lower bound to record beside it.
        sourceCutoffSeqInclusive: 100,
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

    it('does not reactivate an inactive target when the exact localId is already terminal', async () => {
      primeHappyPath();
      mocks.enqueuePendingQueueV2MessageViaHttp.mockResolvedValue({
        didWrite: false,
        terminal: true,
        suppressed: false,
      });

      const result = await runSessionAgentTransition({ credentials, request: request() });

      expect(result).toEqual({ type: 'accepted', localId: LOCAL_ID });
      expect(mocks.requestInactiveSessionResume).not.toHaveBeenCalled();
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

    function dividerLookup(
      payload: Record<string, unknown> | null,
      storedRecord: Readonly<{ role?: string; contentType?: string }> = {},
    ) {
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
                  role: storedRecord.role ?? 'agent',
                  content: {
                    type: storedRecord.contentType ?? 'event',
                    id: `agent-transition:${LOCAL_ID}`,
                    data: payload,
                  },
                },
              },
            },
          };
    }

    const matchingDivider = {
      type: 'message',
      message: 'Continued with another Agent.',
      sessionAgentTransitionV1: {
        v: 1,
        fromAgentId: 'claude',
        toAgentId: 'codex',
        sourceCutoffSeqInclusive: 29_979,
      },
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
          sessionAgentTransitionV1: {
            v: 1,
            fromAgentId: 'opencode',
            toAgentId: 'codex',
            sourceCutoffSeqInclusive: 29_979,
          },
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

    it('refuses a reserved-localId row whose stored payload is not an agent event', async () => {
      // The server's cutover owner will not call a stored row this transition's
      // divider unless it is a `role:'agent'` / `content.type:'event'` record.
      // This reader answers the same question over a row it decrypts itself, so
      // it applies the same two checks: a planted user-role (or non-event) row
      // carrying a matching sidecar must never be read as our own divider.
      for (const forged of [
        { role: 'user', contentType: 'event' },
        { role: 'agent', contentType: 'output' },
      ] as const) {
        primeAlreadyTargeted();
        mocks.findTranscriptEncryptedMessageByLocalIdV2.mockResolvedValue(
          dividerLookup(matchingDivider, forged),
        );

        const result = await runSessionAgentTransition({ credentials, request: request() });

        expect(result).toEqual({
          type: 'partially_applied',
          localId: LOCAL_ID,
          applied: 'current_view_committed',
          code: 'divider_unknown',
        });
        expect(mocks.enqueuePendingQueueV2MessageViaHttp).not.toHaveBeenCalled();
      }
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

  /**
   * The retrieval pointer.
   *
   * The brief is a bounded TAIL, and the target Agent has no way to learn that
   * the rest of the conversation is reachable, where it lives, or which slice it
   * is already holding — so it either works from the tail alone or pages the
   * transcript from the start and re-reads its own prompt.
   */
  describe('retrieval pointer', () => {
    function readRetrievalArgument(): {
      sessionId?: string;
      renderInvocation?: ((cursorSeq: number | null) => string) | null;
      nativeTranscriptPath?: string | null;
    } | null | undefined {
      return (mocks.resolveReplaySeedDraft.mock.calls[0]?.[0] as { retrieval?: never }).retrieval;
    }

    it('hands the Replay owner an invocation the TARGET Agent can actually run', async () => {
      primeHappyPath();

      await runSessionAgentTransition({ credentials, request: request() });

      const retrieval = readRetrievalArgument();
      expect(retrieval?.sessionId).toBe(SESSION_ID);
      expect(retrieval?.renderInvocation?.(4_200)).toContain('session.transcript.get');
      expect(retrieval?.renderInvocation?.(4_200)).toContain('"direction":"before"');
    });

    it('never names a native log this machine cannot open', async () => {
      // Claude prunes and rotates transcripts, so a recorded path routinely
      // outlives its file; pointing at it spends the reader's turn on nothing.
      // The fixture path does not exist, which is exactly that case.
      primeHappyPath();

      await runSessionAgentTransition({ credentials, request: request() });

      expect(readRetrievalArgument()?.nativeTranscriptPath).toBeNull();
    });

    it('carries the SOURCE Agent’s own session log while it is still in the current view', async () => {
      // The cutover projection clears the source Agent's continuity keys, so the
      // brief is the last reader that can see the log at all.
      const { mkdtempSync, writeFileSync } = await import('node:fs');
      const { tmpdir } = await import('node:os');
      const { join } = await import('node:path');
      const logPath = join(mkdtempSync(join(tmpdir(), 'happier-native-log-')), 'session.jsonl');
      writeFileSync(logPath, '{}\n');
      primeHappyPath(sourceMetadata({ claudeTranscriptPath: logPath }));

      await runSessionAgentTransition({ credentials, request: request() });

      expect(readRetrievalArgument()?.nativeTranscriptPath).toBe(logPath);
    });
  });

  /**
   * Same-machine native return (`AM-24`, `AM-26`).
   *
   * Two behaviours, and they are the whole feature:
   *
   * 1. A returning Agent RESUMES the native conversation it left rather than
   *    starting fresh. Observable in exactly one place: the committed target
   *    current view either carries that Agent's recorded vendor resume id or it
   *    does not, and the ordinary inactive-resume owner reads it from there.
   * 2. The replay handed to that returning Agent is BOUNDED by the transcript
   *    head it last saw, so it is told what happened while it was away instead
   *    of being re-sent a conversation it still holds.
   *
   * There is deliberately no continuity proof and no decision-time `stat()`: a
   * dead vendor id fails loudly at the first turn, as any Happier resume does.
   */
  describe('same-machine native return', () => {
    function readSeedSource(): Record<string, unknown> | undefined {
      return (mocks.resolveReplaySeedDraft.mock.calls[0]?.[0] as { source?: Record<string, unknown> })?.source;
    }

    function readCommittedTargetView(): Record<string, unknown> {
      const cutover = mocks.commitSessionAgentTransitionCutover.mock.calls[0]?.[0];
      return JSON.parse(cutover.currentView.metadataCiphertext) as Record<string, unknown>;
    }

    /**
     * The divider as it was actually COMMITTED, read through the single
     * canonical sidecar reader rather than by poking at the payload shape.
     */
    function readCommittedDivider() {
      const cutover = mocks.commitSessionAgentTransitionCutover.mock.calls[0]?.[0];
      const payload = cutover?.divider.content.v as { content: { data: Record<string, unknown> } } | undefined;
      return payload ? readSessionAgentTransitionDividerV1(payload.content.data) : null;
    }

    function codexSourceMetadata(): Record<string, unknown> {
      return {
        path: '/work/repo',
        host: 'mac',
        machineId: 'machine-1',
        flavor: 'codex',
        codexSessionId: 'codex-native-1',
        permissionMode: 'default',
      };
    }

    it('records the PRE-stop transcript head as the departing Agent boundary', async () => {
      // The head moves during the stop, and the two are not interchangeable: a
      // row that lands between the record and the confirmed stop may never have
      // reached the departing Agent. Over-estimating skips it PERMANENTLY;
      // under-estimating costs one re-replayed turn.
      const metadata = sourceMetadata();
      primeHappyPath(metadata);
      mocks.fetchSessionByIdCompat
        .mockResolvedValueOnce(rawSession(metadata, { seq: 100 }))
        .mockResolvedValue(rawSession(metadata, { seq: 140 }));

      await runSessionAgentTransition({ credentials, request: request() });

      expect(mocks.writeAgentNativeResumeRecord).toHaveBeenCalledWith({
        happierSessionId: SESSION_ID,
        agentId: 'claude',
        identity: { v: 1, vendorResumeId: 'claude-native-1' },
        departureSeqInclusive: 100,
      });
      // Control: the brief runs to the POST-stop head, so the fixture really
      // does distinguish the two.
      expect(readSeedSource()?.upToSeqInclusive).toBe(140);
    });

    it('writes the record before the stop, so a stop that never confirms cannot lose it', async () => {
      primeHappyPath();
      mocks.writeAgentNativeResumeRecord.mockImplementation(async () => {
        mocks.callOrder.push('record');
      });

      await runSessionAgentTransition({ credentials, request: request() });

      expect(mocks.callOrder.indexOf('record')).toBeGreaterThanOrEqual(0);
      expect(mocks.callOrder.indexOf('record')).toBeLessThan(mocks.callOrder.indexOf('stop'));
    });

    it('removes the record when the departing Agent has no resumable conversation', async () => {
      // A stale record left behind would let a later return resume a native
      // session this Session no longer corresponds to.
      primeHappyPath(sourceMetadata({ claudeSessionId: undefined }));

      await runSessionAgentTransition({ credentials, request: request() });

      expect(mocks.writeAgentNativeResumeRecord).toHaveBeenCalledWith(
        expect.objectContaining({ agentId: 'claude', identity: null }),
      );
    });

    it('keeps a valid record when the departing Agent is DISABLED in Account settings', async () => {
      // Disabling an Agent is transient and reversible; the conversation it
      // left behind is neither. A capture that evaluated launch policy wrote
      // `identity: null` here, DELETING the only copy of that continuity, and
      // re-enabling the Agent afterwards could never recover it. Whether a
      // recorded identity may be resumed is a RETURN decision, taken against
      // the settings that hold then.
      primeHappyPath();

      await runSessionAgentTransition({
        credentials,
        request: request(),
        deps: {
          readAccountSettings: () => ({
            backendEnabledByTargetKey: { 'agent:claude': false },
          }),
        },
      });

      expect(mocks.writeAgentNativeResumeRecord).toHaveBeenCalledWith(
        expect.objectContaining({
          agentId: 'claude',
          identity: { v: 1, vendorResumeId: 'claude-native-1' },
        }),
      );
    });

    it('never fails the transition over the record', async () => {
      primeHappyPath();
      mocks.writeAgentNativeResumeRecord.mockRejectedValue(new Error('disk is full'));

      const result = await runSessionAgentTransition({ credentials, request: request() });

      expect(result).toEqual({ type: 'accepted', localId: LOCAL_ID });
    });

    /**
     * The structurally impossible case, and the one that must never regress: a
     * FRESH target never ran this Session, so there is no record, therefore no
     * bound, therefore the FULL replay. There is no bound to starve it with.
     */
    it('hands the brief no bound and the target no resume id when the target is fresh', async () => {
      primeHappyPath();

      const result = await runSessionAgentTransition({ credentials, request: request() });

      expect(result).toEqual({ type: 'accepted', localId: LOCAL_ID });
      expect(mocks.readAgentNativeResumeRecord).toHaveBeenCalledWith({
        happierSessionId: SESSION_ID,
        agentId: 'codex',
      });
      expect(readSeedSource()).not.toHaveProperty('returningAgentLastSeenSeq');
      // And the boundary records no bound either: this one genuinely had none,
      // so a later rebuild of it IS the full replay.
      expect(readCommittedDivider()).not.toHaveProperty('returningAgentLastSeenSeqInclusive');
      const written = readCommittedTargetView();
      expect(written.flavor).toBe('codex');
      expect(written.codexSessionId).toBeUndefined();
      expect(written.claudeSessionId).toBeUndefined();
    });

    it('resumes the returning Agent conversation and bounds the replay to the away delta', async () => {
      primeHappyPath(codexSourceMetadata());
      mocks.readAgentNativeResumeRecord.mockResolvedValue({
        identity: { v: 1, vendorResumeId: 'claude-native-9' },
        departureSeqInclusive: 55,
      });

      const result = await runSessionAgentTransition({
        credentials,
        request: request({ expectedCurrentAgentId: 'codex', selection: { v: 1, agentId: 'claude' } }),
      });

      expect(result).toEqual({ type: 'accepted', localId: LOCAL_ID });
      expect(readSeedSource()?.returningAgentLastSeenSeq).toBe(55);
      // The SAME bound, recorded on the boundary it bounded. The brief's text is
      // blanked on acceptance and the departure record is overwritten by the
      // next departure, so a boundary that does not carry this can never be
      // explained again: every later rebuild replays the full prefix and shows
      // more than this Agent was handed.
      expect(readCommittedDivider()?.returningAgentLastSeenSeqInclusive).toBe(55);
      const written = readCommittedTargetView();
      expect(written.flavor).toBe('claude');
      // Written through the current-view projector, which is the only writer of
      // a flat resume key: exactly one Agent's key may be present.
      expect(written.claudeSessionId).toBe('claude-native-9');
      expect(written.codexSessionId).toBeUndefined();
    });

    it('refuses a recorded id the shared eligibility owner will not resume', async () => {
      // The record decides nothing on its own: whether an id may be resumed is
      // the ordinary inactive-resume question, answered by one owner.
      primeHappyPath(codexSourceMetadata());
      mocks.readAgentNativeResumeRecord.mockResolvedValue({
        identity: { v: 1, vendorResumeId: '   ' },
        departureSeqInclusive: 55,
      });

      const result = await runSessionAgentTransition({
        credentials,
        request: request({ expectedCurrentAgentId: 'codex', selection: { v: 1, agentId: 'claude' } }),
      });

      expect(result).toEqual({ type: 'accepted', localId: LOCAL_ID });
      expect(readSeedSource()).not.toHaveProperty('returningAgentLastSeenSeq');
      expect(readCommittedTargetView().claudeSessionId).toBeUndefined();
    });
  });
});
