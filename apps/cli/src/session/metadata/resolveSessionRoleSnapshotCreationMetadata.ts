import { readSessionRolesV1 } from '@happier-dev/protocol/prompts/roles/sessionRolesSnapshot';
import type { V2SessionByIdResponse } from '@happier-dev/protocol';

/**
 * A host snapshot carries a candidate memory reference, not Account authority.
 * The fresh HTTP creator uses its own authenticated Home projection to prove
 * that it also owns the lead. Missing or unreadable proof drops only that
 * reference; the complete role instructions and worker selection stay intact.
 */
export async function resolveSessionRoleSnapshotCreationMetadata(input: Readonly<{
  metadata: unknown;
  readLeadSession: (sessionId: string) => Promise<V2SessionByIdResponse['session'] | null>;
  signal?: AbortSignal;
}>): Promise<unknown> {
  input.signal?.throwIfAborted();
  const roles = readSessionRolesV1(input.metadata);
  if (!roles?.inheritedFrom || !roles.memoryDocRef) return input.metadata;
  let ownsLead = false;
  try {
    const lead = await input.readLeadSession(roles.inheritedFrom);
    input.signal?.throwIfAborted();
    ownsLead = lead?.id === roles.inheritedFrom && (
      lead.effectiveAccess
        ? lead.effectiveAccess.level === 'owner'
        : lead.metadataLayoutVersion === 1 && lead.share === null && lead.ownerMetadata !== undefined
    );
  } catch (error) {
    if (input.signal?.aborted) throw error;
  }
  if (ownsLead) return input.metadata;
  if (!input.metadata || typeof input.metadata !== 'object' || !('work' in input.metadata)) return input.metadata;
  const work = input.metadata.work;
  if (!work || typeof work !== 'object') return input.metadata;
  const { memoryDocRef: _memoryDocRef, ...safeRoles } = roles;
  return { ...input.metadata, work: { ...work, sessionRolesV1: safeRoles } };
}
