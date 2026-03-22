/**
 * Real Claude Code probe (opt-in):
 * - Runs the locally installed `claude` CLI (must already be authenticated on the host).
 * - Force-enables Claude Code experimental Agent Teams.
 * - Creates a team, then stops a teammate via TaskStop.
 * - Captures the observed TaskStop tool_use input + tool_result status/text so Happier lifecycle normalization stays aligned.
 *
 * Enable locally:
 *   HAPPIER_TEST_REAL_CLAUDE=1 HAPPIER_TEST_REAL_CLAUDE_FULL=1 yarn -s workspace @happier-dev/tests test:providers claude.agentTeams.shutdown.resultShape.realProbe.test.ts
 */

import { describe, expect, it } from 'vitest';

import {
  coerceTextFromToolResultResult,
  runRealClaudeCliStreamJsonProbe,
} from '../../src/testkit/providers/claude/realClaudeCliProbe';

const ENABLED = process.env.HAPPIER_TEST_REAL_CLAUDE === '1';
const FULL_PROBE = process.env.HAPPIER_TEST_REAL_CLAUDE_FULL === '1';

function extractStatuses(toolResults: ReadonlyArray<{ result: unknown }>): string[] {
  const out: string[] = [];
  for (const r of toolResults) {
    if (!r?.result || typeof r.result !== 'object' || Array.isArray(r.result)) continue;
    const status = (r.result as any)?.tool_use_result?.status;
    if (typeof status === 'string' && status.trim().length > 0) out.push(status.trim());
  }
  return out;
}

describe('real Claude Agent Teams shutdown result shape probe', () => {
  if (!ENABLED) {
    it.skip('requires HAPPIER_TEST_REAL_CLAUDE=1 (opt-in)', () => {});
    return;
  }

  if (!FULL_PROBE) {
    it.skip('requires HAPPIER_TEST_REAL_CLAUDE_FULL=1 (opt-in, multi-turn)', () => {});
    return;
  }

  it(
    'invokes TaskStop and returns a non-empty acknowledgement (status/text) for teammate shutdown',
    { timeout: 120_000 },
    async () => {
      if (process.platform === 'win32') {
        throw new Error('Real Claude CLI probe is not supported on Windows in this repo.');
      }

      const token = Date.now().toString(36);
      const prompt = [
        'This is a test harness for validating Claude Code Agent Teams shutdown protocol cues.',
        'You MUST use Agent Teams (agent swarm) and you MUST invoke TeamCreate, spawn two teammates, then stop one via TaskStop.',
        `Create a team named "probe-shutdown-${token}" with two agents ("Alpha" and "Beta").`,
        'Spawn teammate Alpha, then spawn teammate Beta.',
        'Ensure BOTH teammates are spawned and running.',
        'Then stop teammate Beta using TaskStop (use whatever id/reference Claude provides for the teammate/task).',
        'Do not use Bash. Do not access files. Do not use any other tools.',
        'Once Beta is stopped, stop.',
        'Finally, reply with EXACT text: OK.',
      ].join('\n');

      const result = await runRealClaudeCliStreamJsonProbe({
        prompt,
        maxTurns: 10,
        timeoutMs: 110_000,
        envOverlay: {
          CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS: '1',
        },
        stopWhen: ({ toolUses, toolResults }) => {
          const spawnedCount = toolResults.filter((r) => {
            if (!r.result || typeof r.result !== 'object' || Array.isArray(r.result)) return false;
            return (r.result as any)?.tool_use_result?.status === 'teammate_spawned';
          }).length;

          const taskStopUse = toolUses.find((u) => u.name === 'TaskStop') ?? null;
          const hasTaskStopResult = Boolean(
            taskStopUse?.toolUseId && toolResults.some((r) => r.toolUseId === taskStopUse.toolUseId),
          );

          return spawnedCount >= 2 && Boolean(taskStopUse) && hasTaskStopResult;
        },
      });

      const sendMessageUses = result.toolUses.filter((u) => u.name === 'SendMessage');

      // Ensure the "shutdown protocol" capability remains discoverable for downstream UI semantics.
      // Claude Code frequently includes this as an instruction in the teammate's prompt in teammate_spawned tool_use_result.
      expect(result.initTools).toEqual(expect.arrayContaining(['TeamCreate', 'TeamDelete', 'SendMessage', 'TaskStop']));

      const statuses = Array.from(new Set(extractStatuses(result.toolResults)));
      const spawnedCount = extractStatuses(result.toolResults).filter((s) => s === 'teammate_spawned').length;
      if (spawnedCount < 2) {
        throw new Error(
          [
            `Expected 2 teammate_spawned tool_use_result events, observed ${spawnedCount}.`,
            `Observed tool_use_result.status values: ${Array.from(new Set(extractStatuses(result.toolResults))).join(', ') || '(none)'}`,
            `stdoutTail:\n${result.stdoutTail.join('\n')}`,
            `stderrTail:\n${result.stderrTail.join('\n')}`,
          ].join('\n'),
        );
      }

      const taskStopUses = result.toolUses.filter((u) => u.name === 'TaskStop');
      expect(taskStopUses.length).toBeGreaterThan(0);
      for (const u of taskStopUses.slice(0, 2)) {
        expect(u.input).toEqual(expect.anything());
        expect(Boolean(u.input && typeof u.input === 'object' && !Array.isArray(u.input))).toBe(true);
      }

      const taskStopToolUseId =
        taskStopUses.map((u) => u.toolUseId).find((id): id is string => typeof id === 'string' && id.trim().length > 0) ?? null;
      const taskStopResult =
        (taskStopToolUseId ? result.toolResults.find((r) => r.toolUseId === taskStopToolUseId) ?? null : null) ??
        null;
      expect(taskStopResult).not.toBeNull();
      if (!taskStopResult) return;

      const taskStopText = coerceTextFromToolResultResult(taskStopResult.result);
      const taskStopStatus =
        taskStopResult.result && typeof taskStopResult.result === 'object' && !Array.isArray(taskStopResult.result)
          ? (taskStopResult.result as any)?.tool_use_result?.status
          : null;

      // Claude tool_result shapes can evolve. Keep assertions stable but meaningful.
      // Require either a non-empty status string or a non-empty text acknowledgement.
      if (typeof taskStopStatus === 'string' && taskStopStatus.trim().length > 0) {
        const s = taskStopStatus.trim().toLowerCase();
        expect(s.includes('stop') || s.includes('shutdown')).toBe(true);
      } else {
        expect(typeof taskStopText === 'string' && taskStopText.trim().length > 0).toBe(true);
        if (taskStopText) {
          const t = taskStopText.toLowerCase();
          expect(t.includes('stop') || t.includes('shutdown') || t.includes('terminated')).toBe(true);
        }
      }

      // Ensure the "shutdown protocol" capability remains discoverable for downstream UI semantics.
      // Claude Code frequently includes this as an instruction in the teammate's prompt in teammate_spawned tool_use_result.
      const spawnedPrompts = result.toolResults
        .map((r) => {
          if (!r.result || typeof r.result !== 'object' || Array.isArray(r.result)) return null;
          const prompt = (r.result as any)?.tool_use_result?.prompt;
          return typeof prompt === 'string' ? prompt : null;
        })
        .filter((p): p is string => typeof p === 'string' && p.trim().length > 0);

      const hasShutdownCue = spawnedPrompts.some((p) => p.toLowerCase().includes('shutdown'));
      if (!hasShutdownCue) {
        throw new Error(
          [
            'Did not observe any shutdown cue in teammate_spawned tool_use_result.prompt payloads.',
            `Observed tool_use_result.status values: ${statuses.join(', ') || '(none)'}`,
            `Observed SendMessage input.type values: ${
              Array.from(
                new Set(
                  sendMessageUses
                    .map((u) => (u.input as any)?.type)
                    .filter((t): t is string => typeof t === 'string' && t.trim().length > 0)
                    .map((t) => t.trim()),
                ),
              ).join(', ') || '(none)'
            }`,
            `Observed spawned prompts:\n${spawnedPrompts.join('\n---\n')}`,
            `stdoutTail:\n${result.stdoutTail.join('\n')}`,
            `stderrTail:\n${result.stderrTail.join('\n')}`,
          ].join('\n'),
        );
      }
    },
  );
});
