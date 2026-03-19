/**
 * Real Claude Code probe (opt-in):
 * - Runs the locally installed `claude` CLI (must already be authenticated on the host).
 * - Force-enables Claude Code experimental Agent Teams.
 * - Creates a team, then deletes it.
 * - Validates the TeamDelete tool_use input and tool_result acknowledgement shape so Happier stays aligned.
 *
 * Enable locally:
 *   HAPPIER_TEST_REAL_CLAUDE=1 HAPPIER_TEST_REAL_CLAUDE_FULL=1 yarn -s workspace @happier-dev/tests test:providers claude.agentTeams.teamDelete.resultShape.realProbe.test.ts
 */

import { describe, expect, it } from 'vitest';

import {
  coerceTextFromToolResultResult,
  runRealClaudeCliStreamJsonProbe,
} from '../../src/testkit/providers/claude/realClaudeCliProbe';

const ENABLED = process.env.HAPPIER_TEST_REAL_CLAUDE === '1';
const FULL_PROBE = process.env.HAPPIER_TEST_REAL_CLAUDE_FULL === '1';

function tryParseJsonObject(text: string | null): Record<string, unknown> | null {
  if (!text) return null;
  try {
    const parsed = JSON.parse(text) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    return parsed as Record<string, unknown>;
  } catch {
    return null;
  }
}

describe('real Claude Agent Teams TeamDelete result shape probe', () => {
  if (!ENABLED) {
    it.skip('requires HAPPIER_TEST_REAL_CLAUDE=1 (opt-in)', () => {});
    return;
  }

  if (!FULL_PROBE) {
    it.skip('requires HAPPIER_TEST_REAL_CLAUDE_FULL=1 (opt-in, multi-turn)', () => {});
    return;
  }

  it(
    'returns a non-empty acknowledgement for TeamDelete (JSON preferred when present)',
    { timeout: 120_000 },
    async () => {
      if (process.platform === 'win32') {
        throw new Error('Real Claude CLI probe is not supported on Windows in this repo.');
      }

      const token = Date.now().toString(36);
      const prompt = [
        'This is a test harness for validating Claude Code Agent Teams TeamDelete result shape.',
        'You MUST use Agent Teams (agent swarm) and invoke TeamCreate and TeamDelete tools.',
        `Create a team named "probe-delete-${token}" with one agent ("Alpha").`,
        'Ensure the teammate is spawned.',
        'Then delete the team using TeamDelete.',
        'Do not use any other tools. Do not use Bash. Do not access files.',
      ].join('\n');

      const result = await runRealClaudeCliStreamJsonProbe({
        prompt,
        maxTurns: 5,
        timeoutMs: 100_000,
        envOverlay: { CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS: '1' },
        stopWhen: ({ toolUses, toolResults }) => {
          const hasDelete = toolUses.some((u) => u.name === 'TeamDelete');
          const hasAnyResult = toolResults.length >= 2;
          return hasDelete && hasAnyResult;
        },
      });

      const deleteUses = result.toolUses.filter((u) => u.name === 'TeamDelete');
      expect(deleteUses.length).toBeGreaterThan(0);
      for (const u of deleteUses.slice(0, 2)) {
        expect(u.input).toEqual(expect.anything());
      }

      const deleteToolUseId =
        deleteUses.map((u) => u.toolUseId).find((id): id is string => typeof id === 'string' && id.trim().length > 0) ?? null;
      const deleteResult =
        (deleteToolUseId ? result.toolResults.find((r) => r.toolUseId === deleteToolUseId) ?? null : null) ??
        result.toolResults.at(-1) ??
        null;
      expect(deleteResult).not.toBeNull();
      if (!deleteResult) return;

      const text = coerceTextFromToolResultResult(deleteResult.result);
      expect(typeof text === 'string' && text.trim().length > 0).toBe(true);

      const parsed = tryParseJsonObject(text);
      if (parsed) {
        // Claude tool_result shapes can evolve. Keep assertions stable but meaningful.
        // Common pattern: `{ success: boolean, message: "..." }`.
        if ('success' in parsed) {
          expect(typeof (parsed as any).success).toBe('boolean');
        }
        if ('message' in parsed) {
          expect(String((parsed as any).message ?? '').trim().length).toBeGreaterThan(0);
        }
        if ('team_name' in parsed) {
          expect(String((parsed as any).team_name ?? '').trim().length).toBeGreaterThan(0);
        }
      }
    },
  );
});
