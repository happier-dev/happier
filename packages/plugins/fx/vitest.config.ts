import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

import cliConfig from '../../../apps/cli/vitest.config';

// FX's integration tests exercise the real host ACP composer and use its
// canonical source resolution and OS/process test boundaries.
export default defineConfig({
  ...cliConfig,
  root: fileURLToPath(new URL('../../../apps/cli/', import.meta.url)),
  test: {
    ...cliConfig.test,
    include: [fileURLToPath(new URL('./src/**/*.test.ts', import.meta.url))],
  },
});
