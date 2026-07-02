import { readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';

import {
  isCodexCandidatePersistedSessionFileForResume,
  normalizeCodexVendorResumeId,
  resolveCodexMaterializedSessionsRoot,
  resolveCodexSessionFileMappingDestinationPaths,
} from '../../home/sync/sessionFiles.js';
import { findCodexRolloutFileById } from '../../../../rollout/discovery/sessionFileSearch.js';

type VerifyResumeReachableInput = Readonly<{
  vendorResumeId: string;
  targetMaterializedRoot: string;
  candidatePersistedSessionFile?: string | null;
}>;

async function statFile(path: string): Promise<boolean> {
  try {
    const metadata = await stat(path);
    return metadata.isFile();
  } catch {
    return false;
  }
}

async function readSessionFileMappings(
  targetMaterializedRoot: string,
): Promise<readonly Readonly<{
  vendorResumeId: string;
  destinationPath: string;
}>[]> {
  for (const name of ['.happier-state-sharing.json', '.happier-codex-home-sharing.json']) {
    try {
      const parsed = JSON.parse(await readFile(join(targetMaterializedRoot, name), 'utf8')) as unknown;
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) continue;
      const mappings = (parsed as { sessionFileMappings?: unknown }).sessionFileMappings;
      if (!Array.isArray(mappings)) continue;
      return mappings.flatMap((mapping) => {
        if (!mapping || typeof mapping !== 'object' || Array.isArray(mapping)) return [];
        const record = mapping as Record<string, unknown>;
        return typeof record.vendorResumeId === 'string' && typeof record.destinationPath === 'string'
          ? [{ vendorResumeId: record.vendorResumeId, destinationPath: record.destinationPath }]
          : [];
      });
    } catch {
      // Fall through to the next compatible manifest name.
    }
  }
  return [];
}

export async function verifyResumeReachableCodex(
  input: VerifyResumeReachableInput,
) {
  const vendorResumeId = normalizeCodexVendorResumeId(input.vendorResumeId);
  if (!vendorResumeId) {
    return { ok: false, reason: 'codex_session_file_not_found' };
  }

  if (typeof input.candidatePersistedSessionFile === 'string' && input.candidatePersistedSessionFile.trim().length > 0) {
    const candidatePath = input.candidatePersistedSessionFile.trim();
    if (
      isCodexCandidatePersistedSessionFileForResume({ candidatePath, vendorResumeId }) &&
      await statFile(candidatePath)
    ) {
      return { ok: true, resolvedPath: candidatePath };
    }
  }

  const mappings = await readSessionFileMappings(input.targetMaterializedRoot);
  for (const mapping of mappings) {
    if (mapping.vendorResumeId !== vendorResumeId) continue;
    const candidatePaths = resolveCodexSessionFileMappingDestinationPaths({
      targetMaterializedRoot: input.targetMaterializedRoot,
      mapping: {
        destinationPath: mapping.destinationPath,
      },
    });
    for (const candidatePath of candidatePaths) {
      if (await statFile(candidatePath)) {
        return { ok: true, resolvedPath: candidatePath };
      }
    }
  }

  const sessionsRoot = resolveCodexMaterializedSessionsRoot(input.targetMaterializedRoot);
  const discoveredPath = await findCodexRolloutFileById({
    sessionsRoot,
    vendorResumeId,
  });
  if (discoveredPath) {
    return { ok: true, resolvedPath: discoveredPath };
  }

  return { ok: false, reason: 'codex_session_file_not_found' };
}
