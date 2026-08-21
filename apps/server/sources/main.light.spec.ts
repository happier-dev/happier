import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  applyLightDefaultEnv: vi.fn(),
  applyPackagedLightRuntimeSqliteDefaults: vi.fn(),
  resolveLightDataDir: vi.fn(() => '/tmp/happier-light-main-test'),
  applySqliteMigrationsFromEnvironment: vi.fn(async () => ({ applied: [] })),
  initializeServerSentry: vi.fn(),
  registerProcessHandlers: vi.fn(),
  startServer: vi.fn(async () => {}),
}));

vi.mock('@/flavors/light/env', () => ({
  applyLightDefaultEnv: mocks.applyLightDefaultEnv,
  applyPackagedLightRuntimeSqliteDefaults: mocks.applyPackagedLightRuntimeSqliteDefaults,
  resolveLightDataDir: mocks.resolveLightDataDir,
}));
vi.mock('@/flavors/light/sqliteMigrations', () => ({
  applySqliteMigrationsFromEnvironment: mocks.applySqliteMigrationsFromEnvironment,
}));
vi.mock('@/app/monitoring/sentry', () => ({
  initializeServerSentry: mocks.initializeServerSentry,
}));
vi.mock('@/utils/process/processHandlers', () => ({
  registerProcessHandlers: mocks.registerProcessHandlers,
}));
vi.mock('@/startServer', () => ({
  startServer: mocks.startServer,
}));

import { runLightServerMain } from './flavors/light/main';

describe('runLightServerMain', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    delete process.env.HAPPY_SERVER_FLAVOR;
    delete process.env.HAPPIER_SERVER_FLAVOR;
  });

  afterEach(() => {
    delete process.env.HAPPY_SERVER_FLAVOR;
    delete process.env.HAPPIER_SERVER_FLAVOR;
  });

  it('runs canonical SQLite migration only and returns for --migrate-only', async () => {
    await runLightServerMain(['--migrate-only']);

    expect(mocks.applyLightDefaultEnv).toHaveBeenCalledWith(process.env);
    expect(mocks.applyPackagedLightRuntimeSqliteDefaults).toHaveBeenCalledWith(process.env);
    expect(mocks.applySqliteMigrationsFromEnvironment).toHaveBeenCalledWith({
      env: process.env,
      dataDir: '/tmp/happier-light-main-test',
    });
    expect(mocks.initializeServerSentry).not.toHaveBeenCalled();
    expect(mocks.registerProcessHandlers).not.toHaveBeenCalled();
    expect(mocks.startServer).not.toHaveBeenCalled();
  });

  it('preserves ordinary light-server startup when migrate-only is absent', async () => {
    await runLightServerMain([]);

    expect(mocks.applySqliteMigrationsFromEnvironment).not.toHaveBeenCalled();
    expect(mocks.initializeServerSentry).toHaveBeenCalledWith(process.env);
    expect(mocks.registerProcessHandlers).toHaveBeenCalledOnce();
    expect(mocks.startServer).toHaveBeenCalledWith('light');
  });
});
