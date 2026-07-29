export type ExecutionRunsBackendSnapshotEntry = Readonly<{
  available?: boolean;
  intents?: readonly string[];
  supportsVendorResume?: boolean;
  title?: string;
  label?: string;
  displayName?: string;
}>;

export type ReviewEngineOption = Readonly<{ id: string; label: string; disabled?: boolean }>;

function supportsReviewIntent(entry: ExecutionRunsBackendSnapshotEntry | null | undefined): boolean {
  const intents = Array.isArray(entry?.intents) ? entry.intents : null;
  if (!intents) return true; // best-effort (older snapshots)
  return intents.includes('review');
}

function resolveReviewEngineLabel(
  id: string,
  entry: ExecutionRunsBackendSnapshotEntry | null | undefined,
  resolveAgentLabel: (agentId: string) => string,
): string {
  const label = entry?.title ?? entry?.label ?? entry?.displayName;
  if (label) return label;

  try {
    return resolveAgentLabel(id);
  } catch {
    return id;
  }
}

function buildReviewEngineOption(
  id: string,
  entry: ExecutionRunsBackendSnapshotEntry | null | undefined,
  resolveAgentLabel: (agentId: string) => string,
): ReviewEngineOption {
  const label = resolveReviewEngineLabel(id, entry, resolveAgentLabel);
  const disabled = entry ? !(entry.available === true && supportsReviewIntent(entry)) : false;
  return { id, label, ...(disabled ? { disabled: true as const } : {}) };
}

export function buildAvailableReviewEngineOptions(params: Readonly<{
  enabledAgentIds: readonly string[];
  resolveAgentLabel: (agentId: string) => string;
  executionRunsBackends: Readonly<Record<string, ExecutionRunsBackendSnapshotEntry>> | null | undefined;
}>): readonly ReviewEngineOption[] {
  const backends = params.executionRunsBackends ?? null;
  const includedIds = new Set<string>();

  const agentOptions: ReviewEngineOption[] = params.enabledAgentIds
    .map((id) => String(id ?? '').trim())
    .filter((id) => id.length > 0)
    .map((id) => {
      includedIds.add(id);
      if (!backends) return { id, label: params.resolveAgentLabel(id) };
      const entry = backends[id];
      // If the machine explicitly reports the backend, surface it even when unavailable so the
      // UI can explain why it's disabled instead of hiding it entirely.
      return buildReviewEngineOption(id, entry, params.resolveAgentLabel);
    });

  if (!backends) {
    return agentOptions;
  }

  const discoveredReviewOptions = Object.entries(backends)
    .map(([rawId, entry]) => [String(rawId ?? '').trim(), entry] as const)
    .filter(([id]) => id.length > 0 && !includedIds.has(id))
    .filter(([, entry]) => supportsReviewIntent(entry))
    .map(([id, entry]) => buildReviewEngineOption(id, entry, params.resolveAgentLabel));

  return [...agentOptions, ...discoveredReviewOptions];
}
