import { describe, expect, it } from 'vitest';

import { resolveCanonicalCodexBackendMode } from './codexBackendMode.js';

describe('resolveCanonicalCodexBackendMode', () => {
  it('normalizes legacy Codex backend aliases from explicit requests', () => {
    expect(resolveCanonicalCodexBackendMode({
      codexBackendMode: '  mcp_resume  ',
    })).toBe('acp');
  });
});
