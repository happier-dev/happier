import { existsSync, readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

describe('native Agent ACP public surface', () => {
  it('does not publish the predecessor experimental ACP package or declarations', () => {
    const packageJson = JSON.parse(
      readFileSync(new URL('../../package.json', import.meta.url), 'utf8'),
    ) as { exports?: Readonly<Record<string, unknown>> };

    expect(packageJson.exports).not.toHaveProperty('./experimental/acp');
    for (const predecessorSource of [
      '../acp/acpBackendSpec.ts',
      '../acp/acpCapabilities.ts',
      '../acp/acpTransport.ts',
      '../acp/index.ts',
      '../acp/types.ts',
    ]) {
      expect(existsSync(new URL(predecessorSource, import.meta.url)), predecessorSource).toBe(false);
    }
  });
});
