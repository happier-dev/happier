import { stat } from 'node:fs/promises';
import { basename, isAbsolute, join } from 'node:path';

import type {
  VerifyResumeReachableInput,
  VerifyResumeReachableResult,
} from '@/backends/connectedServices/verifyResumeReachableTypes';
import { readConnectedServiceStateSharingManifest } from '@/daemon/connectedServices/stateSharing/connectedServiceStateSharingManifest';
import {
  findCodexRolloutFileById,
  isMatchingCodexRolloutFileName,
  normalizeCodexVendorResumeId,
} from '@/backends/codex/utils/codexSessionFiles';

async function statFile(path: string): Promise<boolean> {
  try {
    const metadata = await stat(path);
    return metadata.isFile();
  } catch {
    return false;
  }
}

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
 * Codex shares session state via a SYMLINK: the connected `<targetMaterializedRoot>/codex-home/sessions`
 * is linked to the user's native `~/.codex/sessions` (descriptor `state.entries: { path: 'sessions',
 * mode: 'linked' }`). So the native rollout is already visible through the connected home — there is
 * nothing to copy or import. Reachability is purely a question of locating the `rollout-...-<id>.jsonl`
 * file inside that (potentially 25k+ file) store.
 *
 * Fast-paths first (an absolute persisted hint, then a recorded manifest mapping), then an id-targeted
 * search over `codex-home/sessions` via `findCodexRolloutFileById` (name-only match, newest-date-first
 * traversal, NO file-count cap) so the target is found regardless of how large the linked native store
 * is. A generic capped tree walk would give up before reaching a target in a recent date partition.
 *
 * Codex is inherently target-strict: it only ever searches the final `codex-home/sessions` (the linked
 * native store) and never a separate source/staging root. The cross-provider `input.targetStrict`
 * flag (set by the §2 spawn gate) therefore needs no special handling here — Codex's behavior is
 * unchanged whether it is set or not.
 */
export async function verifyResumeReachableCodex(
  input: VerifyResumeReachableInput,
): Promise<VerifyResumeReachableResult> {
  const vendorResumeId = normalizeCodexVendorResumeId(input.vendorResumeId);
  if (!vendorResumeId) {
    return { ok: false, reason: 'codex_session_file_not_found' };
  }

  if (typeof input.candidatePersistedSessionFile === 'string' && input.candidatePersistedSessionFile.trim().length > 0) {
    const candidatePath = input.candidatePersistedSessionFile.trim();
    if (
      isMatchingCodexRolloutFileName(basename(candidatePath), vendorResumeId) &&
      await statFile(candidatePath)
    ) {
      return { ok: true, resolvedPath: candidatePath };
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
      if (await statFile(candidatePath)) {
        return { ok: true, resolvedPath: candidatePath };
      }
    }
  }

  const sessionsRoot = join(input.targetMaterializedRoot, 'codex-home', 'sessions');
  const discoveredPath = await findCodexRolloutFileById({ sessionsRoot, vendorResumeId });
  if (discoveredPath) {
    return { ok: true, resolvedPath: discoveredPath };
  }

  return { ok: false, reason: 'codex_session_file_not_found' };
}
