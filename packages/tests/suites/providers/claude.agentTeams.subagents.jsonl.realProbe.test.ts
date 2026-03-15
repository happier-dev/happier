/**
 * Real Claude Code probe (opt-in):
 * - Runs the locally installed "claude" CLI (must already be authenticated on the host).
 * - Force-enables Claude Code experimental Agent Teams.
 * - Creates an agent team and ensures teammates are spawned.
 * - Validates that the teammate spawn payload includes an `output_file` path (or equivalent) and that the target file exists.
 *
 * Enable locally:
 *   HAPPIER_TEST_REAL_CLAUDE=1 HAPPIER_TEST_REAL_CLAUDE_FULL=1 yarn -s workspace @happier-dev/tests test:providers claude.agentTeams.subagents.jsonl.realProbe.test.ts
 */

import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import {
  findClaudeSubagentJsonlPath,
  runRealClaudeCliStreamJsonProbe,
} from '../../src/testkit/providers/claude/realClaudeCliProbe';

const ENABLED = process.env.HAPPIER_TEST_REAL_CLAUDE === '1';
const FULL_PROBE = process.env.HAPPIER_TEST_REAL_CLAUDE_FULL === '1';

describe('real Claude Agent Teams subagent JSONL probe', () => {
  if (!ENABLED || !FULL_PROBE) {
    it.skip('requires HAPPIER_TEST_REAL_CLAUDE=1 and HAPPIER_TEST_REAL_CLAUDE_FULL=1 (opt-in)', () => {});
    return;
  }

  it(
    'writes per-teammate JSONL files under .claude/projects/**/<session_id>/subagents/agent-<agent_id>.jsonl after teammate spawn',
    { timeout: 180_000 },
    async () => {
      if (process.platform === 'win32') {
        throw new Error('Real Claude CLI probe is not supported on Windows in this repo.');
      }

      const prompt = [
        'This is a test harness for validating Claude Code Agent Teams subagent JSONL output.',
        'You MUST use the Agent Teams feature and you MUST create a team named "probe" with two agents ("Alpha" and "Beta").',
        'Ensure the teammates are spawned and running.',
        'Do not use Bash. Do not access files. Do not use any other tools.',
      ].join('\n');

      const result = await runRealClaudeCliStreamJsonProbe({
        prompt,
        timeoutMs: 120_000,
        maxTurns: 4,
        envOverlay: {
          CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS: '1',
        },
        stopWhen: ({ toolUses, toolResults }) => {
          const hasTeamCreate = toolUses.some((u) => u.name === 'TeamCreate');
          const hasSpawnWithId = toolResults.some((r) => {
            if (!r.result || typeof r.result !== 'object' || Array.isArray(r.result)) return false;
            const tur = (r.result as any)?.tool_use_result;
            if (!tur || typeof tur !== 'object' || Array.isArray(tur)) return false;
            if (tur.status !== 'teammate_spawned') return false;
            const agentId = typeof tur.agent_id === 'string' ? tur.agent_id.trim() : '';
            const teammateId = typeof tur.teammate_id === 'string' ? tur.teammate_id.trim() : '';
            return Boolean(agentId || teammateId);
          });
          return hasTeamCreate && hasSpawnWithId;
        },
      });

      expect(result.toolUseNames).toContain('TeamCreate');
      // Teammate spawn metadata has been observed to arrive via `Task` tool_result in some versions,
      // but Claude may also only emit `Agent` tool uses for teammate creation. Accept either.
      expect(result.toolUseNames.some((n) => n === 'Task' || n === 'Agent')).toBe(true);
      expect(typeof result.sessionId === 'string' && result.sessionId.trim().length > 0).toBe(true);
      expect(result.agentIds.length).toBeGreaterThan(0);

      const sessionId = String(result.sessionId);
      const uniqueAgentIds = Array.from(new Set(result.agentIds)).map((v) => String(v).trim()).filter(Boolean);
      expect(uniqueAgentIds.length).toBeGreaterThan(0);

      const waitForJsonl = async (agentId: string): Promise<string | null> => {
        const deadline = Date.now() + 10_000;
        while (Date.now() < deadline) {
          const jsonlPath = findClaudeSubagentJsonlPath({ sessionId, agentId });
          if (jsonlPath) return jsonlPath;
          await new Promise((r) => setTimeout(r, 500));
        }
        return null;
      };

      for (const agentId of uniqueAgentIds.slice(0, 2)) {
        const jsonlPath = await waitForJsonl(agentId);
        expect(jsonlPath).toBeTruthy();
        if (!jsonlPath) continue;
        const content = readFileSync(jsonlPath, 'utf8');
        expect(content.trim().length).toBeGreaterThan(0);
      }
    },
  );
});
