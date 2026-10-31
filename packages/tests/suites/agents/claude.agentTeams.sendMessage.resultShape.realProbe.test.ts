/**
 * Real Claude Code probe (opt-in):
 * - Runs the locally installed `claude` CLI (must already be authenticated on the host).
 * - Force-enables Claude Code experimental Agent Teams.
 * - Validates the SendMessage tool_use input + tool_result shape (JSON payload) so Happier normalization stays aligned.
 *
 * Enable locally:
 *   HAPPIER_TEST_REAL_CLAUDE=1 HAPPIER_TEST_REAL_CLAUDE_FULL=1 yarn -s workspace @happier-dev/tests test:agents claude.agentTeams.sendMessage.resultShape.realProbe.test.ts
 */

import { describe, expect, it } from 'vitest';

import {
  coerceTextFromToolResultResult,
  runRealClaudeCliStreamJsonProbe,
  type RealClaudeToolUseBlock,
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

describe('real Claude Agent Teams SendMessage result shape probe', () => {
  if (!ENABLED) {
    it.skip('requires HAPPIER_TEST_REAL_CLAUDE=1 (opt-in)', () => {});
    return;
  }

  if (!FULL_PROBE) {
    it.skip('requires HAPPIER_TEST_REAL_CLAUDE_FULL=1 (opt-in, multi-turn)', () => {});
    return;
  }

  it(
    'returns a JSON tool_result payload with success=true for direct teammate SendMessage',
    { timeout: 120_000 },
    async () => {
      if (process.platform === 'win32') {
        throw new Error('Real Claude CLI probe is not supported on Windows in this repo.');
      }

      const marker = `SENDMESSAGE_RESULT_OK_${Date.now()}`;
      const isDirectMessage = (use: RealClaudeToolUseBlock) =>
        use.name === 'SendMessage' && typeof use.input === 'object' && use.input !== null
        && 'type' in use.input && use.input.type === 'message';
      const prompt = [
        'This is a test harness for validating Claude Code Agent Teams SendMessage result shape.',
        'You MUST use Agent Teams (agent swarm) and invoke TeamCreate and SendMessage tools.',
        'Create a team named "probe-sendresult" with one agent ("Alpha").',
        `Send a direct message to teammate Alpha: "Reply with EXACT text: ${marker}".`,
        'Do not use any other tools. Do not use Bash. Do not access files.',
      ].join('\n');

      const result = await runRealClaudeCliStreamJsonProbe({
        prompt,
        maxTurns: 4,
        timeoutMs: 90_000,
        envOverlay: {
          CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS: '1',
        },
        stopWhen: ({ toolUses, toolResults }) => {
          const direct = toolUses.find(isDirectMessage);
          return Boolean(direct?.toolUseId && toolResults.some((r) => r.toolUseId === direct.toolUseId));
        },
      });

      const sendMessageUses = result.toolUses.filter((u) => u.name === 'SendMessage');
      expect(sendMessageUses.length).toBeGreaterThan(0);
      const direct = sendMessageUses.find(isDirectMessage) ?? null;
      expect(direct).not.toBeNull();
      if (direct) {
        expect(direct.input).toEqual(expect.objectContaining({
          type: 'message',
          recipient: expect.any(String),
          content: expect.any(String),
        }));
      }

      const sendMessageToolUseId = direct?.toolUseId;
      expect(sendMessageToolUseId?.trim()).toBeTruthy();
      const sendMessageToolResult =
        sendMessageToolUseId
          ? result.toolResults.find((r) => r.toolUseId === sendMessageToolUseId) ?? null
          : null;

      expect(sendMessageToolResult).not.toBeNull();

      // TeamCreate tool_result commonly includes an authoritative team id + config path.
      // This is the stable source Happier should prefer over the requested `team_name` input.
      const teamCreateJson =
        result.toolResults
          .map((r) => tryParseJsonObject(coerceTextFromToolResultResult(r.result)))
          .find((obj) => Boolean(obj && typeof obj.team_name === 'string' && typeof obj.team_file_path === 'string')) ??
        null;
      expect(teamCreateJson).not.toBeNull();
      if (teamCreateJson) {
        expect(String(teamCreateJson.team_name).trim().length).toBeGreaterThan(0);
        expect(String(teamCreateJson.team_file_path).trim().length).toBeGreaterThan(0);
      }

      const sendAckText = coerceTextFromToolResultResult(sendMessageToolResult?.result);
      expect(sendAckText).not.toBeNull();
      if (!sendAckText) throw new Error('did not observe any tool_result text');

      const parsedAck = tryParseJsonObject(sendAckText);
      if (parsedAck) {
        // Preferred stable shape: `{ success: true, message: "Message sent ...", ... }`
        expect(parsedAck).toEqual(expect.objectContaining({ success: true }));
        // Message string varies; avoid pinning exact wording beyond being non-empty.
        expect(String(parsedAck.message ?? '').trim().length).toBeGreaterThan(0);
      } else {
        // Fallback: plain-text acknowledgement shape (wording varies).
        expect(sendAckText.trim().length).toBeGreaterThan(0);
      }
    },
  );
});
