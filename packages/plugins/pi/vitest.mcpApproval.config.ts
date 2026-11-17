import { defineConfig } from 'vitest/config';
import inMemoryConfig from '../../../apps/cli/vitest.inMemory.config';

// Native source tests share the host's complete workspace source resolver.
export default defineConfig({
  ...inMemoryConfig,
  test: {
    ...inMemoryConfig.test,
    include: [
      'src/agent/tools/mcpToolPolicy.contract.test.ts',
      'src/agent/runtime/rpc/operations.test.ts',
      'src/agent/runtime/rpc/gatewayFailure.native.test.ts',
    ],
  },
});
