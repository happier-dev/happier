import { describe, expect, it } from 'vitest';

import {
  collectSessionMediaHandoffPaths,
  collectSessionMediaHandoffPathsFromProviderBundle,
} from './collectSessionMediaHandoffPaths';

function mediaEnvelope(path: string, category: 'generated' | 'tool-artifact' | 'attachment' = 'generated') {
  return {
    kind: 'session_media.v1',
    payload: {
      media: [
        {
          role: 'output',
          category,
          mediaKind: 'image',
          path,
        },
      ],
    },
  };
}

function attachmentsEnvelope(path: string) {
  return {
    kind: 'attachments.v1',
    payload: {
      attachments: [
        {
          name: 'upload.png',
          path,
          mimeType: 'image/png',
          sizeBytes: 10,
        },
      ],
    },
  };
}

describe('collectSessionMediaHandoffPaths', () => {
  it('collects durable attachment, generated, and tool-artifact paths from primary and secondary media metadata', () => {
    expect(collectSessionMediaHandoffPaths([
      {
        meta: {
          happier: mediaEnvelope('.happier/uploads/generated/message-1/generated.png'),
        },
      },
      {
        raw: {
          meta: {
            happierMedia: mediaEnvelope('.happier/uploads/artifacts/message-2/tool-output.png', 'tool-artifact'),
          },
        },
      },
      {
        meta: {
          happierMedia: mediaEnvelope('.happier/uploads/messages/message-3/upload.png', 'attachment'),
        },
      },
    ])).toEqual([
      '.happier/uploads/artifacts/message-2/tool-output.png',
      '.happier/uploads/generated/message-1/generated.png',
      '.happier/uploads/messages/message-3/upload.png',
    ]);
  });

  it('collects legacy attachments.v1 paths written by production attachment senders', () => {
    expect(collectSessionMediaHandoffPaths([
      {
        meta: {
          happier: attachmentsEnvelope('.happier/uploads/messages/message-4/upload.png'),
        },
      },
      {
        meta: {
          happier: { kind: 'review_comments.v1', payload: {} },
          happierAttachments: attachmentsEnvelope('.happier/uploads/messages/message-5/upload.png'),
        },
      },
    ])).toEqual([
      '.happier/uploads/messages/message-4/upload.png',
      '.happier/uploads/messages/message-5/upload.png',
    ]);
  });

  it('ignores non-durable or malformed session media metadata', () => {
    expect(collectSessionMediaHandoffPaths([
      { meta: { happier: mediaEnvelope('/tmp/generated.png') } },
      { meta: { happier: mediaEnvelope('file:///tmp/generated.png') } },
      { meta: { happier: mediaEnvelope('C:\\Users\\tester\\generated.png') } },
      { meta: { happier: mediaEnvelope('.happier\\uploads\\generated\\message-1\\image.png') } },
      { meta: { happier: mediaEnvelope('.happier/uploads/generated/message-1/../image.png') } },
      { meta: { happier: mediaEnvelope('https://example.test/generated.png') } },
      { meta: { happier: mediaEnvelope('data:image/png;base64,abc') } },
      { meta: { happier: mediaEnvelope('.happier/uploads/messages/../upload.png', 'attachment') } },
      { meta: { happier: { kind: 'session_media.v1', payload: { media: 'invalid' } } } },
      { meta: { happierMedia: { kind: 'other.v1', payload: { media: [] } } } },
    ])).toEqual([]);
  });

  it('collects paths from provider transcript bundles without failing on malformed rows', async () => {
    const transcript = [
      'not json',
      JSON.stringify({
        meta: {
          happierMedia: mediaEnvelope('.happier/uploads/generated/message-1/from-provider.png'),
        },
      }),
    ].join('\n');

    await expect(collectSessionMediaHandoffPathsFromProviderBundle({
      providerId: 'claude',
      remoteSessionId: 'claude_session_1',
      transcriptBase64: Buffer.from(transcript, 'utf8').toString('base64'),
    })).resolves.toEqual(['.happier/uploads/generated/message-1/from-provider.png']);
  });
});
