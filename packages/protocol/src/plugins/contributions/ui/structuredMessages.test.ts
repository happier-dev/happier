import { describe, expect, it } from 'vitest';

import { PluginStructuredMessageDescriptorV1Schema } from './structuredMessages.js';

describe('plugin structured message descriptors', () => {
  it('accepts JSON enum values in payload schemas', () => {
    const result = PluginStructuredMessageDescriptorV1Schema.safeParse({
      id: 'status-card',
      title: 'Status',
      kind: 'acme.preview/status-card.v1',
      payloadSchema: {
        type: 'string',
        enum: ['ready', 'blocked'],
      },
      renderer: 'status',
      fallback: { kind: 'summary', template: '{status}' },
    });

    expect(result.success).toBe(true);
  });

  it('rejects executable values in payload schema enums', () => {
    const result = PluginStructuredMessageDescriptorV1Schema.safeParse({
      id: 'status-card',
      title: 'Status',
      kind: 'acme.preview/status-card.v1',
      payloadSchema: {
        type: 'string',
        enum: [() => 'ready'],
      },
      renderer: 'status',
      fallback: { kind: 'summary', template: '{status}' },
    });

    expect(result.success).toBe(false);
  });
});
