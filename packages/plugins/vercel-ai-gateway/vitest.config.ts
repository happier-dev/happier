import { fileURLToPath } from 'node:url';
import { mergeConfig, defineConfig } from 'vitest/config';
import rootConfig from '../../../vitest.config';
import { createWorkspacePackageSourcesPlugin } from '../../../scripts/testing/vitestWorkspacePackageResolution';

export default mergeConfig(rootConfig, defineConfig({
  root: fileURLToPath(new URL('../../..', import.meta.url)),
  plugins: [createWorkspacePackageSourcesPlugin([
    { packageName: '@happier-dev/plugin-sdk', packageSourceRoot: fileURLToPath(new URL('../../plugin-sdk/src', import.meta.url)) },
    { packageName: '@happier-dev/protocol', packageSourceRoot: fileURLToPath(new URL('../../protocol/src', import.meta.url)) },
  ], 'vercel-provider-source-packages')],
  resolve: { conditions: ['happier-source'] },
  test: { include: ['packages/plugins/vercel-ai-gateway/src/**/*.test.ts'],
    server: { deps: { inline: [/^@happier-dev\/plugin-sdk(?:\/|$)/, /^@happier-dev\/protocol(?:\/|$)/] } } },
}));
