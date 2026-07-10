import { describe, expect, it } from 'vitest';

import {
  ANTIGRAVITY_AGENT_SETTINGS_CONTRIBUTION,
  ANTIGRAVITY_AGENT_SETTINGS_DEFAULTS,
  ANTIGRAVITY_AGENT_SETTINGS_DESCRIPTOR,
} from './definition.js';

describe('Antigravity agent settings definition', () => {
  it('defines runtime mode as a provider-account enum setting with auto default', () => {
    const field = ANTIGRAVITY_AGENT_SETTINGS_CONTRIBUTION.fields.find((entry) => (
      entry.id === 'antigravityRuntimeMode'
    ));

    expect(ANTIGRAVITY_AGENT_SETTINGS_CONTRIBUTION).toMatchObject({
      id: 'antigravity.agentSettings.v1',
      kind: 'agentSettings.v1',
      agentId: 'antigravity',
      storageScope: 'agentAccount',
    });
    expect(field).toMatchObject({
      id: 'antigravityRuntimeMode',
      default: 'auto',
      storageScope: 'account',
      analytics: {
        trackCurrentState: true,
        trackChanges: true,
        valueKind: 'enum',
        privacy: 'safe',
        identityScope: 'person',
      },
      schema: {
        kind: 'enum',
        values: ['auto', 'cliPrint', 'sdk'],
      },
      ui: {
        kind: 'enum',
      },
    });
    expect(field?.ui?.enumOptions?.map((option) => option.id)).toEqual(['auto', 'cliPrint', 'sdk']);
    expect(ANTIGRAVITY_AGENT_SETTINGS_DEFAULTS).toEqual({
      antigravityRuntimeMode: 'auto',
    });
  });

  it('builds the canonical agent settings UI descriptor from the contribution', () => {
    expect(ANTIGRAVITY_AGENT_SETTINGS_DESCRIPTOR).toMatchObject({
      kind: 'agentSettings.v1',
      descriptorId: 'antigravity.agentSettings.v1',
      agentId: 'antigravity',
      settings: {
        antigravityRuntimeMode: {
          default: 'auto',
          schema: {
            kind: 'enum',
            values: ['auto', 'cliPrint', 'sdk'],
          },
          storageScope: 'account',
        },
      },
    });
    expect(ANTIGRAVITY_AGENT_SETTINGS_DESCRIPTOR.uiSections).toEqual([
      expect.objectContaining({
        id: 'antigravityRuntime',
        fields: [
          expect.objectContaining({
            key: 'antigravityRuntimeMode',
            kind: 'enum',
          }),
        ],
      }),
    ]);
  });
});
