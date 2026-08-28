import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { defineConfig } from 'vitest/config';

import {
  createWorkspacePackageSourcesPlugin,
  type WorkspacePackageSpec,
} from '../../../scripts/testing/vitestWorkspacePackageResolution';

const packageRoot = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(packageRoot, '../../..');

const workspacePackages: readonly WorkspacePackageSpec[] = [
  {
    packageName: '@happier-dev/channels-protocol',
    packageSourceRoot: resolve(repoRoot, 'packages/channels-protocol/src'),
  },
  {
    packageName: '@happier-dev/plugin-sdk',
    packageSourceRoot: resolve(repoRoot, 'packages/plugin-sdk/src'),
  },
  {
    packageName: '@happier-dev/protocol',
    packageSourceRoot: resolve(repoRoot, 'packages/protocol/src'),
  },
];

/** Source-only provider checks must not resolve stale copied SDK/Protocol packages. */
export default defineConfig({
  plugins: [createWorkspacePackageSourcesPlugin(workspacePackages)],
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
    exclude: ['node_modules/**', 'dist/**'],
  },
});
