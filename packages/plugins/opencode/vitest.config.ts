import { defineConfig } from 'vitest/config';
import sdkConfig from '../../plugin-sdk/vitest.config';

export default defineConfig({
  plugins: sdkConfig.plugins,
  test: { include: ['src/**/*.test.ts'] },
});
