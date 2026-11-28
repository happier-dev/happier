import { resolve } from 'node:path';
import config from '../../packages/plugins/claude/vitest.config';
import { createWorkspacePackageSourcesPlugin } from '../../scripts/testing/vitestWorkspacePackageResolution';

// Source-owner checks don't launch packaged custody runtimes. Preserve the
// package's real source resolution, setup, isolation, and boundary fixtures.
export default {
    ...config,
    plugins: [...config.plugins ?? [], createWorkspacePackageSourcesPlugin([
        { packageName: '@happier-dev/sdk', packageSourceRoot: resolve(__dirname, '../../packages/sdk/src') },
        { packageName: '@happier-dev/agents', packageSourceRoot: resolve(__dirname, '../../packages/agents/src') },
        { packageName: '@happier-dev/cli-common', packageSourceRoot: resolve(__dirname, '../../packages/cli-common') },
    ])],
    resolve: { ...config.resolve, alias: [
        ...config.resolve?.alias?.filter(alias => alias.find !== '@') ?? [],
        { find: '@', replacement: resolve(__dirname, 'src') },
    ] },
    test: { ...config.test, pool: 'forks', isolate: true, globals: false,
        setupFiles: [resolve(__dirname, '../../scripts/testing/vitestAgentSetup.mjs'), './src/vitestSetup.composed.testkit.ts'], sequence: { setupFiles: 'list' }, globalSetup: [], include: ['src/**/*.test.ts'], testTimeout: 30_000 },
};
