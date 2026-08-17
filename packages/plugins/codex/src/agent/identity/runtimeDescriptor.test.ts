import { existsSync, readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

describe('Codex runtime identity ownership', () => {
  it('keeps raw Session metadata parsing exclusively in the generated host owner', () => {
    const packageJson = JSON.parse(
      readFileSync(new URL('../../../package.json', import.meta.url), 'utf8'),
    ) as Readonly<{ exports?: Readonly<Record<string, unknown>> }>;

    expect(packageJson.exports).not.toHaveProperty('./agent/identity/runtimeDescriptor');
    expect(packageJson.exports).not.toHaveProperty('./agent/surfaces/sessions/controls/adapter');
    expect(existsSync(new URL('./runtimeDescriptor.ts', import.meta.url))).toBe(false);
    expect(existsSync(new URL('../surfaces/sessions/controls/adapter.ts', import.meta.url))).toBe(false);
  });
});
