/**
 * Real Claude Code probe (opt-in):
 * - Ensures the teammate spawn tool_result can be correlated back to the originating tool_use name.
 * - Protects Happier's UI/tool normalization: if Claude changes the "task tool" name, this test should fail
 *   so we can update our legacy/canonical mappings (e.g. `TaskCreate` → `Task`).
 *
 * Enable locally:
 *   HAPPIER_TEST_REAL_CLAUDE=1 HAPPIER_TEST_REAL_CLAUDE_FULL=1 yarn -s workspace @happier-dev/tests test:providers claude.agentTeams.spawnToolUseName.realProbe.test.ts
 */

import { describe, expect, it } from 'vitest';

import { runRealClaudeCliStreamJsonProbe } from '../../src/testkit/providers/claude/realClaudeCliProbe';

const ENABLED = process.env.HAPPIER_TEST_REAL_CLAUDE === '1';
const FULL_PROBE = process.env.HAPPIER_TEST_REAL_CLAUDE_FULL === '1';

describe('real Claude Agent Teams spawn tool_use name probe', () => {
  if (!ENABLED) {
    it.skip('requires HAPPIER_TEST_REAL_CLAUDE=1 (opt-in)', () => {});
    return;
  }

  if (!FULL_PROBE) {
    it.skip('requires HAPPIER_TEST_REAL_CLAUDE_FULL=1 (needs tool_use + tool_result correlation)', () => {});
    return;
  }

  it(
    'correlates teammate_spawned tool_result back to the originating tool_use name',
    { timeout: 120_000 },
    async () => {
      if (process.platform === 'win32') {
        throw new Error('Real Claude CLI probe is not supported on Windows in this repo.');
      }

      const prompt = [
        'This is a test harness for discovering the tool_use name that produces the teammate_spawned tool_result.',
        'You MUST use Claude Code Agent Teams.',
        'Create a team named "probe_spawn".',
        'Spawn a single teammate named "Alpha".',
        'Do not use any other tools. Do not use Bash. Do not access files.',
        'Once the teammate is spawned, stop.',
      ].join('\n');

      const result = await runRealClaudeCliStreamJsonProbe({
        prompt,
        maxTurns: 4,
        timeoutMs: 90_000,
        envOverlay: {
          CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS: '1',
        },
        stopWhen: ({ toolResults }) => {
          return toolResults.some((r) => {
            if (!r.result || typeof r.result !== 'object' || Array.isArray(r.result)) return false;
            return (r.result as any)?.tool_use_result?.status === 'teammate_spawned';
          });
        },
      });

      const spawned = result.toolResults.find((r) => {
        if (!r.result || typeof r.result !== 'object' || Array.isArray(r.result)) return false;
        return (r.result as any)?.tool_use_result?.status === 'teammate_spawned';
      }) ?? null;

      expect(spawned).not.toBeNull();
      expect(spawned?.toolUseId).toEqual(expect.any(String));

      const toolUse = result.toolUses.find((u) => u.toolUseId === spawned?.toolUseId) ?? null;
      expect(toolUse).not.toBeNull();

      // Known/expected teammate/task tool names. Claude Code has emitted teammate spawns via `Agent` in
      // current builds, and via Task-like tools in some historical flows/sessions.
      //
      // If Claude changes this, update our normalization (UI + parsing).
      expect(['Agent', 'Task', 'TaskCreate', 'TaskUpdate', 'TaskList']).toContain(toolUse?.name);
    },
  );
});
