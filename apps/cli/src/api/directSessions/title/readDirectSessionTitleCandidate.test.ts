import { describe, expect, it } from 'vitest';

import { readDirectSessionTitleCandidate } from './readDirectSessionTitleCandidate';

describe('readDirectSessionTitleCandidate', () => {
  it('rejects boilerplate session title text', () => {
    expect(readDirectSessionTitleCandidate('# Session Title')).toBeNull();
    expect(readDirectSessionTitleCandidate('At the start of the session, ...')).toBeNull();
  });

  it('returns a cleaned title candidate for regular text', () => {
    expect(readDirectSessionTitleCandidate('   Ship the direct-session pager   ')).toBe('Ship the direct-session pager');
  });
});
