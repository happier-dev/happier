import type { SessionRuntimeIssueV1 } from '@happier-dev/protocol/sessions/control/runtimeIssueV1';
import type { MessageMeta } from '@happier-dev/session-core/messages';

/** Already admitted by the canonical stored-message parser; no owner-only metadata is needed. */
export function readRuntimeIssueMessageMeta(meta: MessageMeta | null | undefined): SessionRuntimeIssueV1 | null {
  return meta?.source === 'runtime' ? meta.runtimeIssueV1 ?? null : null;
}

/**
 * True for a message the host's failure projector committed (`runtimeFailureTranscript.ts`): a typed
 * turn failure or input rejection that rides the ordinary agent-message body. The message meta schema
 * keeps its typed issue; older records retain `source` and `runtimeIssueCode`.
 */
export function isRuntimeIssueMessageMeta(meta: MessageMeta | null | undefined): boolean {
  return readRuntimeIssueMessageMeta(meta) !== null
    || (meta?.source === 'runtime' && typeof meta.runtimeIssueCode === 'string');
}
