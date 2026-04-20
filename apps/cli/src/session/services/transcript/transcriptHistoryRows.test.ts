import { describe, expect, it } from 'vitest';

import { extractCompactRow } from './transcriptHistoryRows';

describe('extractCompactRow', () => {
  it('extracts assistant text from output rows', () => {
    const row = extractCompactRow({
      createdAt: 1,
      fallbackId: '3',
      decrypted: {
        role: 'agent',
        content: {
          type: 'output',
          data: {
            type: 'assistant',
            message: {
              role: 'assistant',
              content: [{ type: 'text', text: 'OK' }],
            },
          },
        },
      },
    });

    expect(row).toMatchObject({
      id: '3',
      createdAt: 1,
      role: 'agent',
      kind: 'output',
      text: 'OK',
    });
  });

  it('extracts provider text from ACP message rows', () => {
    const row = extractCompactRow({
      createdAt: 1,
      fallbackId: '4',
      decrypted: {
        role: 'agent',
        content: {
          type: 'acp',
          provider: 'opencode',
          data: {
            type: 'message',
            message: 'provider compact text',
          },
        },
      },
    });

    expect(row).toMatchObject({
      id: '4',
      createdAt: 1,
      role: 'agent',
      kind: 'acp',
      text: 'provider compact text',
    });
  });
});
