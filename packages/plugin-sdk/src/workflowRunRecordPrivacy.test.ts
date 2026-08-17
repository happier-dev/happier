import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';

import { describe, expect, it } from 'vitest';

describe('workflow-run record authority privacy', () => {
  it('does not publish the host workflow-run record port through the SDK package', async () => {
    const packageJson = JSON.parse(
      await readFile(new URL('../package.json', import.meta.url), 'utf8'),
    ) as Readonly<{ exports: Readonly<Record<string, unknown>> }>;

    expect(
      packageJson.exports['./host/agent-runtime/workflow-run-record-port'],
    ).toBeUndefined();
    expect(() => createRequire(import.meta.url).resolve(
      '@happier-dev/plugin-sdk/host/agent-runtime/workflow-run-record-port',
    )).toThrow();
  });
});
