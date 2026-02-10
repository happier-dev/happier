import { describe, expect, it } from 'vitest';

import { validateNormalizedToolFixturesV2 } from './validateToolSchemas';

describe('validateNormalizedToolFixturesV2', () => {
  it('fails closed for unsupported protocols in tool-call fixtures', () => {
    const res = validateNormalizedToolFixturesV2({
      fixturesExamples: {
        'weird/prov/tool-call/x': [{ kind: 'tool-call', payload: { name: 'Read', input: {} } }],
      },
    });
    expect(res.ok).toBe(false);
    if (res.ok) throw new Error('expected schema validation failure');
    expect(res.reason).toContain('unsupported protocol');
  });

  it('fails closed for unsupported protocols in tool-result fixtures', () => {
    const res = validateNormalizedToolFixturesV2({
      fixturesExamples: {
        'weird/prov/tool-result/x': [{ kind: 'tool-result', payload: { output: {} } }],
      },
    });
    expect(res.ok).toBe(false);
    if (res.ok) throw new Error('expected schema validation failure');
    expect(res.reason).toContain('unsupported protocol');
  });

  it('fails on malformed permission-request payloads for normalized protocols', () => {
    const res = validateNormalizedToolFixturesV2({
      fixturesExamples: {
        'acp/opencode/permission-request/bash': [{ kind: 'permission-request', payload: { foo: 'bar' } }],
      },
    });
    expect(res.ok).toBe(false);
    if (res.ok) throw new Error('expected schema validation failure');
    expect(res.reason).toContain('permission-request');
  });

  it('reports multiple validation failures with event location context', () => {
    const res = validateNormalizedToolFixturesV2({
      fixturesExamples: {
        'acp/opencode/tool-call/bad': [{ kind: 'tool-call', payload: { name: 'Read', input: {} } }],
        'acp/opencode/tool-result/bad': [{ kind: 'tool-result', payload: { output: {} } }],
      },
    });
    expect(res.ok).toBe(false);
    if (res.ok) throw new Error('expected schema validation failure');
    expect(res.reason).toContain('acp/opencode/tool-call/bad');
    expect(res.reason).toContain('acp/opencode/tool-result/bad');
    expect(res.reason).toContain('[#0]');
  });
});
