import { describe, expect, it } from 'vitest';

import { scenarioCatalog } from '../../src/testkit/providers/scenarioCatalog';

describe('providers: kimi scenario fixture aliasing', () => {
  const kimiProvider = {
    id: 'kimi',
    protocol: 'acp',
    traceProvider: 'kimi',
  } as any;

  it('adds unknown tool aliases for read fixture requirements', () => {
    const scenario = scenarioCatalog.read_known_file(kimiProvider);
    const keys = scenario.requiredFixtureKeys ?? [];
    const anyBuckets = scenario.requiredAnyFixtureKeys ?? [];
    expect(keys).not.toContain('acp/kimi/tool-call/Read');
    expect(keys).not.toContain('acp/kimi/tool-call/unknown');
    expect(keys).not.toContain('acp/kimi/tool-result/Read');
    expect(keys).not.toContain('acp/kimi/tool-result/unknown');
    expect(anyBuckets).toContainEqual(['acp/kimi/tool-call/Read', 'acp/kimi/tool-call/unknown']);
    expect(anyBuckets).toContainEqual(['acp/kimi/tool-result/Read', 'acp/kimi/tool-result/unknown']);
  });

  it('adds unknown tool aliases inside requiredAny fixture buckets', () => {
    const scenario = scenarioCatalog.search_known_token(kimiProvider);
    const flat = (scenario.requiredAnyFixtureKeys ?? []).flat();
    expect(flat).toContain('acp/kimi/tool-call/CodeSearch');
    expect(flat).toContain('acp/kimi/tool-call/unknown');
    expect(flat).toContain('acp/kimi/tool-result/CodeSearch');
    expect(flat).toContain('acp/kimi/tool-result/unknown');
  });
});
