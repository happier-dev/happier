/**
 * Real Claude Code probe (opt-in):
 * - Runs the locally installed `claude` CLI (must already be authenticated on the host).
 * - Force-enables Claude Code experimental Agent Teams.
 * - Verifies that Agent Teams teammates produce subagent JSONL files under ~/.claude/projects,
 *   and that the routed teammate message appears in that transcript.
 *
 * Enable locally:
 *   HAPPIER_TEST_REAL_CLAUDE=1 HAPPIER_TEST_REAL_CLAUDE_FULL=1 yarn -s workspace @happier-dev/tests test:providers claude.agentTeams.subagentJsonl.realProbe.test.ts
 */

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import {
  findClaudeSubagentJsonlPath,
  runRealClaudeCliStreamJsonProbe,
} from '../../src/testkit/providers/claude/realClaudeCliProbe';

const ENABLED = process.env.HAPPIER_TEST_REAL_CLAUDE === '1';
const FULL_PROBE = process.env.HAPPIER_TEST_REAL_CLAUDE_FULL === '1';

async function waitFor<T>(fn: () => T | null, timeoutMs: number): Promise<T | null> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const value = fn();
    if (value !== null) return value;
    await new Promise((r) => setTimeout(r, 150));
  }
  return null;
}

describe('real Claude Agent Teams subagent JSONL probe', () => {
  if (!ENABLED) {
    it.skip('requires HAPPIER_TEST_REAL_CLAUDE=1 (opt-in)', () => {});
    return;
  }

  if (!FULL_PROBE) {
    it.skip('requires HAPPIER_TEST_REAL_CLAUDE_FULL=1 (opt-in, multi-turn)', () => {});
    return;
  }

  it(
    'writes a subagent JSONL file for a teammate and records the teammate bootstrap transcript',
    { timeout: 180_000 },
    async () => {
      if (process.platform === 'win32') {
        throw new Error('Real Claude CLI probe is not supported on Windows in this repo.');
      }

      const prompt = [
        'This is a test harness for validating Claude Code Agent Teams subagent transcripts.',
        'You MUST use Agent Teams (agent swarm).',
        'Create a team named "probe-jsonl" with two agents ("Alpha" and "Beta").',
        'Ensure the teammates are spawned and running.',
        'Do not message the teammates after spawn.',
        'After the teammates are spawned, respond with: DONE.',
        'Do not use any other tools. Do not use Bash. Do not access files.',
      ].join('\n');

      const result = await runRealClaudeCliStreamJsonProbe({
        prompt,
        maxTurns: 2,
        timeoutMs: 60_000,
        envOverlay: {
          CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS: '1',
        },
        stopWhen: ({ toolResults }) =>
          toolResults.some((r) => {
            if (!r.result || typeof r.result !== 'object' || Array.isArray(r.result)) return false;
            return (r.result as any)?.tool_use_result?.status === 'teammate_spawned';
          }),
      });

      expect(result.sessionId).toEqual(expect.any(String));
      expect(result.initTools).toEqual(expect.arrayContaining(['TeamCreate', 'TeamDelete', 'SendMessage']));

      expect(result.sessionId).not.toBeNull();
      if (!result.sessionId) throw new Error('probe did not capture sessionId');

      const jsonlPath = await waitFor(
        () => findClaudeSubagentJsonlPath({ sessionId: result.sessionId!, agentId: 'Alpha@probe-jsonl' }),
        15_000,
      );
      expect(jsonlPath).not.toBeNull();
      if (!jsonlPath) {
        throw new Error('unable to locate subagent JSONL file for Alpha');
      }

      const raw = readFileSync(jsonlPath, 'utf-8');
      expect(raw.length).toBeGreaterThan(0);
      expect(raw).toMatch(/\bAlpha\b/);
      expect(raw).toMatch(/probe-jsonl/);
    },
  );
});
