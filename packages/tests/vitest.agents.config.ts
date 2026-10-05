import { resolveVitestWorkers } from '../../scripts/testing/vitestWorkers';
import { defineConfig, mergeConfig } from 'vitest/config';

import { resolveVitestFeatureTestExcludeGlobs } from '../../scripts/testing/featureTestGating';
import { createUiProductionHooksVitestConfig } from './vitest.uiProductionHooks';

// The agent suites import testkit modules that reach `apps/cli/src` (for example
// the scenario catalog's Codex child-process observer), and CLI sources use the
// `@/` path alias. Resolve those imports through the same app-source alias
// plugin the core config merges; without it every catalog-importing suite fails
// at module load with `Cannot find package '@/...'`.
export default mergeConfig(createUiProductionHooksVitestConfig(), defineConfig({
  test: {
    ...resolveVitestWorkers(),
    environment: 'node',
    include: ['suites/agents/**/*.test.ts'],
    testTimeout: 600_000,
    hookTimeout: 600_000,
    // NOTE: In some sandboxed environments, worker_threads cannot bind/listen on localhost (EPERM).
    // Provider E2E contract tests start real local servers, so prefer process-based isolation.
    pool: 'forks',
    globals: false,
    exclude: [...resolveVitestFeatureTestExcludeGlobs()],
    env: {
      HAPPIER_FEATURE_POLICY_ENV: '',
    },
  },
}));
