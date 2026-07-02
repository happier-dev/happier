import {
  EXTENSION_HOOK_CATALOG_V1,
  getExtensionHookDefinitionV1,
} from '@happier-dev/protocol';
import { describe, expect, it } from 'vitest';

import {
  CODEX_CATALOG_BACKED_HOOK_IDS,
  CODEX_HOOK_PARITY_ROWS,
  CODEX_MISSING_A_LANE_HOOK_IDS,
} from './hookParity.fixture.js';

const EXPECTED_B6_HOOK_IDS = [
  'session.spawn_new',
  'session.message.send',
  'execution_run.start',
  'execution_run.send',
  'execution_run.stop',
  'execution_run.terminal',
  'backend.resolveRuntimePrerequisites',
  'spawn.augmentEnv',
  'provider.response.after',
  'tool.call.before',
  'tool.result.after',
  'resource.discovery',
  'plugin.reload.before',
  'plugin.reload.after',
  'session.attached',
  'session.detached',
  'approval.decision.made',
  'subagent.start',
  'subagent.end',
] as const;

const BROAD_SURFACE_LABELS = [
  'app-server-catalog',
  'catalog-control',
  'execution-run-runtime',
  'goal-control',
  'mcp-detection',
  'permission-decision',
  'runtime-core',
  'session-runtime',
  'startup-state',
  'terminal-runtime-support',
  'usage-limit-recovery-control',
] as const;

describe('Codex B.6 hook parity fixture', () => {
  it('records the concrete B.6 hook ids without broad surface labels', () => {
    const ids = CODEX_HOOK_PARITY_ROWS.map((row) => row.id);

    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toEqual([...EXPECTED_B6_HOOK_IDS]);
    expect(ids).not.toEqual(expect.arrayContaining([...BROAD_SURFACE_LABELS]));
  });

  it('verifies catalog-backed hooks against the accepted protocol hook catalog', () => {
    const catalogIds = new Set(EXTENSION_HOOK_CATALOG_V1.map((entry) => entry.id));

    for (const hookId of CODEX_CATALOG_BACKED_HOOK_IDS) {
      expect(catalogIds.has(hookId)).toBe(true);
      expect(getExtensionHookDefinitionV1(hookId)?.id).toBe(hookId);
    }
  });

  it('records no remaining A-lane hook catalog blockers after A.7 acceptance', () => {
    expect(CODEX_MISSING_A_LANE_HOOK_IDS).toEqual([]);

    for (const row of CODEX_HOOK_PARITY_ROWS) {
      expect(row.catalogStatus).toBe('catalog-backed');
      expect(getExtensionHookDefinitionV1(row.id)?.id).toBe(row.id);
    }
  });
});
