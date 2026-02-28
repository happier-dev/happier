/**
 * Real Claude Code probe (opt-in):
 * - Runs the locally installed `claude` CLI (must already be authenticated on the host).
 * - Force-enables Claude Code experimental Agent Teams.
 * - Captures any emitted tool_use names so we can keep Happier normalization in sync.
 *
 * Enable locally:
 *   HAPPIER_TEST_REAL_CLAUDE=1 yarn -s workspace @happier-dev/tests test:providers claude.agentTeams.toolNames.realProbe.test.ts
 */

import { describe, expect, it } from 'vitest';

import {
  coerceTextFromToolResultResult,
  runRealClaudeCliStreamJsonProbe,
} from '../../src/testkit/providers/claude/realClaudeCliProbe';

const ENABLED = process.env.HAPPIER_TEST_REAL_CLAUDE === '1';
const FULL_PROBE = process.env.HAPPIER_TEST_REAL_CLAUDE_FULL === '1';

describe('real Claude Agent Teams tool name probe', () => {
  if (!ENABLED) {
    it.skip('requires HAPPIER_TEST_REAL_CLAUDE=1 (opt-in)', () => {});
    return;
  }

  it(
    'discovers the Agent Teams tool names (from system:init tool list) when Claude Code experimental Agent Teams is force-enabled',
    { timeout: 120_000 },
    async () => {
      if (process.platform === 'win32') {
        throw new Error('Real Claude CLI probe is not supported on Windows in this repo.');
      }

      const prompt = [
        'This is a test harness for discovering Claude Code Agent Teams tool names.',
        'You MUST use the Agent Teams feature (agent swarm) and you MUST invoke the Agent Teams tools.',
        'Create a team named "probe" with two agents ("Alpha" and "Beta").',
        'Ensure the teammates are spawned and running.',
        'Send a direct message to teammate Alpha: "Reply with EXACT text: OK".',
        'Also send a broadcast to the team: "Reply with EXACT text: OK".',
        'Do not use any other tools. Do not use Bash. Do not access files.',
      ].join('\n');

      const result = await runRealClaudeCliStreamJsonProbe({
        prompt,
        maxTurns: FULL_PROBE ? 4 : 1,
        timeoutMs: 90_000,
        envOverlay: {
          // Force-enable Claude Code experimental Agent Teams / agent swarm.
          CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS: '1',
        },
        stopWhen: FULL_PROBE
          ? ({ toolUses, toolResults }) => {
              const hasTeamCreate = toolUses.some((u) => u.name === 'TeamCreate');
              const hasSendMessage = toolUses.some((u) => u.name === 'SendMessage');
              const hasSpawned = toolResults.some((r) => {
                if (!r.result || typeof r.result !== 'object' || Array.isArray(r.result)) return false;
                return (r.result as any)?.tool_use_result?.status === 'teammate_spawned';
              });
              return hasTeamCreate && hasSendMessage && hasSpawned;
            }
          : undefined,
      });

      expect(result.initTools).toEqual(expect.arrayContaining(['TeamCreate', 'TeamDelete', 'SendMessage']));

      if (FULL_PROBE) {
        const unique = Array.from(new Set(result.toolUseNames));
        expect(unique.length).toBeGreaterThan(0);

        const teamCreate = result.toolUses.find((u) => u.name === 'TeamCreate') ?? null;
        expect(teamCreate).not.toBeNull();
        if (teamCreate) {
          expect(teamCreate.input).toEqual(expect.objectContaining({
            team_name: expect.any(String),
            description: expect.any(String),
          }));
        }

        const sendMessageUses = result.toolUses.filter((u) => u.name === 'SendMessage');
        expect(sendMessageUses.length).toBeGreaterThan(0);
        for (const use of sendMessageUses.slice(0, 3)) {
          expect(use.input).toEqual(expect.anything());
          expect(use.input && typeof use.input === 'object' && !Array.isArray(use.input)).toBe(true);
        }

        // Teammate spawn: Claude Code currently emits this via Task tool_result. Capture either the structured
        // tool_use_result payload or the text fallback (agent_id/team_name/name lines).
        const spawnedStructured = result.toolResults.find((r) => {
          if (!r.result || typeof r.result !== 'object' || Array.isArray(r.result)) return false;
          return (r.result as any)?.tool_use_result?.status === 'teammate_spawned';
        }) ?? null;

        const spawnedText = result.toolResults.find((r) => {
          const t = coerceTextFromToolResultResult(r.result);
          if (!t) return false;
          return t.includes('Spawned successfully') && (t.includes('agent_id:') || t.includes('teammate_id:')) && t.includes('team_name:');
        }) ?? null;

        expect(spawnedStructured || spawnedText).toBeTruthy();

        if (spawnedStructured) {
          const toolUseResult = (spawnedStructured.result as any).tool_use_result as any;
          expect(toolUseResult).toEqual(expect.objectContaining({
            status: 'teammate_spawned',
          }));
          expect(typeof toolUseResult.agent_id === 'string' || typeof toolUseResult.teammate_id === 'string').toBe(true);
          expect(typeof toolUseResult.team_name === 'string' && toolUseResult.team_name.trim().length > 0).toBe(true);
        }
      }
    },
  );
});
