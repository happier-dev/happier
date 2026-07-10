export type CodexHookParityCatalogStatus = 'catalog-backed' | 'missing-a-lane-owner';

export type CodexHookParityRole =
  | 'codex-handled'
  | 'extension-projector-emitted'
  | 'host-bridge-emitted';

export type CodexHookParityRow = Readonly<{
  catalogStatus: CodexHookParityCatalogStatus;
  id: string;
  missingOwner?: 'A-lane-hook-substrate';
  role: CodexHookParityRole;
}>;

export const CODEX_HOOK_PARITY_ROWS = [
  { id: 'session.spawned', role: 'host-bridge-emitted', catalogStatus: 'catalog-backed' },
  { id: 'session.message.send', role: 'host-bridge-emitted', catalogStatus: 'catalog-backed' },
  { id: 'executionRun.started', role: 'host-bridge-emitted', catalogStatus: 'catalog-backed' },
  { id: 'executionRun.messageSent', role: 'host-bridge-emitted', catalogStatus: 'catalog-backed' },
  { id: 'executionRun.stopped', role: 'host-bridge-emitted', catalogStatus: 'catalog-backed' },
  { id: 'executionRun.completed', role: 'host-bridge-emitted', catalogStatus: 'catalog-backed' },
  {
    id: 'agent.resolvePrerequisites',
    role: 'codex-handled',
    catalogStatus: 'catalog-backed',
  },
  { id: 'agent.spawnEnv.augment', role: 'codex-handled', catalogStatus: 'catalog-backed' },
  { id: 'agent.response.after', role: 'codex-handled', catalogStatus: 'catalog-backed' },
  { id: 'tool.call.before', role: 'codex-handled', catalogStatus: 'catalog-backed' },
  { id: 'tool.result.after', role: 'codex-handled', catalogStatus: 'catalog-backed' },
  { id: 'resource.discovery', role: 'codex-handled', catalogStatus: 'catalog-backed' },
  { id: 'plugin.reload.before', role: 'codex-handled', catalogStatus: 'catalog-backed' },
  { id: 'plugin.reload.after', role: 'codex-handled', catalogStatus: 'catalog-backed' },
  {
    id: 'session.attached',
    role: 'host-bridge-emitted',
    catalogStatus: 'catalog-backed',
  },
  {
    id: 'session.detached',
    role: 'host-bridge-emitted',
    catalogStatus: 'catalog-backed',
  },
  {
    id: 'approval.decision.made',
    role: 'host-bridge-emitted',
    catalogStatus: 'catalog-backed',
  },
  {
    id: 'subagent.started',
    role: 'extension-projector-emitted',
    catalogStatus: 'catalog-backed',
  },
  {
    id: 'subagent.ended',
    role: 'extension-projector-emitted',
    catalogStatus: 'catalog-backed',
  },
] as const satisfies readonly CodexHookParityRow[];

export const CODEX_CATALOG_BACKED_HOOK_IDS = CODEX_HOOK_PARITY_ROWS
  .filter((row) => row.catalogStatus === 'catalog-backed')
  .map((row) => row.id);

export const CODEX_MISSING_A_LANE_HOOK_IDS = CODEX_HOOK_PARITY_ROWS
  .filter((row) => row.catalogStatus === 'missing-a-lane-owner')
  .map((row) => row.id);
