import { describe, expect, it } from 'vitest';

import {
  PluginTranscriptActivityResourceSnapshotV1Schema,
} from './transcriptActivities.js';

function activity(overrides: Readonly<Record<string, unknown>> = {}) {
  return {
    localActivityId: 'build',
    title: 'Build project',
    phase: 'running',
    checklist: [],
    dismissible: false,
    actions: [],
    ...overrides,
  };
}

describe('PluginTranscriptActivityResourceSnapshotV1Schema', () => {
  it('rejects duplicate checklist ids within one activity before they become React keys', () => {
    const parsed = PluginTranscriptActivityResourceSnapshotV1Schema.safeParse({
      version: 1,
      activities: [activity({
        checklist: [
          { id: 'compile', label: 'Compile packages', state: 'active' },
          { id: 'compile', label: 'Compile generated artifacts', state: 'pending' },
        ],
      })],
    });

    expect(parsed.success).toBe(false);
  });

  it('rejects duplicate action ids within one activity before they become React keys', () => {
    const parsed = PluginTranscriptActivityResourceSnapshotV1Schema.safeParse({
      version: 1,
      activities: [activity({
        actions: [
          { actionId: 'open-log', label: 'Open build log' },
          { actionId: 'open-log', label: 'Open the detailed build log' },
        ],
      })],
    });

    expect(parsed.success).toBe(false);
  });
});
