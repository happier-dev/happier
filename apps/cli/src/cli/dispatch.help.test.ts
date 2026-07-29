import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { captureConsoleLogAndMuteStdout } from '@/testkit/logger/captureOutput';
import { createEnvKeyScope } from '@/testkit/env/envScope';
import { reloadConfiguration } from '@/configuration';
import packageJson from '../../package.json';

const { defaultHandlerSpy, ensureMergedAgentCommandRegistryLoadedSpy } = vi.hoisted(() => ({
  defaultHandlerSpy: vi.fn(async () => {}),
  ensureMergedAgentCommandRegistryLoadedSpy: vi.fn(async () => {}),
}));

vi.mock('@/agent/catalog/registry', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/agent/catalog/registry')>();
  return {
    ...actual,
    requireCatalogEntry: vi.fn(() => ({
      getCliCommandHandler: async () => defaultHandlerSpy,
    })),
  };
});

vi.mock('@/cli/commandRegistry', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/cli/commandRegistry')>();
  return {
    ...actual,
    ensureMergedAgentCommandRegistryLoaded: ensureMergedAgentCommandRegistryLoadedSpy,
  };
});

import { dispatchCli } from './dispatch';

describe('dispatchCli root help', () => {
  let output = captureConsoleLogAndMuteStdout();
  let envScope = createEnvKeyScope([
    'HAPPIER_SERVER_URL',
    'HAPPIER_WEBAPP_URL',
    'HAPPIER_PUBLIC_SERVER_URL',
    'HAPPIER_LOCAL_SERVER_URL',
  ]);

  beforeEach(() => {
    defaultHandlerSpy.mockClear();
    ensureMergedAgentCommandRegistryLoadedSpy.mockClear();
    envScope = createEnvKeyScope([
      'HAPPIER_SERVER_URL',
      'HAPPIER_WEBAPP_URL',
      'HAPPIER_PUBLIC_SERVER_URL',
      'HAPPIER_LOCAL_SERVER_URL',
    ]);
    output.restore();
    output = captureConsoleLogAndMuteStdout();
  });

  afterEach(() => {
    envScope.restore();
    reloadConfiguration();
    output.restore();
  });

  it('prints vendor-agnostic root help without invoking the default backend handler', async () => {
    await dispatchCli({
      args: ['--help'],
      rawArgv: ['happier', '--help'],
      terminalRuntime: null,
    });

    expect(defaultHandlerSpy).not.toHaveBeenCalled();
    expect(ensureMergedAgentCommandRegistryLoadedSpy).toHaveBeenCalled();
    expect(output.logs).toContainEqual(expect.stringContaining('happier - AI CLI On the Go'));
    expect(output.logs).toContainEqual(expect.stringContaining('happier codex'));
    expect(output.logs).not.toContainEqual(expect.stringContaining('Claude Code Options'));
  });

  it('routes capabilities JSON requests without invoking the default backend handler', async () => {
    await dispatchCli({
      args: ['capabilities', '--json'],
      rawArgv: ['happier', 'capabilities', '--json'],
      terminalRuntime: null,
    });

    expect(defaultHandlerSpy).not.toHaveBeenCalled();
    expect(output.logs).toContainEqual(expect.stringContaining('"kind":"capabilities_describe"'));
  });

  it('prints version after prefix-only server selection flags without invoking the default backend handler', async () => {
    await dispatchCli({
      args: [
        '--server-url',
        'http://127.0.0.1:53288',
        '--webapp-url',
        'http://app.example.test',
        '--version',
      ],
      rawArgv: [
        'happier',
        '--server-url',
        'http://127.0.0.1:53288',
        '--webapp-url',
        'http://app.example.test',
        '--version',
      ],
      terminalRuntime: null,
    });

    expect(defaultHandlerSpy).not.toHaveBeenCalled();
    expect(output.logs).toEqual([packageJson.version]);
  });

  it('routes the plural sessions alias without invoking the default backend handler', async () => {
    await dispatchCli({
      args: ['sessions', '--help'],
      rawArgv: ['happier', 'sessions', '--help'],
      terminalRuntime: null,
    });

    expect(defaultHandlerSpy).not.toHaveBeenCalled();
  });

  it('routes the singular agent alias without invoking the default backend handler', async () => {
    await dispatchCli({
      args: ['agent', '--help'],
      rawArgv: ['happier', 'agent', '--help'],
      terminalRuntime: null,
    });

    expect(defaultHandlerSpy).not.toHaveBeenCalled();
    expect(output.logs.join('\n')).toContain('happier agents');
  });

  it('routes the singular provider alias to the model-provider help surface', async () => {
    await dispatchCli({
      args: ['provider', '--help'],
      rawArgv: ['happier', 'provider', '--help'],
      terminalRuntime: null,
    });

    expect(defaultHandlerSpy).not.toHaveBeenCalled();
    expect(output.logs.join('\n')).toContain('Manage model-provider connections');
  });
});
