import { basename, isAbsolute } from 'node:path';

import type {
  VerifyResumeReachableInput,
  VerifyResumeReachableResult,
} from '@/backends/connectedServices/verifyResumeReachableTypes';
import {
  buildPiResumeSearchRoots,
  doesPiSessionFileNameMatchSessionId,
  findPiSessionFileForId,
  pathExistsAsFile,
  resolvePiSessionIdFromResumeReference,
} from '@happier-dev/plugins-pi/agent/sessionFiles';

function asNonEmptyString(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/**
 * Provider reachability probe for Pi: is the vendor session file for `vendorResumeId` present in a
 * place Pi reads on resume — OR in a native/source root that the switch will import before spawn
 * (D8)? Search roots come from the SHARED `buildPiResumeSearchRoots`, which includes the native
 * `~/.pi/agent/sessions/--<cwd>--` root. This closes the VG-8 false negative: a native->connected
 * switch (target env has no `PI_CODING_AGENT_DIR` yet) is now proven reachable from the native file
 * that exists on disk, instead of fail-closing a supported switch.
 *
 * IMPORTANT: a positive answer means "reachable from a source the switch WILL import" — necessary
 * but not sufficient on its own. The spawn path must perform a HARD post-materialization re-verify
 * against the real materialized env before launching Pi so a failed/mis-encoded import surfaces as a
 * structured error, never a bare "Pi process exited" (the §2 re-verify gate is a later dev pass).
 *
 * When `input.targetStrict` is set (the §2 spawn gate), reachability is proven ONLY from the EXACT
 * final path Pi reads (`PI_CODING_AGENT_DIR/sessions/--<cwd>--`, which follows the shared-state
 * symlink into native). The source-proof fast-paths (persisted hint, absolute resume id) and the
 * broad native/legacy/staging search roots are all skipped so a file present only in a source/staging
 * location cannot produce a false-positive spawn gate (CS-FINDING-6 / plan §2).
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
  const sessionId = resolvePiSessionIdFromResumeReference(vendorResumeId);
  if (!sessionId) {
    return { ok: false, reason: 'pi_session_file_not_found' };
  }

  if (
    !targetStrict &&
    candidatePersistedSessionFile &&
    doesPiSessionFileNameMatchSessionId(basename(candidatePersistedSessionFile), sessionId) &&
    await pathExistsAsFile(candidatePersistedSessionFile)
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
  const resolvedPath = await findPiSessionFileForId({ sessionId, roots });
  if (resolvedPath) {
    return { ok: true, resolvedPath };
  }

  return { ok: false, reason: 'pi_session_file_not_found' };
}
