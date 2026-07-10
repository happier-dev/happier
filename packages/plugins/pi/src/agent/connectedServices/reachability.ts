import { basename, isAbsolute } from 'node:path';

import {
  buildPiResumeSearchRoots,
  doesPiSessionFileNameMatchSessionId,
  findPiSessionFileForId,
  pathExistsAsFile,
  resolvePiSessionIdFromResumeReference,
} from '../sessionFiles.js';

export type VerifyPiResumeReachableInput = Readonly<{
  targetMaterializedRoot: string;
  targetMaterializedEnv: Readonly<Record<string, string>>;
  vendorResumeId: string | null;
  cwd: string;
  candidatePersistedSessionFile?: string | null;
  targetStrict?: boolean;
}>;

export type VerifyPiResumeReachableResult =
  | Readonly<{ ok: true; resolvedPath: string | null }>
  | Readonly<{ ok: false; reason: string }>;

function asNonEmptyString(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

export async function verifyResumeReachablePi(
  input: VerifyPiResumeReachableInput,
): Promise<VerifyPiResumeReachableResult> {
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
    !targetStrict
    && candidatePersistedSessionFile
    && doesPiSessionFileNameMatchSessionId(basename(candidatePersistedSessionFile), sessionId)
    && await pathExistsAsFile(candidatePersistedSessionFile)
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
