import { existsSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

describe('executionRunBackendRegistry removal', () => {
  it('does not keep a host descriptor-backed execution-run registry module', () => {
    expect(existsSync(new URL('./executionRunBackendRegistry.ts', import.meta.url))).toBe(false);
  });
});
