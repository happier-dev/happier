import { describe, expect, it } from 'vitest';

import {
  parseArgs,
  resolveRetryScenarioIds,
  parseFailureReportJson,
  filterProviderIdsByScenarioRegistry,
  buildProviderChildEnv,
} from '../../scripts/run-providers-parallel.mjs';

describe('providers parallel run script args', () => {
  it('defaults flake retry to enabled', () => {
    const parsed = parseArgs(['node', 'run-providers-parallel.mjs', 'all', 'extended']);

    expect(parsed.flakeRetry).toBe(true);
  });

  it('parses retry options and flags', () => {
    const parsed = parseArgs([
      'node',
      'run-providers-parallel.mjs',
      'all',
      'extended',
      '--max-parallel',
      '5',
      '--update-baselines',
      '--strict-keys',
      '--flake-retry',
    ]);

    expect(parsed).toEqual({
      presetId: 'all',
      tier: 'extended',
      maxParallelRaw: '5',
      retrySerial: true,
      updateBaselines: true,
      strictKeys: true,
      flakeRetry: true,
    });
  });

  it('allows explicit flake retry opt-out', () => {
    const parsed = parseArgs(['node', 'run-providers-parallel.mjs', 'all', 'extended', '--no-flake-retry']);

    expect(parsed.flakeRetry).toBe(false);
  });

  it('disables serial retry with --no-retry-serial', () => {
    const parsed = parseArgs([
      'node',
      'run-providers-parallel.mjs',
      'all',
      'extended',
      '--no-retry-serial',
    ]);

    expect(parsed.retrySerial).toBe(false);
  });

  it('rejects unknown flags', () => {
    expect(() => parseArgs(['node', 'run-providers-parallel.mjs', 'all', 'extended', '--bad-flag'])).toThrow(
      /Unknown flag/,
    );
  });

  it('rejects conflicting flake retry flags', () => {
    expect(() =>
      parseArgs([
        'node',
        'run-providers-parallel.mjs',
        'all',
        'extended',
        '--flake-retry',
        '--no-flake-retry',
      ]),
    ).toThrow(/Conflicting flags/);
  });
});

describe('providers parallel retry selection', () => {
  it('reruns from the failed scenario to the end of the ordered tier list', () => {
    const retryIds = resolveRetryScenarioIds({
      orderedScenarioIds: ['a', 'b', 'c', 'd'],
      failedScenarioId: 'b',
    });
    expect(retryIds).toEqual(['b', 'c', 'd']);
  });

  it('returns null when failed scenario is absent from ordered list', () => {
    const retryIds = resolveRetryScenarioIds({
      orderedScenarioIds: ['a', 'b', 'c'],
      failedScenarioId: 'x',
    });
    expect(retryIds).toBeNull();
  });
});

describe('providers parallel failure report parsing', () => {
  it('parses valid report payloads', () => {
    const parsed = parseFailureReportJson(
      JSON.stringify({
        v: 1,
        providerId: 'kilo',
        scenarioId: 'read_known_file',
        error: 'Missing required fixture key: acp/kilo/tool-call/Read',
        ts: 1770000000000,
      }),
    );

    expect(parsed).toEqual({
      v: 1,
      providerId: 'kilo',
      scenarioId: 'read_known_file',
      error: 'Missing required fixture key: acp/kilo/tool-call/Read',
      ts: 1770000000000,
    });
  });

  it('rejects malformed payloads', () => {
    expect(parseFailureReportJson('')).toBeNull();
    expect(parseFailureReportJson('not-json')).toBeNull();
    expect(
      parseFailureReportJson(
        JSON.stringify({
          providerId: 'kilo',
          scenarioId: 'read_known_file',
        }),
      ),
    ).toBeNull();
  });
});

describe('providers parallel scenario registry filtering', () => {
  it('keeps only providers that declare the selected scenario in the requested tier', async () => {
    const filtered = await filterProviderIdsByScenarioRegistry({
      providerIds: ['qwen', 'kilo', 'codex'],
      tier: 'extended',
      scenarioSelectionRaw: 'acp_set_model_dynamic',
    });

    expect(filtered).toEqual(['kilo', 'codex']);
  });

  it('returns the original provider list when no scenario filter is provided', async () => {
    const filtered = await filterProviderIdsByScenarioRegistry({
      providerIds: ['qwen', 'kilo', 'codex'],
      tier: 'extended',
      scenarioSelectionRaw: '',
    });

    expect(filtered).toEqual(['qwen', 'kilo', 'codex']);
  });
});

describe('providers parallel child env defaults', () => {
  it('disables preflight CLI dist rebuilds by default to avoid parallel build churn', () => {
    const env = buildProviderChildEnv({
      baseEnv: {},
      reportPath: '/tmp/failure-report.json',
      scenarioIds: null,
    });

    expect(env.HAPPIER_E2E_PROVIDER_ALLOW_CLI_PREBUILD_REBUILD).toBe('0');
    expect(env.HAPPY_E2E_PROVIDER_ALLOW_CLI_PREBUILD_REBUILD).toBe('0');
    expect(env.HAPPIER_E2E_PROVIDER_SKIP_SERVER_GENERATE).toBe('1');
    expect(env.HAPPY_E2E_PROVIDER_SKIP_SERVER_GENERATE).toBe('1');
  });

  it('forwards explicit scenario selection into child env', () => {
    const env = buildProviderChildEnv({
      baseEnv: {},
      reportPath: '/tmp/failure-report.json',
      scenarioIds: ['read_known_file', 'search_known_token'],
    });

    expect(env.HAPPIER_E2E_PROVIDER_SCENARIOS).toBe('read_known_file,search_known_token');
    expect(env.HAPPY_E2E_PROVIDER_SCENARIOS).toBe('read_known_file,search_known_token');
  });
});
