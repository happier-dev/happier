import { describe, expect, it } from 'vitest';

import { buildOpenCodeBrokerMarker } from '../broker/env.js';

import { hashOpenCodeDirectKeyAuthContent } from './directKeyAuthHash.js';

describe('hashOpenCodeDirectKeyAuthContent (F3 direct-key fingerprint fold)', () => {
  it('returns empty for native sessions (no auth content)', () => {
    expect(hashOpenCodeDirectKeyAuthContent(undefined)).toBe('');
    expect(hashOpenCodeDirectKeyAuthContent('')).toBe('');
    expect(hashOpenCodeDirectKeyAuthContent('not json')).toBe('');
  });

  it('hashes a direct API key and changes when the key rotates', () => {
    const before = hashOpenCodeDirectKeyAuthContent(JSON.stringify({ anthropic: { type: 'api', key: 'sk-ant-v1' } }));
    const after = hashOpenCodeDirectKeyAuthContent(JSON.stringify({ anthropic: { type: 'api', key: 'sk-ant-v2' } }));
    expect(before).not.toBe('');
    expect(after).not.toBe('');
    expect(before).not.toBe(after);
  });

  it('EXCLUDES the broker marker (stable, non-secret) so OAuth rotation never changes the hash', () => {
    const marker = buildOpenCodeBrokerMarker('openai', '1');
    const onlyBroker = hashOpenCodeDirectKeyAuthContent(JSON.stringify({ openai: { type: 'api', key: marker } }));
    expect(onlyBroker).toBe('');
  });

  it('EXCLUDES non-api entries (e.g. a legacy oauth record) — those are governed by the selection identity', () => {
    const onlyOauth = hashOpenCodeDirectKeyAuthContent(
      JSON.stringify({ openai: { type: 'oauth', access: 'a', refresh: 'r', expires: 1 } }),
    );
    expect(onlyOauth).toBe('');
  });

  it('reacts ONLY to the direct key in a mixed (broker marker + direct key) payload', () => {
    const marker = buildOpenCodeBrokerMarker('openai', '1');
    const v1 = hashOpenCodeDirectKeyAuthContent(JSON.stringify({
      openai: { type: 'api', key: marker },
      anthropic: { type: 'api', key: 'sk-ant-console-v1' },
    }));
    const v2 = hashOpenCodeDirectKeyAuthContent(JSON.stringify({
      openai: { type: 'api', key: marker },
      anthropic: { type: 'api', key: 'sk-ant-console-v2' },
    }));
    // Same marker, rotated direct key ⇒ the hash changes (driven only by the direct key).
    expect(v1).not.toBe(v2);
    // And it equals the hash of the direct key alone (the marker contributes nothing).
    const directOnly = hashOpenCodeDirectKeyAuthContent(JSON.stringify({ anthropic: { type: 'api', key: 'sk-ant-console-v1' } }));
    expect(v1).toBe(directOnly);
  });

  it('is order-independent across multiple direct keys (stable fingerprint regardless of JSON key order)', () => {
    const a = hashOpenCodeDirectKeyAuthContent(JSON.stringify({
      openai: { type: 'api', key: 'sk-openai' },
      anthropic: { type: 'api', key: 'sk-ant' },
    }));
    const b = hashOpenCodeDirectKeyAuthContent(JSON.stringify({
      anthropic: { type: 'api', key: 'sk-ant' },
      openai: { type: 'api', key: 'sk-openai' },
    }));
    expect(a).toBe(b);
  });

  it('never embeds the raw key bytes in the hash output', () => {
    const key = 'sk-ant-super-secret-value';
    const hash = hashOpenCodeDirectKeyAuthContent(JSON.stringify({ anthropic: { type: 'api', key } }));
    expect(hash).not.toContain(key);
    expect(hash).toMatch(/^[0-9a-f]{64}$/u);
  });
});
