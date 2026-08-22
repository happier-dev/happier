import type {
  SessionAgentTransitionBriefPreviewRequestV1,
  SessionAgentTransitionBriefPreviewV1,
} from '@happier-dev/protocol';

import type { StoredCredentials } from '@/persistence';
import { resolveSessionTransportContext } from '@/session/services/resolveSessionTransportContext';
import { tryDecryptSessionOwnerMetadataView } from '@/session/transport/encryption/sessionEncryptionContext';

import {
  buildBoundedActivationBrief,
  type BuildSessionAgentTransitionActivationBrief,
} from './buildSessionAgentTransitionActivationBrief';

export type PreviewSessionAgentTransitionBriefDeps = Readonly<{
  resolveSessionTransportContext: typeof resolveSessionTransportContext;
  decryptOwnerMetadataView: typeof tryDecryptSessionOwnerMetadataView;
  buildActivationBrief: BuildSessionAgentTransitionActivationBrief;
}>;

const DEFAULT_DEPS: PreviewSessionAgentTransitionBriefDeps = {
  resolveSessionTransportContext,
  decryptOwnerMetadataView: tryDecryptSessionOwnerMetadataView,
  buildActivationBrief: buildBoundedActivationBrief,
};

/**
 * Rebuilds the activation brief a transition divider stands for.
 *
 * There is nothing stored to show. `replaySeedV1.seedText` is blanked the
 * instant the target Agent accepts it, and the metadata record holds one seed
 * per Session, so a twice-switched Session has already lost the first. What
 * survives is the divider's own BOUNDS, and running the SAME bounded pass
 * between them reproduces the brief without persisting a second copy of the
 * conversation.
 *
 * `buildActivationBrief` is the shipped default deliberately — the same owner
 * the transition itself runs, not a preview-shaped copy of it. A second
 * composition here could show a brief the target Agent was never sent, and a
 * surface whose whole claim is "this is what it received" must not be free to
 * disagree with the thing that sent it.
 *
 * What can and cannot be reconstructed is not the same question, and the two
 * answers are handled differently:
 *
 * - the transcript prefix is genuinely recoverable, because the divider recorded
 *   the cutoff. It is read as it stands NOW, so a later rollback or retention
 *   trim changes what the pass can see — a reconstruction, and callers must
 *   present it as one;
 * - the departing Agent's own current projections are NOT recoverable, so they
 *   are omitted rather than approximated. `sessionWorkStateV1` and the
 *   catalog-declared native-log proof are Agent-scoped current state: the
 *   cutover cleared the departing Agent's values and the Agent that took over
 *   republishes into the same durable keys, so today's view holds the CURRENT
 *   Agent's live work and — after a switch back — that Agent's newer native
 *   session. Nothing per-boundary survives to tell them apart: the divider
 *   carries only the cutoff and the Agent pair. Handing them down would put
 *   content that never crossed the boundary inside a card whose whole claim is
 *   that it did, so `departingAgentCurrentView: null` drops both halves and the
 *   card states the omission;
 * - the DELTA BOUNDARY of a native return IS recoverable, because the divider
 *   records it beside the cutoff. It could not be re-derived: it lives in the
 *   returning Agent's device-local departure record, which the very next
 *   departure overwrites, and the cutoff is a different number by construction.
 *   Rebuilding without it replayed the FULL prefix to the cutoff for a boundary
 *   that only ever sent the away-delta — a card showing MORE than was handed
 *   over, which fails the one claim this surface makes. Absent on a fresh
 *   target, whose boundary genuinely had no lower bound.
 *
 * Read-only: it resolves transport, decrypts owner metadata and reads the
 * transcript. It writes nothing, reserves nothing and grants no authority.
 */
export async function previewSessionAgentTransitionBrief(params: Readonly<{
  credentials: StoredCredentials;
  request: SessionAgentTransitionBriefPreviewRequestV1;
  deps?: Partial<PreviewSessionAgentTransitionBriefDeps>;
}>): Promise<SessionAgentTransitionBriefPreviewV1> {
  const deps: PreviewSessionAgentTransitionBriefDeps = { ...DEFAULT_DEPS, ...params.deps };

  const transport = await deps.resolveSessionTransportContext({
    credentials: params.credentials,
    idOrPrefix: params.request.sessionId,
  }).catch(() => null);
  // The Session is not addressable from this machine at all: not a readable
  // source with nothing in it, and not a transport hiccup either.
  if (!transport?.ok) return { type: 'unavailable', reason: 'unsupported_session' };

  const metadata = deps.decryptOwnerMetadataView({
    credentials: params.credentials,
    rawSession: transport.rawSession,
    accountEncryptionMode: transport.accountEncryptionCurrentness.mode,
  });
  // No readable owner metadata means no `path`, which the brief builder needs
  // and which it would itself report as unavailable. Saying so here keeps the
  // two answers identical rather than letting one arm invent a different one.
  if (!metadata) return { type: 'unavailable', reason: 'source_unreadable' };

  // The seam is allowed to be synchronous, so the call itself is inside the
  // guard: `Promise.resolve(fn()).catch(...)` never sees a synchronous throw,
  // and this preview must not be able to fail its own read-only request.
  const brief = await (async () => {
    try {
      return await deps.buildActivationBrief({
        credentials: params.credentials,
        // The transport owner resolves prefixes; the brief must be built for
        // the Session it actually opened, not the string the caller typed.
        sessionId: transport.sessionId,
        transcriptHeadSeqInclusive: params.request.sourceCutoffSeqInclusive,
        // The boundary's LOWER bound, exactly as the divider recorded it, so a
        // native return rebuilds the away-delta it actually sent rather than
        // the whole prefix. Absent for a fresh target, which is the full replay
        // that boundary really was.
        ...(typeof params.request.returningAgentLastSeenSeqInclusive === 'number'
          ? { returningAgentLastSeenSeq: params.request.returningAgentLastSeenSeqInclusive }
          : {}),
        sourceMetadata: metadata,
        // Today's view is not the departing Agent's, and no read can turn it
        // back into one — see the omission clause above.
        departingAgentCurrentView: null,
        // The boundary's own pair, as the DIVIDER records them — not whichever
        // Agent runs the Session today. The retrieval pointer names a tool
        // channel that only the arriving Agent has, and the source id names the
        // departing Agent's own session log, so a Session switched again since
        // would compose a brief addressed to the wrong reader and present it as
        // the one that was sent. The current-Agent read this replaced was only
        // correct while the request carried no ids.
        sourceAgentId: params.request.sourceAgentId,
        targetAgentId: params.request.targetAgentId,
      });
    } catch {
      return { status: 'unavailable' } as const;
    }
  })();

  if (brief.status !== 'available') return { type: 'unavailable', reason: 'source_unreadable' };
  const briefText = brief.seed?.seedText ?? '';
  // An `available` brief with no seed is the empty source: the pass ran and the
  // prefix carried nothing replayable. That is a different sentence from "we
  // could not read it", and merging them would tell the reader nothing crossed
  // a boundary that plenty may have crossed.
  if (!briefText) return { type: 'empty', protocolVersion: 1 };
  return { type: 'rebuilt', protocolVersion: 1, briefText };
}
