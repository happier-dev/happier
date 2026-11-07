import { describe, expect, it } from 'vitest';
import { normalizePluginActionInputHintsV2, PluginActionInputHintsV2Schema } from '../plugins/actions/v2.js';

describe('schema-derived Action input hints', () => {
  it('lets an Action with its own editor explicitly omit the host input form', () => {
    const schema = { type: 'object' as const, additionalProperties: false,
      properties: { title: { type: 'string' as const }, body: { type: 'string' as const } } };
    expect(normalizePluginActionInputHintsV2({ fields: [] }, schema)?.fields).toEqual([]);
    expect(normalizePluginActionInputHintsV2(undefined, schema)?.fields.map(field => field.path)).toEqual(['title', 'body']);
  });

  it.each([
    { title: 'Create a task' }, { description: 'Review task details' }, { submitLabel: 'Create' },
  ])('derives inputs when authored hints only customize form presentation: %j', (presentation) => {
    const authored = PluginActionInputHintsV2Schema.parse(presentation);
    const hints = normalizePluginActionInputHintsV2(authored, {
      type: 'object', additionalProperties: false, properties: { title: { type: 'string' } },
    });
    expect(hints).toEqual({ ...presentation,
      fields: [{ path: 'title', title: 'Title', widget: 'text' }] });
  });

});
