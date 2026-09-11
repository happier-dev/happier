import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..', '..');

test('tests workflow runs daemon integration suite on the integration lane', async () => {
  const raw = await readFile(join(repoRoot, '.github', 'workflows', 'tests.yml'), 'utf8');

  assert.match(
    raw,
    /yarn\s+--cwd\s+apps\/cli\s+-s\s+vitest\s+run\s+--config\s+vitest\.integration\.config\.ts\s+src\/daemon\/daemon\.integration\.test\.ts/,
    'tests.yml daemon e2e step should execute daemon.integration.test.ts with vitest.integration.config.ts',
  );
});

test('tests workflow runs daemon spawn/stop stress only with the local server lane', async () => {
  const raw = await readFile(join(repoRoot, '.github', 'workflows', 'tests.yml'), 'utf8');
  const optInOccurrences = raw.match(/HAPPIER_CLI_DAEMON_SPAWN_STOP_STRESS_INTEGRATION/g) ?? [];
  const genericSlowStep = raw.match(/- name: Run slow tests[\s\S]*?run: yarn workspace @happier-dev\/cli test:slow/)?.[0] ?? '';

  assert.match(
    raw,
    /HAPPIER_CLI_DAEMON_SPAWN_STOP_STRESS_INTEGRATION:\s*["']1["'][\s\S]*yarn\s+--cwd\s+apps\/cli\s+-s\s+vitest\s+run\s+--config\s+vitest\.slow\.config\.ts\s+src\/daemon\/daemon\.spawnStop\.stress\.slow\.test\.ts/,
    'tests.yml daemon e2e step should explicitly enable and run daemon spawn/stop stress while its local server is alive',
  );
  assert.equal(optInOccurrences.length, 1, 'only the local-server daemon lane should enable daemon spawn/stop stress');
  assert.doesNotMatch(
    genericSlowStep,
    /HAPPIER_CLI_DAEMON_SPAWN_STOP_STRESS_INTEGRATION/,
    'the ordinary CLI slow step has no server fixture and must not enable daemon spawn/stop stress',
  );
});

test('tests workflow creates daemon e2e credentials via pipeline script (no inline heredoc)', async () => {
  const raw = await readFile(join(repoRoot, '.github', 'workflows', 'tests.yml'), 'utf8');

  assert.match(
    raw,
    /node scripts\/pipeline\/run\.mjs testing-create-auth-credentials/,
    'tests.yml should delegate /v1/auth credentials bootstrap to the pipeline command (no direct leaf script call)',
  );

  assert.doesNotMatch(
    raw,
    /node --input-type=module - <<'NODE'[\s\S]*tweetnacl[\s\S]*\/v1\/auth/,
    'tests.yml should not embed the auth bootstrap as an inline heredoc',
  );
});
