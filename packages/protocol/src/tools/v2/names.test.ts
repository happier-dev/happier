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

describe('canonical background-task tool names', () => {
  it('registers TaskOutput and TaskStop as their own canonical names, distinct from Task/SubAgent', () => {
    for (const name of ['TaskOutput', 'TaskStop'] as const) {
      expect(KNOWN_CANONICAL_TOOL_NAMES_V2.includes(name)).toBe(true);
      expect(KnownCanonicalToolNameV2Schema.safeParse(name).success).toBe(true);
      expect(KNOWN_CANONICAL_TOOL_NAMES_V2.filter((entry) => entry === name).length).toBe(1);
    }
    expect(getToolInputSchemaV2('TaskOutput')).not.toBe(getToolInputSchemaV2('SubAgent'));
    expect(getToolInputSchemaV2('TaskStop')).not.toBe(getToolInputSchemaV2('Task'));
  });

  it('types the background-task join keys instead of letting the passthrough envelope carry anything', () => {
    // A declared field is the only thing that can reject a wrong type here: an undeclared key
    // survives `.passthrough()` unchecked, so these rejections are what prove the fields exist.
    expect(getToolInputSchemaV2('Bash').safeParse({ command: 'ls', run_in_background: 'yes' }).success).toBe(false);
    expect(getToolResultSchemaV2('Bash').safeParse({ stdout: '', backgroundTaskId: 42 }).success).toBe(false);
    expect(getToolInputSchemaV2('TaskOutput').safeParse({ task_id: 7 }).success).toBe(false);
    expect(getToolInputSchemaV2('TaskStop').safeParse({ shell_id: 7 }).success).toBe(false);
    expect(getToolResultSchemaV2('TaskStop').safeParse({ task_type: 7 }).success).toBe(false);
  });

  it('accepts the attested background-task payloads', () => {
    expect(getToolInputSchemaV2('Bash').safeParse({ command: 'yarn build', run_in_background: true }).success).toBe(true);
    expect(getToolResultSchemaV2('Bash').safeParse({ stdout: '', backgroundTaskId: 'task_42' }).success).toBe(true);
    expect(getToolInputSchemaV2('TaskOutput').safeParse({ task_id: 'task_42', block: false, timeout: 30 }).success).toBe(true);
    expect(getToolInputSchemaV2('TaskStop').safeParse({ task_id: 'task_42', shell_id: 'shell_1' }).success).toBe(true);
    expect(getToolResultSchemaV2('TaskStop').safeParse({
      message: 'stopped',
      task_id: 'task_42',
      task_type: 'local_bash',
      command: 'yarn build',
    }).success).toBe(true);
  });
});
