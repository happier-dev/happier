import { describe, expect, it } from 'vitest';

import * as Protocol from '../index.js';
import * as pluginManifest from './manifest/index.js';
import { compilePluginJsonSchema, isValidPluginJsonSchemaValue } from './actions/jsonSchemaValidation.js';
import * as contributionIdentity from './contributionIdentity.js';
import * as pluginId from './pluginId.js';

const {
  PluginContributionIdentityV1Schema,
  PluginContributionLocalIdSchema,
  PluginContributionOperationRoleV1Schema,
  PluginContributionProtocolIdV1Schema,
} = contributionIdentity;

describe('PluginContributionLocalIdSchema', () => {
  it('bounds canonical ASCII local identifiers at 256 bytes', () => {
    const atLimit = 'a'.repeat(256);

    expect(PluginContributionLocalIdSchema.parse(atLimit)).toBe(atLimit);
    expect(PluginContributionLocalIdSchema.safeParse(`${atLimit}a`).success).toBe(false);
  });

  it('projects only a strict fully qualified contribution identity for JSON consumers', () => {
    const schema = (contributionIdentity as typeof contributionIdentity & {
      PluginContributionIdentityV1JsonSchema?: import('./contributions/publicTypes.js').PluginJsonSchemaV2;
    }).PluginContributionIdentityV1JsonSchema;

    expect(schema).toBeDefined();
    if (!schema) return;

    const validates = compilePluginJsonSchema(schema);
    const valid = { pluginId: 'acme.accounts', localId: 'git/hosting' };
    const localIdAtLimit = 'a'.repeat(256);

    expect(isValidPluginJsonSchemaValue(validates, valid)).toBe(true);
    expect(isValidPluginJsonSchemaValue(validates, {
      ...valid,
      localId: localIdAtLimit,
    })).toBe(true);
    expect(isValidPluginJsonSchemaValue(validates, {
      ...valid,
      localId: `${localIdAtLimit}a`,
    })).toBe(false);
    expect(isValidPluginJsonSchemaValue(validates, {
      ...valid,
      localId: 'Git/hosting',
    })).toBe(false);
    expect(isValidPluginJsonSchemaValue(validates, {
      ...valid,
      localId: 'git hosting',
    })).toBe(false);
    expect(isValidPluginJsonSchemaValue(validates, 'git/hosting')).toBe(false);
    expect(isValidPluginJsonSchemaValue(validates, {
      ...valid,
      unknown: true,
    })).toBe(false);
    expect(schema.properties?.pluginId).toBe(
      (pluginId as typeof pluginId & {
        PluginIdJsonSchema?: import('./contributions/publicTypes.js').PluginJsonSchemaV2;
      }).PluginIdJsonSchema,
    );
    expect((Protocol as Record<string, unknown>).PluginContributionIdentityV1JsonSchema).toBe(schema);
    expect((pluginManifest as Record<string, unknown>).PluginContributionIdentityV1JsonSchema).toBe(schema);
  });

  it('rejects surrounding whitespace in nested Plugin identities at both boundaries', () => {
    const schema = (contributionIdentity as typeof contributionIdentity & {
      PluginContributionIdentityV1JsonSchema?: import('./contributions/publicTypes.js').PluginJsonSchemaV2;
    }).PluginContributionIdentityV1JsonSchema;

    expect(schema).toBeDefined();
    if (!schema) return;

    const whitespaceIdentity = { pluginId: ' acme.accounts ', localId: 'git/hosting' };
    const validates = compilePluginJsonSchema(schema);

    expect(PluginContributionIdentityV1Schema.safeParse(whitespaceIdentity).success).toBe(false);
    expect(isValidPluginJsonSchemaValue(validates, whitespaceIdentity)).toBe(false);
  });
});

describe('PluginContributionProtocolIdV1Schema', () => {
  it('preserves existing local ids while admitting only a bounded fully qualified protocol id', () => {
    const qualified = 'happier.channels/providers';
    const atLimit = `acme.${'a'.repeat(249)}/b`;

    expect(PluginContributionProtocolIdV1Schema.parse('connection')).toBe('connection');
    expect(PluginContributionProtocolIdV1Schema.parse('connection/setup')).toBe('connection/setup');
    expect(PluginContributionProtocolIdV1Schema.parse(qualified)).toBe(qualified);
    expect(atLimit).toHaveLength(256);
    expect(PluginContributionProtocolIdV1Schema.parse(atLimit)).toBe(atLimit);

    for (const invalid of [
      'happier.channels.providers',
      'happier..channels/providers',
      'happier.channels//providers',
      'happier.channels/providers.',
      'Happier.channels/providers',
      'happier.channels/providers name',
      'happier.channels\\providers',
      'happier.channels/../providers',
      'happier.__proto__/providers',
      `acme.${'a'.repeat(249)}/bc`,
    ]) {
      expect(PluginContributionProtocolIdV1Schema.safeParse(invalid).success, invalid).toBe(false);
    }
  });
});

describe('PluginContributionOperationRoleV1Schema', () => {
  it('admits lower-camel operation roles without widening contribution local ids', () => {
    const atLimit = 'a'.repeat(256);

    expect(PluginContributionOperationRoleV1Schema.parse('setup')).toBe('setup');
    expect(PluginContributionOperationRoleV1Schema.parse('connectionTest')).toBe('connectionTest');
    expect(PluginContributionOperationRoleV1Schema.parse('messageDeliver')).toBe('messageDeliver');
    expect(PluginContributionOperationRoleV1Schema.parse('connection/test')).toBe('connection/test');
    expect(PluginContributionOperationRoleV1Schema.parse(atLimit)).toBe(atLimit);

    for (const invalid of [
      'connection Test',
      'connection\\Test',
      '../connectionTest',
      'ConnectionTest',
      '_connectionTest',
      `${atLimit}a`,
    ]) {
      expect(PluginContributionOperationRoleV1Schema.safeParse(invalid).success, invalid).toBe(false);
    }
  });
});
