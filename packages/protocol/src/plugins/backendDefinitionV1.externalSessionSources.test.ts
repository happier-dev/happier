import { describe, expect, it } from 'vitest';

import {
  PluginBackendExternalSessionSourceDeclarationV1Schema,
  PluginBackendExternalSessionSurfaceV1Schema,
} from './backendDefinitionV1.js';

const validSourceDeclaration = {
  sourceKind: 'codexHome',
  schema: {
    fields: [
      { name: 'kind', kind: 'literal', value: 'codexHome' },
      { name: 'home', kind: 'enum', values: ['user', 'connectedService'] },
      { name: 'homePath', kind: 'string', optional: true },
      { name: 'connectedServiceId', kind: 'string', optional: true },
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

  it('accepts explicit default and connected-service profile instance declarations', () => {
    const parsed = PluginBackendExternalSessionSourceDeclarationV1Schema.safeParse({
      ...validSourceDeclaration,
      instances: [
        { kind: 'default', constants: { home: 'user' } },
        {
          kind: 'connectedServiceProfiles',
          serviceId: 'openai-codex',
          constants: { home: 'connectedService' },
          fields: {
            serviceId: 'connectedServiceId',
            profileId: 'connectedServiceProfileId',
          },
        },
      ],
    });

    expect(parsed.success).toBe(true);
  });

  it('rejects instance constants and identity mappings that reference undeclared fields', () => {
    const invalidConstant = PluginBackendExternalSessionSourceDeclarationV1Schema.safeParse({
      ...validSourceDeclaration,
      instances: [{ kind: 'default', constants: { missingHome: 'user' } }],
    });
    const invalidMapping = PluginBackendExternalSessionSourceDeclarationV1Schema.safeParse({
      ...validSourceDeclaration,
      instances: [{
        kind: 'connectedServiceProfiles',
        serviceId: 'openai-codex',
        constants: { home: 'connectedService' },
        fields: { serviceId: 'missingServiceId', profileId: 'connectedServiceProfileId' },
      }],
    });

    expect(invalidConstant.success).toBe(false);
    expect(invalidMapping.success).toBe(false);
  });

  it('rejects duplicate default and connected-service profile instance owners', () => {
    const duplicateDefault = PluginBackendExternalSessionSourceDeclarationV1Schema.safeParse({
      ...validSourceDeclaration,
      instances: [
        { kind: 'default', constants: { home: 'user' } },
        { kind: 'default', constants: { home: 'user' } },
      ],
    });
    const duplicateService = PluginBackendExternalSessionSourceDeclarationV1Schema.safeParse({
      ...validSourceDeclaration,
      instances: [
        {
          kind: 'connectedServiceProfiles', serviceId: 'openai-codex', constants: { home: 'connectedService' },
          fields: { serviceId: 'homePath', profileId: 'connectedServiceProfileId' },
        },
        {
          kind: 'connectedServiceProfiles', serviceId: 'openai-codex', constants: { home: 'connectedService' },
          fields: { serviceId: 'homePath', profileId: 'connectedServiceProfileId' },
        },
      ],
    });

    expect(duplicateDefault.success).toBe(false);
    expect(duplicateService.success).toBe(false);
  });

  it('rejects constants outside the declared field contract and non-string identity targets', () => {
    const invalidEnum = PluginBackendExternalSessionSourceDeclarationV1Schema.safeParse({
      ...validSourceDeclaration,
      instances: [{ kind: 'default', constants: { home: 'remote' } }],
    });
    const invalidIdentityTarget = PluginBackendExternalSessionSourceDeclarationV1Schema.safeParse({
      ...validSourceDeclaration,
      instances: [{
        kind: 'connectedServiceProfiles',
        serviceId: 'openai-codex',
        constants: { home: 'connectedService' },
        fields: { serviceId: 'home', profileId: 'connectedServiceProfileId' },
      }],
    });

    expect(invalidEnum.success).toBe(false);
    expect(invalidIdentityTarget.success).toBe(false);
  });

  it('rejects ambiguous field, identity-mapping, and source-kind declarations', () => {
    const duplicateField = PluginBackendExternalSessionSourceDeclarationV1Schema.safeParse({
      ...validSourceDeclaration,
      schema: {
        ...validSourceDeclaration.schema,
        fields: [
          ...validSourceDeclaration.schema.fields,
          { name: 'home', kind: 'string' },
        ],
      },
    });
    const sharedIdentityTarget = PluginBackendExternalSessionSourceDeclarationV1Schema.safeParse({
      ...validSourceDeclaration,
      instances: [{
        kind: 'connectedServiceProfiles',
        serviceId: 'openai-codex',
        constants: { home: 'connectedService' },
        fields: {
          serviceId: 'connectedServiceProfileId',
          profileId: 'connectedServiceProfileId',
        },
      }],
    });
    const duplicateSourceKind = PluginBackendExternalSessionSurfaceV1Schema.safeParse({
      sources: [validSourceDeclaration, validSourceDeclaration],
    });

    expect(duplicateField.success).toBe(false);
    expect(sharedIdentityTarget.success).toBe(false);
    expect(duplicateSourceKind.success).toBe(false);
  });
});
