import { describe, expect, it, vi } from 'vitest';
import { githubActionsRunsWindowV1 } from './runGroups.js';

const translate = (_key: string, fallback: string) => fallback;

describe('the Actions runs window', () => {
  it('offers the read owner’s next page as the list’s continuation while GitHub has more', () => {
    const loadMore = vi.fn();
    const window = githubActionsRunsWindowV1({ continuation: 'cursor-2', incomplete: null }, translate, { loadMore, busy: true });
    expect(window.kind).toBe('partial');
    if (window.kind !== 'partial') return;
    expect(window.continuations).toHaveLength(1);
    expect(window.continuations[0]?.busy).toBe(true);
    window.continuations[0]?.load();
    expect(loadMore).toHaveBeenCalledTimes(1);
  });

  it('stays honestly incomplete, with nothing to press, when the page was cut short without a cursor', () => {
    const window = githubActionsRunsWindowV1({ continuation: null, incomplete: 'projection_truncated' }, translate, { loadMore: vi.fn(), busy: false });
    expect(window.kind).toBe('unavailable');
  });

  it('is complete when GitHub returned every run', () => {
    expect(githubActionsRunsWindowV1({ continuation: null, incomplete: null }, translate, null).kind).toBe('complete');
  });
});
