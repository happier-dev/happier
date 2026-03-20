import { describe, expect, it } from 'vitest';

import {
  buildStructuredAgentMessageChunkMirrorSet,
  shouldSkipLegacyMessageChunkMirror,
} from './legacyMessageChunkMirrorDedup';

describe('legacyMessageChunkMirrorDedup', () => {
  it('only skips as many legacy mirrors as there are structured chunks with the same text', () => {
    const mirrored = buildStructuredAgentMessageChunkMirrorSet([
      {
        sessionUpdate: 'agent_message_chunk',
        content: { text: 'same chunk' },
      },
    ] as any);

    expect(
      shouldSkipLegacyMessageChunkMirror(
        { messageChunk: { textDelta: 'same chunk' } },
        mirrored,
      ),
    ).toBe(true);

    expect(
      shouldSkipLegacyMessageChunkMirror(
        { messageChunk: { textDelta: 'same chunk' } },
        mirrored,
      ),
    ).toBe(false);
  });
});
