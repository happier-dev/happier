import assert from 'node:assert/strict';
import { availableParallelism } from 'node:os';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { createVitest } from 'vitest/node';
const { resolveVitestWorkers } = createRequire(import.meta.url)('./vitestWorkers.ts');

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const configs = [
  'vitest.config.ts',
  'apps/ui/vitest.config.ts',
  'apps/cli/vitest.config.ts',
  'apps/bootstrap/vitest.config.ts',
  'apps/server/vitest.config.ts',
  'apps/server/vitest.dbcontract.config.ts',
  'apps/ui/vitest.artifact-cache.config.ts',
  'apps/cli/vitest.slow.config.ts',
  'apps/cli/vitest.x1.config.ts',
  'packages/agents/vitest.config.ts',
  'packages/connection-supervisor/vitest.config.ts',
  'packages/embed/vitest.config.ts',
  'packages/plugin-sdk/vitest.source.config.ts',
  'packages/plugin-sdk/vitest.external-fixture.config.ts',
  'packages/plugin-ui/vitest.config.ts',
  'packages/privacy-kit/vitest.config.ts',
  'packages/sdk/vitest.config.ts',
  'packages/session-core/vitest.config.ts',
  'packages/support/vitest.config.ts',
  'packages/sync-client/vitest.config.ts',
  'packages/triage-sources/vitest.config.ts',
  'packages/protocol/vitest.audit-p1.config.ts',
  'packages/tests/vitest.core.config.ts',
  'packages/tests/vitest.agents.config.ts',
  'packages/tests/vitest.qa-fixtures.config.ts',
  'packages/plugins/channel-discord/vitest.config.ts',
  'packages/plugins/channel-telegram/vitest.config.ts',
  'packages/plugins/channels/vitest.config.ts',
  'packages/plugins/claude/vitest.config.ts',
  'packages/plugins/elevenlabs/vitest.config.ts',
  'packages/plugins/inspector/vitest.config.ts',
  'packages/plugins/openai/vitest.config.ts',
  'packages/plugins/posthog/vitest.config.ts',
  'packages/plugins/scm-azure-devops/vitest.config.ts',
  'packages/plugins/scm-bitbucket/vitest.config.ts',
  'packages/plugins/scm-git/vitest.config.ts',
  'packages/plugins/scm-github/vitest.config.ts',
  'packages/plugins/scm-gitlab/vitest.config.ts',
  'packages/plugins/sentry/vitest.config.ts',
  'packages/plugins/triage/vitest.config.ts',
  'packages/plugins/xai/vitest.config.ts',
  'packages/tests/vitest.core.fast.config.ts',
  'packages/plugin-sdk/vitest.facade-current.config.ts',
];

test('ordinary source test pools share the bounded default and honor an explicit override', async () => {
  const previous = process.env.HAPPIER_VITEST_MAX_WORKERS;
  const previousUi = process.env.VITEST_UI_MAX_FORKS;
  const externalKeys = ['HAPPIER_VITEST_GOVERNOR_MAX_WORKERS', 'VITEST_MAX_FORKS', 'VITEST_MIN_FORKS', 'VITEST_MAX_THREADS', 'VITEST_MIN_THREADS'];
  const externalValues = externalKeys.map(key => [key, process.env[key]]);
  for (const key of externalKeys) delete process.env[key];
  delete process.env.VITEST_UI_MAX_FORKS;
  try {
    for (const override of [undefined, '2']) {
      if (override === undefined) delete process.env.HAPPIER_VITEST_MAX_WORKERS;
      else process.env.HAPPIER_VITEST_MAX_WORKERS = override;
      for (const config of configs) {
        const ctx = await createVitest('test', {
          config: resolve(repoRoot, config),
          root: dirname(resolve(repoRoot, config)),
          watch: false,
          include: [],
        });
        try {
          const expected = override === undefined
            ? Math.max(1, Math.min(4, Math.floor(availableParallelism() / 2)))
            : 2;
          // Vitest 3.2.4 gives a pool-specific setting precedence over maxWorkers.
          // Inspect the actual loaded configuration so an inherited six-fork
          // bypass cannot pass a helper-only test.
          const actual = ctx.config.poolOptions?.forks?.maxForks
            ?? ctx.config.maxWorkers
            ?? Math.max(availableParallelism() - 1, 1);
          assert.equal(actual, expected, `${config}: effective worker maximum`);
          assert.equal(ctx.config.minWorkers, 1, `${config}: lazy worker minimum`);
        } finally {
          await ctx.close();
        }
      }
    }
  } finally {
    if (previous === undefined) delete process.env.HAPPIER_VITEST_MAX_WORKERS;
    else process.env.HAPPIER_VITEST_MAX_WORKERS = previous;
    if (previousUi === undefined) delete process.env.VITEST_UI_MAX_FORKS;
    else process.env.VITEST_UI_MAX_FORKS = previousUi;
    for (const [key, value] of externalValues) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

test('worker overrides are explicit and the legacy UI allocation is not clamped', () => {
  const expected = Math.max(1, Math.min(4, Math.floor(availableParallelism() / 2)));
  for (const invalid of ['', '0', '-1', '1.5', '2oops']) {
    assert.equal(resolveVitestWorkers({ env: { HAPPIER_VITEST_MAX_WORKERS: invalid } }).maxWorkers, expected);
  }
  assert.equal(resolveVitestWorkers({ env: { CI: 'true' } }).maxWorkers, expected);
  const env = { VITEST_UI_MAX_FORKS: '20' };
  assert.equal(resolveVitestWorkers({ env }).maxWorkers, expected);
  assert.equal(resolveVitestWorkers({ env, legacyUiOverride: true }).maxWorkers, 20);
  assert.equal(resolveVitestWorkers({ env: { ...env, HAPPIER_VITEST_MAX_WORKERS: '2' }, legacyUiOverride: true }).maxWorkers, 2);
  assert.equal(resolveVitestWorkers({ env: { ...env, HAPPIER_VITEST_GOVERNOR_MAX_WORKERS: '1' }, legacyUiOverride: true }).maxWorkers, 20);
  assert.equal(resolveVitestWorkers({ env: { HAPPIER_VITEST_GOVERNOR_MAX_WORKERS: 'invalid' } }).maxWorkers, expected);
});

test('the governor can reduce package workers without widening policy or explicit overrides', async () => {
  const keys = ['HAPPIER_VITEST_GOVERNOR_MAX_WORKERS', 'HAPPIER_VITEST_MAX_WORKERS', 'VITEST_UI_MAX_FORKS',
    'VITEST_MAX_FORKS', 'VITEST_MIN_FORKS', 'VITEST_MAX_THREADS', 'VITEST_MIN_THREADS'];
  const previous = keys.map(key => [key, process.env[key]]);
  try {
    for (const key of keys) delete process.env[key];
    for (const [budget, override, expected] of [
      ['2', undefined, Math.min(2, Math.max(1, Math.min(4, Math.floor(availableParallelism() / 2))))],
      ['13', undefined, Math.max(1, Math.min(4, Math.floor(availableParallelism() / 2)))],
      ['13', '2', 2],
      ['2', '6', 6],
    ]) {
      process.env.HAPPIER_VITEST_GOVERNOR_MAX_WORKERS = budget;
      if (override === undefined) delete process.env.HAPPIER_VITEST_MAX_WORKERS;
      else process.env.HAPPIER_VITEST_MAX_WORKERS = override;
      const ctx = await createVitest('test', {
        config: resolve(repoRoot, 'apps/ui/vitest.config.ts'),
        root: resolve(repoRoot, 'apps/ui'), watch: false, include: [],
      });
      try {
        assert.equal(ctx.config.poolOptions?.forks?.maxForks ?? ctx.config.maxWorkers, expected,
          `effective UI workers for governor=${budget}, override=${override}`);
      } finally {
        await ctx.close();
      }
    }
  } finally {
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

test('explicitly serial lanes remain serial even with a larger worker override', async () => {
  const previous = process.env.HAPPIER_VITEST_MAX_WORKERS;
  process.env.HAPPIER_VITEST_MAX_WORKERS = '8';
  try {
    for (const config of [
      'apps/cli/vitest.integration.config.ts',
      'apps/ui/vitest.integration.config.ts',
      'apps/server/vitest.integration.config.ts',
      'packages/plugin-sdk/vitest.config.ts',
      'packages/channels-protocol/vitest.config.ts',
      'packages/triage-protocol/vitest.config.ts',
    ]) {
      const ctx = await createVitest('test', { config: resolve(repoRoot, config), root: dirname(resolve(repoRoot, config)), watch: false, include: [] });
      try {
        const serial = ctx.config.fileParallelism === false
          || (ctx.config.pool === 'forks' && ctx.config.poolOptions?.forks?.singleFork === true)
          || (ctx.config.pool === 'threads' && ctx.config.poolOptions?.threads?.singleThread === true);
        assert.equal(serial, true, `${config}: serial execution contract`);
      } finally {
        await ctx.close();
      }
    }
  } finally {
    if (previous === undefined) delete process.env.HAPPIER_VITEST_MAX_WORKERS;
    else process.env.HAPPIER_VITEST_MAX_WORKERS = previous;
  }
});
