import type { ArtifactAccessGrantsListResponseV1 } from '@happier-dev/protocol/artifacts/artifactAccessV1';
import {
  qualifyTranscriptAccountActor,
  type TranscriptAccountActor,
} from '@happier-dev/session-core/messages';

/**
 * Project one requester-bound approval identity from the Artifact access owner.
 * Requester preparation owns a direct Account grant, so its presence is the
 * current relationship and its absence from an available roster is former.
 */
export function projectApprovalArtifactAccountActor(input: Readonly<{
  artifactId: string;
  serverId: string | null;
  accountId: string | null | undefined;
  accessGrants: ArtifactAccessGrantsListResponseV1 | null;
}>): TranscriptAccountActor | null {
  const accountId = input.accountId?.trim();
  if (!accountId || !input.serverId || !input.accessGrants
    || input.accessGrants.artifactId !== input.artifactId) return null;

  const grant = input.accessGrants.grants.find(row => (
    row.principal.kind === 'account' && row.principal.accountId === accountId
  ));
  const current = input.accessGrants.ownerAccountId === accountId || grant !== undefined;
  return qualifyTranscriptAccountActor({
    v: 1,
    accountId,
    accessibility: current ? 'current' : 'former',
    profile: grant ? {
      name: grant.display.name,
      firstName: null,
      lastName: null,
      username: grant.display.username ?? null,
      avatarUrl: null,
    } : null,
  }, input.serverId) ?? null;
}
