import { listNativeReviewEngines } from '@happier-dev/protocol';

export type ExecutionRunsBackendSnapshotEntry = Readonly<{
  available?: boolean;
  intents?: readonly string[];
}>;

export type ReviewEngineOption = Readonly<{ id: string; label: string }>;

function supportsReviewIntent(entry: ExecutionRunsBackendSnapshotEntry | null | undefined): boolean {
  const intents = Array.isArray(entry?.intents) ? entry!.intents : null;
  if (!intents) return true; // best-effort (older snapshots)
  return (intents as readonly string[]).includes('review');
}

export function buildAvailableReviewEngineOptions(params: Readonly<{
  enabledAgentIds: readonly string[];
  resolveAgentLabel: (agentId: string) => string;
  executionRunsBackends: Readonly<Record<string, ExecutionRunsBackendSnapshotEntry>> | null | undefined;
}>): readonly ReviewEngineOption[] {
  const backends = params.executionRunsBackends ?? null;

  const agentOptions: ReviewEngineOption[] = params.enabledAgentIds
    .map((id) => String(id ?? '').trim())
    .filter((id) => id.length > 0)
    .filter((id) => {
      if (!backends) return true;
      const entry = backends[id];
      return Boolean(entry?.available === true) && supportsReviewIntent(entry);
    })
    .map((id) => ({ id, label: params.resolveAgentLabel(id) }));

  const nativeOptions: ReviewEngineOption[] = listNativeReviewEngines()
    .filter((engine) => {
      if (!backends) return true; // best-effort (no machine snapshot yet)
      const entry = backends[engine.id];
      if (!entry) return true; // best-effort (older snapshots that don't list native engines)
      return Boolean(entry?.available === true) && supportsReviewIntent(entry);
    })
    .map((engine) => ({ id: engine.id, label: engine.title }));

  return [...agentOptions, ...nativeOptions];
}
