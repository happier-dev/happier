import { describe, expect, it } from 'vitest';

import { PluginBackendExternalSessionSourceDeclarationV1Schema } from './backendDefinitionV1.js';

const validSourceDeclaration = {
  sourceKind: 'codexHome',
  schema: {
    fields: [
      { name: 'home', kind: 'enum', values: ['user', 'connectedService'] },
      { name: 'homePath', kind: 'string', optional: true },
      { name: 'connectedServiceProfileId', kind: 'string', optional: true },
    ],
    refinements: [{
      kind: 'requiresWhenEquals',
      field: 'connectedServiceProfileId',
      when: { field: 'home', equals: 'connectedService' },
    }],
  },
  key: {
    segments: [
      { kind: 'literal', value: 'codexHome' },
      { kind: 'homeMode', field: 'home' },
      { kind: 'conditionalField', field: 'connectedServiceProfileId', when: { field: 'home', equals: 'connectedService' } },
      { kind: 'field', field: 'homePath' },
    ],
  },
} as const;

describe('PluginBackendExternalSessionSourceDeclarationV1Schema', () => {
  it('accepts source declarations whose keys and refinements reference declared fields', () => {
    expect(PluginBackendExternalSessionSourceDeclarationV1Schema.safeParse(validSourceDeclaration).success).toBe(true);
  });

  it('rejects key segments that reference undeclared fields', () => {
    const parsed = PluginBackendExternalSessionSourceDeclarationV1Schema.safeParse({
      ...validSourceDeclaration,
      key: {
        segments: [
          { kind: 'literal', value: 'codexHome' },
          { kind: 'field', field: 'missingHomePath' },
        ],
      },
    });

    expect(parsed.success).toBe(false);
  });

  it('rejects refinements that reference undeclared fields', () => {
    const parsed = PluginBackendExternalSessionSourceDeclarationV1Schema.safeParse({
      ...validSourceDeclaration,
      schema: {
        ...validSourceDeclaration.schema,
        refinements: [{
          kind: 'requiresWhenEquals',
          field: 'connectedServiceProfileId',
          when: { field: 'missingHomeMode', equals: 'connectedService' },
        }],
      },
    });

    expect(parsed.success).toBe(false);
  });
});
