import { beforeEach, describe, expect, it, vi } from 'vitest';
import { FeaturesResponseSchema } from '@happier-dev/protocol';

const mocks = vi.hoisted(() => ({
  fetchAccountMachineReplacements: vi.fn(),
}));

vi.mock('@/api/machine/fetchAccountMachineReplacements', () => ({
  fetchAccountMachineReplacements: mocks.fetchAccountMachineReplacements,
}));

const {
  runSessionAgentTransition,
} = await import('./sessionAgentTransitionCoordinator');
type SessionAgentTransitionDeps =
  import('./sessionAgentTransitionCoordinator').SessionAgentTransitionDeps;
const {
  buildAgentCatalogContribution,
  buildRawSession,
  buildTransitionRequest,
  createTransitionDepsHarness,
  TEST_CREDENTIALS,
  TEST_LOCAL_ID,
  TEST_SESSION_ID,
  TEST_SESSION_SEQ,
  CLAUDE_SOURCE_METADATA,
} = await import('./sessionAgentTransitionTestkit');
const { resolveCliFeatureDecision } = await import('@/features/featureDecisionService');

function resolveAgentSwitchingDecision(serverSnapshot?: Parameters<typeof resolveCliFeatureDecision>[0]['serverSnapshot']) {
  return resolveCliFeatureDecision({
    featureId: 'sessions.agentSwitching',
    env: {} as NodeJS.ProcessEnv,
    serverSnapshot,
  });
}

beforeEach(() => {
  mocks.fetchAccountMachineReplacements.mockReset();
  mocks.fetchAccountMachineReplacements.mockResolvedValue([{ id: 'machine-1' }, { id: 'machine-2' }]);
});

/**
 * The recorded machine is NOT a gate on the transition.
 *
 * A machine-id comparison is only a PROXY for "can this Session be continued
 * here", and the components that actually know already answer it: the stop owner
 * finds no local process for a Session that is not here and reports it, an
 * absent DEVICE-LOCAL native-return record already degrades to a full replay,
 * the cutover is server-side and machine-agnostic, and activating the target
 * succeeds or fails on this host loudly. The proxy was wrong in both directions,
 * so refusing on it removed real capability to prevent nothing.
 */
describe('runSessionAgentTransition — the recorded machine is not a gate', () => {
  it('runs for a Session recorded against another machine, without reading the account chain', async () => {
    const harness = createTransitionDepsHarness();
    harness.deps.resolveSessionTransportContext = vi.fn(async () => ({
      ok: true as const,
      sessionId: TEST_SESSION_ID,
      rawSession: buildRawSession({ machineId: 'machine-2' }),
      accountEncryptionCurrentness: { mode: 'plain' },
      ctx: null,
      mode: 'plain' as const,
    })) as never;
    harness.setMetadata({ ...CLAUDE_SOURCE_METADATA, machineId: 'machine-2' });

    const result = await runSessionAgentTransition({
      credentials: TEST_CREDENTIALS,
      request: buildTransitionRequest(),
      deps: harness.deps,
    });

    expect(result).toEqual({ type: 'accepted', localId: TEST_LOCAL_ID });
    expect(mocks.fetchAccountMachineReplacements).not.toHaveBeenCalled();
  });
});

describe('runSessionAgentTransition — pre-stop failures leave the source untouched (QA-T-03)', () => {
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
      const resolveCliFeatureDecisionForServer = vi.fn(async () => ({
        decision: resolveAgentSwitchingDecision(serverSnapshot),
      }));
      const harness = createTransitionDepsHarness({ resolveCliFeatureDecisionForServer });

      const result = await runSessionAgentTransition({
        credentials: TEST_CREDENTIALS,
        request: buildTransitionRequest(),
        deps: harness.deps,
      });

      expect(result).toEqual({ type: 'rejected', code: 'unsupported_operation', sourceEffect: 'none' });
      expect(resolveCliFeatureDecisionForServer).toHaveBeenCalledWith(expect.objectContaining({
        featureId: 'sessions.agentSwitching',
        serverUrl: 'http://server.test',
      }));
      expect(harness.calls).toEqual([]);
      expect(harness.deps.waitForSessionIdle).not.toHaveBeenCalled();
      expect(harness.deps.callSessionProviderInputAdmission).not.toHaveBeenCalled();
      expect(harness.deps.requestSessionStop).not.toHaveBeenCalled();
      expect(harness.deps.applySessionAgentTransitionCutover).not.toHaveBeenCalled();
      expect(harness.deps.sendSessionMessage).not.toHaveBeenCalled();
    },
  );

  it('rejects a stale current Agent without stopping, quiescing, or writing anything', async () => {
    const harness = createTransitionDepsHarness();
    harness.setMetadata({ ...CLAUDE_SOURCE_METADATA, flavor: 'codex', codexSessionId: 'codex-9' });

    const result = await runSessionAgentTransition({
      credentials: TEST_CREDENTIALS,
      // Expected `claude`, target `gemini`: the Session is already `codex`, so
      // this is neither a no-op nor a retry of a committed cutover.
      request: buildTransitionRequest({ selection: { v: 1, agentId: 'gemini' } }),
      deps: harness.deps,
    });

    expect(result).toEqual({ type: 'rejected', code: 'stale_selection', sourceEffect: 'none' });
    expect(harness.calls).not.toContain('stop');
    expect(harness.calls).not.toContain('cutover');
    expect(harness.calls).not.toContain('send');
    expect(harness.deps.callSessionProviderInputAdmission).not.toHaveBeenCalled();
  });

  it('rejects an unresolvable target through the catalog before any effect', async () => {
    const harness = createTransitionDepsHarness();

    const result = await runSessionAgentTransition({
      credentials: TEST_CREDENTIALS,
      request: buildTransitionRequest({ selection: { v: 1, agentId: 'not-a-catalog-agent' } }),
      deps: harness.deps,
    });

    expect(result).toEqual({ type: 'rejected', code: 'target_unavailable', sourceEffect: 'none' });
    expect(harness.calls).toEqual(['resolveTransport']);
  });

  it('rejects a definitely missing Provider selection before idle, fencing, native records, or stop', async () => {
    const definitiveRejection = vi.fn(async () => ({ ok: false as const }));
    const harness = createTransitionDepsHarness({
      resolveCurrentProviderSpawnDefinitiveRejection: definitiveRejection as never,
    });
    const selection = {
      v: 1 as const,
      agentId: 'codex',
      modelId: 'model-a',
      providerConnectionId: 'pc_missing',
    };

    const result = await runSessionAgentTransition({
      credentials: TEST_CREDENTIALS,
      request: buildTransitionRequest({ selection }),
      deps: harness.deps,
    });

    expect(result).toEqual({ type: 'rejected', code: 'target_unavailable', sourceEffect: 'none' });
    expect(definitiveRejection).toHaveBeenCalledWith({
      agentTargetKey: 'backend:codex',
      agentId: 'codex',
      selection,
    });
    expect(harness.calls).toEqual(['resolveTransport']);
    expect(harness.deps.waitForSessionIdle).not.toHaveBeenCalled();
    expect(harness.deps.callSessionProviderInputAdmission).not.toHaveBeenCalled();
    expect(harness.deps.localAgentNativeResumeRecordStore.writeAgentNativeResumeRecord).not.toHaveBeenCalled();
    expect(harness.deps.requestSessionStop).not.toHaveBeenCalled();
    expect(harness.deps.applySessionAgentTransitionCutover).not.toHaveBeenCalled();
    expect(harness.deps.requestInactiveSessionResume).not.toHaveBeenCalled();
    expect(harness.deps.sendSessionMessage).not.toHaveBeenCalled();
  });

  /**
   * A bundled Agent can be a current, identified, representable catalog
   * contribution and still have NO Sessions surface — `deepsec` and
   * `coderabbit` declare `primary: 'executionRuns'`. Catalog membership and
   * representability therefore do not answer "can this Agent host a Session",
   * and a direct RPC on the open wire can name one. The refusal has to land
   * here, in front of the stop, because a target discovered at activation time
   * is discovered after the source is already gone.
   */
  it('refuses a target Agent with no Sessions surface before the source is stopped', async () => {
    const harness = createTransitionDepsHarness({
      readAgentCatalogSnapshot: vi.fn(() => ({
        agentDefinitionsById: new Map([
          ['claude', buildAgentCatalogContribution({ id: 'claude' })],
          ['deepsec', buildAgentCatalogContribution({ id: 'deepsec', primary: 'executionRuns' })],
        ]),
        catalogEntriesById: {},
      })) as never,
    });

    const result = await runSessionAgentTransition({
      credentials: TEST_CREDENTIALS,
      request: buildTransitionRequest({ selection: { v: 1, agentId: 'deepsec' } }),
      deps: harness.deps,
    });

    expect(result).toEqual({ type: 'rejected', code: 'target_unavailable', sourceEffect: 'none' });
    // The whole point of the arm: nothing was quiesced, stopped, or written.
    expect(harness.calls).toEqual(['resolveTransport']);
    expect(harness.deps.requestSessionStop).not.toHaveBeenCalled();
    expect(harness.deps.callSessionProviderInputAdmission).not.toHaveBeenCalled();
  });

  it('rejects a non-idle source and reopens nothing, because no fence was installed', async () => {
    const harness = createTransitionDepsHarness({
      waitForSessionIdle: vi.fn(async () => ({ ok: false as const, code: 'timeout' as const })),
    });

    const result = await runSessionAgentTransition({
      credentials: TEST_CREDENTIALS,
      request: buildTransitionRequest(),
      deps: harness.deps,
    });

    expect(result).toEqual({ type: 'rejected', code: 'source_not_idle', sourceEffect: 'none' });
    expect(harness.deps.callSessionProviderInputAdmission).not.toHaveBeenCalled();
    expect(harness.deps.requestSessionStop).not.toHaveBeenCalled();
  });

  it('reopens the exact epoch fence when currentness is lost after quiesce but before stop', async () => {
    const harness = createTransitionDepsHarness();
    let transportCall = 0;
    harness.deps.resolveSessionTransportContext = vi.fn(async () => {
      transportCall += 1;
      harness.calls.push('resolveTransport');
      return {
        ok: true as const,
        sessionId: 'session-1',
        rawSession: { id: 'session-1', machineId: 'machine-1', seq: 42, active: false, archivedAt: null },
        accountEncryptionCurrentness: { mode: 'plain' },
        ctx: null,
        mode: 'plain' as const,
      };
    }) as never;
    harness.deps.decryptOwnerMetadataView = vi.fn(() => (
      // Preflight sees `claude`; the pre-stop recheck sees a concurrent switch.
      transportCall <= 1
        ? { ...CLAUDE_SOURCE_METADATA }
        : { ...CLAUDE_SOURCE_METADATA, flavor: 'gemini', claudeSessionId: undefined }
    )) as never;

    const result = await runSessionAgentTransition({
      credentials: TEST_CREDENTIALS,
      request: buildTransitionRequest(),
      deps: harness.deps,
    });

    expect(result).toEqual({ type: 'rejected', code: 'stale_selection', sourceEffect: 'none' });
    expect(harness.calls).toEqual([
      'resolveTransport',
      'waitForIdle',
      'admission:enforce',
      'resolveTransport',
      'admission:clear',
    ]);
    expect(harness.deps.requestSessionStop).not.toHaveBeenCalled();
  });

  it('rejects the same Agent as a no-op only when the caller also expected it', async () => {
    const harness = createTransitionDepsHarness();

    const result = await runSessionAgentTransition({
      credentials: TEST_CREDENTIALS,
      request: buildTransitionRequest({
        expectedCurrentAgentId: 'claude',
        selection: { v: 1, agentId: 'claude' },
      }),
      deps: harness.deps,
    });

    expect(result).toEqual({ type: 'rejected', code: 'same_target', sourceEffect: 'none' });
    expect(harness.calls).toEqual(['resolveTransport']);
  });
});

describe('runSessionAgentTransition — exact input admission by localId (QA-T-08)', () => {
  it('accepts only after canonical admission acknowledges that exact localId', async () => {
    const harness = createTransitionDepsHarness();

    const result = await runSessionAgentTransition({
      credentials: TEST_CREDENTIALS,
      request: buildTransitionRequest(),
      deps: harness.deps,
    });

    expect(result).toEqual({ type: 'accepted', localId: TEST_LOCAL_ID });
    expect(harness.deps.sendSessionMessage).toHaveBeenCalledTimes(1);
    expect(harness.deps.sendSessionMessage).toHaveBeenCalledWith(
      expect.objectContaining({ localId: TEST_LOCAL_ID, message: 'continue please' }),
    );
  });

  it('does not reactivate an inactive target when canonical admission says the localId is terminal', async () => {
    const harness = createTransitionDepsHarness({
      sendSessionMessage: vi.fn(async () => ({
        ok: true as const,
        sessionId: TEST_SESSION_ID,
        localId: TEST_LOCAL_ID,
        waited: false,
        terminal: true as const,
      })) as never,
    });

    const result = await runSessionAgentTransition({
      credentials: TEST_CREDENTIALS,
      request: buildTransitionRequest(),
      deps: harness.deps,
    });

    expect(result).toEqual({ type: 'accepted', localId: TEST_LOCAL_ID });
    expect(harness.deps.requestInactiveSessionResume).not.toHaveBeenCalled();
  });

  it('never reports accepted when the canonical owner acknowledges a different localId', async () => {
    const harness = createTransitionDepsHarness({
      sendSessionMessage: vi.fn(async () => ({
        ok: true as const,
        sessionId: 'session-1',
        localId: 'some-other-local-id',
        waited: false,
      })) as never,
    });

    const result = await runSessionAgentTransition({
      credentials: TEST_CREDENTIALS,
      request: buildTransitionRequest(),
      deps: harness.deps,
    });

    expect(result).toEqual({
      type: 'partially_applied',
      localId: TEST_LOCAL_ID,
      applied: 'current_view_committed',
      code: 'input_admission_failed',
    });
  });

  it('reports a definite canonical rejection as input_rejected, never as rejected', async () => {
    const harness = createTransitionDepsHarness({
      sendSessionMessage: vi.fn(async () => ({
        ok: false as const,
        code: 'admission_rejected' as const,
        admissionResult: { status: 'rejected' as const, code: 'session_input_invalid' as const },
      })) as never,
    });

    const result = await runSessionAgentTransition({
      credentials: TEST_CREDENTIALS,
      request: buildTransitionRequest(),
      deps: harness.deps,
    });

    expect(result).toEqual({
      type: 'partially_applied',
      localId: TEST_LOCAL_ID,
      applied: 'current_view_committed',
      code: 'input_rejected',
    });
  });

  it('retrying after outcome_unknown admits the same localId exactly once', async () => {
    // First pass: the cutover transport is ambiguous, so the daemon cannot name
    // an effect and never reaches admission.
    const first = createTransitionDepsHarness({
      applySessionAgentTransitionCutover: vi.fn(async () => ({
        ok: false as const,
        effect: 'unknown' as const,
        error: 'transport' as const,
      })),
    });
    const firstResult = await runSessionAgentTransition({
      credentials: TEST_CREDENTIALS,
      request: buildTransitionRequest(),
      deps: first.deps,
    });
    expect(firstResult).toEqual({ type: 'outcome_unknown', localId: TEST_LOCAL_ID });
    expect(first.deps.sendSessionMessage).not.toHaveBeenCalled();

    // Retry: the cutover HAD landed. The Session already names the target, so
    // the retry reconciles instead of switching again, and admits the SAME
    // localId once.
    const retry = createTransitionDepsHarness({
      findTranscriptMessageByLocalId: vi.fn(async () => ({
        type: 'found' as const,
        message: {
          id: 'm1',
          seq: 77,
          localId: `agent-transition:${TEST_LOCAL_ID}`,
          sidechainId: null,
          createdAt: 1,
          updatedAt: 1,
          content: {
            t: 'plain',
            v: {
              role: 'agent',
              content: {
                type: 'event',
                id: `agent-transition:${TEST_LOCAL_ID}`,
                data: {
                  type: 'message',
                  message: 'Continued with another Agent.',
                  sessionAgentTransitionV1: {
                    v: 1,
                    fromAgentId: 'claude',
                    toAgentId: 'codex',
                    sourceCutoffSeqInclusive: 29_979,
                  },
                },
              },
            },
          },
        },
      })) as never,
    });
    retry.setMetadata({ flavor: 'codex', machineId: 'machine-1', codexSessionId: 'codex-1' });

    const retryResult = await runSessionAgentTransition({
      credentials: TEST_CREDENTIALS,
      request: buildTransitionRequest(),
      deps: retry.deps,
    });

    expect(retryResult).toEqual({ type: 'accepted', localId: TEST_LOCAL_ID });
    expect(retry.deps.sendSessionMessage).toHaveBeenCalledTimes(1);
    // A retry must never repeat the switch.
    expect(retry.deps.requestSessionStop).not.toHaveBeenCalled();
    expect(retry.deps.applySessionAgentTransitionCutover).not.toHaveBeenCalled();
  });

  it('reports a committed cutover with no usable divider row as divider_unavailable on retry', async () => {
    const harness = createTransitionDepsHarness();
    harness.setMetadata({ flavor: 'codex', machineId: 'machine-1', codexSessionId: 'codex-1' });

    const result = await runSessionAgentTransition({
      credentials: TEST_CREDENTIALS,
      request: buildTransitionRequest(),
      deps: harness.deps,
    });

    expect(result).toEqual({
      type: 'partially_applied',
      localId: TEST_LOCAL_ID,
      applied: 'current_view_committed',
      code: 'divider_unavailable',
    });
    expect(harness.deps.sendSessionMessage).not.toHaveBeenCalled();
  });
});

describe('runSessionAgentTransition — target model intent', () => {
  function readSealedMetadata(currentView: unknown): Record<string, unknown> {
    const view = currentView as { metadataCiphertext?: unknown };
    return JSON.parse(String(view.metadataCiphertext)) as Record<string, unknown>;
  }

  /**
   * The transport is a boundary double, but the payload it receives is the code
   * under test: this captures the sealed current view so the projection can be
   * read back for real.
   */
  function createCutoverCapture() {
    const captured: { currentView: unknown } = { currentView: null };
    const applySessionAgentTransitionCutover = vi.fn(async (input: { currentView: unknown }) => {
      captured.currentView = input.currentView;
      return { ok: true as const, dividerSeq: 77 };
    }) as unknown as SessionAgentTransitionDeps['applySessionAgentTransitionCutover'];
    return { applySessionAgentTransitionCutover, captured };
  }

  it('commits an explicit CLEAR when the armed switch chose no model', async () => {
    const cutover = createCutoverCapture();
    const harness = createTransitionDepsHarness({
      applySessionAgentTransitionCutover: cutover.applySessionAgentTransitionCutover,
    });
    harness.setMetadata({
      ...CLAUDE_SOURCE_METADATA,
      modelSelectionIntentV1: {
        v: 1,
        updatedAt: 1,
        selection: {
          agentTargetKey: 'builtInAgent:claude',
          providerConnectionId: null,
          modelId: 'claude-haiku-4-5',
        },
      },
    });

    await runSessionAgentTransition({
      credentials: TEST_CREDENTIALS,
      // No `modelId`: the reader picked the Agent row and no model.
      request: buildTransitionRequest({ selection: { v: 1, agentId: 'codex' } }),
      deps: harness.deps,
    });

    expect(cutover.applySessionAgentTransitionCutover).toHaveBeenCalled();
    const sealed = readSealedMetadata(cutover.captured.currentView);
    // Deleting the key is indistinguishable from "never set", so the source
    // Agent's model id stayed the newest surviving opinion in every
    // timestamp-arbitrated reader (the composer chip and the target's spawn).
    // A cleared intent carries the cutover timestamp and can be observed.
    expect(sealed.modelSelectionIntentV1).toEqual({
      v: 1,
      updatedAt: expect.any(Number),
      selection: null,
    });
    // Strictly newer than the source Agent's selection, so a timestamp arbiter
    // holding that selection locally must adopt the clear.
    expect((sealed.modelSelectionIntentV1 as { updatedAt: number }).updatedAt).toBeGreaterThan(1);
    // The legacy carrier gets the same fact through its own reset sentinel, so a
    // reader still on `modelOverrideV1` sees the clear rather than an absent key.
    expect((sealed.modelOverrideV1 as { modelId: string }).modelId).toBe('default');
  });

  it('commits the chosen target model when the armed switch named one', async () => {
    const cutover = createCutoverCapture();
    const harness = createTransitionDepsHarness({
      applySessionAgentTransitionCutover: cutover.applySessionAgentTransitionCutover,
    });

    await runSessionAgentTransition({
      credentials: TEST_CREDENTIALS,
      request: buildTransitionRequest({
        selection: { v: 1, agentId: 'codex', modelId: 'gpt-5.6-luna' },
      }),
      deps: harness.deps,
    });

    const sealed = readSealedMetadata(cutover.captured.currentView);
    expect((sealed.modelSelectionIntentV1 as { selection: { modelId: string } }).selection.modelId)
      .toBe('gpt-5.6-luna');
  });

  /**
   * A connected-service binding is Agent-scoped: it names a `serviceId` the
   * SOURCE Agent's catalog declares, and every reader resolves it against the
   * Session's CURRENT Agent. Carried across the cutover in the predecessor tree,
   * `openai-codex`/`codex6` survived a switch to `claude`: the daemon
   * spawn-preflighted the wrong service's credential, the target runtime's
   * registration reconciled to
   * `generation_application_scope_service_unsupported`, and `/session-started`
   * answered 503 twenty times until the freshly started target died with the
   * Session already committed to the target Agent.
   */
  describe('target connected-service binding', () => {
    const SOURCE_BOUND = {
      ...CLAUDE_SOURCE_METADATA,
      connectedServices: {
        v: 1,
        bindingsByServiceId: {
          'claude-subscription': { source: 'connected', selection: 'profile', profileId: 'team' },
        },
      },
      connectedServicesUpdatedAt: 11,
      connectedServiceMaterializationIdentityV1: {
        v: 1,
        id: 'csm_source',
        createdAt: 1,
        source: 'first_spawn',
      },
    };

    it('rebinds the target from the account default instead of carrying the source binding', async () => {
      const cutover = createCutoverCapture();
      const harness = createTransitionDepsHarness({
        applySessionAgentTransitionCutover: cutover.applySessionAgentTransitionCutover,
        resolveSpawnConnectedServicesDefaults: (async () => ({
          connectedServices: {
            v: 1,
            bindingsByServiceId: {
              'openai-codex': { source: 'connected', selection: 'group', groupId: 'happier' },
            },
          },
          connectedServicesUpdatedAt: 4_000,
        })) as unknown as SessionAgentTransitionDeps['resolveSpawnConnectedServicesDefaults'],
      });
      harness.setMetadata({ ...SOURCE_BOUND });

      await runSessionAgentTransition({
        credentials: TEST_CREDENTIALS,
        request: buildTransitionRequest(),
        deps: harness.deps,
      });

      const sealed = readSealedMetadata(cutover.captured.currentView);
      const bindings = (sealed.connectedServices as { bindingsByServiceId: Record<string, unknown> })
        .bindingsByServiceId;
      expect(bindings['claude-subscription']).toBeUndefined();
      expect(bindings['openai-codex']).toEqual({ source: 'connected', selection: 'group', groupId: 'happier' });
      expect(sealed.connectedServicesUpdatedAt).toBe(4_000);
      // The materialized credential home is per-binding; reusing the source's id
      // would point the target at the departed Agent's home.
      expect(sealed.connectedServiceMaterializationIdentityV1).not.toMatchObject({ id: 'csm_source' });
    });

    it('leaves the target on native auth when the Account configures no default for it', async () => {
      const cutover = createCutoverCapture();
      const harness = createTransitionDepsHarness({
        applySessionAgentTransitionCutover: cutover.applySessionAgentTransitionCutover,
      });
      harness.setMetadata({ ...SOURCE_BOUND });

      await runSessionAgentTransition({
        credentials: TEST_CREDENTIALS,
        request: buildTransitionRequest(),
        deps: harness.deps,
      });

      const sealed = readSealedMetadata(cutover.captured.currentView);
      expect(sealed.connectedServices).toBeUndefined();
      expect(sealed.connectedServicesUpdatedAt).toBeUndefined();
      expect(sealed.connectedServiceMaterializationIdentityV1).toBeUndefined();
    });

    it('degrades to native rather than failing a transition whose source is already stopped', async () => {
      const cutover = createCutoverCapture();
      const harness = createTransitionDepsHarness({
        applySessionAgentTransitionCutover: cutover.applySessionAgentTransitionCutover,
        resolveSpawnConnectedServicesDefaults: (async () => {
          throw new Error('connected_services_default_settings_invalid');
        }) as unknown as SessionAgentTransitionDeps['resolveSpawnConnectedServicesDefaults'],
      });
      harness.setMetadata({ ...SOURCE_BOUND });

      const result = await runSessionAgentTransition({
        credentials: TEST_CREDENTIALS,
        request: buildTransitionRequest(),
        deps: harness.deps,
      });

      expect(result).toMatchObject({ type: 'accepted' });
      const sealed = readSealedMetadata(cutover.captured.currentView);
      expect(sealed.connectedServices).toBeUndefined();
    });
  });
});

/**
 * The transition's storage gate.
 *
 * A Session whose transcript lives with an external Agent cannot be continued
 * in place, and the coordinator refuses it. The refusal read the metadata
 * through a nullable helper that returned `null` for THREE different facts —
 * "no link", "malformed link", "two rows disagree" — so a Session with an
 * unusable link passed the gate as if it had no link at all and the coordinator
 * went on to quiesce and STOP the source runtime. The gate must require
 * `persisted` positively; both unresolved shapes produce zero source effect.
 */
describe('runSessionAgentTransition — an unresolved external link is not "hosted here"', () => {
  const UNRESOLVED_LINKS = [
    [
      'a malformed canonical link',
      {
        externalSessionV1: {
          v: 1,
          agentId: 'codex',
          machineId: 'machine-1',
          remoteSessionId: 'remote-1',
          source: { kind: 'codexHome', home: 'user' },
          followStatusV1: { v: 1, status: 'not-a-status', updatedAtMs: 10 },
        },
      },
    ],
    [
      'dual rows requiring reconciliation',
      {
        externalSessionV1: {
          v: 1,
          agentId: 'codex',
          machineId: 'machine-1',
          remoteSessionId: 'remote-1',
          source: { kind: 'codexHome', home: 'user' },
        },
        directSessionV1: {
          v: 1,
          agentId: 'claude',
          machineId: 'machine-legacy',
          remoteSessionId: 'remote-legacy',
          source: { kind: 'claudeConfig', configDir: '/tmp/claude' },
        },
      },
    ],
  ] as const;

  it.each(UNRESOLVED_LINKS)(
    'rejects with zero source effect when the source carries %s',
    async (_label, link) => {
      const harness = createTransitionDepsHarness();
      harness.setMetadata({ ...CLAUDE_SOURCE_METADATA, ...link });

      const result = await runSessionAgentTransition({
        credentials: TEST_CREDENTIALS,
        request: buildTransitionRequest(),
        deps: harness.deps,
      });

      expect(result).toEqual({ type: 'rejected', code: 'unsupported_operation', sourceEffect: 'none' });
      expect(harness.calls).toEqual(['resolveTransport']);
      expect(harness.deps.waitForSessionIdle).not.toHaveBeenCalled();
      expect(harness.deps.callSessionProviderInputAdmission).not.toHaveBeenCalled();
      expect(harness.deps.requestSessionStop).not.toHaveBeenCalled();
      expect(harness.deps.applySessionAgentTransitionCutover).not.toHaveBeenCalled();
      expect(harness.deps.sendSessionMessage).not.toHaveBeenCalled();
    },
  );
});
