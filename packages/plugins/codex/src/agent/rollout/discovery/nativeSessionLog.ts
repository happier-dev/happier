import { join } from 'node:path';

import {
  normalizeCodexVendorResumeId,
  resolveCodexMaterializedSessionsRoot,
} from '../../auth/services/home/sync/sessionFiles.js';
import { resolveConfiguredCodexHomePath } from './homeEntries.js';
import { findCodexRolloutFileById } from './sessionFileSearch.js';

/**
 * Where Codex's own log for a given thread lives on THIS machine.
 *
 * Claude records its transcript path in Session metadata, so a host that reads
 * the catalog-declared proof slot finds it there. Codex records no path at all:
 * it names the file after the thread id and files it under either a
 * date-partitioned `<codexHome>/sessions` or `<codexHome>/archived_sessions`
 * tree. That derivation — the `rollout-…-<id>.jsonl` naming rule, the partition
 * layout, the `CODEX_HOME` override — is this Agent's knowledge, so the host
 * asks for the answer instead of reconstructing it.
 *
 * The search is id-targeted and name-only (see `findCodexRolloutFileById`): a
 * real home holds tens of thousands of rollouts, and the newest-first descent
 * short-circuits on the first exact suffix match. The id is normalized first
 * because it becomes a file-name suffix; one carrying a path separator is not a
 * Codex thread id and is refused rather than searched for.
 *
 * KNOWN CEILING: the home is the CONFIGURED one (`CODEX_HOME`, else `~/.codex`).
 * A Session running against a connected-service materialized Codex home writes
 * its rollout there instead, and is reachable here only once state sharing has
 * imported it back into the configured home. Nothing is guessed in that case —
 * the caller stat-verifies whatever comes back, so an unimported Session simply
 * hands over no log, exactly as it does today.
 */
export async function resolveCodexNativeSessionLogPath(input: Readonly<{
  vendorResumeId: string;
  env?: NodeJS.ProcessEnv;
}>): Promise<string | null> {
  const vendorResumeId = normalizeCodexVendorResumeId(input.vendorResumeId);
  if (!vendorResumeId) return null;
  const codexHome = resolveConfiguredCodexHomePath(input.env ?? process.env);
  for (const sessionsRoot of [
    resolveCodexMaterializedSessionsRoot(codexHome),
    join(codexHome, 'archived_sessions'),
  ]) {
    const found = await findCodexRolloutFileById({ sessionsRoot, vendorResumeId });
    if (found) return found;
  }
  return null;
}
