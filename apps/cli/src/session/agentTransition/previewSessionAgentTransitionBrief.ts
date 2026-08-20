import type {
  SessionAgentTransitionBriefPreviewRequestV1,
  SessionAgentTransitionBriefPreviewV1,
} from '@happier-dev/protocol';

import type { Credentials } from '@/persistence';
import { resolveSessionTransportContext } from '@/session/services/resolveSessionTransportContext';
import { tryDecryptSessionMetadata } from '@/session/transport/encryption/sessionEncryptionContext';

import { buildSessionAgentTransitionActivationBrief } from './buildSessionAgentTransitionActivationBrief';

export type PreviewSessionAgentTransitionBriefDeps = Readonly<{
  resolveSessionTransportContext: typeof resolveSessionTransportContext;
  decryptSessionMetadata: typeof tryDecryptSessionMetadata;
  buildActivationBrief: typeof buildSessionAgentTransitionActivationBrief;
}>;

const DEFAULT_DEPS: PreviewSessionAgentTransitionBriefDeps = {
  resolveSessionTransportContext,
  decryptSessionMetadata: tryDecryptSessionMetadata,
  buildActivationBrief: buildSessionAgentTransitionActivationBrief,
};

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function readNonEmptyString(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

/**
 * Rebuilds the activation brief a transition divider stands for.
 *
 * There is nothing stored to show. `replaySeedV1.seedText` is blanked the
 * instant the target Agent accepts it, and the metadata record holds one seed
 * per Session, so a twice-switched Session has already lost the first. What
 * survives is the divider's `sourceCutoffSeqInclusive`, and running the SAME
 * bounded pass over the same bound reproduces the brief without persisting a
 * second copy of the conversation.
 *
 * The brief owner is the shipped default deliberately — the same one the
 * transition itself runs, not a preview-shaped copy. A second composition here
 * could show a brief the target Agent was never sent, and a surface whose whole
 * claim is "this is what it received" must not be free to disagree with the
 * thing that sent it.
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
 *   catalog-declared native-log path are Agent-scoped current state: the cutover
 *   cleared the departing Agent's values and the Agent that took over
 *   republishes into the same durable keys, so today's view holds the CURRENT
 *   Agent's live work and — after a switch back — that Agent's newer native
 *   session. Nothing per-boundary survives to tell them apart: the divider
 *   carries only the cutoff and the Agent pair. Handing them down would put
 *   content that never crossed the boundary inside a card whose whole claim is
 *   that it did, so `departingAgentCurrentView: null` drops both halves and the
 *   card states the omission.
 *
 * Read-only: it resolves transport, decrypts Session metadata and reads the
 * transcript. It writes nothing, reserves nothing and grants no authority.
 */
export async function previewSessionAgentTransitionBrief(params: Readonly<{
  credentials: Credentials;
  request: SessionAgentTransitionBriefPreviewRequestV1;
  deps?: Partial<PreviewSessionAgentTransitionBriefDeps>;
}>): Promise<SessionAgentTransitionBriefPreviewV1> {
  const deps: PreviewSessionAgentTransitionBriefDeps = { ...DEFAULT_DEPS, ...params.deps };

  const sessionTarget = await deps.resolveSessionTransportContext({
    credentials: params.credentials,
    idOrPrefix: params.request.sessionId,
  }).catch(() => null);
  // The Session is not addressable from this machine at all: not a readable
  // source with nothing in it, and not a transport hiccup either.
  if (!sessionTarget?.ok) return { type: 'unavailable', reason: 'unsupported_session' };

  const metadata = asRecord(deps.decryptSessionMetadata({
    credentials: params.credentials,
    rawSession: sessionTarget.rawSession,
  }));
  const workspacePath = metadata ? readNonEmptyString(metadata.path) : null;
  // No readable metadata means no workspace path, which the brief owner needs
  // for both the retrieval pointer and the summary seam.
  if (!metadata || !workspacePath) return { type: 'unavailable', reason: 'source_unreadable' };

  // The recorded ids are passed through as they stand. A divider outlives the
  // catalog, and the brief owner already degrades an id it no longer knows to
  // "no native transcript path" / "no retrieval invocation" — so rejecting one
  // here would refuse to explain a boundary that is still perfectly true.
  // The owner is allowed to be synchronous at its seam, so the call itself is
  // inside the guard: this read-only preview must not be able to fail its own
  // request, and an authentication error is still an unreadable source here
  // rather than something the reader of a transcript card can act on.
  const brief = await (async () => {
    try {
      return await deps.buildActivationBrief({
        credentials: params.credentials,
        // The transport owner resolves prefixes; the brief must be built for
        // the Session it actually opened, not the string the caller typed.
        sessionId: sessionTarget.sessionId,
        sourceAgentId: params.request.sourceAgentId,
        targetAgentId: params.request.targetAgentId,
        workspacePath,
        // Today's view is not the departing Agent's, and no read can turn it
        // back into one — see the omission clause above.
        departingAgentCurrentView: null,
        transcriptHeadSeqInclusive: params.request.sourceCutoffSeqInclusive,
      });
    } catch {
      return { status: 'unavailable' } as const;
    }
  })();

  // A pass that ran and found nothing replayable is a different sentence from
  // "we could not read it", and merging them would tell the reader nothing
  // crossed a boundary that plenty may have crossed.
  if (brief.status === 'no_source_dialog') return { type: 'empty', protocolVersion: 1 };
  if (brief.status !== 'seeded') return { type: 'unavailable', reason: 'source_unreadable' };
  return { type: 'rebuilt', protocolVersion: 1, briefText: brief.seedDraft };
}
