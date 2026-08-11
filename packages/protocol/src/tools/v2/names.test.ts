import { describe, expect, it } from 'vitest';

import {
  KNOWN_CANONICAL_TOOL_NAMES_V2,
  KnownCanonicalToolNameV2Schema,
  getToolInputSchemaV2,
  getToolResultSchemaV2,
} from './index.js';

describe('canonical Workflow tool name', () => {
  it('registers Workflow as a known canonical tool name', () => {
    expect(KNOWN_CANONICAL_TOOL_NAMES_V2.includes('Workflow')).toBe(true);
    expect(KnownCanonicalToolNameV2Schema.safeParse('Workflow').success).toBe(true);
  });

  it('keeps Workflow distinct from Task and SubAgent', () => {
    expect(KNOWN_CANONICAL_TOOL_NAMES_V2.includes('Task')).toBe(true);
    expect(KNOWN_CANONICAL_TOOL_NAMES_V2.includes('SubAgent')).toBe(true);
    const occurrences = KNOWN_CANONICAL_TOOL_NAMES_V2.filter((name) => name === 'Workflow').length;
    expect(occurrences).toBe(1);
  });

  it('registers the background-task control tools as canonical names distinct from the subagent family', () => {
    // `TaskOutput` and `TaskStop` are real SDK tools acting on a detached process. While they were
    // not canonical names, `KnownCanonicalToolNameV2Schema` rejected them and every renderer
    // registry fell back to the unknown-tool card.
    for (const toolName of ['TaskOutput', 'TaskStop'] as const) {
      expect(KNOWN_CANONICAL_TOOL_NAMES_V2.includes(toolName)).toBe(true);
      expect(KnownCanonicalToolNameV2Schema.safeParse(toolName).success).toBe(true);
      expect(toolName).not.toBe('SubAgent');
      expect(toolName).not.toBe('Task');
    }
  });

  it('does not register the Bash output schema or a kill-shell tool as tool names', () => {
    // `BashOutput` is a member of the SDK's `ToolOutputSchemas` — the `Bash` tool's RESULT shape —
    // and `KillShell`/`KillBash` do not exist in the SDK at all. Naming them would create renderers
    // and catalog entries for things a provider can never call.
    for (const notATool of ['BashOutput', 'KillShell', 'KillBash']) {
      expect(KNOWN_CANONICAL_TOOL_NAMES_V2.includes(notATool as never)).toBe(false);
    }
  });

  it('keeps the TaskStop result shape the SDK attests, and the Bash background join key', () => {
    const taskStopResult = getToolResultSchemaV2('TaskStop');
    const parsed = taskStopResult.safeParse({
      message: 'Stopped task_1',
      task_id: 'task_1',
      task_type: 'local_bash',
      command: 'sleep 60',
    });
    expect(parsed.success).toBe(true);

    // `BashOutput.backgroundTaskId` joins a detached Bash command to its background task.
    const bashResult = getToolResultSchemaV2('Bash');
    const bashParsed = bashResult.safeParse({ stdout: '', stderr: '', backgroundTaskId: 'task_1' });
    expect(bashParsed.success).toBe(true);
    expect((bashParsed as { data: Record<string, unknown> }).data.backgroundTaskId).toBe('task_1');
  });

  it('exposes dedicated input/result schemas for Workflow that can carry a workflow tool-use id', () => {
    const inputSchema = getToolInputSchemaV2('Workflow');
    const resultSchema = getToolResultSchemaV2('Workflow');
    expect(inputSchema).toBeDefined();
    expect(resultSchema).toBeDefined();
    expect(inputSchema.safeParse({ script: "export const meta = { name: 'demo' }" }).success).toBe(true);
    // Carries the canonical tool-use id used to join transcript cards to the activity snapshot.
    expect(resultSchema.safeParse({ task_id: 'w1', tool_use_id: 'toolu_1', status: 'completed' }).success).toBe(true);
  });
});
