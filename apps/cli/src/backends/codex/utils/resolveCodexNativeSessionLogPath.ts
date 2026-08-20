import {
  findCodexRolloutFileById,
  normalizeCodexVendorResumeId,
  resolveCodexNativeSessionsRoot,
} from '@/backends/codex/utils/codexSessionFiles';

/**
 * Where Codex's own log for a given thread lives on THIS machine.
 *
 * Claude records its transcript path in Session metadata, so a reader of the
 * catalog-declared proof slot finds it there. Codex records no path at all: it
 * names the file after the thread id and files it under a date-partitioned
 * `<codexHome>/sessions` tree. That derivation is this provider's knowledge, so
 * generic code asks for the answer rather than reconstructing it.
 *
 * The search is id-targeted and name-only (see `findCodexRolloutFileById`): a
 * real home holds tens of thousands of rollouts, and the newest-first descent
 * short-circuits on the first exact suffix match. The id is normalized first
 * because it becomes a file-name suffix.
 *
 * KNOWN CEILING: the home is the CONFIGURED one (`CODEX_HOME`, else `~/.codex`).
 * Codex shares connected-service session state by SYMLINKING that connected home's
 * `sessions` at the native store, so a connected Session's rollout is normally
 * visible here too; a home that is genuinely separate is not searched. Nothing is
 * guessed either way — the caller verifies the returned path against the
 * filesystem, so an unreachable Session simply hands over no log.
 */
export async function resolveCodexNativeSessionLogPath(input: Readonly<{
  vendorResumeId: string;
  env?: NodeJS.ProcessEnv;
}>): Promise<string | null> {
  const vendorResumeId = normalizeCodexVendorResumeId(input.vendorResumeId);
  if (!vendorResumeId) return null;
  return await findCodexRolloutFileById({
    sessionsRoot: resolveCodexNativeSessionsRoot(input.env ?? process.env),
    vendorResumeId,
  });
}
