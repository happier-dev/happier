import { realpath } from 'node:fs/promises';
import { basename, isAbsolute, join, relative, sep } from 'node:path';

import type {
  VerifyResumeReachableInput,
  VerifyResumeReachableResult,
} from '@/backends/connectedServices/verifyResumeReachableTypes';
import { readConnectedServiceStateSharingManifest } from '@/daemon/connectedServices/stateSharing/connectedServiceStateSharingManifest';
import {
  findCodexRolloutFileById,
  isMatchingCodexRolloutFileName,
  normalizeCodexVendorResumeId,
  resolveExistingCodexRolloutPath,
} from '@/backends/codex/utils/codexSessionFiles';
import { reconcileCodexResumeRolloutPath } from './reconcileCodexResumeRolloutPath';
import { resolveConfiguredCodexHome } from '@/backends/codex/utils/resolveConfiguredCodexHome';

function resolveMappingDestinationPaths(params: Readonly<{
  targetMaterializedRoot: string;
  mapping: Record<string, unknown>;
}>): string[] {
  const rawPaths: string[] = [];
  if (typeof params.mapping.destinationPath === 'string' && params.mapping.destinationPath.trim().length > 0) {
    rawPaths.push(params.mapping.destinationPath.trim());
  }
  if (typeof params.mapping.relativePath === 'string' && params.mapping.relativePath.trim().length > 0) {
    rawPaths.push(params.mapping.relativePath.trim());
  }
  return rawPaths.map((rawPath) =>
    isAbsolute(rawPath) ? rawPath : join(params.targetMaterializedRoot, rawPath),
  );
}

/**
 * Prove the rollout visible in the final Codex home's session store. Shared homes can link their
 * store to native state; isolated homes must hold their own rollout. An old absolute hint or manifest
 * mapping is not proof until its real path is contained by a real target store root.
 *
 * Fast-paths first (an absolute persisted hint, then a recorded manifest mapping), then an id-targeted
 * search over `codex-home/sessions` via `findCodexRolloutFileById` (name-only match, newest-date-first
 * traversal, NO file-count cap) so the target is found regardless of how large the linked native store
 * is. A generic capped tree walk would give up before reaching a target in a recent date partition.
 *
 * Target strictness applies equally to hints, manifest mappings and id-targeted searches; no separate
 * source/staging root can satisfy the proof.
 */
export async function verifyResumeReachableCodex(
  input: VerifyResumeReachableInput,
): Promise<VerifyResumeReachableResult> {
  const vendorResumeId = normalizeCodexVendorResumeId(input.vendorResumeId);
  if (!vendorResumeId) {
    return { ok: false, reason: 'codex_session_file_not_found' };
  }

  const codexHome = input.targetMaterializedEnv.CODEX_HOME?.trim()
    ? resolveConfiguredCodexHome(input.targetMaterializedEnv)
    : join(input.targetMaterializedRoot, 'codex-home');
  const sessionsRoot = join(codexHome, 'sessions');
  const canonicalSessionsRoot = await realpath(sessionsRoot).catch(() => null);
  const resolveVisibleTargetRollout = async (candidatePath: string): Promise<string | null> => {
    if (!isMatchingCodexRolloutFileName(basename(candidatePath), vendorResumeId)) return null;
    const path = await resolveExistingCodexRolloutPath(candidatePath);
    if (!path) return null;
    const canonicalPath = await realpath(path).catch(() => null);
    if (!canonicalPath || !canonicalSessionsRoot) return null;
    const pathFromRoot = relative(canonicalSessionsRoot, canonicalPath);
    return pathFromRoot !== '' && pathFromRoot !== '..'
      && !pathFromRoot.startsWith(`..${sep}`) && !isAbsolute(pathFromRoot) ? path : null;
  };

  const acceptReachablePath = async (resolvedPath: string): Promise<VerifyResumeReachableResult> => {
    const reconciled = await reconcileCodexResumeRolloutPath({
      targetMaterializedEnv: input.targetMaterializedEnv,
      vendorResumeId,
      resolvedRolloutPath: resolvedPath,
      cwd: input.cwd,
    });
    return reconciled
      ? { ok: true, resolvedPath }
      : { ok: false, reason: 'codex_session_index_reconciliation_failed' };
  };

  if (typeof input.candidatePersistedSessionFile === 'string' && input.candidatePersistedSessionFile.trim().length > 0) {
    const candidatePath = await resolveVisibleTargetRollout(input.candidatePersistedSessionFile.trim());
    if (candidatePath) {
      return await acceptReachablePath(candidatePath);
    }
  }

  const manifest = await readConnectedServiceStateSharingManifest(input.targetMaterializedRoot);
  for (const mapping of manifest.sessionFileMappings) {
    if (mapping.vendorResumeId !== vendorResumeId) continue;
    const candidatePaths = resolveMappingDestinationPaths({
      targetMaterializedRoot: input.targetMaterializedRoot,
      mapping: mapping as unknown as Record<string, unknown>,
    });
    for (const candidatePath of candidatePaths) {
      const visiblePath = await resolveVisibleTargetRollout(candidatePath);
      if (visiblePath) {
        return await acceptReachablePath(visiblePath);
      }
    }
  }

  const discoveredPath = await findCodexRolloutFileById({ sessionsRoot, vendorResumeId });
  const visiblePath = discoveredPath && await resolveVisibleTargetRollout(discoveredPath);
  if (visiblePath) {
    return await acceptReachablePath(visiblePath);
  }

  return { ok: false, reason: 'codex_session_file_not_found' };
}
