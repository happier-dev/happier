import { defineConfig } from 'vitest/config';

import integrationConfig from './vitest.integration.config';

// Source integration exercises current workspace providers through the same
// resolver as unit tests. Native custody remains a prerequisite; packaged CLI
// subprocess tests use vitest.integration.config.ts and its full setup.
export default defineConfig({
  ...integrationConfig,
  test: {
    ...integrationConfig.test,
    globalSetup: ['./src/test-setup.unit.ts'],
  },
});
