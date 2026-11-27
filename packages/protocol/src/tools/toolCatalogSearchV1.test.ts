import { describe, expect, it } from 'vitest';

import { rankToolCatalogSearchV1 } from './toolCatalogSearchV1.js';

describe('rankToolCatalogSearchV1', () => {
  it('ranks a whole-intent match from either source ahead of a partial ID match', () => {
    const items = [
      { id: 'search', title: 'Action Search', searchText: 'search all actions' },
      { id: 'issues', title: 'Issue Finder', searchText: 'search open issues' },
      { id: 'create', title: 'Create Issue', searchText: 'create an issue' },
    ];

    expect(rankToolCatalogSearchV1(items, '  SEARCH open  ', (item) => item))
      .toEqual([items[1], items[0]]);
  });

  it('matches the full query in a tool name when its description uses different terms', () => {
    const items = [
      { id: 'rename', title: 'Rename', searchText: 'rename available workspaces' },
      { id: 'directory', title: 'Worktree Rename', searchText: 'change directory display name' },
    ];

    expect(rankToolCatalogSearchV1(items, 'rename worktree', (item) => item))
      .toEqual([items[1], items[0]]);
  });

  it('matches hyphenated server names against underscore-normalized wire keys', () => {
    const items = [
      { id: 'code_mode_qa_mcp/ping', title: 'ping', searchText: 'code_mode_qa_mcp return server pid' },
    ];

    expect(rankToolCatalogSearchV1(items, 'code-mode-qa-mcp', (item) => item))
      .toEqual([items[0]]);
  });
});
