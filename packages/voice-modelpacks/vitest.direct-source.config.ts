import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { defineConfig, mergeConfig } from 'vitest/config';

import rootConfig from '../../vitest.config';
import { createWorkspacePackageSourcesPlugin } from '../../scripts/testing/vitestWorkspacePackageResolution.ts';

const packageRoot = fileURLToPath(new URL('.', import.meta.url));

export default mergeConfig(rootConfig, defineConfig({
  plugins: [createWorkspacePackageSourcesPlugin([
    {
      packageName: '@happier-dev/protocol',
      packageSourceRoot: resolve(packageRoot, '../protocol/src'),
    },
  ], 'happier-voice-modelpacks-workspace-package-sources')],
}));
