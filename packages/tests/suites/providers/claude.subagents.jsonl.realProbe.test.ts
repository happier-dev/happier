/**
 * Real Claude Code probe (opt-in):
 * - Runs the locally installed "claude" CLI (must already be authenticated on the host).
 * - Forces a Task/subagent spawn.
 * - Validates that Claude Code writes per-subagent JSONL output files under ".claude/projects/<project>/<session_id>/subagents/".
 *
 * Enable locally:
 *   HAPPIER_TEST_REAL_CLAUDE=1 HAPPIER_TEST_REAL_CLAUDE_FULL=1 yarn -s workspace @happier-dev/tests test:providers claude.subagents.jsonl.realProbe.test.ts
 */

import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import {
  findClaudeSubagentJsonlPath,
  runRealClaudeCliStreamJsonProbe,
} from '../../src/testkit/providers/claude/realClaudeCliProbe';

const ENABLED = process.env.HAPPIER_TEST_REAL_CLAUDE === '1';
const FULL_PROBE = process.env.HAPPIER_TEST_REAL_CLAUDE_FULL === '1';

describe('real Claude subagent JSONL probe', () => {
  if (!ENABLED || !FULL_PROBE) {
    it.skip('requires HAPPIER_TEST_REAL_CLAUDE=1 and HAPPIER_TEST_REAL_CLAUDE_FULL=1 (opt-in)', () => {});
    return;
  }

  it(
    'writes per-subagent JSONL files under .claude/projects/**/<session_id>/subagents/agent-<agent_id>.jsonl after Task spawn',
    { timeout: 120_000 },
    async () => {
      if (process.platform === 'win32') {
        throw new Error('Real Claude CLI probe is not supported on Windows in this repo.');
      }

      const prompt = [
        'This is a test harness for validating Claude Code subagent JSONL output.',
        'You MUST use the Task tool exactly once to spawn a subagent.',
        'Do not use Bash. Do not access files. Do not use any other tools.',
        'Ask the subagent to reply with EXACT text: SUBAGENT_OK.',
        'After spawning the subagent, reply yourself with EXACT text: OK.',
      ].join('\n');

      const result = await runRealClaudeCliStreamJsonProbe({
        prompt,
        timeoutMs: 90_000,
        maxTurns: 1,
      });

      expect(result.toolUseNames).toContain('Task');
      expect(typeof result.sessionId === 'string' && result.sessionId.trim().length > 0).toBe(true);
      expect(result.agentIds.length).toBeGreaterThan(0);

      const sessionId = String(result.sessionId);
      const agentId = String(result.agentIds[0] ?? '').trim();
      expect(agentId.length).toBeGreaterThan(0);

      const jsonlPath = findClaudeSubagentJsonlPath({ sessionId, agentId });
      expect(jsonlPath).toBeTruthy();
      if (!jsonlPath) return;

      const content = readFileSync(jsonlPath, 'utf8');
      expect(content.trim().length).toBeGreaterThan(0);
      expect(content).toContain(agentId);
    },
  );
});
