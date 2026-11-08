import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  isPluginCollectionSchemaWideningV1,
  normalizePluginAccountCollectionContractV1,
  NormalizedPluginAccountCollectionContractV1Schema,
  PluginAccountCollectionContributionV1Schema,
  resolvePluginCollectionContractAccessV1,
} from './collectionsV1.js';
import type { PluginJsonSchemaV2 } from '../contributions/jsonSchema.js';
import { areCollectionSchemaLayoutsEquivalent } from './collectionSchemaEquivalence.js';

const config = { type: 'object', properties: { label: { type: 'string' } }, required: ['label'], additionalProperties: false } satisfies PluginJsonSchemaV2;
const schema = { type: 'object', properties: { id: { type: 'string' }, config }, required: ['id', 'config'], additionalProperties: false } satisfies PluginJsonSchemaV2;
const contract = (schema: PluginJsonSchemaV2) => normalizePluginAccountCollectionContractV1({
  pluginId: 'example.reference-layout',
  contribution: PluginAccountCollectionContributionV1Schema.parse({ id: 'records', schemaVersion: 1,
    schema, serverReadable: ['id'], indexes: [], }),
});

describe('Collection declaration reference layout', () => {
  it('re-admits the exact READY148 selected Channels writer through the current declaration', () => {
    const captured = JSON.parse(readFileSync(new URL('../../../../plugins/channels/src/testkit/fixtures/channelStateV21ReferenceLayout.json', import.meta.url), 'utf8'));
    const source = NormalizedPluginAccountCollectionContractV1Schema.parse(captured.collection);
    const manifest = JSON.parse(readFileSync(new URL('../../../../../apps/cli/assets/bundled-plugin-manifests/channels.json', import.meta.url), 'utf8'));
    const target = normalizePluginAccountCollectionContractV1({ pluginId: manifest.id,
      contribution: PluginAccountCollectionContributionV1Schema.parse(manifest.contributes.accountCollections.find((entry: { id: string }) => entry.id === 'channel-state')) });
    expect(source.contractDigest).toBe('qN26BJMgqxy2rXmpSZpMBlUEp54Fk0iE8MORtT1jBLg');
    expect(isPluginCollectionSchemaWideningV1({ source, target })).toBe(true);
    expect(resolvePluginCollectionContractAccessV1({ currentWriter: source, requested: target })).toBe('readOnly');
    expect(resolvePluginCollectionContractAccessV1({ currentWriter: target, requested: target })).toBe('writable');
  });

  it('admits the real Channels inline schema through its equivalent compact declaration', () => {
    const historical = JSON.parse(readFileSync(new URL('../../../../plugins/channels/src/testkit/fixtures/channelStateV20.json', import.meta.url), 'utf8'));
    const manifest = JSON.parse(readFileSync(new URL('../../../../../apps/cli/assets/bundled-plugin-manifests/channels.json', import.meta.url), 'utf8'));
    const declaration = PluginAccountCollectionContributionV1Schema.parse(manifest.contributes.accountCollections.find((entry: { id: string }) => entry.id === 'channel-state'));
    const normalize = (schema: PluginJsonSchemaV2) => normalizePluginAccountCollectionContractV1({ pluginId: manifest.id,
      contribution: { ...declaration, schema } });
    expect(isPluginCollectionSchemaWideningV1({ source: normalize(historical.collection.schema), target: normalize(declaration.schema) })).toBe(true);
  });

  it('re-admits a byte-equivalent definition layout without giving the retained digest write authority', () => {
    const source = contract(schema);
    const target = contract({ ...schema, properties: { ...schema.properties, config: { $ref: '#/$defs/shared' } }, $defs: { shared: config } });
    expect(target.contractDigest).not.toBe(source.contractDigest);
    expect(isPluginCollectionSchemaWideningV1({ source, target })).toBe(true);
    expect(isPluginCollectionSchemaWideningV1({ source: target, target: source })).toBe(true);
    expect(resolvePluginCollectionContractAccessV1({ currentWriter: target, requested: source })).toBe('readOnly');
    expect(resolvePluginCollectionContractAccessV1({ currentWriter: target, requested: target })).toBe('writable');
    const narrowed = contract({ ...target.schema, $defs: { shared: { ...config, properties: { label: { type: 'string', maxLength: 1 } } } } });
    expect(isPluginCollectionSchemaWideningV1({ source, target: narrowed })).toBe(false);
  });

  it('compares reference targets rather than their names, including escaped pointers and nested definitions', () => {
    const source = contract({ ...schema, properties: { ...schema.properties, config: { $ref: '#/definitions/a~1b~0c' } }, definitions: { 'a/b~c': config } });
    const target = contract({ ...schema, properties: { ...schema.properties, config: { $ref: '#/$defs/renamed' } }, $defs: { renamed: { $ref: '#/$defs/value' }, value: config } });
    expect(isPluginCollectionSchemaWideningV1({ source, target })).toBe(true);
  });

  it('keeps literal data and negated or sibling constraints from becoming equivalent through references', () => {
    const referenced = { ...schema, properties: { ...schema.properties, config: { $ref: '#/$defs/shared' } }, $defs: { shared: config } };
    const source = contract(referenced);
    expect(isPluginCollectionSchemaWideningV1({ source, target: contract({ ...referenced,
      properties: { ...referenced.properties, config: { $ref: '#/$defs/shared', not: config } },
    }) })).toBe(false);
    const negative = contract({ ...schema, properties: { ...schema.properties, config: { not: { $ref: '#/$defs/shared' } } }, $defs: { shared: config } });
    expect(isPluginCollectionSchemaWideningV1({ source: negative, target: contract({ ...negative.schema,
      $defs: { shared: { ...config, required: [] } },
    }) })).toBe(false);
    const literal = (pointer: string) => contract({ ...schema, properties: { ...schema.properties,
      config: { const: { $ref: pointer } },
    }, $defs: { first: config, second: config } });
    expect(isPluginCollectionSchemaWideningV1({ source: literal('#/$defs/first'), target: literal('#/$defs/second') })).toBe(false);
  });

  it('compares recursive constraints without accepting reference-only cycles or changed recursive leaves', () => {
    const recursive = (name: string, label: PluginJsonSchemaV2): PluginJsonSchemaV2 => ({
      type: 'object', properties: { tree: { $ref: `#/$defs/${name}` } }, additionalProperties: false,
      $defs: { [name]: { type: 'object', properties: { label, child: { $ref: `#/$defs/${name}` } }, additionalProperties: false } },
    });
    const before = recursive('before', { type: 'string' });
    expect(areCollectionSchemaLayoutsEquivalent(before, recursive('after', { type: 'string' }))).toBe(true);
    expect(areCollectionSchemaLayoutsEquivalent(before, recursive('after', { type: 'string', maxLength: 1 }))).toBe(false);
    expect(areCollectionSchemaLayoutsEquivalent(before, { $ref: '#' })).toBe(false);
    expect(areCollectionSchemaLayoutsEquivalent(before, { $ref: '#/$defs/missing' })).toBe(false);
  });
});
