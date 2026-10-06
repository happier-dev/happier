import { describe, expect, it } from 'vitest';

import { PluginActionConfirmationV2Schema, PluginActionContributionV2Schema } from './v2.js';
import { pluginActionRequiresPresentUserIntent } from './invocation.js';

describe('PluginActionConfirmationV2Schema', () => {
  it('admits a warning-confirmed read without classifying it as a remote write', () => {
    const action = PluginActionContributionV2Schema.parse({
      id: 'sensitive/read', title: 'Read captured variables', description: 'Read a selected occurrence.',
      execution: { target: 'daemon' }, scopes: ['global'],
      surfaces: ['ui', 'agent', 'mcp', 'cli'], placementBindings: [], dangerLevel: 'safe',
      confirmation: { title: 'Reveal captured variables?', body: 'Captured values can contain credentials.' },
    });
    expect(action.dangerLevel).toBe('safe');
    expect(pluginActionRequiresPresentUserIntent(action, 'agent')).toBe(true);
    expect(pluginActionRequiresPresentUserIntent({ ...action, approvalRequiredByActionSettings: false }, 'agent')).toBe(false);
    expect(pluginActionRequiresPresentUserIntent({ ...action, approvalRequiredByActionSettings: true }, 'agent')).toBe(true);
    const { confirmation: _confirmation, ...withoutConfirmation } = action;
    expect(PluginActionContributionV2Schema.safeParse({ ...withoutConfirmation, dangerLevel: 'writesRemote' }).success).toBe(false);
    expect(PluginActionContributionV2Schema.safeParse({ ...action, unrecognizedAuthority: true }).success).toBe(false);
  });

  it('accepts only bounded localized title and body presentation', () => {
    expect(PluginActionConfirmationV2Schema.parse({
      title: { key: 'automation.historyGapReset.title', fallback: 'Start a new baseline' },
      body: {
        key: 'automation.historyGapReset.body',
        fallback: 'Events in the history gap are not replayed.',
      },
    })).toMatchObject({
      title: { fallback: 'Start a new baseline' },
      body: { fallback: 'Events in the history gap are not replayed.' },
    });
    expect(PluginActionConfirmationV2Schema.safeParse({
      title: 'x'.repeat(1_025),
    }).success).toBe(false);
    expect(PluginActionConfirmationV2Schema.safeParse({
      title: 'Start a new baseline',
      body: 'x'.repeat(4_097),
    }).success).toBe(false);
  });
});
