import { afterEach, describe, expect, it, vi } from 'vitest';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createEnvKeyScope } from '@/testkit/env/envScope';
import { createTempDirSync, removeTempDirSync } from '@/testkit/fs/tempDir';
import { captureConsoleText } from '@/testkit/logger/captureOutput';

describe('configuration env url fallback', () => {
  const envKeys = [
    'HAPPIER_HOME_DIR',
    'HAPPIER_SERVER_URL',
    'HAPPIER_LOCAL_SERVER_URL',
    'HAPPIER_PUBLIC_SERVER_URL',
    'HAPPIER_WEBAPP_URL',
    'HAPPIER_ACTIVE_SERVER_ID',
    'HAPPIER_EXECUTION_RUNS_MAX_CONCURRENT_PER_SESSION',
    'HAPPIER_EPHEMERAL_TASKS_MAX_CONCURRENT_PER_SESSION',
    'HAPPIER_EXECUTION_RUNS_BOUNDED_TIMEOUT_MS',
    'HAPPIER_EXECUTION_RUNS_REVIEW_BOUNDED_TIMEOUT_MS',
    'HAPPIER_EXECUTION_RUNS_MAX_TURNS',
    'HAPPIER_EXECUTION_RUNS_MAX_DEPTH',
    'HAPPIER_EXECUTION_BUDGET_MAX_CONCURRENT_TOTAL_PER_SESSION',
    'HAPPIER_EXECUTION_BUDGET_MAX_CONCURRENT_BY_CLASS_JSON',
  ] as const;
  let envScope = createEnvKeyScope(envKeys);
  const tempDirs: string[] = [];

  afterEach(() => {
    envScope.restore();
    envScope = createEnvKeyScope(envKeys);
    vi.resetModules();
    for (const tempDir of tempDirs) {
      removeTempDirSync(tempDir);
    }
    tempDirs.length = 0;
  });

  it('defaults webappUrl to server origin when HAPPIER_SERVER_URL is custom and webapp is unset', async () => {
    const homeDir = createTempDirSync('happier-cli-config-');
    tempDirs.push(homeDir);
    process.env.HAPPIER_HOME_DIR = homeDir;
    process.env.HAPPIER_SERVER_URL = 'https://selfhost.example.test/api';
    delete process.env.HAPPIER_WEBAPP_URL;

    const output = captureConsoleText();
    try {
      const configMod = await import('./configuration');
      configMod.reloadConfiguration();
      expect(configMod.configuration.serverUrl).toBe('https://selfhost.example.test/api');
      expect(configMod.configuration.webappUrl).toBe('https://selfhost.example.test');
    } finally {
      output.restore();
    }
  });

  it('keeps the cloud default webappUrl when HAPPIER_SERVER_URL matches the cloud default and webapp is unset', async () => {
    const homeDir = createTempDirSync('happier-cli-config-');
    tempDirs.push(homeDir);
    process.env.HAPPIER_HOME_DIR = homeDir;
    process.env.HAPPIER_SERVER_URL = 'https://api.happier.dev';
    delete process.env.HAPPIER_WEBAPP_URL;

    const output = captureConsoleText();
    try {
      const configMod = await import('./configuration');
      configMod.reloadConfiguration();
      expect(configMod.configuration.serverUrl).toBe('https://api.happier.dev');
      expect(configMod.configuration.webappUrl).toBe('https://app.happier.dev');
    } finally {
      output.restore();
    }
  });

  it('normalizes trailing slashes so env HAPPIER_SERVER_URL matches persisted server profiles', async () => {
    const homeDir = createTempDirSync('happier-cli-config-');
    tempDirs.push(homeDir);
    const settingsFile = join(homeDir, 'settings.json');
    writeFileSync(
      settingsFile,
      JSON.stringify(
        {
          schemaVersion: 5,
          activeServerId: 'custom',
          servers: {
            custom: {
              id: 'custom',
              serverUrl: 'https://selfhost.example.test/api',
              webappUrl: 'https://selfhost.example.test',
            },
          },
        },
        null,
        2,
      ),
      'utf-8',
    );

    process.env.HAPPIER_HOME_DIR = homeDir;
    process.env.HAPPIER_SERVER_URL = 'https://selfhost.example.test/api/';
    delete process.env.HAPPIER_WEBAPP_URL;

    const output = captureConsoleText();
    try {
      const configMod = await import('./configuration');
      configMod.reloadConfiguration();
      expect(configMod.configuration.activeServerId).toBe('custom');
      expect(configMod.configuration.serverUrl).toBe('https://selfhost.example.test/api');
    } finally {
      output.restore();
    }
  });

  it('reuses persisted webappUrl when env server override matches a saved profile', async () => {
    const homeDir = createTempDirSync('happier-cli-config-');
    tempDirs.push(homeDir);
    const settingsFile = join(homeDir, 'settings.json');
    writeFileSync(
      settingsFile,
      JSON.stringify(
        {
          schemaVersion: 5,
          activeServerId: 'custom',
          servers: {
            custom: {
              id: 'custom',
              serverUrl: 'https://api.selfhost.example.test/v1',
              webappUrl: 'https://app.selfhost.example.test',
            },
          },
        },
        null,
        2,
      ),
      'utf-8',
    );

    process.env.HAPPIER_HOME_DIR = homeDir;
    process.env.HAPPIER_SERVER_URL = 'https://api.selfhost.example.test/v1/';
    delete process.env.HAPPIER_WEBAPP_URL;

    const output = captureConsoleText();
    try {
      const configMod = await import('./configuration');
      configMod.reloadConfiguration();
      expect(configMod.configuration.activeServerId).toBe('custom');
      expect(configMod.configuration.serverUrl).toBe('https://api.selfhost.example.test/v1');
      expect(configMod.configuration.webappUrl).toBe('https://app.selfhost.example.test');
    } finally {
      output.restore();
    }
  });

  it('falls back to cloud when persisted activeServerId is path-unsafe', async () => {
    const homeDir = createTempDirSync('happier-cli-config-unsafe-id-');
    tempDirs.push(homeDir);
    const settingsFile = join(homeDir, 'settings.json');
    writeFileSync(
      settingsFile,
      JSON.stringify(
        {
          schemaVersion: 5,
          activeServerId: '../escape',
          servers: {
            '../escape': {
              id: '../escape',
              serverUrl: 'https://selfhost.example.test/api',
              webappUrl: 'https://selfhost.example.test',
            },
            cloud: {
              id: 'cloud',
              serverUrl: 'https://api.happier.dev',
              webappUrl: 'https://app.happier.dev',
            },
          },
        },
        null,
        2,
      ),
      'utf-8',
    );

    process.env.HAPPIER_HOME_DIR = homeDir;
    delete process.env.HAPPIER_SERVER_URL;
    delete process.env.HAPPIER_WEBAPP_URL;

    const configMod = await import('./configuration');
    configMod.reloadConfiguration();
    expect(configMod.configuration.activeServerId).toBe('cloud');
    expect(configMod.configuration.activeServerDir).toBe(join(homeDir, 'servers', 'cloud'));
  });

  it('uses HAPPIER_ACTIVE_SERVER_ID override for active server scope without changing URL selection', async () => {
    const homeDir = createTempDirSync('happier-cli-config-active-scope-');
    tempDirs.push(homeDir);
    const settingsFile = join(homeDir, 'settings.json');
    writeFileSync(
      settingsFile,
      JSON.stringify(
        {
          schemaVersion: 5,
          activeServerId: 'custom',
          servers: {
            custom: {
              id: 'custom',
              serverUrl: 'https://api.selfhost.example.test/v1',
              webappUrl: 'https://app.selfhost.example.test',
            },
          },
        },
        null,
        2,
      ),
      'utf-8',
    );

    process.env.HAPPIER_HOME_DIR = homeDir;
    process.env.HAPPIER_ACTIVE_SERVER_ID = 'stack_main__id_default';
    delete process.env.HAPPIER_SERVER_URL;
    delete process.env.HAPPIER_WEBAPP_URL;

    const configMod = await import('./configuration');
    configMod.reloadConfiguration();
    expect(configMod.configuration.activeServerId).toBe('stack_main__id_default');
    expect(configMod.configuration.serverUrl).toBe('https://api.selfhost.example.test/v1');
    expect(configMod.configuration.webappUrl).toBe('https://app.selfhost.example.test');
  });

  it('prefers the persisted active server id when multiple saved profiles share the env-selected URL', async () => {
    const homeDir = createTempDirSync('happier-cli-config-duplicate-url-');
    tempDirs.push(homeDir);
    const settingsFile = join(homeDir, 'settings.json');
    writeFileSync(
      settingsFile,
      JSON.stringify(
        {
          schemaVersion: 5,
          activeServerId: 'custom-3',
          servers: {
            cloud: {
              id: 'cloud',
              serverUrl: 'https://api.happier.dev',
              webappUrl: 'https://app.happier.dev',
            },
            'custom-2': {
              id: 'custom-2',
              serverUrl: 'http://192.168.1.115:26851',
              webappUrl: 'http://192.168.1.115:8081',
            },
            'custom-3': {
              id: 'custom-3',
              serverUrl: 'http://192.168.1.115:26851',
              webappUrl: 'http://192.168.1.115:8081',
            },
          },
        },
        null,
        2,
      ),
      'utf-8',
    );

    process.env.HAPPIER_HOME_DIR = homeDir;
    process.env.HAPPIER_PUBLIC_SERVER_URL = 'http://192.168.1.115:26851';
    process.env.HAPPIER_SERVER_URL = 'http://192.168.1.115:26851';
    process.env.HAPPIER_WEBAPP_URL = 'http://192.168.1.115:8081';
    delete process.env.HAPPIER_ACTIVE_SERVER_ID;

    const configMod = await import('./configuration');
    configMod.reloadConfiguration();
    expect(configMod.configuration.activeServerId).toBe('custom-3');
    expect(configMod.configuration.serverUrl).toBe('http://192.168.1.115:26851');
    expect(configMod.configuration.webappUrl).toBe('http://192.168.1.115:8081');
  });

  it('reads execution-run and ephemeral-task budget env vars', async () => {
    const homeDir = createTempDirSync('happier-cli-config-budget-');
    tempDirs.push(homeDir);
    process.env.HAPPIER_HOME_DIR = homeDir;
    process.env.HAPPIER_EXECUTION_RUNS_MAX_CONCURRENT_PER_SESSION = '7';
    process.env.HAPPIER_EPHEMERAL_TASKS_MAX_CONCURRENT_PER_SESSION = '3';
    process.env.HAPPIER_EXECUTION_RUNS_BOUNDED_TIMEOUT_MS = '45000';
    process.env.HAPPIER_EXECUTION_RUNS_REVIEW_BOUNDED_TIMEOUT_MS = '180000';
    process.env.HAPPIER_EXECUTION_RUNS_MAX_TURNS = '9';
    process.env.HAPPIER_EXECUTION_RUNS_MAX_DEPTH = '2';
    process.env.HAPPIER_EXECUTION_BUDGET_MAX_CONCURRENT_TOTAL_PER_SESSION = '5';
    process.env.HAPPIER_EXECUTION_BUDGET_MAX_CONCURRENT_BY_CLASS_JSON = JSON.stringify({ review: 1, automation: 2 });

    const configMod = await import('./configuration');
    configMod.reloadConfiguration();
    expect(configMod.configuration.executionRunsMaxConcurrentPerSession).toBe(7);
    expect(configMod.configuration.ephemeralTasksMaxConcurrentPerSession).toBe(3);
    expect(configMod.configuration.executionRunsBoundedTimeoutMs).toBe(45000);
    expect(Reflect.get(configMod.configuration, 'executionRunsReviewBoundedTimeoutMs')).toBe(180000);
    expect(configMod.configuration.executionRunsMaxTurns).toBe(9);
    expect(configMod.configuration.executionRunsMaxDepth).toBe(2);
    expect(configMod.configuration.executionBudgetMaxConcurrentTotalPerSession).toBe(5);
    expect(configMod.configuration.executionBudgetMaxConcurrentByClass).toEqual({ review: 1, automation: 2 });
  });

  it('defaults execution-run concurrency and timeouts to unlimited when budget env vars are unset', async () => {
    const homeDir = createTempDirSync('happier-cli-config-budget-defaults-');
    tempDirs.push(homeDir);
    process.env.HAPPIER_HOME_DIR = homeDir;
    delete process.env.HAPPIER_EXECUTION_RUNS_MAX_CONCURRENT_PER_SESSION;
    delete process.env.HAPPIER_EXECUTION_RUNS_BOUNDED_TIMEOUT_MS;
    delete process.env.HAPPIER_EXECUTION_RUNS_REVIEW_BOUNDED_TIMEOUT_MS;
    delete process.env.HAPPIER_EXECUTION_RUNS_MAX_TURNS;

    const configMod = await import('./configuration');
    configMod.reloadConfiguration();
    expect(configMod.configuration.executionRunsMaxConcurrentPerSession).toBeNull();
    expect(configMod.configuration.ephemeralTasksMaxConcurrentPerSession).toBeNull();
    expect(configMod.configuration.executionRunsBoundedTimeoutMs).toBeNull();
    expect(configMod.configuration.executionRunsReviewBoundedTimeoutMs).toBeNull();
    expect(configMod.configuration.executionRunsMaxTurns).toBeNull();
  });
});
