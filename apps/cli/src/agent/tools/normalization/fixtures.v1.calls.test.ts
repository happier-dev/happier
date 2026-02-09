import { describe, expect, it } from 'vitest';

import { normalizeToolCallV2 } from './index';
import {
  asRecord,
  asToolNormalizationProtocol,
  firstFixtureEvent,
  loadFixtureV1,
  type ToolTraceEventV1,
} from './fixtures.v1.testkit';

function normalizeFirstCallEvent(event: ToolTraceEventV1) {
  const payload = asRecord(event.payload) ?? {};
  return normalizeToolCallV2({
    protocol: asToolNormalizationProtocol(event.protocol),
    provider: String(event.provider ?? 'unknown'),
    toolName: String(payload.name ?? ''),
    rawInput: payload.input,
    callId:
      typeof payload.callId === 'string'
        ? payload.callId
        : typeof payload.id === 'string'
          ? payload.id
          : undefined,
  });
}

describe('tool normalization fixtures (v1): tool calls + permissions', () => {
  it('normalizes tool-call events into canonical tool names + V2 metadata', () => {
    const fixtures = loadFixtureV1();
    expect(fixtures.v).toBe(1);

    for (const events of Object.values(fixtures.examples)) {
      for (const event of events) {
        if (event.kind !== 'tool-call') continue;

        const payload = asRecord(event.payload) ?? {};
        const toolName = String(payload.name ?? '');
        const callId = typeof payload.callId === 'string' ? payload.callId : undefined;
        expect(toolName.length).toBeGreaterThan(0);

        const normalized = normalizeToolCallV2({
          protocol: asToolNormalizationProtocol(event.protocol),
          provider: String(event.provider ?? 'unknown'),
          toolName,
          rawInput: payload.input,
          callId,
        });

        expect(typeof normalized.canonicalToolName).toBe('string');
        expect(normalized.canonicalToolName.length).toBeGreaterThan(0);

        const inputRecord = asRecord(normalized.input);
        expect(inputRecord).toBeTruthy();
        expect(asRecord(inputRecord?._happier)).toMatchObject({
          v: 2,
          protocol: event.protocol,
          provider: event.provider,
          rawToolName: toolName,
          canonicalToolName: normalized.canonicalToolName,
        });
        expect(inputRecord?._raw).toBeDefined();
      }
    }
  });

  it('normalizes tool-call inputs for file/search/web tools (surfaces key fields when provided)', () => {
    const fixtures = loadFixtureV1();

    const sample = (key: string): ToolTraceEventV1 => {
      const event = firstFixtureEvent(fixtures, key);
      expect(event).toBeTruthy();
      return event as ToolTraceEventV1;
    };

    {
      const norm = normalizeFirstCallEvent(sample('claude/claude/tool-call/Write'));
      expect(norm.canonicalToolName).toBe('Write');
      const input = asRecord(norm.input);
      expect(typeof input?.file_path).toBe('string');
      expect(typeof input?.content).toBe('string');
    }

    {
      const norm = normalizeFirstCallEvent(sample('claude/claude/tool-call/TodoWrite'));
      expect(norm.canonicalToolName).toBe('TodoWrite');
      expect(Array.isArray(asRecord(norm.input)?.todos)).toBe(true);
    }

    {
      const norm = normalizeFirstCallEvent(sample('acp/gemini/tool-call/TodoWrite'));
      expect(norm.canonicalToolName).toBe('TodoWrite');
      expect(Array.isArray(asRecord(norm.input)?.todos)).toBe(true);
    }

    {
      const norm = normalizeFirstCallEvent(sample('claude/claude/tool-call/Edit'));
      expect(norm.canonicalToolName).toBe('Edit');
      const input = asRecord(norm.input);
      expect(typeof input?.file_path).toBe('string');
      expect(typeof input?.old_string).toBe('string');
      expect(typeof input?.new_string).toBe('string');
    }

    {
      const norm = normalizeFirstCallEvent(sample('acp/opencode/tool-call/search'));
      expect(norm.canonicalToolName).toBe('CodeSearch');
      expect(typeof asRecord(norm.input)?.query).toBe('string');
    }

    {
      const norm = normalizeFirstCallEvent(sample('claude/claude/tool-call/Glob'));
      expect(norm.canonicalToolName).toBe('Glob');
      expect(typeof asRecord(norm.input)?.pattern).toBe('string');
    }

    {
      const norm = normalizeFirstCallEvent(sample('claude/claude/tool-call/Grep'));
      expect(norm.canonicalToolName).toBe('Grep');
      expect(typeof asRecord(norm.input)?.pattern).toBe('string');
    }

    {
      const norm = normalizeFirstCallEvent(sample('claude/claude/tool-call/WebSearch'));
      expect(norm.canonicalToolName).toBe('WebSearch');
      expect(typeof asRecord(norm.input)?.query).toBe('string');
    }

    {
      const norm = normalizeFirstCallEvent(sample('claude/claude/tool-call/WebFetch'));
      expect(norm.canonicalToolName).toBe('WebFetch');
      expect(typeof asRecord(norm.input)?.url).toBe('string');
    }

    {
      const norm = normalizeFirstCallEvent(sample('claude/claude/tool-call/AskUserQuestion'));
      expect(norm.canonicalToolName).toBe('AskUserQuestion');
      expect(Array.isArray(asRecord(norm.input)?.questions)).toBe(true);
    }

    {
      const norm = normalizeFirstCallEvent(sample('claude/claude/tool-call/TaskCreate'));
      expect(norm.canonicalToolName).toBe('Task');
      const input = asRecord(norm.input);
      expect(input?.operation).toBe('create');
      expect(typeof input?.subject).toBe('string');
    }

    {
      const norm = normalizeFirstCallEvent(sample('acp/auggie/tool-call/search'));
      expect(norm.canonicalToolName).toBe('CodeSearch');
      expect(typeof asRecord(norm.input)?.query).toBe('string');
    }

    {
      const norm = normalizeFirstCallEvent(sample('acp/auggie/tool-call/fetch'));
      expect(norm.canonicalToolName).toBe('WebSearch');
      expect(typeof asRecord(norm.input)?.query).toBe('string');
    }

    {
      const norm = normalizeFirstCallEvent(sample('acp/auggie/tool-call/Edit'));
      expect(norm.canonicalToolName).toBe('Write');
      const input = asRecord(norm.input);
      expect(typeof input?.file_path).toBe('string');
      expect(typeof input?.content).toBe('string');
    }

    {
      const norm = normalizeFirstCallEvent(sample('acp/auggie/tool-call/delete'));
      expect(norm.canonicalToolName).toBe('Delete');
      expect(asRecord(norm.input)).toMatchObject({ file_paths: ['tool_validation_results.md'] });
    }
  });

  it('normalizes permission-request events without throwing (derives a canonical tool name)', () => {
    const fixtures = loadFixtureV1();

    for (const events of Object.values(fixtures.examples)) {
      for (const event of events) {
        if (event.kind !== 'permission-request') continue;

        const payload = asRecord(event.payload) ?? {};
        const toolName = String(payload.toolName ?? '');
        expect(toolName.length).toBeGreaterThan(0);

        const rawInput = asRecord(payload.options)?.toolCall ?? asRecord(payload.options)?.input ?? payload.options ?? {};
        const callId = typeof payload.permissionId === 'string' ? payload.permissionId : undefined;

        const normalized = normalizeToolCallV2({
          protocol: asToolNormalizationProtocol(event.protocol),
          provider: String(event.provider ?? 'unknown'),
          toolName,
          rawInput,
          callId,
        });

        expect(typeof normalized.canonicalToolName).toBe('string');
        expect(normalized.canonicalToolName.length).toBeGreaterThan(0);
        expect(asRecord(normalized.input)?._raw).toBeDefined();
      }
    }
  });

  it('canonicalizes Auggie workspace indexing permission prompts for consistent rendering', () => {
    const fixtures = loadFixtureV1();
    const event = firstFixtureEvent(fixtures, 'acp/auggie/permission-request/Unknown tool');
    expect(event).toBeTruthy();

    const payload = asRecord(event?.payload) ?? {};
    const rawInput = asRecord(payload.options)?.toolCall ?? asRecord(payload.options)?.input ?? payload.options ?? {};
    const normalized = normalizeToolCallV2({
      protocol: 'acp',
      provider: String(event?.provider ?? 'unknown'),
      toolName: String(payload.toolName ?? ''),
      rawInput,
      callId: typeof payload.permissionId === 'string' ? payload.permissionId : undefined,
    });

    expect(normalized.canonicalToolName).toBe('WorkspaceIndexingPermission');
  });
});
