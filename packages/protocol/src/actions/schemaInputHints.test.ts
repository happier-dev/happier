import { describe, expect, it } from 'vitest';
import { z } from 'zod/mini';

import { normalizePluginActionInputHintsV2, PluginActionInputHintsV2Schema } from '../plugins/actions/v2.js';
import { ActionInputHintsSchema } from './actionInputHints.js';
import { getActionSpec } from './actionSpecs.js';
import { completeActionInputHints } from './schemaInputHints.js';
import { lazyZodSchema } from '../lazyZodSchema.js';
import { resolveEffectiveActionInputFields } from './actionInputHintsRuntime.js';

describe('schema-derived Action input hints', () => {
  it('renders declared literal-union choices without dropping other typed configuration fields', () => {
    const hints = normalizePluginActionInputHintsV2(undefined, {
      type: 'object', additionalProperties: false, required: ['endpoint'],
      properties: {
        endpoint: { type: 'string' },
        addressing: { anyOf: [{ const: 'auto', type: 'string' }, { const: 'dns', type: 'string' }, { const: 'path', type: 'string' }] },
        enabled: { type: 'boolean' }, attempts: { type: 'integer' },
        advanced: { type: 'object', additionalProperties: false, properties: { label: { type: 'string' } } },
        mixed: { anyOf: [{ type: 'string' }, { type: 'number' }] },
      },
    });
    expect(hints?.fields).toEqual([
      { path: 'endpoint', title: 'Endpoint', widget: 'text', required: true },
      { path: 'addressing', title: 'Addressing', widget: 'select', options: [
        { value: 'auto', label: 'auto' }, { value: 'dns', label: 'dns' }, { value: 'path', label: 'path' }] },
      { path: 'enabled', title: 'Enabled', widget: 'boolean' },
      { path: 'attempts', title: 'Attempts', widget: 'integer' },
      { path: 'advanced', title: 'Advanced', widget: 'json' },
      { path: 'mixed', title: 'Mixed', widget: 'json' },
    ]);
  });

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

  it('derives portable fields and choices without changing the executable input schema', () => {
    const schema = {
      type: 'object' as const,
      additionalProperties: false,
      required: ['repositoryId', 'enabled', 'attempts', 'mode', 'payload'],
      properties: {
        repositoryId: { type: 'string' as const, title: 'Repository', description: 'Exact repository identity.' },
        enabled: { type: 'boolean' as const },
        attempts: { type: 'integer' as const },
        ratio: { type: 'number' as const },
        endpoint: { type: 'string' as const, format: 'uri' as const },
        mode: { type: 'string' as const, enum: ['keep', 'replace'] },
        labels: { type: 'array' as const, items: { type: 'string' as const } },
        roles: { type: 'array' as const, items: { type: 'string' as const, enum: ['reader', 'writer'] } },
        payload: { anyOf: [{ type: 'string' as const }, { type: 'object' as const, additionalProperties: false }] },
        opaque: {},
        settings: { type: 'object' as const, additionalProperties: false, properties: { enabled: { type: 'boolean' as const } } },
      },
    };
    const hints = normalizePluginActionInputHintsV2(undefined, schema);
    expect(hints?.fields).toEqual([
      { path: 'repositoryId', title: 'Repository', description: 'Exact repository identity.', widget: 'text', required: true },
      { path: 'enabled', title: 'Enabled', widget: 'boolean', required: true },
      { path: 'attempts', title: 'Attempts', widget: 'integer', required: true },
      { path: 'ratio', title: 'Ratio', widget: 'number' },
      { path: 'endpoint', title: 'Endpoint', widget: 'url' },
      { path: 'mode', title: 'Mode', widget: 'select', required: true,
        options: [{ value: 'keep', label: 'keep' }, { value: 'replace', label: 'replace' }] },
      { path: 'labels', title: 'Labels', widget: 'text_list', listSeparator: 'newline' },
      { path: 'roles', title: 'Roles', widget: 'multiselect',
        options: [{ value: 'reader', label: 'reader' }, { value: 'writer', label: 'writer' }] },
      { path: 'payload', title: 'Payload', widget: 'json', required: true },
      { path: 'opaque', title: 'Opaque', widget: 'json' },
      { path: 'settings', title: 'Settings', widget: 'json' },
    ]);
    expect(ActionInputHintsSchema.parse(hints)).toEqual(hints);
  });

  it('retains authored localized semantics and nested fields without adding an overlapping parent editor', () => {
    const hints = normalizePluginActionInputHintsV2({
      title: { key: 'action.configure', fallback: 'Configure connection' },
      fields: [{ path: 'settings.enabled', title: 'Enable connection', widget: 'boolean',
        visibleWhen: { op: 'eq', path: 'mode', value: 'custom' } },
      { path: 'mode', title: 'Connection mode', widget: 'select', options: [{ value: 'custom', label: 'Custom connection' }] }],
    }, {
      type: 'object', additionalProperties: false,
      properties: {
        settings: { type: 'object', additionalProperties: false, required: ['enabled', 'label'],
          properties: { enabled: { type: 'boolean' }, label: { type: 'string' } } },
        mode: { type: 'string', enum: ['custom', 'automatic'] },
        revision: { type: 'integer' },
      },
    });
    expect(hints).toEqual({ title: 'Configure connection', fields: [
      { path: 'settings.enabled', title: 'Enable connection', widget: 'boolean', visibleWhen: { op: 'eq', path: 'mode', value: 'custom' } },
      { path: 'mode', title: 'Connection mode', widget: 'select', options: [{ value: 'custom', label: 'Custom connection' }] },
      { path: 'settings.label', title: 'Label', widget: 'text' },
      { path: 'revision', title: 'Revision', widget: 'integer' },
    ] });
  });

  it('offers root-union operands as JSON without claiming branch-only fields are always required', () => {
    const hints = normalizePluginActionInputHintsV2(undefined, {
      oneOf: [
        { type: 'object', additionalProperties: false, required: ['kind', 'entry'],
          properties: { kind: { const: 'pin' }, entry: { type: 'object', additionalProperties: false } } },
        { type: 'object', additionalProperties: false, required: ['kind', 'entries'],
          properties: { kind: { const: 'clear' }, entries: { type: 'array', items: { type: 'string' } } } },
      ],
    });
    expect(hints?.fields).toEqual([
      { path: 'kind', title: 'Kind', widget: 'json', required: true },
      { path: 'entry', title: 'Entry', widget: 'json' },
      { path: 'entries', title: 'Entries', widget: 'json' },
    ]);
  });

  it('presents the root-union arm the authored fields choose, with its own widgets, and leaves the other arms to complete inputs', () => {
    const hints = normalizePluginActionInputHintsV2({
      fields: [{ path: 'query', title: 'Search for', widget: 'text', required: true }],
    }, { anyOf: [
      { type: 'object', additionalProperties: false, required: ['connectionId', 'query'],
        properties: { connectionId: { type: 'string', minLength: 1 }, query: { type: 'string', minLength: 1 } } },
      { type: 'object', additionalProperties: false, required: ['destination'],
        properties: { destination: { type: 'object', additionalProperties: false } } },
    ] });
    expect(hints?.fields).toEqual([
      { path: 'query', title: 'Search for', widget: 'text', required: true },
      { path: 'connectionId', title: 'Connection Id', widget: 'text', required: true },
    ]);
  });

  it('keeps empty inputs empty and refuses to reinterpret literal dotted keys as nested paths', () => {
    expect(normalizePluginActionInputHintsV2(undefined, { type: 'object', additionalProperties: false }))
      .toBeUndefined();
    const hints = normalizePluginActionInputHintsV2(undefined, {
      type: 'object', additionalProperties: false, properties: { 'literal.key': { type: 'string' }, normal: { type: 'string' } },
    });
    expect(hints?.fields.map(field => field.path)).toEqual(['normal']);
  });

  it('does not require a field when a root union admits an empty object', () => {
    const hints = normalizePluginActionInputHintsV2(undefined, { anyOf: [
      { type: 'object', additionalProperties: false, properties: { name: { type: 'string' } }, required: ['name'] },
      { type: 'object', additionalProperties: false },
    ] });
    expect(hints?.fields).toEqual([{ path: 'name', title: 'Name', widget: 'json' }]);
  });

  it('fills built-in Workflow operands beneath authored hints at the same catalog owner', () => {
    expect(getActionSpec('workflow.run.get').inputHints?.fields).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: 'runId', widget: 'text', required: true }),
    ]));
  });

  it('prepares only demanded catalog inputs and delivers a changed schema to the real field consumer', () => {
    let preparedSchemas = 0;
    const base = getActionSpec('workflow.run.get');
    const rows = Array.from({ length: 1000 }, (_, index) => completeActionInputHints({
      ...base, inputHints: undefined, cli: undefined, surfaceBindings: undefined,
      inputSchema: lazyZodSchema(() => {
        preparedSchemas++;
        return z.strictObject({ [`operand${index}`]: z.string() });
      }),
    }));
    expect(preparedSchemas).toBe(0);
    const first = rows[0]!.inputHints;
    for (let index = 0; index < 1000; index++) expect(rows[0]!.inputHints).toBe(first);
    expect(preparedSchemas).toBe(1);
    expect(resolveEffectiveActionInputFields(rows[0]!, {})).toMatchObject([{ path: 'operand0', required: true }]);
    expect(resolveEffectiveActionInputFields(rows[1]!, {})).toMatchObject([{ path: 'operand1', required: true }]);
    expect(preparedSchemas).toBe(2);
  });
});
