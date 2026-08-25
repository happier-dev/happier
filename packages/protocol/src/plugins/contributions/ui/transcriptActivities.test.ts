import { describe, expect, it } from 'vitest';

import {
  MAX_PLUGIN_TRANSCRIPT_ACTIVITIES_PER_RESOURCE_V1,
  MAX_PLUGIN_TRANSCRIPT_ACTIVITY_RESOURCE_BYTES_V1,
  PLUGIN_TRANSCRIPT_ACTIVITY_CONTENT_TYPE_V1,
  PluginTranscriptActivityResourceSnapshotV1Schema,
} from './transcriptActivities.js';
import * as protocolUiClient from '../../ui/client.js';

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
  it('projects the canonical transcript-activity resource contract through the browser-safe Protocol UI client', () => {
    const client = protocolUiClient as Readonly<Record<string, unknown>>;

    expect(client['PLUGIN_TRANSCRIPT_ACTIVITY_CONTENT_TYPE_V1'])
      .toBe(PLUGIN_TRANSCRIPT_ACTIVITY_CONTENT_TYPE_V1);
    expect(client['MAX_PLUGIN_TRANSCRIPT_ACTIVITIES_PER_RESOURCE_V1'])
      .toBe(MAX_PLUGIN_TRANSCRIPT_ACTIVITIES_PER_RESOURCE_V1);
    expect(client['MAX_PLUGIN_TRANSCRIPT_ACTIVITY_RESOURCE_BYTES_V1'])
      .toBe(MAX_PLUGIN_TRANSCRIPT_ACTIVITY_RESOURCE_BYTES_V1);
    expect(client['PluginTranscriptActivityResourceSnapshotV1Schema'])
      .toBe(PluginTranscriptActivityResourceSnapshotV1Schema);
  });

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
