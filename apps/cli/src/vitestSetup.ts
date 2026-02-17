import { mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Many CLI tests touch persistence under `HAPPIER_HOME_DIR`. Our `.env.integration-test`
// sets a shared value, which can cause cross-process races when Vitest runs with multiple
// workers. Provide a per-process default home directory instead; individual tests may
// still override `process.env.HAPPIER_HOME_DIR` and call `vi.resetModules()` as needed.
const defaultHomeDir = join(tmpdir(), `happier-dev-test-${process.pid}`);
process.env.HAPPIER_HOME_DIR = defaultHomeDir;
mkdirSync(defaultHomeDir, { recursive: true });

// CLI tests should not inherit embedded build-policy gating (set in CI).
// Clear it by default so feature tests can opt-in explicitly per case.
process.env.HAPPIER_FEATURE_POLICY_ENV = '';
