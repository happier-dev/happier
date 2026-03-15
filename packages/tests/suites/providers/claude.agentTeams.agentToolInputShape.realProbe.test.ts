/**
 * Real Claude Code probe (opt-in):
 * - Runs the locally installed "claude" CLI (must already be authenticated on the host).
 * - Force-enables Claude Code experimental Agent Teams.
 * - Creates an agent team and spawns teammates.
 * - If Claude emits `Agent` tool_use blocks for teammate creation, validates the observed input shape.
 *
 * Enable locally:
 *   HAPPIER_TEST_REAL_CLAUDE=1 HAPPIER_TEST_REAL_CLAUDE_FULL=1 yarn -s workspace @happier-dev/tests test:providers claude.agentTeams.agentToolInputShape.realProbe.test.ts
 */

import { describe, expect, it } from 'vitest';

import { runRealClaudeCliStreamJsonProbe } from '../../src/testkit/providers/claude/realClaudeCliProbe';

const ENABLED = process.env.HAPPIER_TEST_REAL_CLAUDE === '1';
const FULL_PROBE = process.env.HAPPIER_TEST_REAL_CLAUDE_FULL === '1';

describe('real Claude Agent Teams Agent tool input shape probe', () => {
  if (!ENABLED || !FULL_PROBE) {
    it.skip('requires HAPPIER_TEST_REAL_CLAUDE=1 and HAPPIER_TEST_REAL_CLAUDE_FULL=1 (opt-in)', () => {});
    return;
  }

  it(
    'captures Agent tool_use input shape when present',
    { timeout: 120_000 },
    async () => {
      if (process.platform === 'win32') {
        throw new Error('Real Claude CLI probe is not supported on Windows in this repo.');
      }

      const prompt = [
        'This is a test harness for validating Claude Code Agent Teams teammate tool payloads.',
        'You MUST create a team named "probe" with two agents ("Alpha" and "Beta").',
        'Ensure the teammates are spawned and running.',
        'Do not use Bash. Do not access files. Do not use any other tools.',
      ].join('\n');

      const result = await runRealClaudeCliStreamJsonProbe({
        prompt,
        maxTurns: 4,
        timeoutMs: 90_000,
        envOverlay: {
          CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS: '1',
        },
        stopWhen: ({ toolUses, toolResults }) => {
          const hasTeamCreate = toolUses.some((u) => u.name === 'TeamCreate');
          const hasSpawned = toolResults.some((r) => {
            if (!r.result || typeof r.result !== 'object' || Array.isArray(r.result)) return false;
            return (r.result as any)?.tool_use_result?.status === 'teammate_spawned';
          });
          return hasTeamCreate && hasSpawned;
        },
      });

      // Claude can emit either `Task` tool uses or `Agent` tool uses for teammate creation depending on version.
      const hasAgentToolUse = result.toolUses.some((u) => u.name === 'Agent');
      const hasTaskToolUse = result.toolUses.some((u) => u.name === 'Task');
      expect(hasAgentToolUse || hasTaskToolUse).toBe(true);

      if (!hasAgentToolUse) return;

      const agentToolUses = result.toolUses.filter((u) => u.name === 'Agent');
      expect(agentToolUses.length).toBeGreaterThan(0);
      for (const use of agentToolUses.slice(0, 2)) {
        expect(use.input).toEqual(expect.anything());
        expect(use.input && typeof use.input === 'object' && !Array.isArray(use.input)).toBe(true);

        // Keep this shape intentionally loose: Claude has been observed to vary keys across versions.
        expect(use.input).toEqual(expect.objectContaining({
          name: expect.any(String),
        }));

        const record = use.input as any;
        const promptValue = typeof record.prompt === 'string' ? record.prompt.trim() : '';
        const descriptionValue = typeof record.description === 'string' ? record.description.trim() : '';
        expect(promptValue.length > 0 || descriptionValue.length > 0).toBe(true);
      }
    },
  );
});

