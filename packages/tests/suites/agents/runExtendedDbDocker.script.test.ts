import { afterEach, describe, expect, it, vi } from 'vitest';
import { spawnSync } from 'node:child_process';

// Docker and Yarn are external process boundaries; exercise the real runner.
vi.mock('node:child_process', () => ({ spawnSync: vi.fn() }));

import * as runExtendedDbDockerScript from '../../scripts/run-extended-db-docker.mjs';
import { parseArgs, resolveExtendedDbCommandTimeoutMs, resolveExtendedDbStepTimeoutMs } from '../../scripts/run-extended-db-docker.mjs';
import { buildExtendedDbCommandPlan } from '../../scripts/extended-db-docker.plan.mjs';

type PnpmInvocationResolver = (
  args: readonly string[],
  options?: Readonly<{ platform?: NodeJS.Platform; npmExecPath?: string; comspec?: string }>,
) => Readonly<{ command: string; args: string[]; windowsVerbatimArguments?: boolean }>;

describe('extended-db container ownership', () => {
  const originalSignals = new Map((['SIGINT', 'SIGTERM'] as const).map(signal => [signal, process.listeners(signal)] as const));
  afterEach(() => {
    vi.mocked(spawnSync).mockReset();
    for (const [signal, original] of originalSignals) {
      for (const listener of process.listeners(signal)) if (!original.includes(listener)) process.removeListener(signal, listener);
    }
  });

  it.each([
    { db: 'postgres', keep: false },
    { db: 'mysql', keep: false },
    { db: 'postgres', keep: true },
    { db: 'mysql', keep: true },
  ])('cleans up only disposable $db containers and volumes (keep=$keep)', async ({ db, keep }) => {
    const id = 'a'.repeat(64);
    vi.mocked(spawnSync).mockImplementation((command, args) => ({
      status: 0, signal: null, pid: 1, output: [], stderr: '',
      stdout: command !== 'docker' ? '' : args?.[0] === 'run' ? id
        : args?.[0] === 'inspect' ? 'healthy' : args?.[0] === 'port' ? '127.0.0.1:54321' : '',
    }));
    await runExtendedDbDockerScript.main(['node', 'runner', '--db', db, '--mode', 'contract', '--name', 'c31-owned', ...(keep ? ['--keep'] : [])]);
    const contract = vi.mocked(spawnSync).mock.calls.find(([, args]) => Array.isArray(args) && args.includes('test:db-contract'));
    expect(contract?.[2]?.env).toMatchObject({ HAPPIER_DB_CONTRACT_CONTAINER_ID: id });
    const removals = vi.mocked(spawnSync).mock.calls.filter(([command, args]) => command === 'docker' && args?.[0] === 'rm');
    expect(removals.map(([, args]) => args)).toEqual(keep ? [] : [['rm', '-f', '-v', id]]);
  });

  it('leaves an existing same-name container alone when docker run fails', async () => {
    vi.mocked(spawnSync).mockImplementation((command, args) => ({
      status: command === 'docker' && args?.[0] === 'run' ? 1 : 0,
      signal: null, pid: 1, output: [], stdout: '', stderr: '',
    }));
    await expect(runExtendedDbDockerScript.main(['node', 'runner', '--db', 'postgres', '--name', 'c31-collision']))
      .rejects.toThrow(/Command failed/);
    expect(vi.mocked(spawnSync).mock.calls.filter(([command, args]) => command === 'docker' && args?.[0] === 'rm')
      .map(([, args]) => args)).toEqual([]);
  });

  it('runs repeated server contract file selections against one disposable database', async () => {
    const id = 'e'.repeat(64);
    const files = [
      'sources/app/teams/identity/teamIdentityConnectionLifecycle.dbcontract.spec.ts',
      'sources/app/teams/memberships/memberAdministration.dbcontract.spec.ts',
    ];
    vi.mocked(spawnSync).mockImplementation((command, args) => ({
      status: 0, signal: null, pid: 1, output: [], stderr: '',
      stdout: command !== 'docker' ? '' : args?.[0] === 'run' ? id
        : args?.[0] === 'inspect' ? 'healthy' : args?.[0] === 'port' ? '127.0.0.1:54321' : '',
    }));
    await runExtendedDbDockerScript.main(['node', 'runner', '--db', 'mysql', '--mode', 'contract',
      ...files.flatMap(file => ['--contract-file', file])]);
    const contract = vi.mocked(spawnSync).mock.calls.find(([, args]) => args?.includes('test:db-contract'));
    expect(contract?.[1]).toEqual(['--filter', '@happier-dev/server', 'run', 'test:db-contract', ...files]);
    expect(contract?.[2]?.env).toMatchObject({ HAPPIER_DB_PROVIDER: 'mysql', HAPPIER_DB_CONTRACT_CONTAINER_ID: id });
  });

  it.each([
    ['suites/core-e2e/teamSetup.D.existingClones.slow.e2e.test.ts'],
    ['suites/core-e2e/teamSetup.F.storage.slow.e2e.test.ts', 'suites/core-e2e/teamSetup.F.resources.slow.e2e.test.ts'],
  ].map(files => ({ files })))('runs the selected composed files $files against one disposable database and cleans up only its container', async ({ files }) => {
    const id = 'b'.repeat(64);
    vi.mocked(spawnSync).mockImplementation((command, args) => ({
      status: 0, signal: null, pid: 1, output: [], stderr: '',
      stdout: command !== 'docker' ? '' : args?.[0] === 'run' ? id
        : args?.[0] === 'inspect' ? 'healthy' : args?.[0] === 'port' ? '127.0.0.1:54321' : '',
    }));
    await runExtendedDbDockerScript.main(['node', 'runner', '--db', 'postgres', '--mode', 'e2e',
      ...files.flatMap(file => ['--e2e-file', file])]);
    const focused = vi.mocked(spawnSync).mock.calls.find(([, args]) => args?.includes(files[0]));
    expect(focused?.[1]).toEqual(['--filter', '@happier-dev/tests', 'exec', 'node',
      'scripts/run-vitest-with-heartbeat.mjs', '--config', 'vitest.core.slow.config.ts', ...files]);
    expect(focused?.[2]?.env).toMatchObject({
      HAPPIER_E2E_DB_PROVIDER: 'postgres',
      DATABASE_URL: 'postgresql://happier:happier@127.0.0.1:54321/happier?sslmode=disable',
    });
    const removals = vi.mocked(spawnSync).mock.calls.filter(([command, args]) => command === 'docker' && args?.[0] === 'rm');
    expect(removals.map(([, args]) => args)).toEqual([['rm', '-f', '-v', id]]);
  });

  it('runs selected browser flows with disposable PostgreSQL through the existing Playwright owner', async () => {
    const id = 'c'.repeat(64);
    const file = 'suites/ui-e2e/automations.authoring.feat.automations.spec.ts';
    vi.mocked(spawnSync).mockImplementation((command, args) => ({
      status: 0, signal: null, pid: 1, output: [], stderr: '',
      stdout: command !== 'docker' ? '' : args?.[0] === 'run' ? id
        : args?.[0] === 'inspect' ? 'healthy' : args?.[0] === 'port' ? '127.0.0.1:54321' : '',
    }));
    await runExtendedDbDockerScript.main(['node', 'runner', '--db', 'postgres', '--mode', 'ui',
      '--ui-file', file, '--ui-grep', 'P04\\.']);
    const browser = vi.mocked(spawnSync).mock.calls.find(([, args]) => args?.includes(file));
    expect(browser?.[1]).toEqual(['--filter', '@happier-dev/tests', 'exec', 'node',
      'scripts/run-playwright-with-heartbeat.mjs', '--config', 'playwright.ui.config.mjs', file, '--grep', 'P04\\.']);
    expect(browser?.[2]?.env).toMatchObject({ HAPPIER_E2E_DB_PROVIDER: 'postgres',
      DATABASE_URL: 'postgresql://happier:happier@127.0.0.1:54321/happier?sslmode=disable' });
    expect(vi.mocked(spawnSync).mock.calls.filter(([command, args]) => command === 'docker' && args?.[0] === 'rm')
      .map(([, args]) => args)).toEqual([['rm', '-f', '-v', id]]);
  });
});

describe('extended-db docker script args', () => {
  it('rejects a contract-file selector in browser mode instead of running a different suite', () => {
    expect(() => buildExtendedDbCommandPlan({ db: 'postgres', mode: 'ui', databaseUrl: 'postgresql://fixture',
      contractFile: 'sources/app/automations/selected.postgres.dbcontract.spec.ts' }))
      .toThrow(/contract file filter/);
  });

  it('loads selected browser suites from workspace source before their fixtures start', () => {
    const steps = buildExtendedDbCommandPlan({ db: 'postgres', mode: 'ui', databaseUrl: 'postgresql://fixture',
      uiFile: 'suites/ui-e2e/automations.authoring.feat.automations.spec.ts', uiGrep: 'P04\\.',
      env: { HAPPIER_E2E_PROVIDER_USE_CLI_SOURCE_ENTRYPOINT: '1', NODE_OPTIONS: '--enable-source-maps' } });
    expect(steps.map(step => step.kind)).toEqual(['ui']);
    expect(steps[0].env.NODE_OPTIONS).toMatch(/^--enable-source-maps --import file:.*\/packages\/cli-common\/registerSourceRuntime\.mjs$/);
  });

  it('parses valid args', () => {
    const parsed = parseArgs([
      'node',
      'run-extended-db-docker.mjs',
      '--db',
      'postgres',
      '--mode',
      'contract',
      '--name',
      'db-test',
      '--keep',
    ]);

    expect(parsed).toEqual({
      mode: 'contract',
      keep: true,
      db: 'postgres',
      name: 'db-test',
    });
  });

  it('accepts the explicit Session System Record upgrade contract mode', () => {
    expect(parseArgs([
      'node',
      'run-extended-db-docker.mjs',
      '--db',
      'mysql',
      '--mode',
      'session-system-record-upgrade',
    ])).toEqual({
      mode: 'session-system-record-upgrade',
      keep: false,
      db: 'mysql',
    });
  });

  it('rejects unknown args', () => {
    expect(() => parseArgs(['node', 'run-extended-db-docker.mjs', '--db', 'postgres', '--invalid'])).toThrow(
      /Unknown arg/,
    );
  });

  it('wraps the Windows pnpm shim through cmd.exe', () => {
    const resolveExtendedDbPnpmInvocation = (runExtendedDbDockerScript as {
      resolveExtendedDbPnpmInvocation?: PnpmInvocationResolver;
    }).resolveExtendedDbPnpmInvocation;

    expect(resolveExtendedDbPnpmInvocation).toBeTypeOf('function');
    if (!resolveExtendedDbPnpmInvocation) throw new Error('missing extended DB Yarn invocation resolver');

    const invocation = resolveExtendedDbPnpmInvocation(['--silent', 'run', 'test:e2e:core:fast'], {
      platform: 'win32',
      npmExecPath: 'C:\\npm\\node_modules\\npm\\bin\\npm-cli.js',
      comspec: 'C:\\Windows\\System32\\cmd.exe',
    });

    expect(invocation.command).toBe('C:\\Windows\\System32\\cmd.exe');
    expect(invocation.windowsVerbatimArguments).toBe(true);
    expect(invocation.args.join(' ')).toContain('pnpm.cmd');
    expect(invocation.args.join(' ')).toContain('pnpm');
    expect(invocation.args.join(' ')).not.toContain('npm-cli.js');
  });
});

describe('Session System Record provider upgrade command plan', () => {
  const databaseUrl = 'provider://fixture-url';

  it.each([
    ['postgres', 'migrate:full:deploy', 'HAPPIER_TEST_POSTGRES_DATABASE_URL'],
    ['mysql', 'migrate:mysql:deploy', 'HAPPIER_TEST_MYSQL_DATABASE_URL'],
  ] as const)('seeds %s preview data, deploys twice through the canonical owner, verifies, then runs Board contracts', (
    db,
    migrationScript,
    providerUrlKey,
  ) => {
    const plan = buildExtendedDbCommandPlan({
      db,
      mode: 'session-system-record-upgrade',
      databaseUrl,
    });

    expect(plan.map((step) => step.kind)).toEqual([
      'session-system-record-upgrade-seed',
      'session-system-record-migrate-first',
      'session-system-record-migrate-second',
      'session-system-record-upgrade-verify',
      'session-system-record-board-contract',
    ]);
    expect(plan[0]?.args).toEqual([
      '--silent',
      '--filter',
      '@happier-dev/server',
      'run',
      'test:session-system-record-upgrade-fixture',
      'seed',
    ]);
    for (const migrationStep of plan.slice(1, 3)) {
      expect(migrationStep.args).toEqual([
        '--silent',
        '--filter',
        '@happier-dev/server',
        'run',
        migrationScript,
      ]);
    }
    expect(plan[3]?.args).toEqual([
      '--silent',
      '--filter',
      '@happier-dev/server',
      'run',
      'test:session-system-record-upgrade-fixture',
      'verify',
    ]);
    expect(plan[4]?.args).toEqual([
      '--filter',
      '@happier-dev/server',
      'run',
      'test:db-contract',
      'sources/app/session/systemRecords/sessionSystemRecords.dbcontract.spec.ts',
    ]);
    for (const step of plan) {
      expect(step.env).toMatchObject({
        HAPPIER_DB_PROVIDER: db,
        DATABASE_URL: databaseUrl,
        [providerUrlKey]: databaseUrl,
      });
    }
    expect(plan.flatMap((step) => step.args).join(' ')).not.toMatch(/\bprisma\s+migrate\s+deploy\b/u);
  });

  it('uses the canonical PostgreSQL migration owner for ordinary final-schema contracts too', () => {
    const plan = buildExtendedDbCommandPlan({ db: 'postgres', mode: 'contract', databaseUrl });
    expect(plan[0]?.args).toEqual([
      '--silent',
      '--filter',
      '@happier-dev/server',
      'run',
      'migrate:full:deploy',
    ]);
    expect(plan.flatMap((step) => step.args).join(' ')).not.toMatch(/\bprisma\s+migrate\s+deploy\b/u);
  });
});

describe('extended-db docker script timeouts', () => {
  it('uses a generous default step timeout (overrideable by env)', () => {
    expect(resolveExtendedDbStepTimeoutMs({} as unknown as NodeJS.ProcessEnv)).toBe(3_600_000);
    expect(
      resolveExtendedDbStepTimeoutMs({ HAPPIER_E2E_EXTENDED_DB_STEP_TIMEOUT_MS: '120000' } as unknown as NodeJS.ProcessEnv),
    ).toBe(120_000);
  });

  it('uses fallback for missing/invalid values', () => {
    expect(resolveExtendedDbCommandTimeoutMs(undefined, 55_000)).toBe(55_000);
    expect(resolveExtendedDbCommandTimeoutMs('0', 55_000)).toBe(55_000);
    expect(resolveExtendedDbCommandTimeoutMs('-1', 55_000)).toBe(55_000);
    expect(resolveExtendedDbCommandTimeoutMs('abc', 55_000)).toBe(55_000);
  });

  it('parses values and clamps minimum', () => {
    expect(resolveExtendedDbCommandTimeoutMs('120000', 55_000)).toBe(120_000);
    expect(resolveExtendedDbCommandTimeoutMs('500', 55_000)).toBe(5_000);
  });
});
