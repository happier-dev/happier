import { existsSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

describe('gemini execution-run legacy registry', () => {
  it('does not keep a legacy built-in execution-run registry module', () => {
    expect(existsSync(new URL('./registry/executionRunBackendRegistry.ts', import.meta.url))).toBe(false);
  });
});
