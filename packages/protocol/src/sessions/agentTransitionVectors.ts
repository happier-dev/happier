/**
 * Shared protocol vectors for same-Session cross-Agent continuation.
 *
 * This file is BYTE-IDENTICAL in both trees and imports nothing, so "the two
 * trees agree on the wire" is provable by diffing it and by each tree parsing
 * the same data through its own local schemas.
 *
 * successor: packages/protocol/src/sessions/agentTransitionVectors.ts
 * predecessor: packages/protocol/src/sessionAgentTransitionVectors.ts
 *
 * `valid` entries MUST parse; `invalid` entries MUST be rejected. Do not edit a
 * vector to make an implementation pass — a vector change is a wire change.
 */
export const SESSION_AGENT_TRANSITION_VECTORS = {
  schema: 'happier.sessionAgentTransition.v1',

  selection: {
    valid: {
      minimal: { v: 1, agentId: 'claude' },
      withModel: { v: 1, agentId: 'codex', modelId: 'gpt-5' },
      withProviderConnection: {
        v: 1,
        agentId: 'codex',
        modelId: 'gpt-5',
        providerConnectionId: 'conn_01',
      },
      nullableClears: {
        v: 1,
        agentId: 'claude',
        providerConnectionId: null,
        acpSessionModeId: null,
      },
      withModeAndOverrides: {
        v: 1,
        agentId: 'gemini',
        modelId: 'gemini-3-pro',
        acpSessionModeId: 'default',
        sessionConfigOptionOverrides: {
          v: 1,
          updatedAt: 1_760_000_000_000,
          overrides: {
            reasoning_effort: { updatedAt: 1_760_000_000_000, value: 'high' },
          },
        },
      },
    },
    invalid: {
      /** `providerConnectionId` requires an explicit `modelId`. */
      providerConnectionWithoutModel: { v: 1, agentId: 'codex', providerConnectionId: 'conn_01' },
      /** The selection object is closed. */
      unknownKey: { v: 1, agentId: 'claude', backendTarget: { kind: 'builtInAgent' } },
      blankAgentId: { v: 1, agentId: '   ' },
      missingVersion: { agentId: 'claude' },
      wrongVersion: { v: 2, agentId: 'claude' },
    },
  },

  request: {
    valid: {
      minimal: {
        v: 1,
        sessionId: 'sess_01',
        expectedCurrentAgentId: 'codex',
        selection: { v: 1, agentId: 'claude' },
        input: { text: 'keep going', localId: 'local_01', meta: {} },
      },
    },
    invalid: {
      /** `localId` is the dedupe, divider-correlation, and compare-clear key. */
      missingInputLocalId: {
        v: 1,
        sessionId: 'sess_01',
        expectedCurrentAgentId: 'codex',
        selection: { v: 1, agentId: 'claude' },
        input: { text: 'keep going', meta: {} },
      },
      blankInputLocalId: {
        v: 1,
        sessionId: 'sess_01',
        expectedCurrentAgentId: 'codex',
        selection: { v: 1, agentId: 'claude' },
        input: { text: 'keep going', localId: '   ', meta: {} },
      },
      /** The outer request is closed: no native path, resume id, or snapshot. */
      unknownOuterKey: {
        v: 1,
        sessionId: 'sess_01',
        expectedCurrentAgentId: 'codex',
        selection: { v: 1, agentId: 'claude' },
        input: { text: 'keep going', localId: 'local_01', meta: {} },
        vendorResumeId: 'abc',
      },
      missingExpectedCurrentAgentId: {
        v: 1,
        sessionId: 'sess_01',
        selection: { v: 1, agentId: 'claude' },
        input: { text: 'keep going', localId: 'local_01', meta: {} },
      },
    },
  },

  result: {
    valid: {
      accepted: { type: 'accepted', localId: 'local_01' },

      /** Every `rejected` code is pre-effect, so `sourceEffect` is always `none`. */
      rejectedUnsupportedOperation: {
        type: 'rejected', code: 'unsupported_operation', sourceEffect: 'none',
      },
      rejectedForbidden: { type: 'rejected', code: 'forbidden', sourceEffect: 'none' },
      rejectedSameTarget: { type: 'rejected', code: 'same_target', sourceEffect: 'none' },
      rejectedStaleSelection: { type: 'rejected', code: 'stale_selection', sourceEffect: 'none' },
      rejectedTargetUnavailable: {
        type: 'rejected', code: 'target_unavailable', sourceEffect: 'none',
      },
      rejectedSourceNotIdle: { type: 'rejected', code: 'source_not_idle', sourceEffect: 'none' },
      /**
       * The one stop outcome whose `sourceEffect: 'none'` is truthful: the stop
       * result PROVED the source is still running.
       */
      rejectedSourceStopFailed: {
        type: 'rejected', code: 'source_stop_failed', sourceEffect: 'none',
      },

      /**
       * Source confirmed stopped, nothing committed. Session is still the
       * SOURCE Agent: safe actions are resume-source or retry, not
       * resume-target.
       */
      partialContextUnavailable: {
        type: 'partially_applied',
        localId: 'local_01',
        applied: 'source_stopped',
        code: 'context_unavailable',
      },
      partialCutoverConflict: {
        type: 'partially_applied',
        localId: 'local_01',
        applied: 'source_stopped',
        code: 'cutover_conflict',
      },

      /** Session IS the target Agent. The UI must not offer "Keep editing". */
      partialDividerMissing: {
        type: 'partially_applied',
        localId: 'local_01',
        applied: 'current_view_committed',
        code: 'divider_missing',
      },
      partialTargetStartFailed: {
        type: 'partially_applied',
        localId: 'local_01',
        applied: 'current_view_committed',
        code: 'target_start_failed',
      },
      /**
       * A row EXISTS at the reserved localId carrying a different transition
       * payload. Distinct from `divider_missing`: the boundary is present but
       * untrustworthy, so retry re-derives the same conflict and the bounded
       * context pass must not stop at it.
       */
      partialDividerConflict: {
        type: 'partially_applied',
        localId: 'local_01',
        applied: 'current_view_committed',
        code: 'divider_conflict',
      },
      partialInputAdmissionFailed: {
        type: 'partially_applied',
        localId: 'local_01',
        applied: 'current_view_committed',
        code: 'input_admission_failed',
      },
      partialInputRejected: {
        type: 'partially_applied',
        localId: 'local_01',
        applied: 'current_view_committed',
        code: 'input_rejected',
      },

      /**
       * Genuinely indeterminate — an unconfirmed stop, or facts that cannot
       * establish whether cutover happened. It carries NO code: every state the
       * daemon can name rides `rejected` or `partially_applied`.
       */
      unknownBare: { type: 'outcome_unknown', localId: 'local_01' },
    },
    invalid: {
      /** A code reachable with the source already stopped may never ride `rejected`. */
      rejectedCarryingPostStopCode: {
        type: 'rejected', code: 'cutover_conflict', sourceEffect: 'none',
      },
      rejectedCarryingInputRejected: {
        type: 'rejected', code: 'input_rejected', sourceEffect: 'none',
      },
      rejectedCarryingUnknownCode: {
        type: 'rejected', code: 'reconciliation_required', sourceEffect: 'none',
      },
      /** `rejected` cannot claim a source effect. */
      rejectedWithSourceEffect: {
        type: 'rejected', code: 'forbidden', sourceEffect: 'current_view_committed',
      },
      /** `applied` has exactly two depths; nothing else is a known partial state. */
      partialWithUnknownAppliedDepth: {
        type: 'partially_applied',
        localId: 'local_01',
        applied: 'divider_appended',
        code: 'cutover_conflict',
      },
      /** A pre-commit code cannot claim a committed view ... */
      committedCarryingPreCommitCode: {
        type: 'partially_applied',
        localId: 'local_01',
        applied: 'current_view_committed',
        code: 'context_unavailable',
      },
      /** ... and a post-commit code cannot claim nothing was committed. */
      sourceStoppedCarryingCommittedCode: {
        type: 'partially_applied',
        localId: 'local_01',
        applied: 'source_stopped',
        code: 'target_start_failed',
      },
      /** A partial outcome always identifies the input it was carrying. */
      partialWithoutLocalId: {
        type: 'partially_applied', applied: 'current_view_committed', code: 'divider_missing',
      },
      /** `outcome_unknown` carries no code at all — it cannot name a cause. */
      unknownCarryingRejectedCode: {
        type: 'outcome_unknown', localId: 'local_01', code: 'forbidden',
      },
      unknownCarryingStopCode: {
        type: 'outcome_unknown', localId: 'local_01', code: 'source_stop_failed',
      },
      unknownCarryingPartialCode: {
        type: 'outcome_unknown', localId: 'local_01', code: 'cutover_conflict',
      },
      unknownArm: { type: 'pending', localId: 'local_01' },
    },
  },

  inspection: {
    request: {
      valid: {
        minimal: { v: 1, sourceSessionId: 'sess_01', selection: { v: 1, agentId: 'claude' } },
      },
      invalid: {
        unknownKey: {
          v: 1,
          sourceSessionId: 'sess_01',
          selection: { v: 1, agentId: 'claude' },
          machineId: 'm1',
        },
      },
    },
    valid: {
      /** The successor's full depth. */
      allSupported: {
        type: 'available',
        protocolVersion: 1,
        sameSessionTransition: true,
        nativeReturn: true,
      },
      /** The predecessor minimum: fresh target, no native return. */
      predecessorMinimum: {
        type: 'available',
        protocolVersion: 1,
        sameSessionTransition: true,
        nativeReturn: false,
      },
      noneSupported: {
        type: 'available',
        protocolVersion: 1,
        sameSessionTransition: false,
        nativeReturn: false,
      },
      unavailableOperation: { type: 'unavailable', reason: 'operation_unavailable' },
      unavailableSession: { type: 'unavailable', reason: 'unsupported_session' },
      unavailableTarget: { type: 'unavailable', reason: 'target_unavailable' },
    },
    invalid: {
      /** Every support flag is required: a missing flag must not read as `false`. */
      missingFlag: {
        type: 'available',
        protocolVersion: 1,
        sameSessionTransition: true,
      },
      unknownFlag: {
        type: 'available',
        protocolVersion: 1,
        sameSessionTransition: true,
        nativeReturn: true,
        transcriptExport: true,
      },
      unknownReason: { type: 'unavailable', reason: 'machine_offline' },
      wrongProtocolVersion: {
        type: 'available',
        protocolVersion: 2,
        sameSessionTransition: true,
        nativeReturn: true,
      },
    },
    /**
     * METHOD_NOT_AVAILABLE collapses "old daemon" and "unreachable machine".
     * The client disambiguates with the machine-presence fact it already holds.
     */
    unavailablePresentation: [
      { reason: 'operation_unavailable', machinePresence: 'online', expected: 'update_cli' },
      { reason: 'operation_unavailable', machinePresence: 'offline', expected: 'machine_offline' },
      {
        reason: 'operation_unavailable',
        machinePresence: 'unknown',
        expected: 'update_or_reconnect',
      },
      { reason: 'unsupported_session', machinePresence: 'online', expected: 'unsupported_session' },
      {
        reason: 'unsupported_session',
        machinePresence: 'offline',
        expected: 'unsupported_session',
      },
      { reason: 'target_unavailable', machinePresence: 'offline', expected: 'target_unavailable' },
    ],
  },

  divider: {
    localIdPrefix: 'agent-transition:',
    sidecarKey: 'sessionAgentTransitionV1',
    message: 'Continued with another Agent.',
    submittedLocalId: 'local_01',
    expectedLocalId: 'agent-transition:local_01',
    reservedLocalIds: ['agent-transition:local_01', 'agent-transition:'],
    unreservedLocalIds: ['local_01', 'agent-transition', 'x-agent-transition:local_01'],
    payload: {
      valid: {
        minimal: { v: 1, fromAgentId: 'codex', toAgentId: 'claude' },
      },
      invalid: {
        unknownKey: { v: 1, fromAgentId: 'codex', toAgentId: 'claude', modelId: 'gpt-5' },
        missingTo: { v: 1, fromAgentId: 'codex' },
        blankFrom: { v: 1, fromAgentId: '  ', toAgentId: 'claude' },
        wrongVersion: { v: 2, fromAgentId: 'codex', toAgentId: 'claude' },
      },
    },
    /**
     * The divider as it appears on the wire: the EXISTING passthrough
     * `type:'message'` agent-event arm, never a new `AgentEventSchema` variant.
     */
    agentEvent: {
      type: 'message',
      message: 'Continued with another Agent.',
      sessionAgentTransitionV1: { v: 1, fromAgentId: 'codex', toAgentId: 'claude' },
    },
    /** An ordinary message event must not be read as a divider. */
    plainMessageAgentEvent: { type: 'message', message: 'Continued with another Agent.' },
    /** A malformed sidecar is ignored rather than half-trusted. */
    malformedSidecarAgentEvent: {
      type: 'message',
      message: 'Continued with another Agent.',
      sessionAgentTransitionV1: { v: 1, fromAgentId: 'codex' },
    },
  },

  sourceContext: {
    valid: {
      latest: {
        v: 1,
        kind: 'session_replay',
        sourceSessionId: 'sess_01',
        forkPoint: { type: 'latest' },
      },
      exactSeq: {
        v: 1,
        kind: 'session_replay',
        sourceSessionId: 'sess_01',
        forkPoint: { type: 'seq', upToSeqInclusive: 42 },
      },
    },
    invalid: {
      /** The cutoff is `SessionForkPoint`. There is no `throughSeqInclusive`. */
      inventedCutoffField: {
        v: 1,
        kind: 'session_replay',
        sourceSessionId: 'sess_01',
        forkPoint: { type: 'seq', throughSeqInclusive: 42 },
      },
      unknownKind: {
        v: 1,
        kind: 'session_transcript',
        sourceSessionId: 'sess_01',
        forkPoint: { type: 'latest' },
      },
      unknownKey: {
        v: 1,
        kind: 'session_replay',
        sourceSessionId: 'sess_01',
        forkPoint: { type: 'latest' },
        agentId: 'claude',
      },
      missingForkPoint: { v: 1, kind: 'session_replay', sourceSessionId: 'sess_01' },
    },
  },

  fork: {
    /** `native` is the generic "no Replay fallback" intent. */
    strategies: ['auto', 'native', 'provider_native', 'acp_fork_latest', 'replay'],
    valid: {
      nativeIntent: {
        v: 1,
        parentSessionId: 'sess_01',
        forkPoint: { type: 'latest' },
        strategy: 'native',
      },
      /** The predecessor already ships `requestId`; the successor must accept it. */
      withRequestId: {
        v: 1,
        parentSessionId: 'sess_01',
        forkPoint: { type: 'seq', upToSeqInclusive: 7 },
        strategy: 'replay',
        requestId: 'req_01',
      },
    },
    invalid: {
      unknownStrategy: {
        v: 1,
        parentSessionId: 'sess_01',
        forkPoint: { type: 'latest' },
        strategy: 'native_only',
      },
      blankRequestId: {
        v: 1,
        parentSessionId: 'sess_01',
        forkPoint: { type: 'latest' },
        requestId: '   ',
      },
    },
  },

  composerIntent: {
    valid: {
      minimal: {
        v: 1,
        mode: 'same_session',
        sourceAgentId: 'codex',
        selection: { v: 1, agentId: 'claude' },
      },
    },
    invalid: {
      /** No acknowledgment flag, timer, TTL, operation id, or progress phase. */
      acknowledgedFlag: {
        v: 1,
        mode: 'same_session',
        sourceAgentId: 'codex',
        selection: { v: 1, agentId: 'claude' },
        acknowledged: true,
      },
      unknownMode: {
        v: 1,
        mode: 'new_session',
        sourceAgentId: 'codex',
        selection: { v: 1, agentId: 'claude' },
      },
      /** Review reasons are derived at read time, never persisted on the intent. */
      persistedReviewReason: {
        v: 1,
        mode: 'same_session',
        sourceAgentId: 'codex',
        selection: { v: 1, agentId: 'claude' },
        reviewReason: 'restored_draft',
      },
    },
  },

  /**
   * Matched provider-native resume identity (successor only — the predecessor
   * discards inactive native state). The proof is nested inside the value
   * carrying the id so the two can never be written independently.
   */
  nativeResumeIdentity: {
    valid: {
      bareId: { v: 1, vendorResumeId: 'sess-abc', continuityProof: null },
      withTranscriptProof: {
        v: 1,
        vendorResumeId: 'sess-abc',
        continuityProof: { kind: 'transcriptPath', value: '/home/u/.claude/projects/x/sess-abc.jsonl' },
      },
    },
    invalid: {
      /** A proof may never be written without the id it belongs to. */
      proofWithoutId: {
        v: 1,
        continuityProof: { kind: 'transcriptPath', value: '/tmp/x.jsonl' },
      },
      /** Absent proof must be an explicit null, not an omission. */
      omittedProof: { v: 1, vendorResumeId: 'sess-abc' },
      /** Proof kinds are catalog-declared, never free-form. */
      unknownProofKind: {
        v: 1,
        vendorResumeId: 'sess-abc',
        continuityProof: { kind: 'sessionFile', value: '/tmp/x.jsonl' },
      },
      /** No second, independently-writable proof field. */
      siblingProofField: {
        v: 1,
        vendorResumeId: 'sess-abc',
        continuityProof: null,
        continuityProofValue: '/tmp/x.jsonl',
      },
      blankId: { v: 1, vendorResumeId: '   ', continuityProof: null },
    },
    /** The released bare-string identity still reads as a proofless pair. */
    legacyBareString: 'sess-abc',
  },
} as const;
