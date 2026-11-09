import { describe, expect, it } from 'vitest';

import { ActionInputHintsSchema, normalizeActionInputHintsText } from './actionInputHints.js';
import { PluginUiViewV2Schema } from '../plugins/contributions/ui/v2.js';
import { WidgetDefinitionV1Schema } from '../widgets/widgetDefinitionV1.js';

describe('Action input hint path grammar', () => {
  it('preserves optional catalog presentation while localizing an admitted choice', () => {
    const hints = ActionInputHintsSchema.parse({ fields: [{ path: 'software', title: 'Software', widget: 'select',
      options: [{ value: { pluginId: 'com.example.software', recipeId: 'fonts', revision: '1' }, label: 'Fonts',
        icon: 'file', brand: { state: 'missing' }, source: { kind: 'path', locator: '/plugins/software' }, version: '2.0.0' }],
    }] });
    expect(normalizeActionInputHintsText(hints, text => `Localized ${text}`).fields[0]?.options?.[0])
      .toEqual({ ...hints.fields[0]!.options![0]!, label: 'Localized Fonts' });
  });
  it('preserves declared JSON defaults through plugin and host input-hint admission', async () => {
    const { PluginActionInputHintsV2Schema } = await import('../plugins/actions/v2.js');
    const hints = { fields: [
      { path: 'enabled', title: 'Enabled', widget: 'boolean', defaultValue: true },
      { path: 'count', title: 'Count', widget: 'integer', defaultValue: 0 },
      { path: 'label', title: 'Label', widget: 'text', defaultValue: '' },
    ] };
    const admitted = PluginActionInputHintsV2Schema.parse(hints);
    expect(ActionInputHintsSchema.parse(admitted)).toEqual(hints);
    expect(normalizeActionInputHintsText(admitted, (text) => typeof text === 'string' ? text : text.fallback)).toEqual(hints);
  });

  it('carries a byte-size unit on an integer field through plugin and host admission, and refuses it elsewhere', async () => {
    const { PluginActionInputHintsV2Schema } = await import('../plugins/actions/v2.js');
    const hints = { fields: [{ path: 'size.memoryBytes', title: 'Memory', widget: 'integer', unit: 'bytes', defaultValue: 4 * 1024 ** 3 }] };
    const admitted = PluginActionInputHintsV2Schema.parse(hints);
    expect(ActionInputHintsSchema.parse(admitted)).toEqual(hints);
    expect(normalizeActionInputHintsText(admitted, (text) => typeof text === 'string' ? text : text.fallback)).toEqual(hints);
    expect(ActionInputHintsSchema.safeParse({ fields: [{ path: 'name', title: 'Name', widget: 'text', unit: 'bytes' }] }).success).toBe(false);
  });

  it.each([
    { fields: Array.from({ length: 65 }, (_, index) => ({ path: `field${index}`, title: `Field ${index}`, widget: 'text' })) },
    { fields: [{ path: 'choice', title: 'Choice', widget: 'select', options: Array.from({ length: 257 }, (_, index) => ({ value: `choice${index}`, label: `Choice ${index}` })) }] },
  ])('admits large valid declarations through Action, plugin View and widget owners', inputs => {
    expect(ActionInputHintsSchema.parse(inputs).fields).toEqual(inputs.fields);
    expect(PluginUiViewV2Schema.parse({ id: 'widget', renderer: 'native', container: 'widget', target: { kind: 'app' },
      sizeDeclaration: { sizes: ['medium'], defaultSize: 'medium' },
      inputs, inputSchema: { type: 'object', additionalProperties: false } }).inputs?.fields).toEqual(inputs.fields);
    expect(WidgetDefinitionV1Schema.parse({ v: 1, id: 'definition', name: 'Widget',
      sizeDeclaration: { sizes: ['medium'], defaultSize: 'medium' },
      body: { kind: 'installed', surface: { pluginId: 'acme.widgets', localId: 'widget' } },
      inputs, inputSchema: { type: 'object', additionalProperties: false }, provenance: { source: { kind: 'authored' } } }).inputs.fields).toEqual(inputs.fields);
  });

  it('admits an explicitly host-resolved empty Connected Account field without relaxing static selects', () => {
    const hostResolvedEmpty = ActionInputHintsSchema.safeParse({
      fields: [{
        path: 'credentialRef',
        title: 'Connected account',
        widget: 'select',
        options: [],
        resolvedEmptyConnectedAccountOptions: true,
      }],
    });
    const staticEmpty = ActionInputHintsSchema.safeParse({
      fields: [{
        path: 'credentialRef',
        title: 'Connected account',
        widget: 'select',
        options: [],
      }],
    });

    expect(hostResolvedEmpty.success).toBe(true);
    expect(staticEmpty.success).toBe(false);
  });

  it('rejects segment-local whitespace before secret cleanup and max-selection consumers see a descriptor', () => {
    const parsed = ActionInputHintsSchema.safeParse({
      fields: [{
        path: 'auth. token',
        title: 'Token',
        widget: 'secret',
      }, {
        path: 'preferences. selections',
        title: 'Selections',
        widget: 'multiselect',
        maxSelections: 1,
        options: [
          { value: 'one', label: 'One' },
          { value: 'two', label: 'Two' },
        ],
      }],
    });

    expect(parsed.success).toBe(false);
    if (parsed.success) return;
    expect(parsed.error.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: ['fields', 0, 'path'] }),
      expect.objectContaining({ path: ['fields', 1, 'path'] }),
    ]));
  });

  it('rejects a whitespace-segment predicate instead of letting it read a secret path', () => {
    const parsed = ActionInputHintsSchema.safeParse({
      fields: [{
        path: 'auth.token',
        title: 'Token',
        widget: 'secret',
      }, {
        path: 'followUp',
        title: 'Follow up',
        widget: 'text',
        visibleWhen: { op: 'truthy', path: 'auth. token' },
      }],
    });

    expect(parsed.success).toBe(false);
    if (parsed.success) return;
    expect(parsed.error.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: ['fields', 1, 'visibleWhen', 'path'] }),
    ]));
  });
});
