import { describe, expect, it } from 'vitest';

import { ANTIGRAVITY_AGENT_SETTINGS_CONTRIBUTION } from './definition.js';

describe('Antigravity agent settings definition', () => {
  it('defines runtime mode as a provider-account enum setting with auto default', () => {
    const field = ANTIGRAVITY_AGENT_SETTINGS_CONTRIBUTION.fields.find((entry) => (
      entry.id === 'antigravityRuntimeMode'
    ));

    expect(ANTIGRAVITY_AGENT_SETTINGS_CONTRIBUTION).toMatchObject({
      id: 'agent-settings',
      version: 1,
      target: { kind: 'agent', agent: 'antigravity' },
      scope: 'account',
    });
    expect(field).toMatchObject({
      id: 'antigravityRuntimeMode',
      default: 'auto',
      analytics: {
        trackCurrentState: true,
        trackChanges: true,
        valueKind: 'enum',
        privacy: 'safe',
        identityScope: 'person',
      },
      schema: {
        type: 'string',
        enum: ['auto', 'cliPrint', 'sdk'],
      },
      presentation: {
        control: 'select',
      },
    });
    expect(field?.presentation?.options?.map((option) => option.value)).toEqual([
      'auto',
      'cliPrint',
      'sdk',
    ]);
  });

  it('keeps presentation metadata on the canonical settings contribution', () => {
    expect(ANTIGRAVITY_AGENT_SETTINGS_CONTRIBUTION.presentation.sections).toEqual([
      expect.objectContaining({
        id: 'antigravity-runtime',
        fields: ['antigravityRuntimeMode'],
      }),
    ]);
  });
});
