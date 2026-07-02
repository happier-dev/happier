import { basename, isAbsolute, join } from 'node:path';

import type {
  VerifyResumeReachableInput,
  VerifyResumeReachableResult,
} from '@/backends/connectedServices/verifyResumeReachableTypes';
import {
  doesPiSessionFileNameMatchSessionId,
  findNewestPiSessionFileInDir,
  formatPiSessionDirectoryForCwd,
  pathExistsAsFile,
  resolvePiSessionIdFromResumeReference,
} from '@happier-dev/plugins-pi/agent/sessionFiles';

const OH_MY_PI_SESSION_NOT_FOUND_REASON = 'ohmypi_session_file_not_found';

function asNonEmptyString(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function resolveOhMyPiAgentDir(input: VerifyResumeReachableInput): string | null {
  const fromEnv = asNonEmptyString(input.targetMaterializedEnv.PI_CODING_AGENT_DIR);
  if (fromEnv) return fromEnv;
  return null;
}

function buildSearchDirectories(input: VerifyResumeReachableInput): string[] {
  const agentDir = resolveOhMyPiAgentDir(input);
  if (!agentDir) return [];
  const encodedCwdDir = formatPiSessionDirectoryForCwd(input.cwd);
  return Array.from(new Set([
    join(agentDir, 'sessions', encodedCwdDir),
    join(agentDir, 'sessions'),
  ]));
}

export async function verifyResumeReachableOhMyPi(
  input: VerifyResumeReachableInput,
): Promise<VerifyResumeReachableResult> {
  const candidatePersistedSessionFile = asNonEmptyString(input.candidatePersistedSessionFile);
  const vendorResumeId = asNonEmptyString(input.vendorResumeId);
  if (!vendorResumeId) {
    return { ok: false, reason: OH_MY_PI_SESSION_NOT_FOUND_REASON };
  }

  const sessionId = resolvePiSessionIdFromResumeReference(vendorResumeId);
  if (!sessionId) {
    return { ok: false, reason: OH_MY_PI_SESSION_NOT_FOUND_REASON };
  }

  if (
    candidatePersistedSessionFile
    && doesPiSessionFileNameMatchSessionId(basename(candidatePersistedSessionFile), sessionId)
    && await pathExistsAsFile(candidatePersistedSessionFile)
  ) {
    return {
      ok: true,
      resolvedPath: candidatePersistedSessionFile,
    };
  }

  if (isAbsolute(vendorResumeId) && await pathExistsAsFile(vendorResumeId)) {
    return { ok: true, resolvedPath: vendorResumeId };
  }

  for (const dir of buildSearchDirectories(input)) {
    const found = await findNewestPiSessionFileInDir({ sessionId, dir });
    if (found) {
      return { ok: true, resolvedPath: found };
    }
  }

  return { ok: false, reason: OH_MY_PI_SESSION_NOT_FOUND_REASON };
}
