import { describe, expect, it } from 'vitest';
import { projectGithubSuggestions } from './suggestions.js';

const comment = {
  path: 'file.ts', originalLine: 2, originalStartLine: null, outdated: false,
  originalCommit: { oid: 'a'.repeat(40) }, commit: { oid: 'b'.repeat(40) }, line: 99,
  diffHunk: '@@ -1,2 +1,2 @@\n context\n-old\n+original',
  body: '```suggestion\nreplacement\n```',
};

describe('GitHub suggestion snapshots', () => {
  it('keeps a carriage return that is content on a line with no terminal newline', () => {
    expect(projectGithubSuggestions({ ...comment,
      diffHunk: '@@ -1,2 +1,2 @@\n context\n-old\n+original\r\n\\ No newline at end of file' }, 'RIGHT'))
      .toMatchObject([{ originalLines: ['original\r'] }]);
  });
  it('uses the fenced block’s content indentation for an indented suggestion', () => {
    expect(projectGithubSuggestions({ ...comment, body: '  ```suggestion\n    nested();\n  ```' }, 'RIGHT'))
      .toMatchObject([{ replacement: '  nested();' }]);
  });
  it('retains deletion and multiple complete alternatives on the original commit', () => {
    expect(projectGithubSuggestions({ ...comment, body: '```suggestion\n```\n```suggestion\nother\n```' }, 'RIGHT'))
      .toMatchObject([{ commitOid: 'a'.repeat(40), startLine: 2, endLine: 2, originalLines: ['original'], replacement: '' },
        { replacement: 'other' }]);
  });
  it.each([
    { ...comment, body: '```suggestion\nunfinished' },
    { ...comment, body: '````text\n```suggestion\nexample\n```\n````' },
    { ...comment, originalLine: 3 },
    { ...comment, originalCommit: null },
  ])('omits incomplete or unbound suggestion snapshots', row => {
    expect(projectGithubSuggestions(row, 'RIGHT')).toEqual([]);
  });
  it('does not reinterpret a left-side review range as checkout lines', () => {
    expect(projectGithubSuggestions(comment, 'LEFT')).toEqual([]);
  });
});
