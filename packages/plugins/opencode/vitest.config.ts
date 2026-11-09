import { defineConfig } from 'vitest/config';
import sdkConfig from '../../plugin-sdk/vitest.config';

export default defineConfig({
  plugins: sdkConfig.plugins,
  test: {
    include: ['src/**/*.test.ts'],
    exclude: [
      'src/agent/mcpToolPolicy.contract.test.ts',
      'src/agent/runtime/server/runtime.test.ts',
      'src/agent/runtime/server/openCodeServerClient.test.ts',
    ],
  },
});
