import { describe, expect, it } from 'vitest';

import { PluginContributesV2Schema } from './v2.js';

describe('plugin prompt asset contributions', () => {
  it('parses digest-resource prompt assets targeted to an Agent', () => {
    const parsed = PluginContributesV2Schema.parse({
      promptAssets: [
        {
          id: 'security-review',
          kind: 'systemPrompt',
          resource: 'security-review-prompt',
          target: { kind: 'agent', agent: 'deepsec' },
          priority: 20,
        },
      ],
    });

    expect(parsed.promptAssets).toEqual([
      {
        id: 'security-review',
        kind: 'systemPrompt',
        resource: 'security-review-prompt',
        target: { kind: 'agent', agent: 'deepsec' },
        priority: 20,
      },
    ]);
  });

  it('rejects provider-targeted prompt assets', () => {
    expect(() =>
      PluginContributesV2Schema.parse({
        promptAssets: [
          {
            id: 'security-review',
            kind: 'systemPrompt',
            resource: 'security-review-prompt',
            target: { kind: 'provider', provider: 'deepsec' },
          },
        ],
      }),
    ).toThrow();
  });
});
