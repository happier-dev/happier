import { describe, expect, it } from 'vitest';
import { z } from 'zod/mini';
import Ajv from 'ajv';

import { ACTION_IDS, ActionIdSchema } from './actionIds.js';
import { ActionFailureCauseV1Schema } from './actionExecutionResult.js';
import { zodSchemaToJsonSchemaObject } from './actionInputJsonSchema.js';

describe('Action id declaration projection', () => {
  it('keeps unrelated failure declarations stable when the host adds an Action', () => {
    const before = zodSchemaToJsonSchemaObject(ActionFailureCauseV1Schema);
    // Simulate an actionIds.ts addition in the enum vocabulary used by Zod's
    // JSON Schema emitter, without changing shared source or mocking a parser.
    const entries: Record<string, string> = ActionIdSchema._zod.def.entries;
    const added = 'projectionTest.unrelatedAction';
    try {
      entries[added] = added;
      expect(zodSchemaToJsonSchemaObject(ActionFailureCauseV1Schema)).toEqual(before);
    } finally {
      delete entries[added];
    }
    expect(z.toJSONSchema(ActionIdSchema)).toMatchObject({ type: 'string' });
    expect(z.toJSONSchema(ActionIdSchema)).not.toHaveProperty('enum');
  });

  it('refuses an unknown well-formed id at host Action membership admission', () => {
    const validateReference = new Ajv().compile(zodSchemaToJsonSchemaObject(ActionIdSchema, { target: 'draft-7' }));
    expect(ACTION_IDS.filter(id => !validateReference(id))).toEqual([]);
    expect(validateReference('projectionTest.unknownAction')).toBe(true);
    expect(validateReference('not an action id')).toBe(false);
    expect(ActionIdSchema.safeParse('session.open').success).toBe(true);
    expect(ActionIdSchema.safeParse('projectionTest.unknownAction').success).toBe(false);
  });
});
