import { stat } from 'node:fs/promises';
import { basename, isAbsolute } from 'node:path';

import {
  findNewestSessionFileInDir,
  isBareSessionFileId,
  listSessionFileStoreRoots,
  parseSessionIdFromFileName,
  resolveSessionFileStoreDirs,
  sessionFileNameMatchesSessionId,
} from '@happier-dev/plugin-sdk/experimental/sessions/fileStores';

import { OH_MY_PI_SESSION_FILE_STORE_DESCRIPTOR_V1 } from '../sessionFileStoreDescriptor.js';

const OH_MY_PI_SESSION_NOT_FOUND_REASON = 'ohmypi_session_file_not_found';

export type VerifyOhMyPiResumeReachableInput = Readonly<{
  targetMaterializedRoot: string;
  targetMaterializedEnv: Readonly<Record<string, string>>;
  vendorResumeId: string | null;
  cwd: string;
  candidatePersistedSessionFile?: string | null;
  targetStrict?: boolean;
}>;

export type VerifyOhMyPiResumeReachableResult =
  | Readonly<{ ok: true; resolvedPath: string | null }>
  | Readonly<{ ok: false; reason: string }>;

function asNonEmptyString(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function resolveOhMyPiSessionIdFromResumeReference(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed) return null;
  if (isBareSessionFileId(trimmed)) return trimmed;
  return parseSessionIdFromFileName(basename(trimmed));
}

async function pathExistsAsFile(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
}

async function buildSearchDirectories(
  input: VerifyOhMyPiResumeReachableInput,
): Promise<readonly string[]> {
  const resolution = await resolveSessionFileStoreDirs({
    product: OH_MY_PI_SESSION_FILE_STORE_DESCRIPTOR_V1,
    env: input.targetMaterializedEnv,
    cwd: input.cwd,
  });
  return Array.from(new Set([
    ...await listSessionFileStoreRoots(resolution),
    resolution.sessionsRoot,
  ]));
}

export async function verifyResumeReachableOhMyPi(
  input: VerifyOhMyPiResumeReachableInput,
): Promise<VerifyOhMyPiResumeReachableResult> {
  const targetStrict = input.targetStrict === true;
  const candidatePersistedSessionFile = asNonEmptyString(input.candidatePersistedSessionFile);
  const vendorResumeId = asNonEmptyString(input.vendorResumeId);
  if (!vendorResumeId) {
    return { ok: false, reason: OH_MY_PI_SESSION_NOT_FOUND_REASON };
  }

  const sessionId = resolveOhMyPiSessionIdFromResumeReference(vendorResumeId);
  if (!sessionId) {
    return { ok: false, reason: OH_MY_PI_SESSION_NOT_FOUND_REASON };
  }

  if (
    !targetStrict
    && candidatePersistedSessionFile
    && sessionFileNameMatchesSessionId(basename(candidatePersistedSessionFile), sessionId)
    && await pathExistsAsFile(candidatePersistedSessionFile)
  ) {
    return {
      ok: true,
      resolvedPath: candidatePersistedSessionFile,
    };
  }

  if (!targetStrict && isAbsolute(vendorResumeId) && await pathExistsAsFile(vendorResumeId)) {
    return { ok: true, resolvedPath: vendorResumeId };
  }

  for (const dir of await buildSearchDirectories(input)) {
    const found = await findNewestSessionFileInDir({ sessionId, dir });
    if (found) {
      return { ok: true, resolvedPath: found };
    }
  }

  return { ok: false, reason: OH_MY_PI_SESSION_NOT_FOUND_REASON };
}
