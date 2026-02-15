import { describe, expect, it } from 'vitest';

import type { ToolTraceFixturesV1 } from './extractToolTraceFixtures';
import { mergeToolTraceFixturesV1 } from './mergeToolTraceFixtures';

describe('mergeToolTraceFixturesV1', () => {
  it('prefers next examples but preserves missing allowlisted keys from existing', () => {
    const existing: ToolTraceFixturesV1 = {
      v: 1,
      generatedAt: 1,
      examples: {
        'acp/x/tool-call/Read': [{ v: 1 } as any],
        'acp/x/tool-result/Read': [{ v: 1 } as any],
      },
    };

    const next: ToolTraceFixturesV1 = {
      v: 1,
      generatedAt: 2,
      examples: {
        'acp/x/tool-call/Read': [{ v: 1, next: true } as any],
      },
    };

    const merged = mergeToolTraceFixturesV1({
      existing,
      next,
      allowlistKeys: new Set(['acp/x/tool-call/Read', 'acp/x/tool-result/Read']),
    });

    expect(Object.keys(merged.examples).sort()).toEqual(['acp/x/tool-call/Read', 'acp/x/tool-result/Read']);
    expect(merged.examples['acp/x/tool-call/Read']).toEqual(next.examples['acp/x/tool-call/Read']);
    expect(merged.examples['acp/x/tool-result/Read']).toEqual(existing.examples['acp/x/tool-result/Read']);
  });

  it('returns next fixtures unchanged when allowlistKeys is not provided', () => {
    const next: ToolTraceFixturesV1 = {
      v: 1,
      generatedAt: 2,
      examples: {
        'acp/x/tool-call/Read': [{ v: 1 } as any],
      },
    };

    const merged = mergeToolTraceFixturesV1({ existing: null, next });
    expect(merged).toEqual(next);
  });
});

