import { defineConfig } from 'vitest/config';
import config from './vitest.config';

// Native agent tests exercise public host ports and do not load React Native.
export default defineConfig({
  ...config,
  test: {
    ...config.test,
    setupFiles: [],
    include: ['src/agent/**/*.test.ts', 'src/agentSettings/**/*.test.ts'],
  },
});
