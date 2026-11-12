import { resolveVitestWorkers } from '../../../scripts/testing/vitestWorkers';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { defineConfig } from 'vitest/config';

import { createWorkspacePackageSourcesPlugin, readHostWorkspacePackageSpecs } from '../../../scripts/testing/vitestWorkspacePackageResolution';

const repoRoot = fileURLToPath(new URL('../../..', import.meta.url));
const packageRoot = fileURLToPath(new URL('.', import.meta.url));

export default defineConfig({
  root: packageRoot,
  resolve: {
    alias: { '@': resolve(packageRoot, '../../../apps/ui/sources') },
  },
  plugins: [createWorkspacePackageSourcesPlugin(
    readHostWorkspacePackageSpecs(repoRoot, packageRoot),
    'happier-elevenlabs-workspace-package-sources',
  )],
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
