import { defineConfig } from 'vitest/config';

import cliConfig from './vitest.config';

// Source compositions that open no native process need no distribution/custody.
export default defineConfig({
  ...cliConfig,
  test: {
    ...cliConfig.test,
    setupFiles: cliConfig.test?.setupFiles,
    globalSetup: [],
  },
});
