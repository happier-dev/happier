import { describe, expect, it } from 'vitest';

import { extractAssistantTextSnapshotFromSessionContent } from './extractAssistantTextSnapshot';

describe('extractAssistantTextSnapshotFromSessionContent', () => {
  it('extracts assistant text from agent_message body rows', () => {
    expect(extractAssistantTextSnapshotFromSessionContent({
      role: 'agent',
      content: {
        type: 'codex',
        data: {
          type: 'agent_message',
          text: 'codex snapshot text',
        },
      },
    })).toMatchObject({
      text: 'codex snapshot text',
      provider: 'codex',
      sidechainId: null,
    });
  });

  it('preserves Claude provider attribution for output rows', () => {
    expect(extractAssistantTextSnapshotFromSessionContent({
      role: 'agent',
      content: {
        type: 'output',
        data: {
          type: 'assistant',
          message: {
            role: 'assistant',
            content: [{ type: 'text', text: 'claude snapshot text' }],
          },
        },
      },
    })).toMatchObject({
      text: 'claude snapshot text',
      provider: 'claude',
      sidechainId: null,
    });
  });
});
