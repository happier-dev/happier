import { describe, expect, it } from 'vitest';

import { PluginActionContributionV2Schema, PluginActionInputHintsV2Schema } from './v2.js';
import type { PluginJsonSchemaV2 } from '../contributions/publicTypes.js';

const localized = { key: 'plugin.title', fallback: 'Title' };

const qualifiedAccountRef: PluginJsonSchemaV2 = {
  type: 'object',
  properties: {
    service: {
      type: 'object',
      properties: {
        pluginId: { type: 'string' },
        localId: { type: 'string' },
      },
      required: ['pluginId', 'localId'],
      additionalProperties: false,
    },
    accountId: { type: 'string' },
  },
  required: ['service', 'accountId'],
  additionalProperties: false,
};

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
