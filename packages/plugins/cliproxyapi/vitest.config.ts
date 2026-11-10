import { fileURLToPath } from 'node:url';
import { defineConfig, mergeConfig } from 'vitest/config';

import rootConfig from '../../../vitest.config';
import { createWorkspacePackageSourcesPlugin } from '../../../scripts/testing/vitestWorkspacePackageResolution';

export default mergeConfig(rootConfig, defineConfig({
  root: fileURLToPath(new URL('../../..', import.meta.url)),
  plugins: [createWorkspacePackageSourcesPlugin([
    { packageName: '@happier-dev/plugins-grok', packageSourceRoot: fileURLToPath(new URL('../grok/src', import.meta.url)) },
    { packageName: '@happier-dev/plugin-sdk', packageSourceRoot: fileURLToPath(new URL('../../plugin-sdk/src', import.meta.url)) },
    { packageName: '@happier-dev/protocol', packageSourceRoot: fileURLToPath(new URL('../../protocol/src', import.meta.url)) },
  ], 'cliproxyapi-provider-source-packages')],
  resolve: { conditions: ['happier-source'] },
  test: {
    include: ['packages/plugins/cliproxyapi/src/**/*.test.ts'],
    server: { deps: { inline: [/^@happier-dev\/plugin-sdk(?:\/|$)/, /^@happier-dev\/protocol(?:\/|$)/] } },
  },
}));
