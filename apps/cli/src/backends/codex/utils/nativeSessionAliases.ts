import type { NativeSessionAliasAssignmentV1 } from '@happier-dev/protocol';
import { collectCodexSessionRolloutFiles } from '../directSessions/collectCodexSessionRolloutFiles';
import { readCodexSessionMetaFromRollout } from '../localControl/rolloutDiscovery';

/** Codex records its provider-assigned nickname with the thread's creation metadata.
 * Thread titles, parent spawn arguments, filenames, and mtimes do not prove assignment.
 * Native spawn/resume preserves that nickname: recorder.rs stores source.get_nickname(),
 * control/spawn.rs resumes with the stored nickname, and registry.rs honors the preferred
 * nickname verbatim. This applies to that native lifecycle, not manual metadata edits.
 * Primary source basis inspected 2026-10-28: openai/codex main, codex-rs/rollout/src/recorder.rs
 * and codex-rs/core/src/agent/{control/spawn,registry}.rs. Missing evidence stays unresolved.
 */
export async function readCodexNativeSessionAliases(params: Readonly<{
  codexHome: string;
  sessionId: string;
  observedAt: number;
}>): Promise<NativeSessionAliasAssignmentV1[]> {
  const files = await collectCodexSessionRolloutFiles({ codexHome: params.codexHome, remoteSessionId: params.sessionId });
  const assignments: NativeSessionAliasAssignmentV1[] = [];
  for (const file of files) {
    const metadata = await readCodexSessionMetaFromRollout(file.filePath);
    if (metadata?.id !== params.sessionId || typeof metadata.agent_nickname !== 'string' || !metadata.agent_nickname.trim()) continue;
    // The creation record owns this timestamp; discovery scores and filename dates cannot substitute.
    const timestamp = metadata.timestamp;
    if (typeof timestamp !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(timestamp)) continue;
    const assignedAt = Date.parse(timestamp);
    if (!Number.isSafeInteger(assignedAt) || assignedAt <= 0 || assignedAt > params.observedAt) continue;
    // Date.parse normalizes impossible calendar dates; those are not provider evidence.
    if (new Date(assignedAt).toISOString().slice(0, 19) !== timestamp.slice(0, 19)) continue;
    assignments.push({ providerId: 'codex', providerSessionId: params.sessionId, alias: metadata.agent_nickname, assignedAt, observedAt: params.observedAt });
  }
  return assignments;
}
