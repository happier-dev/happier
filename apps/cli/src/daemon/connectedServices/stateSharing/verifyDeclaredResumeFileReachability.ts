import { readFile, readdir, realpath, stat } from 'node:fs/promises';
import { basename, isAbsolute, join, relative, resolve, sep } from 'node:path';

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
import type { VerifyResumeReachableResult } from '../verifyResumeReachableTypes';
import { isSafeConnectedServiceStateSharingEntry } from './connectedServiceStateSharingManifest';

const RESUME_SESSION_FILE_NOT_FOUND_REASON = 'resume_session_file_not_found';

type VerifyResumeReachable = (
  input: AgentConnectedAccountResumeReachabilityInputV1,
) => Promise<AgentConnectedAccountResumeReachabilityResultV1>;

export type VerifyDeclaredResumeFileReachabilityResult = Exclude<VerifyResumeReachableResult, { proof: 'native_session' }>;

function isWithinRoot(root: string, candidate: string): boolean {
  const pathFromRoot = relative(root, candidate);
  return pathFromRoot === '' || (!pathFromRoot.startsWith('..') && !isAbsolute(pathFromRoot));
}

async function readCandidate(path: string, root: string, stateEntryPath: string, includeNativeSessionId: boolean): Promise<AgentConnectedAccountResumeFileCandidateV1> {
  const fileName = basename(path);
  return Object.freeze({
    fileName,
    stateEntryPath,
    relativePath: relative(root, path).split(sep).join('/'),
    nativeSessionId: includeNativeSessionId
      ? await readSessionIdFromFileHead(path) ?? parseSessionIdFromFileName(fileName)
      : null,
  });
}

async function findDeclaredCandidateInRoot(input: Readonly<{
  root: string;
  stateEntryPath: string;
  includeNativeSessionId: boolean;
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
      const candidate = await readCandidate(canonicalPath, input.root, input.stateEntryPath, input.includeNativeSessionId);
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
 * the Agent receives only relative-layout/filename/session-id facts for correlation.
 */
type DeclaredResumeReachabilityInput = Readonly<{
  targetMaterializedRoot: string;
  stateSharingDescriptor?: ConnectedServiceStateSharingDescriptor;
  vendorResumeId: string | null;
  candidatePersistedSessionFile?: string | null;
  runtimeDescriptorV1?: AgentConnectedAccountResumeReachabilityInputV1['runtimeDescriptorV1'];
  verifyResumeReachable: VerifyResumeReachable;
  nativeInspection?: AgentConnectedAccountResumeReachabilityInputV1['nativeInspection'];
}>;

/** File adoption retains its exact path proof and never supplies a native inspector. */
export async function verifyDeclaredResumeFileReachability(input: Omit<DeclaredResumeReachabilityInput, 'nativeInspection'> & Readonly<{
  stateSharingDescriptor: ConnectedServiceStateSharingDescriptor;
}>): Promise<VerifyDeclaredResumeFileReachabilityResult> {
  const result = await verifyDeclaredResumeReachability({ ...input, nativeInspection: undefined });
  return result.ok && result.proof === 'native_session'
    ? { ok: false, reason: RESUME_SESSION_FILE_NOT_FOUND_REASON }
    : result;
}

/** Invoke native correlation once, with file custody remaining at this owner. */
export async function verifyDeclaredResumeReachability(input: DeclaredResumeReachabilityInput): Promise<VerifyResumeReachableResult> {
  const targetMaterializedRoot = input.targetMaterializedRoot.trim();
  const validRoot = targetMaterializedRoot.length > 0 && isAbsolute(targetMaterializedRoot);
  if (!validRoot && !input.nativeInspection) {
    return { ok: false, reason: RESUME_SESSION_FILE_NOT_FOUND_REASON };
  }
  const stateEntries = validRoot ? input.stateSharingDescriptor?.state.entries ?? [] : [];
  let matchedPath: string | null = null;
  const requiredPaths = new Set<string>();
  const sessionFiles = Object.freeze({
    verifyDeclaredPaths: async (request: Parameters<
      AgentConnectedAccountResumeReachabilityInputV1['sessionFiles']['verifyDeclaredPaths']
    >[0]) => {
      if (request.paths.length === 0) return Object.freeze({ found: false });
      const verifiedPaths: string[] = [];
      for (const required of request.paths) {
        if (!isSafeConnectedServiceStateSharingEntry(required.path)) return Object.freeze({ found: false });
        const candidate = resolve(targetMaterializedRoot, ...required.path.split(/[\\/]+/));
        let found = false;
        for (const entry of stateEntries) {
          if (!isSafeConnectedServiceStateSharingEntry(entry.path)) continue;
          const lexicalRoot = resolve(targetMaterializedRoot, ...entry.path.split(/[\\/]+/));
          if (!isWithinRoot(lexicalRoot, candidate)) continue;
          const declaredRoot = await realpath(lexicalRoot).catch(() => null);
          const canonicalPath = await realpath(candidate).catch(() => null);
          if (!declaredRoot || !canonicalPath || !isWithinRoot(declaredRoot, canonicalPath)) continue;
          const entryStat = await stat(canonicalPath).catch(() => null);
          if (!entryStat || (required.kind === 'directory' ? !entryStat.isDirectory() : !entryStat.isFile())) continue;
          if (required.kind === 'json_object') {
            const contents: unknown = await readFile(canonicalPath, 'utf8').then(text => JSON.parse(text)).catch(() => null);
            if (!contents || typeof contents !== 'object' || Array.isArray(contents)) continue;
          }
          found = true;
          verifiedPaths.push(canonicalPath);
          break;
        }
        if (!found) return Object.freeze({ found: false });
      }
      for (const path of verifiedPaths) requiredPaths.add(path);
      return Object.freeze({ found: true });
    },
    findDeclaredCandidate: async (request: Parameters<
      AgentConnectedAccountResumeReachabilityInputV1['sessionFiles']['findDeclaredCandidate']
    >[0]) => {
      const includeNativeSessionId = request.includeNativeSessionId !== false;
      const hint = input.candidatePersistedSessionFile?.trim();
      const hintedPath = hint && isAbsolute(hint) ? await realpath(hint).catch(() => null) : null;
      for (const entry of stateEntries) {
        if (!isSafeConnectedServiceStateSharingEntry(entry.path)) continue;
        const declaredRoot = await realpath(resolve(targetMaterializedRoot, entry.path)).catch(() => null);
        if (!declaredRoot) continue;
        if (hintedPath && isWithinRoot(declaredRoot, hintedPath)) {
          const hintedStat = await stat(hintedPath).catch(() => null);
          if (hintedStat?.isFile() && request.matchesCandidate(await readCandidate(hintedPath, declaredRoot, entry.path, includeNativeSessionId))) {
            matchedPath = hintedPath;
            return Object.freeze({ found: true });
          }
        }
        const found = await findDeclaredCandidateInRoot({
          root: declaredRoot,
          stateEntryPath: entry.path,
          includeNativeSessionId,
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
    ...(input.nativeInspection ? { nativeInspection: input.nativeInspection } : {}),
  })).catch(() => ({ ok: false as const, reason: 'resume_reachability_check_failed' }));
  if (!result.ok) return result;
  if (result.proof === 'native_session') {
    return input.nativeInspection
      ? { ok: true, proof: 'native_session' }
      : { ok: false, reason: RESUME_SESSION_FILE_NOT_FOUND_REASON };
  }
  // Exact declared paths already carry Agent-owned native correlation. Keep
  // the candidate as primary when supplied, and preserve every companion for
  // the retained-state importer rather than copying only one trajectory.
  const resolvedPath = matchedPath ?? requiredPaths.values().next().value;
  return resolvedPath
    ? { ok: true, resolvedPath, ...(requiredPaths.size ? { requiredPaths: [...requiredPaths] } : {}) }
    : { ok: false, reason: RESUME_SESSION_FILE_NOT_FOUND_REASON };
}
