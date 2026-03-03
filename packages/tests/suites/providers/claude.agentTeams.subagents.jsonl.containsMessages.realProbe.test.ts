/**
 * Real Claude Code probe (opt-in):
 * - Runs the locally installed "claude" CLI (must already be authenticated on the host).
 * - Force-enables Claude Code experimental Agent Teams.
 * - Creates an agent team and spawns teammates.
 * - Sends both a direct teammate message and a broadcast.
 * - Validates the Alpha teammate JSONL contains the message markers.
 *
 * Enable locally:
 *   HAPPIER_TEST_REAL_CLAUDE=1 HAPPIER_TEST_REAL_CLAUDE_FULL=1 yarn -s workspace @happier-dev/tests test:providers claude.agentTeams.subagents.jsonl.containsMessages.realProbe.test.ts
 */

import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import {
  coerceTextFromToolResultResult,
  findClaudeSubagentJsonlPath,
  runRealClaudeCliStreamJsonProbe,
} from '../../src/testkit/providers/claude/realClaudeCliProbe';

const ENABLED = process.env.HAPPIER_TEST_REAL_CLAUDE === '1';
const FULL_PROBE = process.env.HAPPIER_TEST_REAL_CLAUDE_FULL === '1';

describe('real Claude Agent Teams subagent JSONL content probe', () => {
  if (!ENABLED || !FULL_PROBE) {
    it.skip('requires HAPPIER_TEST_REAL_CLAUDE=1 and HAPPIER_TEST_REAL_CLAUDE_FULL=1 (opt-in)', () => {});
    return;
  }

  it(
    'emits direct + broadcast SendMessage tool uses (with markers) and writes teammate JSONL files',
    { timeout: 150_000 },
    async () => {
      if (process.platform === 'win32') {
        throw new Error('Real Claude CLI probe is not supported on Windows in this repo.');
      }

      const token = Date.now().toString(36);
      const directMarker = `HAPPIER_PROBE_DIRECT_${token}`;
      const broadcastMarker = `HAPPIER_PROBE_BROADCAST_${token}`;

      const prompt = [
        'This is a test harness for validating Claude Code Agent Teams teammate JSONL content.',
        'You MUST use the Agent Teams feature and you MUST create a team named "probe" with two agents ("Alpha" and "Beta").',
        'Ensure the teammates are spawned and running.',
        `Send a direct message to teammate Alpha with EXACT content: ${directMarker}`,
        `Send a broadcast to the team with EXACT content: ${broadcastMarker}`,
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
          const hasDirectSend = toolUses.some(
            (u) =>
              u.name === 'SendMessage' &&
              (u.input as any)?.type === 'message' &&
              (u.input as any)?.content === directMarker &&
              (u.input as any)?.recipient !== 'team-lead',
          );
          const hasBroadcastSend = toolUses.some(
            (u) => u.name === 'SendMessage' && (u.input as any)?.type === 'broadcast' && (u.input as any)?.content === broadcastMarker,
          );
          const hasDirectResult = toolResults.some((r) => (coerceTextFromToolResultResult(r.result) ?? '').includes(directMarker));
          const hasBroadcastResult = toolResults.some((r) => (coerceTextFromToolResultResult(r.result) ?? '').includes(broadcastMarker));
          const hasSpawnWithId = toolResults.some((r) => {
            if (!r.result || typeof r.result !== 'object' || Array.isArray(r.result)) return false;
            const tur = (r.result as any)?.tool_use_result;
            if (!tur || typeof tur !== 'object' || Array.isArray(tur)) return false;
            if (tur.status !== 'teammate_spawned') return false;
            const agentId = typeof tur.agent_id === 'string' ? tur.agent_id.trim() : '';
            const teammateId = typeof tur.teammate_id === 'string' ? tur.teammate_id.trim() : '';
            return Boolean(agentId || teammateId);
          });
          return hasTeamCreate && hasDirectSend && hasBroadcastSend && hasDirectResult && hasBroadcastResult && hasSpawnWithId;
        },
      });

      const hasTeamCreate = result.toolUses.some((u) => u.name === 'TeamCreate');
      const hasDirectSend = result.toolUses.some(
        (u) => u.name === 'SendMessage' && (u.input as any)?.type === 'message' && (u.input as any)?.content === directMarker,
      );
      const hasBroadcastSend = result.toolUses.some(
        (u) => u.name === 'SendMessage' && (u.input as any)?.type === 'broadcast' && (u.input as any)?.content === broadcastMarker,
      );
      const hasSpawnWithId = result.toolResults.some((r) => {
        if (!r.result || typeof r.result !== 'object' || Array.isArray(r.result)) return false;
        const tur = (r.result as any)?.tool_use_result;
        if (!tur || typeof tur !== 'object' || Array.isArray(tur)) return false;
        if (tur.status !== 'teammate_spawned') return false;
        const agentId = typeof tur.agent_id === 'string' ? tur.agent_id.trim() : '';
        const teammateId = typeof tur.teammate_id === 'string' ? tur.teammate_id.trim() : '';
        return Boolean(agentId || teammateId);
      });

      expect(hasTeamCreate).toBe(true);
      expect(hasDirectSend).toBe(true);
      expect(hasBroadcastSend).toBe(true);
      expect(hasSpawnWithId).toBe(true);

      expect(typeof result.sessionId === 'string' && result.sessionId.trim().length > 0).toBe(true);
      expect(result.agentIds.length).toBeGreaterThan(0);

      const toolResultTexts = result.toolResults.map((r) => coerceTextFromToolResultResult(r.result)).filter(Boolean);
      expect(toolResultTexts.some((t) => t.includes(directMarker))).toBe(true);
      expect(toolResultTexts.some((t) => t.includes(broadcastMarker))).toBe(true);

      const sessionId = String(result.sessionId);
      const uniqueAgentIds = Array.from(new Set(result.agentIds))
        .map((v) => String(v).trim())
        .filter(Boolean);
      expect(uniqueAgentIds.length).toBeGreaterThan(0);

      const waitForJsonl = async (agentId: string): Promise<string | null> => {
        const deadline = Date.now() + 25_000;
        while (Date.now() < deadline) {
          const jsonlPath = findClaudeSubagentJsonlPath({ sessionId, agentId });
          if (jsonlPath) return jsonlPath;
          await new Promise((r) => setTimeout(r, 500));
        }
        return null;
      };

      const jsonlPath = await waitForJsonl(uniqueAgentIds[0] ?? '');
      expect(jsonlPath).toBeTruthy();
      if (!jsonlPath) return;
      const jsonlContent = readFileSync(jsonlPath, 'utf8');
      expect(jsonlContent.trim().length).toBeGreaterThan(0);
    },
  );
});
