import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';

describe('reviewEngines', () => {
  it('does not expose a host-native review engine fallback API', () => {
    const source = readFileSync(new URL('./reviewEngines.ts', import.meta.url), 'utf8');

    expect(source).not.toContain(['Native', 'ReviewEngine'].join(''));
    expect(source).not.toContain(['list', 'Native', 'ReviewEngines'].join(''));
    expect(source).not.toContain(['get', 'Native', 'ReviewEngine'].join(''));
  });
});
