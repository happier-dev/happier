import { describe, expect, it } from 'vitest';

import { normalizeToolCallV2, normalizeToolResultV2 } from './index';
import { asRecord, firstFixtureEvent, loadFixtureV1 } from './fixtures.v1.testkit';

describe('tool normalization fixtures (v1): catalog coverage', () => {
  it('includes baseline coverage across protocols/providers', () => {
    const fixtures = loadFixtureV1();
    const keys = Object.keys(fixtures.examples);

    expect(keys).toEqual(expect.arrayContaining([
      'acp/auggie/tool-call/Bash',
      'acp/opencode/tool-call/execute',
      'acp/gemini/permission-request/edit',
      'acp/codex/tool-call/execute',
      'codex/codex/tool-call/CodexBash',
      'claude/claude/tool-call/Bash',
    ]));
  });

  it('applies key canonical tool-call transformations (execute→Bash, CodexDiff→Diff, CodexPatch→Patch, GeminiReasoning→Reasoning)', () => {
    const fixtures = loadFixtureV1();

    const exec = firstFixtureEvent(fixtures, 'acp/opencode/tool-call/execute');
    expect(exec).toBeTruthy();
    const execPayload = asRecord(exec?.payload) ?? {};
    const execNorm = normalizeToolCallV2({
      protocol: 'acp',
      provider: 'opencode',
      toolName: String(execPayload.name ?? ''),
      rawInput: execPayload.input,
      callId: typeof execPayload.callId === 'string' ? execPayload.callId : undefined,
    });
    expect(execNorm.canonicalToolName).toBe('Bash');

    const codexBash = firstFixtureEvent(fixtures, 'codex/codex/tool-call/CodexBash');
    expect(codexBash).toBeTruthy();
    const codexBashPayload = asRecord(codexBash?.payload) ?? {};
    const codexBashNorm = normalizeToolCallV2({
      protocol: 'codex',
      provider: 'codex',
      toolName: String(codexBashPayload.name ?? ''),
      rawInput: codexBashPayload.input,
      callId: typeof codexBashPayload.callId === 'string' ? codexBashPayload.callId : undefined,
    });
    expect(codexBashNorm.canonicalToolName).toBe('Bash');
    expect(typeof asRecord(codexBashNorm.input)?.command).toBe('string');

    const codexDiff = firstFixtureEvent(fixtures, 'codex/codex/tool-call/CodexDiff');
    expect(codexDiff).toBeTruthy();
    const codexDiffPayload = asRecord(codexDiff?.payload) ?? {};
    const codexDiffNorm = normalizeToolCallV2({
      protocol: 'codex',
      provider: 'codex',
      toolName: String(codexDiffPayload.name ?? ''),
      rawInput: codexDiffPayload.input,
      callId: typeof codexDiffPayload.callId === 'string' ? codexDiffPayload.callId : undefined,
    });
    expect(codexDiffNorm.canonicalToolName).toBe('Diff');
    expect(typeof asRecord(codexDiffNorm.input)?.unified_diff).toBe('string');

    const codexPatch = firstFixtureEvent(fixtures, 'codex/codex/tool-call/CodexPatch');
    expect(codexPatch).toBeTruthy();
    const codexPatchPayload = asRecord(codexPatch?.payload) ?? {};
    const codexPatchNorm = normalizeToolCallV2({
      protocol: 'codex',
      provider: 'codex',
      toolName: String(codexPatchPayload.name ?? ''),
      rawInput: codexPatchPayload.input,
      callId: typeof codexPatchPayload.callId === 'string' ? codexPatchPayload.callId : undefined,
    });
    expect(codexPatchNorm.canonicalToolName).toBe('Patch');
    expect(asRecord(asRecord(codexPatchNorm.input)?.changes)).toBeTruthy();

    const reasoning = firstFixtureEvent(fixtures, 'acp/gemini/tool-call/GeminiReasoning');
    expect(reasoning).toBeTruthy();
    const reasoningPayload = asRecord(reasoning?.payload) ?? {};
    const reasoningNorm = normalizeToolCallV2({
      protocol: 'acp',
      provider: 'gemini',
      toolName: String(reasoningPayload.name ?? ''),
      rawInput: reasoningPayload.input,
      callId: typeof reasoningPayload.callId === 'string' ? reasoningPayload.callId : undefined,
    });
    expect(reasoningNorm.canonicalToolName).toBe('Reasoning');
  });

  it('canonicalizes ACP lowercase tool names into canonical families (including heuristics for edit/write/fetch)', () => {
    const fixtures = loadFixtureV1();

    const normalizeFirst = (key: string, index = 0) => {
      const event = fixtures.examples[key]?.[index];
      expect(event).toBeTruthy();
      const payload = asRecord(event?.payload) ?? {};
      return normalizeToolCallV2({
        protocol: 'acp',
        provider: String(event?.provider ?? 'unknown'),
        toolName: String(payload.name ?? ''),
        rawInput: payload.input,
        callId: typeof payload.callId === 'string' ? payload.callId : undefined,
      });
    };

    expect(normalizeFirst('acp/opencode/tool-call/execute').canonicalToolName).toBe('Bash');
    expect(normalizeFirst('acp/codex/tool-call/execute').canonicalToolName).toBe('Bash');
    expect(normalizeFirst('acp/gemini/tool-call/execute').canonicalToolName).toBe('Bash');

    expect(normalizeFirst('acp/opencode/tool-call/read').canonicalToolName).toBe('Read');
    expect(normalizeFirst('acp/codex/tool-call/read').canonicalToolName).toBe('Read');
    expect(normalizeFirst('acp/gemini/tool-call/read').canonicalToolName).toBe('Read');

    expect(normalizeFirst('acp/gemini/tool-call/glob').canonicalToolName).toBe('Glob');
    expect(normalizeFirst('claude/claude/tool-call/Glob').canonicalToolName).toBe('Glob');

    expect(normalizeFirst('acp/opencode/tool-call/search').canonicalToolName).toBe('CodeSearch');
    expect(normalizeFirst('acp/codex/tool-call/search').canonicalToolName).toBe('CodeSearch');
    expect(normalizeFirst('acp/gemini/tool-call/search').canonicalToolName).toBe('CodeSearch');
    expect(normalizeFirst('acp/auggie/tool-call/search').canonicalToolName).toBe('CodeSearch');

    expect(normalizeFirst('acp/opencode/tool-call/edit', 0).canonicalToolName).toBe('Write');
    expect(normalizeFirst('acp/opencode/tool-call/edit', 1).canonicalToolName).toBe('Edit');
    expect(normalizeFirst('acp/codex/tool-call/edit', 0).canonicalToolName).toBe('Patch');

    expect(normalizeFirst('acp/gemini/tool-call/write', 0).canonicalToolName).toBe('Write');
    expect(normalizeFirst('acp/gemini/tool-call/write', 1).canonicalToolName).toBe('TodoWrite');

    expect(normalizeFirst('acp/auggie/tool-call/fetch', 0).canonicalToolName).toBe('WebSearch');
    expect(normalizeFirst('acp/auggie/tool-call/fetch', 1).canonicalToolName).toBe('WebFetch');
  });

  it('normalizes MCP generic tools into a stable safe-display shape (title/subtitle + raw preserved)', () => {
    const fixtures = loadFixtureV1();
    const call = firstFixtureEvent(fixtures, 'codex/codex/tool-call/mcp__happier__change_title');
    expect(call).toBeTruthy();
    const callPayload = asRecord(call?.payload) ?? {};
    const callNorm = normalizeToolCallV2({
      protocol: 'codex',
      provider: 'codex',
      toolName: String(callPayload.name ?? ''),
      rawInput: callPayload.input,
      callId: typeof callPayload.callId === 'string' ? callPayload.callId : undefined,
    });
    expect(callNorm.canonicalToolName).toBe('change_title');
    const input = asRecord(callNorm.input);
    expect(typeof input?.title).toBe('string');
    expect(asRecord(input)?._raw).toBeDefined();

    const result = firstFixtureEvent(fixtures, 'codex/codex/tool-call-result/mcp__happier__change_title');
    expect(result).toBeTruthy();
    const resultPayload = asRecord(result?.payload) ?? {};
    const resultNorm = normalizeToolResultV2({
      protocol: 'codex',
      provider: 'codex',
      rawToolName: String(callPayload.name ?? ''),
      canonicalToolName: callNorm.canonicalToolName,
      rawOutput: resultPayload.output,
    });
    const out = asRecord(resultNorm);
    expect(typeof out?.title).toBe('string');
    expect(out?._raw).toBeDefined();
  });
});
