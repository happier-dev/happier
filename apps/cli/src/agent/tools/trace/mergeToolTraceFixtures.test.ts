import { describe, expect, it } from 'vitest';

import type { ToolTraceFixturesV1, ToolTraceFixturesV2 } from './extractToolTraceFixtures';
import { mergeToolTraceFixturesV1 } from './mergeToolTraceFixtures';
import { makeTraceEvent } from './testEvents.testkit';

describe('mergeToolTraceFixturesV1', () => {
  it('prefers current examples while retaining missing allowlisted historical examples', () => {
    const event = makeTraceEvent({ ts: 1, protocol: 'acp', provider: 'x', kind: 'tool-call', payload: { name: 'Read' } });
    const existing: ToolTraceFixturesV1 = {
      v: 1, generatedAt: 1,
      examples: { 'acp/x/tool-call/Read': [event], 'acp/x/tool-result/Read': [{ ...event, kind: 'tool-result' }] },
    };
    const next: ToolTraceFixturesV2 = {
      v: 2, generatedAt: 2,
      examples: { 'acp/x/tool-call/Read': [{ ...event, payload: { name: 'Read', next: true } }] },
    };
    const merged = mergeToolTraceFixturesV1({ existing, next,
      allowlistKeys: new Set(['acp/x/tool-call/Read', 'acp/x/tool-result/Read']) });
    expect(merged.v).toBe(2);
    expect(Object.keys(merged.examples).sort()).toEqual(['acp/x/tool-call/Read', 'acp/x/tool-result/Read']);
    expect(merged.examples['acp/x/tool-call/Read']).toEqual(next.examples['acp/x/tool-call/Read']);
    expect(merged.examples['acp/x/tool-result/Read']).toEqual(existing.examples['acp/x/tool-result/Read']);
  });

  it('returns current fixtures unchanged when no allowlist is supplied', () => {
    const next: ToolTraceFixturesV2 = { v: 2, generatedAt: 2, examples: {} };
    expect(mergeToolTraceFixturesV1({ existing: null, next })).toEqual(next);
  });
});
