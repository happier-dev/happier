import { describe, expect, it } from 'vitest';

import type { ExternalSessionTranscriptRawMessageV1 } from '@happier-dev/protocol';

import { buildExternalSessionReadyNotificationPreview } from './buildExternalSessionReadyNotificationPreview';

describe('buildExternalSessionReadyNotificationPreview', () => {
  it('uses canonical transcript body extraction for Codex agent_message rows', () => {
    const items: ExternalSessionTranscriptRawMessageV1[] = [{
      id: 'row-1',
      createdAtMs: 1,
      raw: {
        role: 'agent',
        content: {
          type: 'codex',
          data: {
            type: 'agent_message',
            text: 'Codex preview text',
          },
        },
      },
    }];

    expect(buildExternalSessionReadyNotificationPreview(items)).toBe('Codex preview text');
  });
});
