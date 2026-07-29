import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { defineConfig, mergeConfig } from 'vitest/config';

import rootConfig from '../../vitest.config';

export default mergeConfig(rootConfig, defineConfig({
  resolve: {
    alias: [{
      find: /^@happier-dev\/protocol$/,
      replacement: resolve(fileURLToPath(new URL('.', import.meta.url)), '../protocol/src/index.ts'),
    }],
  },
}));
