import type { ExecutionRunsBackendSnapshotEntry } from '@/sync/domains/reviews/reviewEngineCatalog';

export type ExecutionRunProfileCapability = Readonly<{
  id: string;
  intent: string;
  title: string;
  compatibleAgentIds: readonly string[];
  generationId: string;
  available: boolean;
  unavailableCode?: string;
  defaults: Readonly<{ retention: string; runClass: string; io: string }>;
}>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readProfileTitle(value: unknown, fallback: string): string {
  if (typeof value === 'string' && value.trim()) return value.trim();
  if (isRecord(value) && typeof value.fallback === 'string' && value.fallback.trim()) return value.fallback.trim();
  return fallback;
}

export function extractExecutionRunsBackendsFromMachineCapabilitiesState(state: any): Record<string, ExecutionRunsBackendSnapshotEntry> | null {
  const snapshot = state?.snapshot?.response;
  const entry = snapshot?.results?.['tool.executionRuns'];
  if (!entry || entry.ok !== true) return null;
  const backends = (entry.data as any)?.backends;
  if (!backends || typeof backends !== 'object') return null;
  return backends as any;
}

export function extractExecutionRunProfilesFromMachineCapabilitiesState(state: unknown): readonly ExecutionRunProfileCapability[] {
  const snapshot = isRecord(state) && isRecord(state.snapshot) && isRecord(state.snapshot.response)
    ? state.snapshot.response
    : null;
  const results = snapshot && isRecord(snapshot.results) ? snapshot.results : null;
  const entry = results?.['tool.executionRuns'];
  if (!isRecord(entry) || entry.ok !== true || !isRecord(entry.data)) return Object.freeze([]);
  const rawProfiles = entry.data.executionRunProfiles;
  if (!Array.isArray(rawProfiles)) return Object.freeze([]);

  return Object.freeze(rawProfiles.flatMap((raw): ExecutionRunProfileCapability[] => {
    if (!isRecord(raw)) return [];
    const id = typeof raw.id === 'string' ? raw.id.trim() : '';
    const intent = typeof raw.intent === 'string' ? raw.intent.trim() : '';
    const generationId = typeof raw.generationId === 'string' ? raw.generationId.trim() : '';
    const compatibleAgentIds = Array.isArray(raw.compatibleAgents)
      ? raw.compatibleAgents.map((agentId) => typeof agentId === 'string' ? agentId.trim() : '').filter(Boolean)
      : [];
    const defaults = isRecord(raw.defaults) ? raw.defaults : null;
    if (
      !id.includes('/')
      || !intent
      || !generationId
      || compatibleAgentIds.length === 0
      || !defaults
      || typeof defaults.retention !== 'string'
      || typeof defaults.runClass !== 'string'
      || typeof defaults.io !== 'string'
    ) return [];
    return [{
      id,
      intent,
      title: readProfileTitle(raw.title, id),
      compatibleAgentIds: Object.freeze(compatibleAgentIds),
      generationId,
      available: raw.available === true,
      ...(typeof raw.unavailableCode === 'string' && raw.unavailableCode.trim()
        ? { unavailableCode: raw.unavailableCode.trim() }
        : {}),
      defaults: Object.freeze({
        retention: defaults.retention,
        runClass: defaults.runClass,
        io: defaults.io,
      }),
    }];
  }));
}
