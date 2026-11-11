import { readFile } from 'node:fs/promises';
import { isDeepStrictEqual } from 'node:util';
import * as z from 'zod/mini';

import { WorkspaceSyncRelationshipV1Schema } from '@happier-dev/protocol/sessions/control/handoff/workspaceSyncSchemas';
import { writeJsonAtomic } from '@/utils/fs/writeJsonAtomic';

const identity = () => z.string().check(z.minLength(1));
const requesterCopyCustodySchema = z.strictObject({
  accountServerId: identity(),
  actorAccountId: identity(),
  sourceWriter: z.strictObject({ machineId: identity(), installationId: identity() }),
  sourceWorkspace: z.strictObject({ id: identity(), machineId: identity(), rootPath: identity() }),
  target: z.strictObject({ machineId: identity(), installationId: identity() }),
  relationship: WorkspaceSyncRelationshipV1Schema,
});

/** Identity of an admitted native copy, never credentials or a replayable admission. */
export type WorkspaceSyncRequesterCopyCustody = z.infer<typeof requesterCopyCustodySchema>;

// V1 readers matched the owned fields and tolerated unrelated record metadata.
const basisSchema = z.object({
  relationshipId: identity(),
  endpointRole: z.enum(['alpha', 'beta']),
  targetWorkspaceRefId: identity(),
  canonicalRoot: identity(),
  rootFingerprint: identity(),
  policyDigest: identity(),
  completedAtMs: z.number(),
});
const readyFactSchema = z.discriminatedUnion('v', [
  z.extend(basisSchema, { v: z.literal(1) }),
  z.extend(basisSchema, { v: z.literal(2), requesterCopyCustody: requesterCopyCustodySchema }),
]);

export type WorkspaceSyncFinalReadyFact = z.infer<typeof readyFactSchema>;
type WithoutCompletion<T> = T extends unknown ? Omit<T, 'completedAtMs'> : never;
export type WorkspaceSyncFinalReadyFactInput = WithoutCompletion<WorkspaceSyncFinalReadyFact>;
export type WorkspaceSyncFinalReadyBasis = Omit<z.infer<typeof basisSchema>, 'completedAtMs'>;

export async function readWorkspaceSyncFinalReadyFactAtPath(path: string): Promise<WorkspaceSyncFinalReadyFact | null> {
  const raw = await readFile(path, 'utf8').catch(() => null);
  if (raw === null) return null;
  try {
    const parsed = readyFactSchema.safeParse(JSON.parse(raw) as unknown);
    return parsed.success ? parsed.data : null;
  } catch { return null; }
}

export function matchesWorkspaceSyncFinalReadyFact(fact: WorkspaceSyncFinalReadyFact, expected: WorkspaceSyncFinalReadyBasis & Readonly<{
  requesterCopyCustody?: WorkspaceSyncRequesterCopyCustody;
}>): boolean {
  return fact.relationshipId === expected.relationshipId
    && fact.endpointRole === expected.endpointRole
    && fact.targetWorkspaceRefId === expected.targetWorkspaceRefId
    && fact.canonicalRoot === expected.canonicalRoot
    && fact.rootFingerprint === expected.rootFingerprint
    && fact.policyDigest === expected.policyDigest
    && (expected.requesterCopyCustody === undefined
      ? fact.v === 1
      : fact.v === 2 && isDeepStrictEqual(fact.requesterCopyCustody, expected.requesterCopyCustody));
}

export async function writeWorkspaceSyncFinalReadyFact(path: string, fact: WorkspaceSyncFinalReadyFactInput): Promise<void> {
  await writeJsonAtomic(path, { ...fact, completedAtMs: Date.now() });
}
