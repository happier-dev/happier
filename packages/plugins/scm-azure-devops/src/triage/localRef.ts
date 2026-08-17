import type { TriageSourceEntryLocalRefV1 } from '@happier-dev/triage-protocol/v1';

import { AZURE_DEVOPS_TRIAGE_KIND_ID } from './descriptor.js';
import { buildAzureCollisionScope, isAzureGuid } from './identity.js';
import type { AzureDevOpsOrigin } from './types.js';

/** The native routing facts a valid Azure local ref carries, once proven against this base. */
export type AzureEntryAddress = Readonly<{
  repositoryId: string;
  pullRequestId: number;
}>;

const ENTRY_ID_PATTERN = /^[1-9][0-9]*$/u;

/**
 * Validate one local ref against the exact configured instance it arrived with.
 *
 * `CONTRACT.md` §3 puts this comparison beside the source's own identity builder: the target
 * validates only the public grammar and the declared kind, and cannot parse a source token or
 * repeat the derivation. The scope is therefore rebuilt from the configured base plus the ref's
 * own repository GUID and compared byte-for-byte, so a ref minted against a different
 * deployment — or against a name rather than a GUID — cannot route through this instance.
 */
export function parseAzureEntryLocalRef(
  localRef: TriageSourceEntryLocalRefV1,
  origin: AzureDevOpsOrigin,
): AzureEntryAddress | null {
  if (localRef.kindId !== AZURE_DEVOPS_TRIAGE_KIND_ID) return null;

  const separator = localRef.collisionScope.lastIndexOf(':');
  if (separator < 0) return null;
  const repositoryId = localRef.collisionScope.slice(separator + 1);
  if (!isAzureGuid(repositoryId)) return null;

  const expected = buildAzureCollisionScope({ origin, repositoryId });
  if (expected === null || expected !== localRef.collisionScope) return null;

  if (!ENTRY_ID_PATTERN.test(localRef.entryId)) return null;
  const pullRequestId = Number(localRef.entryId);
  if (!Number.isSafeInteger(pullRequestId) || pullRequestId <= 0) return null;

  return { repositoryId: repositoryId.trim().toLowerCase(), pullRequestId };
}
