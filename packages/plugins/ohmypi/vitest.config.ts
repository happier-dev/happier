import { resolve } from 'node:path';
import { configDefaults, defineConfig } from 'vitest/config';
import { createWorkspacePackageSourcesPlugin } from '../../../scripts/testing/vitestWorkspacePackageResolution';
import { resolveVitestWorkers } from '../../../scripts/testing/vitestWorkers';

export default defineConfig({
  plugins: [createWorkspacePackageSourcesPlugin([
    { packageName: '@happier-dev/plugins-muse', packageSourceRoot: resolve(__dirname, '../muse/src') },
    { packageName: '@happier-dev/plugins-kimi', packageSourceRoot: resolve(__dirname, '../kimi/src') },
    { packageName: '@happier-dev/plugins-grok', packageSourceRoot: resolve(__dirname, '../grok/src') },
    { packageName: '@happier-dev/plugins-gemini', packageSourceRoot: resolve(__dirname, '../gemini/src') },
    { packageName: '@happier-dev/plugins-scm-github', packageSourceRoot: resolve(__dirname, '../scm-github/src') },

    { packageName: '@happier-dev/deployment-protocol', packageSourceRoot: resolve(__dirname, '../../deployment-protocol/src') },
    { packageName: '@happier-dev/cli-common', packageSourceRoot: resolve(__dirname, '../../cli-common/src') },
    { packageName: '@happier-dev/plugin-sdk', packageSourceRoot: resolve(__dirname, '../../plugin-sdk/src') },
    { packageName: '@happier-dev/protocol', packageSourceRoot: resolve(__dirname, '../../protocol/src') },
    { packageName: '@happier-dev/agents', packageSourceRoot: resolve(__dirname, '../../agents/src') },
  ])],
  test: { ...resolveVitestWorkers(), environment: 'node', exclude: [...configDefaults.exclude, '.project/**'] },
});
