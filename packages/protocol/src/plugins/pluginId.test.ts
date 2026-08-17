import { describe, expect, it } from 'vitest';

import * as Protocol from '../index.js';
import * as pluginManifest from './manifest/index.js';
import { PluginMachineMaterializationRefV1JsonSchema } from './availability/materializationRefV1.js';
import * as pluginId from './pluginId.js';
import { compilePluginJsonSchema, isValidPluginJsonSchemaValue } from './actions/jsonSchemaValidation.js';

const {
  PluginIdSchema,
  encodePluginIdForFilesystem,
  isReservedHappierPluginId,
} = pluginId;

describe('PluginIdSchema', () => {
  it('accepts lower-case dotted owner ids including first-party namespaces', () => {
    expect(PluginIdSchema.parse('acme.plugin')).toBe('acme.plugin');
    expect(PluginIdSchema.parse('happier.agent.codex')).toBe('happier.agent.codex');
    expect(PluginIdSchema.parse('happier.scm.forge.github')).toBe('happier.scm.forge.github');
    expect(PluginIdSchema.parse('happier.scm.backend.git')).toBe('happier.scm.backend.git');
  });

  it('bounds the canonical ASCII plugin identifier at 256 bytes', () => {
    const atLimit = `acme.${'a'.repeat(251)}`;

    expect(atLimit).toHaveLength(256);
    expect(PluginIdSchema.parse(atLimit)).toBe(atLimit);
    expect(PluginIdSchema.safeParse(`${atLimit}a`).success).toBe(false);
  });

  it('projects the canonical Plugin ID grammar as a reusable JSON Schema fragment', () => {
    const schema = (pluginId as typeof pluginId & {
      PluginIdJsonSchema?: import('./contributions/publicTypes.js').PluginJsonSchemaV2;
    }).PluginIdJsonSchema;

    expect(schema).toBeDefined();
    if (!schema) return;

    const validates = compilePluginJsonSchema(schema);
    const atLimit = `acme.${'a'.repeat(251)}`;

    expect(isValidPluginJsonSchemaValue(validates, atLimit)).toBe(true);
    expect(isValidPluginJsonSchemaValue(validates, `${atLimit}a`)).toBe(false);
    expect(isValidPluginJsonSchemaValue(validates, 'Acme.Plugin')).toBe(false);
    expect(PluginMachineMaterializationRefV1JsonSchema.properties?.pluginId).toBe(schema);
    expect((Protocol as Record<string, unknown>).PluginIdJsonSchema).toBe(schema);
    expect((pluginManifest as Record<string, unknown>).PluginIdJsonSchema).toBe(schema);
  });

  it('keeps the executable Plugin ID parser identical to its reusable JSON Schema fragment', () => {
    const schema = (pluginId as typeof pluginId & {
      PluginIdJsonSchema?: import('./contributions/publicTypes.js').PluginJsonSchemaV2;
    }).PluginIdJsonSchema;

    expect(schema).toBeDefined();
    if (!schema) return;

    const validates = compilePluginJsonSchema(schema);
    for (const [value, accepted] of [
      ['acme.plugin', true],
      ['acme.__proto__', false],
      ['acme.constructor.plugin', false],
      ['acme.prototype.plugin', false],
      ['acme.plugin/child', false],
      ['acme..plugin', false],
    ] as const) {
      expect(PluginIdSchema.safeParse(value).success, value).toBe(accepted);
      expect(isValidPluginJsonSchemaValue(validates, value), value).toBe(accepted);
    }
  });

  it('rejects surrounding whitespace at both direct Plugin ID boundaries', () => {
    const schema = (pluginId as typeof pluginId & {
      PluginIdJsonSchema?: import('./contributions/publicTypes.js').PluginJsonSchemaV2;
    }).PluginIdJsonSchema;

    expect(schema).toBeDefined();
    if (!schema) return;

    const whitespaceId = ' acme.plugin ';
    const validates = compilePluginJsonSchema(schema);

    expect(PluginIdSchema.safeParse(whitespaceId).success).toBe(false);
    expect(isValidPluginJsonSchemaValue(validates, whitespaceId)).toBe(false);
  });

  it('rejects short, uppercase, reserved, and path-like owner ids', () => {
    for (const id of [
      'codex',
      'claude',
      'opencode',
      'scm-github',
      'Acme.Plugin',
      'acme.Plugin',
      'acme_plugin.tool',
      'acme.__proto__',
      'acme/plugin',
      'acme\\plugin',
      '.acme.plugin',
      'acme.plugin.',
    ]) {
      expect(PluginIdSchema.safeParse(id).success, id).toBe(false);
    }
  });

  it('identifies the host-reserved happier namespace separately from syntax validation', () => {
    expect(isReservedHappierPluginId('happier.agent.codex')).toBe(true);
    expect(isReservedHappierPluginId(' happier.agent.codex ')).toBe(false);
    expect(isReservedHappierPluginId('acme.plugin')).toBe(false);
  });

  it('encodes raw owner ids for filesystem storage without normalizing their identity', () => {
    expect(encodePluginIdForFilesystem(' happier.agent.codex ')).toBe('%20happier.agent.codex%20');
    expect(encodePluginIdForFilesystem('acme.plugin')).toBe('acme.plugin');
  });
});
