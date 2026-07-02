import { describe, expect, it } from 'vitest';

import {
  readOpenCodeProviderSessionIdFromMetadata,
  writeOpenCodeProviderSessionIdMetadata,
} from './session.js';

describe('OpenCode provider session metadata', () => {
  it('reads legacy provider session metadata', () => {
    expect(readOpenCodeProviderSessionIdFromMetadata({
      opencodeSessionId: '  oc-session  ',
    })).toBe('oc-session');
  });

  it('writes provider session metadata through the canonical helper', () => {
    expect(writeOpenCodeProviderSessionIdMetadata(' oc-session ')).toEqual({
      opencodeSessionId: 'oc-session',
    });
  });
});
