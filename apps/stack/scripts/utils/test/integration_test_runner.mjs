import { readBooleanEnvFlag } from './test_env.mjs';
import { isIntegrationTestFile, isRealIntegrationTestFile } from './test_paths.mjs';

export const RUN_REAL_INTEGRATION_ENV_VAR = 'HAPPIER_STACK_RUN_REAL_INTEGRATION_TESTS';

export function shouldRunRealIntegrationTests(env) {
  return readBooleanEnvFlag(env, RUN_REAL_INTEGRATION_ENV_VAR, false);
}

export function splitRealIntegrationTests(testFiles) {
  const real = [];
  const regular = [];
  for (const file of testFiles) {
    if (!isIntegrationTestFile(file)) continue;
    if (isRealIntegrationTestFile(file)) real.push(file);
    else regular.push(file);
  }
  return { regular, real };
}

export function resolveIntegrationRunPlan(testFiles, env) {
  const { regular, real } = splitRealIntegrationTests(testFiles);
  return {
    regular,
    real,
    runReal: shouldRunRealIntegrationTests(env),
  };
}

export function formatRealIntegrationSkipMessage(realCount) {
  return (
    `[stack:test:integration] skipping ${realCount} real integration test file(s). ` +
    `To run them: ${RUN_REAL_INTEGRATION_ENV_VAR}=1\n`
  );
}
