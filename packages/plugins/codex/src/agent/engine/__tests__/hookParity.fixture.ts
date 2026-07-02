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
  { id: 'session.spawn_new', role: 'host-bridge-emitted', catalogStatus: 'catalog-backed' },
  { id: 'session.message.send', role: 'host-bridge-emitted', catalogStatus: 'catalog-backed' },
  { id: 'execution_run.start', role: 'host-bridge-emitted', catalogStatus: 'catalog-backed' },
  { id: 'execution_run.send', role: 'host-bridge-emitted', catalogStatus: 'catalog-backed' },
  { id: 'execution_run.stop', role: 'host-bridge-emitted', catalogStatus: 'catalog-backed' },
  { id: 'execution_run.terminal', role: 'host-bridge-emitted', catalogStatus: 'catalog-backed' },
  {
    id: 'backend.resolveRuntimePrerequisites',
    role: 'codex-handled',
    catalogStatus: 'catalog-backed',
  },
  { id: 'spawn.augmentEnv', role: 'codex-handled', catalogStatus: 'catalog-backed' },
  { id: 'provider.response.after', role: 'codex-handled', catalogStatus: 'catalog-backed' },
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
    id: 'subagent.start',
    role: 'extension-projector-emitted',
    catalogStatus: 'catalog-backed',
  },
  {
    id: 'subagent.end',
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
