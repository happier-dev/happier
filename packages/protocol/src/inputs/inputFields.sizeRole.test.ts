import { describe, expect, it } from 'vitest';
import { InputHintsSchema, normalizeInputHintsText } from './inputFields.js';
import { createStoredReadSchema } from '../json/storedReadSchema.js';

describe('saved size field declarations', () => {
  it('admits roles, preserves them through localization and rejects unknown roles', () => {
    const hints = InputHintsSchema.parse({ fields: [
      { path: 'ram', title: 'RAM', widget: 'integer', role: 'memory', unit: 'bytes' },
      { path: 'cores', title: 'CPU', widget: 'integer', role: 'cpu' },
      { path: 'storage', title: 'Storage', widget: 'integer', role: 'disk' },
      { path: 'system', title: 'System image', widget: 'text', role: 'image' },
    ] });
    expect(normalizeInputHintsText(hints, text => text).fields).toEqual(hints.fields);
    expect(InputHintsSchema.safeParse({ fields: [{ path: 'x', title: 'X', widget: 'integer', role: 'gpu' }] }).success).toBe(false);
    expect(InputHintsSchema.safeParse({ fields: [{ path: 'x', title: 'X', widget: 'integer' }] }).success).toBe(true);
    const stored = { fields: [{ path: 'x', title: 'X', widget: 'integer', futurePresentation: true }] };
    expect(InputHintsSchema.safeParse(stored).success).toBe(false);
    expect(createStoredReadSchema(InputHintsSchema).parse(stored).fields[0]).not.toHaveProperty('futurePresentation');
  });
});
