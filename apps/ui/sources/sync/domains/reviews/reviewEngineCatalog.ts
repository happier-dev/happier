export type ExecutionRunsBackendSnapshotEntry = Readonly<{
  available?: boolean;
  intents?: readonly string[];
  supportsVendorResume?: boolean;
}>;

export type ReviewEngineOption = Readonly<{ id: string; label: string; disabled?: boolean }>;

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
    .map((id) => {
      if (!backends) return { id, label: params.resolveAgentLabel(id) };
      const entry = backends[id];
      // If the machine explicitly reports the backend, surface it even when unavailable so the
      // UI can explain why it's disabled instead of hiding it entirely.
      const available = entry ? Boolean(entry.available === true) : true;
      const reviewOk = supportsReviewIntent(entry);
      const disabled = entry ? !(available && reviewOk) : false;
      return { id, label: params.resolveAgentLabel(id), ...(disabled ? { disabled: true as const } : {}) } as any;
    });

  return agentOptions;
}
