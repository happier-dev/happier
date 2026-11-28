import { basename, isAbsolute, join } from 'node:path';

import type {
  VerifyResumeReachableInput,
  VerifyResumeReachableResult,
} from '@/backends/connectedServices/verifyResumeReachableTypes';
import {
  buildPiResumeSearchRoots,
  findPiSessionFileForId,
  matchesPiSessionFileIdentity,
  pathExistsAsFile,
  resolveExpectedPiSessionIdForResume,
  resolvePiSessionIdFromResumeReference,
} from '@/backends/pi/utils/piSessionFiles';

function asNonEmptyString(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/**
 * Provider reachability probe for Pi: is the vendor session file for `vendorResumeId` present in a
 * place Pi reads on resume — OR in a native/source root that the switch will import before spawn
 * (D8)? Search roots come from the SHARED `buildPiResumeSearchRoots`, which includes the native
 * `~/.pi/agent/sessions/--<cwd>--` root. This closes the VG-8 false negative: a native→connected
 * switch (target env has no `PI_CODING_AGENT_DIR` yet) is now proven reachable from the native file
 * that exists on disk, instead of fail-closing a supported switch.
 *
 * IMPORTANT: a positive answer means "reachable from a source the switch WILL import" — necessary
 * but not sufficient on its own. The spawn path performs a HARD post-materialization re-verify
 * against the real materialized env before launching Pi (see `resolveConnectedServiceAuthForSpawn`),
 * so a failed/mis-encoded import surfaces as a structured error, never a bare "Pi process exited".
 *
 * When `input.targetStrict` is set (the §2 spawn gate), reachability is proven ONLY from the EXACT
 * final path Pi reads (`PI_CODING_AGENT_DIR/sessions/--<cwd>--`, which follows the shared-state
 * symlink into native). A known basename can be resolved there if its header matches. The broad
 * native/legacy/staging roots and any absolute source path are skipped to keep source-only files
 * from satisfying the spawn gate (CS-FINDING-6 / plan §2).
 */
export async function verifyResumeReachablePi(
  input: VerifyResumeReachableInput,
): Promise<VerifyResumeReachableResult> {
  const targetStrict = input.targetStrict === true;
  const candidatePersistedSessionFile = asNonEmptyString(input.candidatePersistedSessionFile);
  const vendorResumeId = asNonEmptyString(input.vendorResumeId);
  if (!vendorResumeId) {
    return { ok: false, reason: 'pi_session_file_not_found' };
  }
  const sessionId = targetStrict
    ? resolvePiSessionIdFromResumeReference(vendorResumeId)
    : await resolveExpectedPiSessionIdForResume(vendorResumeId);
  if (!sessionId) {
    return { ok: false, reason: 'pi_session_file_not_found' };
  }

  if (
    !targetStrict &&
    candidatePersistedSessionFile &&
    await matchesPiSessionFileIdentity(candidatePersistedSessionFile, sessionId)
  ) {
    return { ok: true, resolvedPath: candidatePersistedSessionFile };
  }

  if (!targetStrict && isAbsolute(vendorResumeId) && await pathExistsAsFile(vendorResumeId)) {
    return { ok: true, resolvedPath: vendorResumeId };
  }

  const roots = buildPiResumeSearchRoots({
    cwd: input.cwd,
    env: input.targetMaterializedEnv,
    targetMaterializedRoot: input.targetMaterializedRoot,
    candidatePersistedSessionFile,
    targetStrict,
  });
  if (targetStrict && candidatePersistedSessionFile && isAbsolute(candidatePersistedSessionFile)) {
    for (const root of roots) {
      const targetPath = join(root, basename(candidatePersistedSessionFile));
      if (await matchesPiSessionFileIdentity(targetPath, sessionId, { requireHeader: true })) {
        return { ok: true, resolvedPath: targetPath };
      }
    }
  }
  const resolvedPath = await findPiSessionFileForId({ sessionId, roots });
  if (resolvedPath) {
    return { ok: true, resolvedPath };
  }

  return { ok: false, reason: 'pi_session_file_not_found' };
}
