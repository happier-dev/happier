import { readdir, realpath } from 'node:fs/promises';
import { basename, isAbsolute, join, relative, resolve } from 'node:path';

import type {
  AgentConnectedAccountResumeFileCandidateV1,
  AgentConnectedAccountResumeReachabilityInputV1,
  AgentConnectedAccountResumeReachabilityResultV1,
} from '@happier-dev/plugin-sdk/agents/runtime';
import {
  parseSessionIdFromFileName,
  readSessionIdFromFileHead,
} from '@happier-dev/plugin-sdk/sessions/file-stores';

import type { ConnectedServiceStateSharingDescriptor } from '@/agent/catalog/types';
import { isSafeConnectedServiceStateSharingEntry } from './connectedServiceStateSharingManifest';

const RESUME_SESSION_FILE_NOT_FOUND_REASON = 'resume_session_file_not_found';

type VerifyResumeReachable = (
  input: AgentConnectedAccountResumeReachabilityInputV1,
) => Promise<AgentConnectedAccountResumeReachabilityResultV1>;

export type VerifyDeclaredResumeFileReachabilityResult =
  | Readonly<{ ok: true; resolvedPath: string }>
  | Readonly<{ ok: false; reason: string }>;

function isWithinRoot(root: string, candidate: string): boolean {
  const pathFromRoot = relative(root, candidate);
  return pathFromRoot === '' || (!pathFromRoot.startsWith('..') && !isAbsolute(pathFromRoot));
}

async function readCandidate(path: string): Promise<AgentConnectedAccountResumeFileCandidateV1> {
  const fileName = basename(path);
  return Object.freeze({
    fileName,
    nativeSessionId:
      await readSessionIdFromFileHead(path)
      ?? parseSessionIdFromFileName(fileName),
  });
}

async function findDeclaredCandidateInRoot(input: Readonly<{
  root: string;
  matchesCandidate(candidate: AgentConnectedAccountResumeFileCandidateV1): boolean;
}>): Promise<string | null> {
  const walk = async (directory: string): Promise<string | null> => {
    const entries = await readdir(directory, { withFileTypes: true }).catch(() => null);
    if (!entries) return null;
    for (const entry of entries) {
      if (entry.isSymbolicLink()) continue;
      const joinedPath = join(directory, entry.name);
      const canonicalPath = await realpath(joinedPath).catch(() => null);
      if (!canonicalPath || !isWithinRoot(input.root, canonicalPath)) continue;
      if (entry.isDirectory()) {
        const nested = await walk(canonicalPath);
        if (nested) return nested;
        continue;
      }
      if (!entry.isFile()) continue;
      const candidate = await readCandidate(canonicalPath);
      if (input.matchesCandidate(candidate)) {
        return canonicalPath;
      }
    }
    return null;
  };
  return await walk(input.root);
}

/**
 * Resolves resume evidence beneath the Agent's already-declared state-sharing
 * entries. The host owns roots, traversal, file reads, and the resolved path;
 * the Agent receives only bounded filename/session-id facts for correlation.
 */
export async function verifyDeclaredResumeFileReachability(input: Readonly<{
  targetMaterializedRoot: string;
  stateSharingDescriptor: ConnectedServiceStateSharingDescriptor;
  vendorResumeId: string | null;
  runtimeDescriptorV1?: AgentConnectedAccountResumeReachabilityInputV1['runtimeDescriptorV1'];
  verifyResumeReachable: VerifyResumeReachable;
}>): Promise<VerifyDeclaredResumeFileReachabilityResult> {
  const targetMaterializedRoot = input.targetMaterializedRoot.trim();
  if (!targetMaterializedRoot || !isAbsolute(targetMaterializedRoot)) {
    return { ok: false, reason: RESUME_SESSION_FILE_NOT_FOUND_REASON };
  }
  let matchedPath: string | null = null;
  const sessionFiles = Object.freeze({
    findDeclaredCandidate: async (request: Parameters<
      AgentConnectedAccountResumeReachabilityInputV1['sessionFiles']['findDeclaredCandidate']
    >[0]) => {
      for (const entry of input.stateSharingDescriptor.state.entries) {
        if (!isSafeConnectedServiceStateSharingEntry(entry.path)) continue;
        const declaredRoot = await realpath(resolve(targetMaterializedRoot, entry.path)).catch(() => null);
        if (!declaredRoot) continue;
        const found = await findDeclaredCandidateInRoot({
          root: declaredRoot,
          matchesCandidate: request.matchesCandidate,
        });
        if (!found) continue;
        matchedPath = found;
        return Object.freeze({ found: true });
      }
      return Object.freeze({ found: false });
    },
  });
  const result = await input.verifyResumeReachable(Object.freeze({
    vendorResumeId: input.vendorResumeId,
    ...(input.runtimeDescriptorV1 ? { runtimeDescriptorV1: input.runtimeDescriptorV1 } : {}),
    sessionFiles,
  })).catch(() => ({ ok: false as const, reason: 'resume_reachability_check_failed' }));
  if (!result.ok) return result;
  return matchedPath
    ? { ok: true, resolvedPath: matchedPath }
    : { ok: false, reason: RESUME_SESSION_FILE_NOT_FOUND_REASON };
}
