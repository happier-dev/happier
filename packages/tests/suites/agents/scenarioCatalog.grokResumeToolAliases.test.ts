import { describe, expect, it } from 'vitest';

import { scenarioCatalog } from '../../src/testkit/providers/scenarios/scenarioCatalog';

describe('providers: Grok resume tool aliases', () => {
  const provider = {
    id: 'grok',
    protocol: 'acp',
  } as any;

  it('accepts the canonical Write projection when Grok fulfills the requested shell marker as a write', () => {
    const scenario = scenarioCatalog.acp_resume_load_session(provider);
    const buckets = scenario.requiredAnyFixtureKeys ?? [];

    expect(buckets[0]).toContain('acp/grok/tool-call/Write');
    expect(buckets[1]).toContain('acp/grok/tool-result/Write');
  });
});
