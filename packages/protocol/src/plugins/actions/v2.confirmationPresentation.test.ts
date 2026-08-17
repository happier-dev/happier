import { describe, expect, it } from 'vitest';

import { PluginActionConfirmationV2Schema } from './v2.js';

describe('PluginActionConfirmationV2Schema', () => {
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
