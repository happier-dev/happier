/**
 * Real Claude Code probe (opt-in):
 * - Runs the locally installed `claude` CLI (must already be authenticated on the host).
 * - Force-enables Claude Code experimental Agent Teams.
 * - Verifies that teammate subagent JSONL transcripts are written to disk.
 *
 * Enable locally:
 *   HAPPIER_TEST_REAL_CLAUDE=1 HAPPIER_TEST_REAL_CLAUDE_FULL=1 yarn -s workspace @happier-dev/tests test:providers claude.agentTeams.subagentJsonl.realProbe.test.ts
 */

import { describe, expect, it } from 'vitest';

import {
  findClaudeSubagentJsonlPath,
  runRealClaudeCliStreamJsonProbe,
} from '../../src/testkit/providers/claude/realClaudeCliProbe';

const ENABLED = process.env.HAPPIER_TEST_REAL_CLAUDE === '1';
const FULL_PROBE = process.env.HAPPIER_TEST_REAL_CLAUDE_FULL === '1';

async function waitForNonNull<T>(args: {
  timeoutMs: number;
  intervalMs: number;
  get: () => T | null;
}): Promise<T | null> {
  const deadline = Date.now() + args.timeoutMs;
  while (Date.now() < deadline) {
    const value = args.get();
    if (value !== null) return value;
    await new Promise((resolve) => setTimeout(resolve, args.intervalMs));
  }
  return null;
}

describe('real Claude Agent Teams subagent JSONL probe', () => {
  if (!ENABLED) {
    it.skip('requires HAPPIER_TEST_REAL_CLAUDE=1 (opt-in)', () => {});
    return;
  }

  it(
    'writes teammate subagent transcripts under ~/.claude/projects/<project>/<sessionId>/subagents',
    { timeout: 180_000 },
    async () => {
      if (!FULL_PROBE) {
        throw new Error('This probe requires HAPPIER_TEST_REAL_CLAUDE_FULL=1 to ensure teammates are spawned.');
      }
      if (process.platform === 'win32') {
        throw new Error('Real Claude CLI probe is not supported on Windows in this repo.');
      }

      const prompt = [
        'This is a test harness for verifying Claude Code Agent Teams subagent transcript files.',
        'You MUST use Agent Teams.',
        'Create a team named "probe" with two agents ("Alpha" and "Beta").',
        'Send a direct message to teammate Alpha: "Reply with EXACT text: OK".',
        'Send a direct message to teammate Beta: "Reply with EXACT text: OK".',
        'Do not use any other tools. Do not use Bash. Do not access files.',
      ].join('\n');

      const result = await runRealClaudeCliStreamJsonProbe({
        prompt,
        maxTurns: 4,
        timeoutMs: 120_000,
        envOverlay: {
          CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS: '1',
        },
        stopWhen: ({ toolUses, toolResults }) => {
          const hasTeamCreate = toolUses.some((u) => u.name === 'TeamCreate');
          const sendMessages = toolUses.filter((u) => u.name === 'SendMessage');
          const hasSendMessage = sendMessages.length >= 2;
          const hasSpawned = toolResults.some((r) => {
            if (!r.result || typeof r.result !== 'object' || Array.isArray(r.result)) return false;
            return (r.result as any)?.tool_use_result?.status === 'teammate_spawned';
          });
          return hasTeamCreate && hasSendMessage && hasSpawned;
        },
      });

      expect(result.sessionId).toBeTruthy();
      expect(result.agentIds.length).toBeGreaterThan(0);

      const sessionId = result.sessionId!;
      const uniqueAgentIds = Array.from(new Set(result.agentIds)).slice(0, 4);

      const foundPaths: string[] = [];
      for (const agentId of uniqueAgentIds) {
        const path = await waitForNonNull({
          timeoutMs: 10_000,
          intervalMs: 250,
          get: () => findClaudeSubagentJsonlPath({ sessionId, agentId }),
        });
        expect(path, `Expected subagent jsonl path for agentId=${agentId}`).toBeTruthy();
        if (path) foundPaths.push(path);
      }

      // Sanity: at least one path exists.
      expect(foundPaths.length).toBeGreaterThan(0);
    },
  );
});

