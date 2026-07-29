import { access } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { resolveAcpSdkTestRuntime } from './acpSdkTestRuntime';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../../../..');

describe('resolveAcpSdkTestRuntime', () => {
  it('resolves the SDK public package root and the shared AgentApp adapter', async () => {
    const runtime = resolveAcpSdkTestRuntime(repoRoot);
    const requireFromHere = createRequire(import.meta.url);

    expect(runtime.sdkEntry).toBe(requireFromHere.resolve('@agentclientprotocol/sdk', {
      paths: [resolve(repoRoot, 'apps/cli')],
    }));
    expect(() => requireFromHere.resolve('@agentclientprotocol/sdk/dist/acp.js', {
      paths: [resolve(repoRoot, 'apps/cli')],
    })).toThrow();
    await expect(access(runtime.sdkEntry)).resolves.toBeUndefined();
    await expect(access(runtime.agentAppAdapterEntry)).resolves.toBeUndefined();
  });
});
