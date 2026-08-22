import { describe, expect, it } from 'vitest';

import {
  buildClaudeJsonlProviderFactLocalId,
  buildClaudeJsonlProviderFactLocalIdFromParts,
} from './providerFactIdentity.js';

describe('Claude JSONL provider fact identity', () => {
  it('uses the same key for a parsed row and lifecycle evidence from its parts', () => {
    const row = {
      type: 'user',
      uuid: 'user-1',
      sidechainId: 'agent-1',
      message: { content: 'hello' },
    } as const;

    expect(buildClaudeJsonlProviderFactLocalId(row as never)).toBe(
      buildClaudeJsonlProviderFactLocalIdFromParts({
        type: 'user',
        id: 'user-1',
        sidechainId: 'agent-1',
      }),
    );
  });
});
