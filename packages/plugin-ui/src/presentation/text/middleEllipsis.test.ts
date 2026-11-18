import { describe, expect, it } from 'vitest';

import { HAPPIER_MIDDLE_ELLIPSIS_STYLE, splitForWebMiddleEllipsis } from './middleEllipsis.js';

describe('splitForWebMiddleEllipsis', () => {
  it('keeps the word space at a cut, which a browser would drop at the start or end of a run', () => {
    const split = splitForWebMiddleEllipsis('An Environment you can’t open');
    expect(split).not.toBeNull();
    // Rejoined as the two runs render, the words stay apart.
    expect(`${split!.head}${split!.tail}`.replace(/ /g, ' ')).toBe('An Environment you can’t open');
    expect(split!.tail.startsWith(' ')).toBe(false);
    expect(split!.head.endsWith(' ')).toBe(false);
  });

  it('keeps the word space before a path that starts mid-line ("POST /checkout · Production")', () => {
    const split = splitForWebMiddleEllipsis('POST /checkout · billing-api · Production');
    expect(split).not.toBeNull();
    expect(`${split!.head}${split!.tail}`.replace(/\u00a0/g, ' ').replace(/\u200e/g, '')).toBe('POST /checkout · billing-api · Production');
    expect(split!.head.endsWith(' ')).toBe(false);
    expect(split!.tail.replace(/\u200e/g, '').startsWith(' ')).toBe(false);
  });

  it('keeps a name’s distinguishing suffix whole', () => {
    expect(splitForWebMiddleEllipsis('customer-portal · Production')).toMatchObject({ head: 'customer-portal', tail: ' · Production',
      tailStyle: HAPPIER_MIDDLE_ELLIPSIS_STYLE.tail });
  });

  it('keeps the parent that tells same-name paths apart: the root stays and the rest gives up its start (#18)', () => {
    const paths = ['/tmp/happier-qa-usage-acct-1030-agent-20261030/claude', '/tmp/happier-qa-usage-acct-1031-20261031/claude'];
    const splits = paths.map(path => splitForWebMiddleEllipsis(path)!);
    for (const [index, split] of splits.entries()) {
      // A bidi mark keeps the tail's characters in order while its ellipsis falls at its start.
      expect(`${split.head}${split.tail}`.replace(/\u200e/g, '')).toBe(paths[index]);
      expect(split).toMatchObject({ head: '/tmp', headStyle: HAPPIER_MIDDLE_ELLIPSIS_STYLE.headWhole,
        tailStyle: HAPPIER_MIDDLE_ELLIPSIS_STYLE.tailFromStart });
    }
    expect(splitForWebMiddleEllipsis('~/.gemini/antigravity-cli/brain')).toMatchObject({ head: '~/.gemini' });
    // A last segment long enough to tell paths apart stays the whole tail, as before.
    expect(splitForWebMiddleEllipsis('~/src/happier-agent-workspace-billing')).toMatchObject({ head: '~/src', tail: '/happier-agent-workspace-billing',
      tailStyle: HAPPIER_MIDDLE_ELLIPSIS_STYLE.tail });
  });
});
