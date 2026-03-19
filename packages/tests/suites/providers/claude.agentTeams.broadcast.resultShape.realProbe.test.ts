/**
 * Real Claude Code probe (opt-in):
 * - Runs the locally installed `claude` CLI (must already be authenticated on the host).
 * - Force-enables Claude Code experimental Agent Teams.
 * - Creates a team, then sends a broadcast message.
 * - Validates the SendMessage broadcast tool_use input + tool_result acknowledgement (JSON preferred when present).
 *
 * Enable locally:
 *   HAPPIER_TEST_REAL_CLAUDE=1 HAPPIER_TEST_REAL_CLAUDE_FULL=1 yarn -s workspace @happier-dev/tests test:providers claude.agentTeams.broadcast.resultShape.realProbe.test.ts
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

describe('real Claude Agent Teams broadcast SendMessage result shape probe', () => {
  if (!ENABLED) {
    it.skip('requires HAPPIER_TEST_REAL_CLAUDE=1 (opt-in)', () => {});
    return;
  }

  if (!FULL_PROBE) {
    it.skip('requires HAPPIER_TEST_REAL_CLAUDE_FULL=1 (opt-in, multi-turn)', () => {});
    return;
  }

  it(
    'returns a non-empty acknowledgement for broadcast SendMessage (JSON preferred when present)',
    { timeout: 120_000 },
    async () => {
      if (process.platform === 'win32') {
        throw new Error('Real Claude CLI probe is not supported on Windows in this repo.');
      }

      const marker = `BROADCAST_RESULT_OK_${Date.now()}`;
      const token = Date.now().toString(36);
      const prompt = [
        'This is a test harness for validating Claude Code Agent Teams broadcast SendMessage result shape.',
        'You MUST use Agent Teams (agent swarm) and invoke TeamCreate and SendMessage tools.',
        `Create a team named "probe-broadcast-${token}" with two agents ("Alpha" and "Beta").`,
        'Ensure the teammates are spawned.',
        `Send a broadcast message to the team: "Reply with EXACT text: ${marker}".`,
        'Do not use any other tools. Do not use Bash. Do not access files.',
      ].join('\n');

      const result = await runRealClaudeCliStreamJsonProbe({
        prompt,
        maxTurns: 5,
        timeoutMs: 100_000,
        envOverlay: {
          CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS: '1',
        },
        stopWhen: ({ toolUses, toolResults }) => {
          const hasBroadcastUse = toolUses.some((u) => u.name === 'SendMessage' && (u.input as any)?.type === 'broadcast');
          const hasAnyResult = toolResults.length >= 2;
          return hasBroadcastUse && hasAnyResult;
        },
      });

      const sendMessageUses = result.toolUses.filter((u) => u.name === 'SendMessage');
      expect(sendMessageUses.length).toBeGreaterThan(0);
      const broadcast = sendMessageUses.find((u) => (u.input as any)?.type === 'broadcast') ?? null;
      expect(broadcast).not.toBeNull();
      if (broadcast) {
        expect(broadcast.input).toEqual(expect.objectContaining({
          type: 'broadcast',
          content: expect.any(String),
        }));
      }

      const broadcastToolUseId =
        sendMessageUses
          .filter((u) => (u.input as any)?.type === 'broadcast')
          .map((u) => u.toolUseId)
          .find((id): id is string => typeof id === 'string' && id.trim().length > 0) ?? null;

      const broadcastResult =
        (broadcastToolUseId
          ? result.toolResults.find((r) => r.toolUseId === broadcastToolUseId) ?? null
          : null) ??
        result.toolResults.at(-1) ??
        null;

      expect(broadcastResult).not.toBeNull();
      if (!broadcastResult) return;

      const text = coerceTextFromToolResultResult(broadcastResult.result);
      expect(typeof text === 'string' && text.trim().length > 0).toBe(true);

      const parsed = tryParseJsonObject(text);
      if (parsed) {
        if ('success' in parsed) {
          expect(parsed).toEqual(expect.objectContaining({ success: true }));
        }
        if ('message' in parsed) {
          expect(String((parsed as any).message ?? '').trim().length).toBeGreaterThan(0);
        }
      }
    },
  );
});

