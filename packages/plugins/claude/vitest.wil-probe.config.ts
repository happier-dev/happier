import { resolve } from 'node:path';
import config from './vitest.config';
import { createWorkspacePackageSourcesPlugin } from '../../../scripts/testing/vitestWorkspacePackageResolution';

// This stdio boundary does not load the CLI's packaged runtime/plugin registry.
export default {
  ...config,
  plugins: [
    ...(config.plugins ?? []),
    createWorkspacePackageSourcesPlugin([
      { packageName: '@happier-dev/sdk', packageSourceRoot: resolve(__dirname, '../../sdk/src') },
      { packageName: '@happier-dev/cli-common', packageSourceRoot: resolve(__dirname, '../../cli-common/src') },
    ]),
  ],
  resolve: {
    ...config.resolve,
    alias: [
      ...(config.resolve?.alias ?? []).filter(alias => alias.find !== '@'),
      { find: '@', replacement: resolve(__dirname, '../../../apps/cli/src') },
    ],
  },
  test: {
    ...config.test,
    // Match the CLI owner's filesystem/process lane (apps/cli/vitest.config.ts).
    testTimeout: 30_000,
    setupFiles: [],
    include: [
      'apps/cli/src/daemon/spawn/resolveSpawnChildEnvironment.mcpSelection.test.ts',
      'apps/cli/src/agent/runtime/createSessionMetadata.test.ts',
      'apps/cli/src/mcp/servers/probeMcpStdioServerTools.test.ts',
      'apps/cli/src/agent/executionRuns/policy/executionRunPermissionDecision.handsOff.test.ts',
      'apps/cli/src/api/machine/resolveExecutionRunAccountSettingsSnapshot.test.ts',
      'apps/cli/src/mcp/servers/materializeMcpServerConfigRecord.test.ts',
      'apps/cli/src/mcp/runtime/resolveRunnerMcpServers.composed.test.ts',
      'apps/cli/src/mcp/runtime/resolveRunnerMcpServers.runBinding.test.ts',
      'apps/cli/src/agent/runtime/bridges/executionRun/runtime/openInputs.test.ts',
      'apps/cli/src/agent/runtime/bridges/executionRun/resolveExecutionRunResumeBackendOptions.test.ts',
      'apps/cli/src/agent/runtime/bridges/executionRun/startExecutionRun.test.ts',
      'apps/cli/src/agent/runtime/registry/engineRegistry/runtimeCore.sessionOwnedRun.test.ts',
      'apps/cli/src/daemon/workflows/sessionStepExecutor.test.ts',
      'apps/cli/src/daemon/workflows/executionRunStepExecutor.test.ts',
    ],
  },
};
