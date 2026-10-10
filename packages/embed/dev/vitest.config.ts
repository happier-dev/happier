import { defineConfig } from 'vitest/config';
import pluginSdkConfig from '../../plugin-sdk/vitest.config';

// Exercise the fixture against current SDK/Protocol source, not packaged builds.
export default defineConfig({
  ...pluginSdkConfig,
  test: { ...pluginSdkConfig.test, environment: 'node', include: ['fixture.test.mjs'] },
});
