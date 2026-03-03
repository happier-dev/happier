function envFlag(env, name, fallback) {
  const raw = (env && typeof env === 'object' ? env[name] : undefined);
  const value = typeof raw === 'string' ? raw.trim().toLowerCase() : '';
  if (!value) return fallback;
  if (['1', 'true', 'yes', 'y', 'on'].includes(value)) return true;
  if (['0', 'false', 'no', 'n', 'off'].includes(value)) return false;
  return fallback;
}

export function shouldRunRealIntegrationTests(env) {
  return envFlag(env, 'HAPPIER_STACK_RUN_REAL_INTEGRATION_TESTS', false);
}

export function splitRealIntegrationTests(testFiles) {
  const real = [];
  const regular = [];
  for (const file of testFiles) {
    if (String(file).endsWith('.real.integration.test.mjs')) real.push(file);
    else regular.push(file);
  }
  return { regular, real };
}

