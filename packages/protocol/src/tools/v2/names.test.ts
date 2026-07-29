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
