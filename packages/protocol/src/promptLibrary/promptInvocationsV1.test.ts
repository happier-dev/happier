import { describe, expect, it } from 'vitest';

import { PromptInvocationEntryV1Schema, PromptInvocationsV1Schema, normalizePromptInvocationTokenV1 } from './promptInvocationsV1.js';

describe('PromptInvocationsV1Schema', () => {
  it('defaults to an empty list', () => {
    expect(PromptInvocationsV1Schema.parse({})).toEqual({ v: 1, entries: [] });
  });

  it('accepts valid tokens', () => {
    const parsed = PromptInvocationsV1Schema.safeParse({
      v: 1,
      entries: [
        {
          id: 'i1',
          token: '/foo',
          title: 'Foo',
          target: { kind: 'doc', artifactId: 'a1' },
          behavior: 'insert',
          allowArgs: true,
          availableIn: 'global',
        },
      ],
    });
    expect(parsed.success).toBe(true);
  });

  it('rejects tokens that look like paths (nested slashes)', () => {
    expect(
      PromptInvocationEntryV1Schema.safeParse({
        id: 'i1',
        token: '/Users/foo',
        title: 'Foo',
        target: { kind: 'doc', artifactId: 'a1' },
      }).success,
    ).toBe(false);
  });

  it('fails closed to an empty list when the container is invalid', () => {
    expect(
      PromptInvocationsV1Schema.parse({
        v: 1,
        entries: [
          {
            id: 'i1',
            token: '/Users/foo',
            title: 'Foo',
            target: { kind: 'doc', artifactId: 'a1' },
          },
        ],
      }),
    ).toEqual({ v: 1, entries: [] });
  });
});

describe('normalizePromptInvocationTokenV1', () => {
  it('lowercases and trims', () => {
    expect(normalizePromptInvocationTokenV1('  /Foo  ')).toBe('/foo');
  });
});
