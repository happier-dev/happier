import { defineConfig } from 'vitest/config';
import { workspacePackageOptimizationExcludes, workspacePackageSourcesPlugin } from '../../../apps/cli/scripts/vitestWorkspacePackageResolution';

export default defineConfig({
  test: { environment: 'node', include: ['src/**/*.test.ts'] },
  optimizeDeps: { exclude: workspacePackageOptimizationExcludes },
  plugins: [workspacePackageSourcesPlugin],
});
