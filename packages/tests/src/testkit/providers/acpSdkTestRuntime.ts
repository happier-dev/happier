import { createRequire } from 'node:module';
import { resolve } from 'node:path';

export function resolveAcpSdkTestRuntime(repoRoot: string): Readonly<{
  sdkEntry: string;
  agentAppAdapterEntry: string;
}> {
  const requireFromHere = createRequire(import.meta.url);
  return {
    sdkEntry: requireFromHere.resolve('@agentclientprotocol/sdk', {
      paths: [resolve(repoRoot, 'apps/cli')],
    }),
    agentAppAdapterEntry: resolve(repoRoot, 'packages/tests/fixtures/acp-test-agent-app-adapter.mjs'),
  };
}
