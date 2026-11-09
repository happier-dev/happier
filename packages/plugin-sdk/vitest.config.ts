import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';
import { createWorkspacePackageSourcesPlugin } from '../../scripts/testing/vitestWorkspacePackageResolution';

const sourceRoot = (name: string) => fileURLToPath(new URL(`../${name}/src`, import.meta.url));

export const PLUGIN_SDK_AUTHORED_TEST_INCLUDE = ['src/**/*.test.ts'] as const;

export default defineConfig({
    plugins: [createWorkspacePackageSourcesPlugin([
        { packageName: '@happier-dev/protocol', packageSourceRoot: sourceRoot('protocol') },
        { packageName: '@happier-dev/deployment-protocol', packageSourceRoot: sourceRoot('deployment-protocol') },
        { packageName: '@happier-dev/agents', packageSourceRoot: sourceRoot('agents') },
        { packageName: '@happier-dev/cli-common', packageSourceRoot: sourceRoot('cli-common') },
        { packageName: '@happier-dev/release-runtime', packageSourceRoot: sourceRoot('release-runtime') },
        { packageName: '@happier-dev/email-transports-protocol', packageSourceRoot: sourceRoot('email-transports-protocol') },
        { packageName: '@happier-dev/forge-ci', packageSourceRoot: sourceRoot('forge-ci') },
        { packageName: '@happier-dev/plugin-ui', packageSourceRoot: sourceRoot('plugin-ui') },
        { packageName: '@happier-dev/channels-protocol', packageSourceRoot: sourceRoot('channels-protocol') },
        { packageName: '@happier-dev/triage-protocol', packageSourceRoot: sourceRoot('triage-protocol') },
        { packageName: '@happier-dev/triage-sources', packageSourceRoot: sourceRoot('triage-sources') },
        { packageName: '@happier-dev/plugin-sdk', packageSourceRoot: sourceRoot('plugin-sdk') },
    ])],
    test: {
        setupFiles: ['./src/ui/configureZodLocale.ts'],
        // Package-local publishers can hold complete `.tmp.*` copies beside
        // `src` while a prepared reader runs. Only the authored source tree
        // owns this Vitest lane; copied package trees and example builds have
        // their own explicit package-boundary tests.
        include: [...PLUGIN_SDK_AUTHORED_TEST_INCLUDE],
        exclude: ['src/declarationClosureIdentity.test.ts'],
        // Several authored suites construct complete TypeScript programs or
        // run real bundlers. Parallel files multiply those subprocesses until
        // their bounded commands time out and Vitest's worker RPC stalls.
        fileParallelism: false,
    },
});
