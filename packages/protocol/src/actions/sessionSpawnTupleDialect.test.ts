import { describe, expect, it } from 'vitest';
import { getActionSpec } from './actionSpecs.js';
import { actionSpecToActionDefinitionV1 } from './actionCatalog.js';
import { zodSchemaToJsonSchemaObject } from './actionInputJsonSchema.js';
import { SessionBotFaceV1Schema } from '../sessions/identity/sessionBotFaceV1.js';
import { compilePluginJsonSchema, createPluginJsonSchemaZodValueAdapter } from '../plugins/actions/jsonSchemaValidation.js';
import { normalizePluginJsonSchema } from '../plugins/actions/protocolComposableSchema.js';
import { isRecursivelyClosedPluginJsonSchemaV2 } from '../plugins/contributions/jsonSchema.js';

describe('native Session spawn tuple admission', () => {
  it('admits the real declared writer schema even when the request omits its optional Bot face', () => {
    const spec = getActionSpec('session.spawn_new');
    const definition = actionSpecToActionDefinitionV1(spec);
    const validate = compilePluginJsonSchema(normalizePluginJsonSchema(definition.inputSchema));
    const input = {
      executionTarget: { serverId: 'home', machineId: 'machine' },
      directory: { kind: 'managed' },
      agentTarget: { kind: 'agent', identity: { pluginId: 'external.agent', localId: 'agent' } },
      permissionMode: 'read-only',
    };
    expect(spec.inputSchema.safeParse(input).success).toBe(true);
    expect(validate(input)).toBe(true);
  });

  it('preserves positional types and exact tuple lengths through the public schema compiler and adapter', () => {
    const projected = zodSchemaToJsonSchemaObject(SessionBotFaceV1Schema, { target: 'draft-7', reused: 'ref' });
    const normalized = normalizePluginJsonSchema(JSON.parse(JSON.stringify(projected)));
    const validate = compilePluginJsonSchema(normalized);
    const adapter = createPluginJsonSchemaZodValueAdapter(normalized);
    const face = { shape: { v: 1, fill: ['M0 0'], stroke: [['M0 0', 1]], cut: ['M1 1', ['M2 2', 2]], mouth: [1, 2, 3] } };
    expect(isRecursivelyClosedPluginJsonSchemaV2(normalized)).toBe(true);
    for (const value of [face, {}, { shape: { v: 1, fill: [], mouth: [0, 0, 0] } }]) {
      expect(SessionBotFaceV1Schema.safeParse(value).success).toBe(true);
      expect(validate(value)).toBe(true);
      expect(adapter.parse(value)).toEqual(value);
    }
    for (const shape of [
      { ...face.shape, stroke: [[1, 'M0 0']] },
      { ...face.shape, stroke: [['M0 0']] },
      { ...face.shape, stroke: [['M0 0', 1, 2]] },
      { ...face.shape, cut: [[1, 'M0 0']] },
      { ...face.shape, mouth: [1, 2] },
      { ...face.shape, mouth: [1, 2, 3, 4] },
      { ...face.shape, mouth: [1, '2', 3] },
    ]) {
      const value = { shape };
      expect(SessionBotFaceV1Schema.safeParse(value).success).toBe(false);
      expect(validate(value), JSON.stringify(value)).toBe(false);
      expect(adapter.safeParse(value).success).toBe(false);
    }
  });
});
