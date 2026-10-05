import { resolveVitestWorkers } from '../../../scripts/testing/vitestWorkers';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { defineConfig } from 'vitest/config';

import { createWorkspacePackageSourcesPlugin } from '../../../scripts/testing/vitestWorkspacePackageResolution';

const packageRoot = fileURLToPath(new URL('.', import.meta.url));

export default defineConfig({
  root: packageRoot,
  plugins: [createWorkspacePackageSourcesPlugin([
    { packageName: '@happier-dev/plugin-sdk', packageSourceRoot: resolve(packageRoot, '../../plugin-sdk/src') },
    { packageName: '@happier-dev/protocol', packageSourceRoot: resolve(packageRoot, '../../protocol/src') },
    { packageName: '@happier-dev/agents', packageSourceRoot: resolve(packageRoot, '../../agents/src') },
    { packageName: '@happier-dev/cli-common', packageSourceRoot: resolve(packageRoot, '../../cli-common/src') },
  ], 'happier-xai-workspace-package-sources')],
  test: {
    ...resolveVitestWorkers(),
    environment: 'node',
    include: ['src/**/*.{spec,test}.{ts,tsx}'],
    env: { HAPPIER_FEATURE_POLICY_ENV: '' },
    server: {
      deps: { inline: [/^@happier-dev\/(?:plugin-sdk|protocol)(?:\/|$)/] },
    },
  },
});
