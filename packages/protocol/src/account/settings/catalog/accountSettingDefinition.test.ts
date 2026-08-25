import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import {
  ACCOUNT_SETTING_CLASSIFICATIONS,
  defineAccountSettingDefinitions,
  type AccountSettingDefinition,
} from './accountSettingDefinition.js';

/**
 * The refusals under test are runtime admission checks for definitions the type
 * system already discourages, so the fixture asserts the declared shape while
 * deliberately supplying values that shape forbids. Without the cast the
 * invalid vectors could not be written at all and the guard would stay
 * unfalsifiable.
 */
function definition(
  overrides: Partial<AccountSettingDefinition> = {},
): AccountSettingDefinition {
  return {
    schema: z.string(),
    default: 'value',
    description: 'Account census setting',
    storageScope: 'account',
    semanticDomain: 'census',
    classification: 'preference',
    maximumSerializedValueBytes: 1024,
    ...overrides,
  } as AccountSettingDefinition;
}

describe('Account setting catalog admission', () => {
  it('admits a fully classified and bounded definition', () => {
    const definitions = defineAccountSettingDefinitions({
      censusPreference: definition(),
      censusLegacy: definition({
        classification: 'legacy',
        compatibility: {
          provenance: 'Pre-PEP Account Settings root.',
          removalCondition: 'Remove after the named destination activates its transfer.',
        },
      }),
    });

    expect(Object.keys(definitions)).toEqual(['censusPreference', 'censusLegacy']);
    expect(ACCOUNT_SETTING_CLASSIFICATIONS).toEqual(['preference', 'policy', 'legacy', 'transferring']);
  });

  // Every refusal below is the census invariant SET-E0 depends on: a key that
  // reaches the catalog without a semantic domain, a byte ceiling, or — for a
  // compatibility root — a provenance and removal condition is an unclassified
  // key, and the catalog is the only place that can still refuse it.
  it.each([
    [
      'a blank semantic domain',
      definition({ semanticDomain: '   ' }),
      /requires a semantic domain/,
    ],
    [
      'a non-positive byte ceiling',
      definition({ maximumSerializedValueBytes: 0 }),
      /requires a positive serialized-byte bound/,
    ],
    [
      'a fractional byte ceiling',
      definition({ maximumSerializedValueBytes: 12.5 }),
      /requires a positive serialized-byte bound/,
    ],
    [
      'a legacy root with no compatibility metadata',
      definition({ classification: 'legacy' }),
      /requires compatibility provenance and a removal condition/,
    ],
    [
      'a transferring root with no compatibility metadata',
      definition({ classification: 'transferring' }),
      /requires compatibility provenance and a removal condition/,
    ],
    [
      'a blank compatibility provenance',
      definition({
        classification: 'legacy',
        compatibility: { provenance: ' ', removalCondition: 'Remove after transfer.' },
      }),
      /has incomplete compatibility metadata/,
    ],
    [
      'a blank removal condition',
      definition({
        classification: 'legacy',
        compatibility: { provenance: 'Pre-PEP root.', removalCondition: '  ' },
      }),
      /has incomplete compatibility metadata/,
    ],
  ])('refuses %s', (_label, candidate, message) => {
    expect(() => defineAccountSettingDefinitions({ censusKey: candidate })).toThrow(message);
  });

  it('still refuses a schema whose declared default the schema itself rejects', () => {
    expect(() => defineAccountSettingDefinitions({
      censusKey: definition({ schema: z.number(), default: 'not-a-number' }),
    })).toThrow(/censusKey/);
  });
});
