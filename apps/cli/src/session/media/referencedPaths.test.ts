import { describe, expect, it } from 'vitest';

import {
  collectReferencedSessionMediaWorkspacePaths,
} from './referencedPaths';

function mediaEnvelope(
  path: string,
  category: 'attachment' | 'generated' | 'tool-artifact' = 'generated',
) {
  return {
    kind: 'session_media.v1',
    payload: {
      media: [
        {
          id: 'media-1',
          role: 'output',
          category,
          mediaKind: 'image',
          mimeType: 'image/png',
          name: 'image.png',
          path,
          sizeBytes: 12,
          origin: { source: 'provider-generated' },
        },
      ],
    },
  };
}

describe('collectReferencedSessionMediaWorkspacePaths', () => {
  it('collects deduped byte-free session_media.v1 workspace paths from transcript metadata', () => {
    expect(collectReferencedSessionMediaWorkspacePaths([
      { meta: { happier: mediaEnvelope('.happier/uploads/generated/session-1/message-1/image.png') } },
      { raw: { meta: { happierMedia: mediaEnvelope('.happier/uploads/artifacts/session-1/message-2/plot.png', 'tool-artifact') } } },
      { meta: { happierMedia: mediaEnvelope('.happier/uploads/generated/session-1/message-1/image.png') } },
      { meta: { happierMedia: mediaEnvelope('.happier/uploads/messages/session-1/message-3/upload.png', 'attachment') } },
    ])).toEqual([
      '.happier/uploads/artifacts/session-1/message-2/plot.png',
      '.happier/uploads/generated/session-1/message-1/image.png',
      '.happier/uploads/messages/session-1/message-3/upload.png',
    ]);
  });

  it('ignores unsafe public or absolute paths and inline-byte-shaped metadata', () => {
    expect(collectReferencedSessionMediaWorkspacePaths([
      { meta: { happier: mediaEnvelope('/tmp/provider.png') } },
      { meta: { happier: mediaEnvelope('file:///tmp/provider.png') } },
      { meta: { happier: mediaEnvelope('https://example.test/provider.png') } },
      { meta: { happier: mediaEnvelope('data:image/png;base64,abc') } },
      { meta: { happier: mediaEnvelope('C:\\Users\\tester\\provider.png') } },
      { meta: { happier: mediaEnvelope('.happier/uploads/generated/session-1/../provider.png') } },
      {
        meta: {
          happier: {
            kind: 'session_media.v1',
            payload: {
              media: [{
                category: 'generated',
                path: '.happier/uploads/generated/session-1/message-1/image.png',
                data: 'inline bytes must not be accepted as a continuity reference',
              }],
            },
          },
        },
      },
      { meta: { happierMedia: { kind: 'other.v1', payload: { media: [] } } } },
    ])).toEqual([]);
  });
});
