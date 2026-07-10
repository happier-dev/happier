import { describe, expect, it } from 'vitest';

import type { PluginAgentSettingsContributionV1 } from '@happier-dev/protocol';

import { buildAgentSettingsDefinitionFromContribution } from './fromContribution.js';

const CONTRIBUTION = Object.freeze({
  id: 'acme.agentSettings.v1',
  kind: 'agentSettings.v1',
  agentId: 'acme',
  version: 1,
  storageScope: 'agentAccount',
  fields: [
    {
      id: 'enabled',
      schema: { kind: 'boolean' },
      default: true,
      description: 'Enable Acme',
      storageScope: 'account',
    },
    {
      id: 'mode',
      schema: { kind: 'enum', values: ['managed', 'external'] },
      default: 'managed',
      description: 'Preferred mode',
      storageScope: 'account',
    },
    {
      id: 'sources',
      schema: { kind: 'enumArray', values: ['user', 'project', 'local'], max: 3 },
      default: ['user', 'project'],
      description: 'Source order',
      storageScope: 'account',
    },
    {
      id: 'advancedJson',
      schema: { kind: 'jsonObjectString', maxLength: 64 },
      default: '',
      description: 'Advanced JSON options',
      storageScope: 'account',
    },
    {
      id: 'maxItems',
      schema: { kind: 'positiveInteger', nullable: true },
      default: null,
      description: 'Maximum item count',
      storageScope: 'account',
    },
  ],
  ui: { sections: [], subagentSettingsSections: [] },
} as const satisfies PluginAgentSettingsContributionV1);

describe('buildAgentSettingsDefinitionFromContribution', () => {
  it('compiles data-only agent-settings contributions into host validation definitions', () => {
    const definition = buildAgentSettingsDefinitionFromContribution(CONTRIBUTION);

    expect(definition.agentId).toBe('acme');
    expect(definition.fields.enabled?.default).toBe(true);
    expect(definition.fields.mode?.schema.safeParse('external').success).toBe(true);
    expect(definition.fields.mode?.schema.safeParse('bad').success).toBe(false);
    expect(definition.fields.sources?.schema.safeParse(['local', 'user']).success).toBe(true);
    expect(definition.fields.sources?.schema.safeParse(['local', 'bad']).success).toBe(false);
    expect(definition.fields.advancedJson?.schema.safeParse('{ "ok": true }').success).toBe(true);
    expect(definition.fields.advancedJson?.schema.safeParse('[1,2,3]').success).toBe(false);
    expect(definition.fields.maxItems?.schema.safeParse(null).success).toBe(true);
    expect(definition.fields.maxItems?.schema.safeParse(10).success).toBe(true);
    expect(definition.fields.maxItems?.schema.safeParse(0).success).toBe(false);
  });
});
