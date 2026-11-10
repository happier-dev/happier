import { describe, expect, it } from 'vitest';

import { PluginActionContributionV2Schema, PluginActionInputHintsV2Schema } from './v2.js';
import type { PluginJsonSchemaV2 } from '../contributions/publicTypes.js';
import { QualifiedConnectedAccountRefJsonSchema } from '../../connect/qualifiedConnectedAccountPersistence.js';

const localized = { key: 'plugin.title', fallback: 'Title' };

const qualifiedAccountRef: PluginJsonSchemaV2 = QualifiedConnectedAccountRefJsonSchema;

const nullableQualifiedAccountRef: PluginJsonSchemaV2 = {
  anyOf: [qualifiedAccountRef, { type: 'null' }],
};

/**
 * The published Triage scan input: two closed object arms that carry the same
 * configured instance, distinguished only by the page request they can express.
 */
function scanInputSchema(
  initialAccount: PluginJsonSchemaV2,
  continuationAccount: PluginJsonSchemaV2 = initialAccount,
): PluginJsonSchemaV2 {
  const instance = (account: PluginJsonSchemaV2): PluginJsonSchemaV2 => ({
    type: 'object',
    properties: {
      binding: {
        type: 'object',
        properties: {
          purpose: { type: 'string' },
          account,
        },
        required: ['purpose', 'account'],
        additionalProperties: false,
      },
    },
    required: ['binding'],
    additionalProperties: false,
  });
  return {
    anyOf: [
      {
        type: 'object',
        properties: {
          instance: instance(initialAccount),
          page: {
            type: 'object',
            properties: { kind: { type: 'string', const: 'initial' }, limit: { type: 'integer' } },
            required: ['kind', 'limit'],
            additionalProperties: false,
          },
        },
        required: ['instance', 'page'],
        additionalProperties: false,
      },
      {
        type: 'object',
        properties: {
          instance: instance(continuationAccount),
          page: {
            type: 'object',
            properties: { kind: { type: 'string', const: 'continuation' }, continuation: { type: 'string' } },
            required: ['kind', 'continuation'],
            additionalProperties: false,
          },
        },
        required: ['instance', 'page'],
        additionalProperties: false,
      },
    ],
  };
}

function scanAction(inputSchema: PluginJsonSchemaV2) {
  return {
    id: 'scan',
    title: localized,
    scopes: ['global'],
    surfaces: ['plugin'],
    dangerLevel: 'safe' as const,
    execution: { target: 'daemon' } as const,
    inputSchema,
    connectedAccountPurposeBindings: [{
      path: 'instance.binding.account',
      purpose: 'account-use',
    }],
  };
}

describe('Connected Account purpose bindings across union-shaped Action inputs', () => {
  it('admits one alternative qualified Account path per ordinary source or configured-instance arm', () => {
    const configured = scanInputSchema(qualifiedAccountRef).anyOf?.[0];
    if (!configured) throw new Error('expected configured input arm');
    const source: PluginJsonSchemaV2 = { type: 'object', properties: { sourceConfig: {
      type: 'object', properties: { credentialRef: qualifiedAccountRef }, required: ['credentialRef'], additionalProperties: false,
    } }, required: ['sourceConfig'], additionalProperties: false };
    const native: PluginJsonSchemaV2 = { type: 'object', properties: { instance: {
      type: 'object', properties: { binding: { type: 'object', properties: { service: qualifiedAccountRef.properties?.service ?? {} },
        required: ['service'], additionalProperties: false } }, required: ['binding'], additionalProperties: false,
    } }, required: ['instance'], additionalProperties: false };
    const action = { ...scanAction({ anyOf: [configured, source, native] }), connectedAccountPurposeBindings: [{
      path: 'instance.binding.account', alternativePaths: ['sourceConfig.credentialRef'],
      nativeServicePath: 'instance.binding.service', purpose: 'account-use',
    }] };
    expect(PluginActionContributionV2Schema.safeParse(action).success).toBe(true);
  });

  it.each(['missing', 'multiple', 'malformed'] as const)('rejects an alternative credential arm with %s selection', kind => {
    const account = kind === 'malformed' ? { type: 'string' as const } : qualifiedAccountRef;
    const properties = { ...(kind === 'missing' ? {} : { first: account }), ...(kind === 'multiple' ? { second: account } : {}) };
    const action = { ...scanAction({ type: 'object', properties, required: Object.keys(properties), additionalProperties: false }),
      connectedAccountPurposeBindings: [{ path: 'first', alternativePaths: ['second'], purpose: 'account-use' }] };
    expect(PluginActionContributionV2Schema.safeParse(action).success).toBe(false);
  });
  it('preserves nested selection correlation and rejects reused or inconsistent alternative credential paths', () => {
    const arm = (name: string, account: PluginJsonSchemaV2 = qualifiedAccountRef): PluginJsonSchemaV2 => ({
      type: 'object', properties: { [name]: account }, required: [name], additionalProperties: false,
    });
    const action = (second: PluginJsonSchemaV2 = qualifiedAccountRef) => ({
      ...scanAction({ type: 'object', properties: { binding: { anyOf: [arm('first'), arm('second', second)] } },
        required: ['binding'], additionalProperties: false }),
      connectedAccountPurposeBindings: [{ path: 'binding.first', alternativePaths: ['binding.second'], purpose: 'account-use' }],
    });
    expect(PluginActionContributionV2Schema.safeParse(action()).success).toBe(true);
    expect(PluginActionContributionV2Schema.safeParse(action({ ...qualifiedAccountRef, properties: {
      ...qualifiedAccountRef.properties, accountId: { type: 'string', const: 'one-account' },
    } })).success).toBe(false);
    expect(PluginActionContributionV2Schema.safeParse({ ...action(), connectedAccountPurposeBindings: [{
      path: 'binding.first', alternativePaths: ['binding.first', 'binding.second'], purpose: 'account-use',
    }] }).success).toBe(false);
    expect(PluginActionContributionV2Schema.safeParse({ ...action(), connectedAccountPurposeBindings: [
      ...action().connectedAccountPurposeBindings, { path: 'binding.second', purpose: 'another-purpose' },
    ] }).success).toBe(false);
  });
  it('rejects a service identity union when any arm is not an exact qualified identity', () => {
    const service = qualifiedAccountRef.properties?.service;
    const canonicalArms = service?.anyOf;
    if (!canonicalArms?.length) throw new Error('expected canonical service identity alternatives');
    const invalidServices: readonly PluginJsonSchemaV2[] = [
      { type: 'null' },
      { type: 'string' },
      { type: 'object', properties: { pluginId: { const: 'happier' } }, required: ['pluginId'], additionalProperties: false },
      { type: 'object', properties: { pluginId: { const: 1 }, localId: { const: 'mcp-sign-in' } }, required: ['pluginId', 'localId'], additionalProperties: false },
      { ...canonicalArms[0], additionalProperties: true },
    ];
    for (const invalidService of invalidServices) {
      const accountRef: PluginJsonSchemaV2 = {
        ...qualifiedAccountRef,
        properties: { ...qualifiedAccountRef.properties, service: { anyOf: [...canonicalArms, invalidService] } },
      };
      expect(PluginActionContributionV2Schema.safeParse(scanAction(scanInputSchema(accountRef))).success).toBe(false);
    }
  });

  it('admits one explicit account or native service path per configured-source input arm', () => {
    const serviceRef = qualifiedAccountRef.properties?.service;
    if (!serviceRef) throw new Error('expected qualified service schema');
    const selection: PluginJsonSchemaV2 = {
      anyOf: [{
        type: 'object' as const, properties: { account: qualifiedAccountRef },
        required: ['account'], additionalProperties: false as const,
      }, {
        type: 'object' as const, properties: { source: { const: 'native' }, service: serviceRef },
        required: ['source', 'service'], additionalProperties: false as const,
      }],
    };
    const action = {
      ...scanAction({ type: 'object', properties: { binding: selection }, required: ['binding'], additionalProperties: false }),
      connectedAccountPurposeBindings: [{ path: 'binding.account', nativeServicePath: 'binding.service', purpose: 'account-use' }],
    };
    expect(PluginActionContributionV2Schema.safeParse(action).success).toBe(true);
    expect(PluginActionContributionV2Schema.safeParse({
      ...action,
      inputSchema: { type: 'object', properties: { binding: { type: 'object', properties: { account: qualifiedAccountRef, service: serviceRef }, required: ['account', 'service'], additionalProperties: false } }, required: ['binding'], additionalProperties: false },
    }).success).toBe(false);
  });

  it('accepts a bound credential-ref path declared identically in every union arm', () => {
    const parsed = PluginActionContributionV2Schema.safeParse(
      scanAction(scanInputSchema(qualifiedAccountRef)),
    );

    expect(parsed.success).toBe(true);
  });

  it('accepts a nullable exact qualified credential ref declared in every union arm', () => {
    const parsed = PluginActionContributionV2Schema.safeParse(
      scanAction(scanInputSchema(nullableQualifiedAccountRef)),
    );

    expect(parsed.success).toBe(true);
  });

  it('rejects a bound credential-ref path missing from one union arm', () => {
    const inputSchema = scanInputSchema(qualifiedAccountRef);
    const arms = inputSchema.anyOf ?? [];
    const continuationArm = arms[1];
    if (!continuationArm) throw new Error('expected two declared scan arms');
    const withoutAccount: PluginJsonSchemaV2 = {
      anyOf: [
        arms[0] as PluginJsonSchemaV2,
        {
          ...continuationArm,
          properties: {
            ...continuationArm.properties,
            instance: {
              type: 'object',
              properties: {
                binding: {
                  type: 'object',
                  properties: { purpose: { type: 'string' } },
                  required: ['purpose'],
                  additionalProperties: false,
                },
              },
              required: ['binding'],
              additionalProperties: false,
            },
          },
        },
      ],
    };

    expect(PluginActionContributionV2Schema.safeParse(scanAction(withoutAccount)).success).toBe(false);
  });

  it('rejects a bound credential-ref path whose leaf type differs in one union arm', () => {
    const parsed = PluginActionContributionV2Schema.safeParse(
      scanAction(scanInputSchema(qualifiedAccountRef, { type: 'string' })),
    );

    expect(parsed.success).toBe(false);
  });

  it('rejects a bound credential-ref path narrowed to a different service in one union arm', () => {
    const otherServiceRef: PluginJsonSchemaV2 = {
      ...qualifiedAccountRef,
      properties: {
        service: {
          type: 'object',
          properties: {
            pluginId: { type: 'string', const: 'com.other.plugin' },
            localId: { type: 'string' },
          },
          required: ['pluginId', 'localId'],
          additionalProperties: false,
        },
        accountId: { type: 'string' },
      },
    };
    const parsed = PluginActionContributionV2Schema.safeParse(
      scanAction(scanInputSchema(qualifiedAccountRef, otherServiceRef)),
    );

    expect(parsed.success).toBe(false);
  });

  it('rejects a bound credential-ref path that is nullable in only one union arm', () => {
    const parsed = PluginActionContributionV2Schema.safeParse(
      scanAction(scanInputSchema(qualifiedAccountRef, nullableQualifiedAccountRef)),
    );

    expect(parsed.success).toBe(false);
  });

  it('rejects purpose bindings whose input schema is neither an object nor a union of objects', () => {
    expect(PluginActionContributionV2Schema.safeParse(
      scanAction({ anyOf: [{ type: 'object', properties: {}, additionalProperties: false }, { type: 'string' }] }),
    ).success).toBe(false);
  });

  it('resolves union-shaped input hint fields through every arm', () => {
    const hints = PluginActionInputHintsV2Schema.parse({
      fields: [{
        path: 'instance.binding.account',
        title: localized,
        widget: 'select',
        connectedAccountOptions: true,
      }],
    });

    expect(PluginActionContributionV2Schema.safeParse({
      ...scanAction(scanInputSchema(qualifiedAccountRef)),
      inputHints: hints,
    }).success).toBe(true);
    expect(PluginActionContributionV2Schema.safeParse({
      ...scanAction(scanInputSchema(qualifiedAccountRef, { type: 'string' })),
      connectedAccountPurposeBindings: undefined,
      inputHints: hints,
    }).success).toBe(false);
  });
});
