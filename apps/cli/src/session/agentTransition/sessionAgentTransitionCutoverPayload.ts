import {
  SESSION_AGENT_TRANSITION_DIVIDER_MESSAGE,
  SESSION_AGENT_TRANSITION_DIVIDER_SIDECAR_KEY,
  SessionAgentTransitionDividerV1Schema,
  SessionStoredMessageContentSchema,
  buildSessionAgentTransitionDividerLocalId,
  type AccountEncryptionCurrentnessResponse,
  type SessionAgentTransitionDividerV1,
  type SessionStoredMessageContent,
} from '@happier-dev/protocol';

import type { StoredCredentials } from '@/persistence';
import {
  prepareSessionMetadataTuplePatchForTransaction,
  readSessionMetadataTupleWriterSnapshot,
} from '@/session/metadata/updateSessionMetadataWithRetry';
import {
  encryptStoredSessionPayload,
  type SessionStoredContentCryptoContext,
} from '@/session/transport/encryption/sessionEncryptionContext';
import type {
  RawSessionRecord,
  SessionAgentTransitionCurrentViewWriteV1,
} from '@/session/transport/http/sessionsHttp';

/**
 * Sealing for the two cutover payloads the server command accepts.
 *
 * Both are built from the SAME already-projected target current view, so the
 * layout difference never reaches the transition coordinator's decision logic
 * and no second metadata mutator exists. Layout 1 reuses the shipped
 * `owner_inactive_model_intent` owner patch — including its inactive predicate
 * — rather than introducing a cutover-specific patch mode.
 */

export type SealSessionAgentTransitionCurrentViewResult =
  | Readonly<{ ok: true; currentView: SessionAgentTransitionCurrentViewWriteV1 }>
  | Readonly<{ ok: false }>;

export async function sealSessionAgentTransitionCurrentView(
  params: Readonly<{
    credentials: StoredCredentials;
    accountEncryptionCurrentness: AccountEncryptionCurrentnessResponse;
    rawSession: RawSessionRecord;
    projectTargetView: (
      metadata: Record<string, unknown>,
    ) => Record<string, unknown> | Promise<Record<string, unknown>>;
  }> & SessionStoredContentCryptoContext,
): Promise<SealSessionAgentTransitionCurrentViewResult> {
  const cryptoContext: SessionStoredContentCryptoContext = params;
  const layoutAwareRawSession = params.rawSession as unknown as Parameters<
    typeof readSessionMetadataTupleWriterSnapshot
  >[0]['rawSession'];
  try {
    const snapshot = readSessionMetadataTupleWriterSnapshot({
      credentials: params.credentials,
      accountEncryptionCurrentness: params.accountEncryptionCurrentness,
      rawSession: layoutAwareRawSession,
    });

    if (snapshot.mode === 'legacy_owner') {
      const targetMetadata = await params.projectTargetView(
        snapshot.value.metadata as Record<string, unknown>,
      );
      return {
        ok: true,
        currentView: {
          kind: 'legacy_v0',
          expectedMetadataVersion: snapshot.metadataVersion,
          metadataCiphertext: encryptStoredSessionPayload({
            ...cryptoContext,
            payload: targetMetadata,
          }),
          expectedAgentStateVersion: snapshot.agentStateVersion,
          // The target republishes its own AgentState; the transition never
          // carries the source runtime's projection forward.
          agentStateCiphertext: null,
        },
      };
    }

    const ownerPatch = await prepareSessionMetadataTuplePatchForTransaction({
      credentials: params.credentials,
      accountEncryptionCurrentness: params.accountEncryptionCurrentness,
      rawSession: layoutAwareRawSession,
      updater: params.projectTargetView,
    });
    return {
      ok: true,
      currentView: {
        kind: 'envelope_tuple_v1',
        ownerPatch: {
          ...ownerPatch,
          mode: 'owner_inactive_model_intent',
          sessionExpectation: { kind: 'inactive_model_intent' },
        },
      },
    };
  } catch {
    return { ok: false };
  }
}

export type SessionAgentTransitionDividerPayload = Readonly<{
  localId: string;
  sidecar: SessionAgentTransitionDividerV1;
  content: SessionStoredMessageContent;
}>;

/**
 * The divider is an ordinary `role:'agent'` / `content.type:'event'` transcript
 * record. Its payload rides the already-shipped `type:'message'` passthrough
 * arm with the strict `sessionAgentTransitionV1` sidecar, so a released older
 * reader still renders truthful prose.
 *
 * Content is a pure function of the committed target view, which is exactly
 * what makes a retry byte-identical and therefore idempotent at the canonical
 * message owner.
 */
export function buildSessionAgentTransitionDividerPayload(
  params: Readonly<{
    submittedLocalId: string;
    fromAgentId: string;
    toAgentId: string;
    /**
     * The post-stop transcript cutoff U the activation pass observed. It stays
     * U when the pass produces no dialog; `0` is valid only when U itself is
     * zero.
     *
     * Required at the schema too, not just here: nothing else records the pass's
     * upper bound once the cutover lands — `replaySeedV1.seedText` is blanked
     * the instant the target accepts it — so a writer that may omit it is a
     * writer that can silently make the boundary unexplainable. A sidecar
     * without it does not read as a divider at all.
     */
    sourceCutoffSeqInclusive: number;
    /**
     * The native-return departure bound this transition replayed FROM, or
     * `null` for a fresh target that had none.
     *
     * The cutoff above is the pass's upper bound; on a native return the pass
     * also had a lower one, and the delta between them is the whole handoff.
     * That bound lives only in this machine's departure record, which the next
     * departure overwrites, so recording it on the boundary it bounded is what
     * keeps the handoff reconstructable at all.
     *
     * `null` is written as an ABSENT key, not as a stored null: absence is
     * already the fresh target's meaning at the schema, and a second spelling
     * for the same fact is a state every reader would have to collapse.
     */
    returningAgentLastSeenSeqInclusive: number | null;
  }> & SessionStoredContentCryptoContext,
): SessionAgentTransitionDividerPayload {
  const cryptoContext: SessionStoredContentCryptoContext = params;
  const localId = buildSessionAgentTransitionDividerLocalId(params.submittedLocalId);
  const sidecar = SessionAgentTransitionDividerV1Schema.parse({
    v: 1,
    fromAgentId: params.fromAgentId,
    toAgentId: params.toAgentId,
    sourceCutoffSeqInclusive: params.sourceCutoffSeqInclusive,
    ...(params.returningAgentLastSeenSeqInclusive === null
      ? {}
      : { returningAgentLastSeenSeqInclusive: params.returningAgentLastSeenSeqInclusive }),
  });
  const payload = {
    role: 'agent',
    content: {
      type: 'event',
      id: localId,
      data: {
        type: 'message',
        message: SESSION_AGENT_TRANSITION_DIVIDER_MESSAGE,
        [SESSION_AGENT_TRANSITION_DIVIDER_SIDECAR_KEY]: sidecar,
      },
    },
  };
  const content = SessionStoredMessageContentSchema.parse(
    params.mode === 'plain'
      ? { t: 'plain', v: payload }
      : {
          t: 'encrypted',
          c: encryptStoredSessionPayload({ ...cryptoContext, payload }),
        },
  );
  return { localId, sidecar, content };
}
