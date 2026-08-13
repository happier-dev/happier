import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { captureConsoleLogAndMuteStdout } from '@/testkit/logger/captureOutput';

const defaultHandlerSpy = vi.fn(async () => {});

vi.mock('@/backends/catalog', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/backends/catalog')>();
  return {
    ...actual,
    requireCatalogEntry: vi.fn(() => ({
      getCliCommandHandler: async () => defaultHandlerSpy,
    })),
  };
});

import { dispatchCli } from './dispatch';

describe('dispatchCli root help', () => {
  let output = captureConsoleLogAndMuteStdout();

  beforeEach(() => {
    defaultHandlerSpy.mockClear();
    output.restore();
    output = captureConsoleLogAndMuteStdout();
  });

  afterEach(() => {
    output.restore();
  });

  it('prints vendor-agnostic root help without invoking the default backend handler', async () => {
    await dispatchCli({
      args: ['--help'],
      rawArgv: ['happier', '--help'],
      terminalRuntime: null,
    });

    expect(defaultHandlerSpy).not.toHaveBeenCalled();
    expect(output.logs).toContainEqual(expect.stringContaining('happier - AI CLI On the Go'));
    expect(output.logs).toContainEqual(expect.stringContaining('happier codex'));
    expect(output.logs).toContainEqual(expect.stringContaining('happier session'));
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

  it('routes the plural sessions alias without invoking the default backend handler', async () => {
    await dispatchCli({
      args: ['sessions', '--help'],
      rawArgv: ['happier', 'sessions', '--help'],
      terminalRuntime: null,
    });

    expect(defaultHandlerSpy).not.toHaveBeenCalled();
  });

  it('returns the predecessor empty plugin catalog without starting the default agent', async () => {
    await dispatchCli({
      args: ['plugins', 'list', '--json'],
      rawArgv: ['happier', 'plugins', 'list', '--json'],
      terminalRuntime: null,
    });

    expect(defaultHandlerSpy).not.toHaveBeenCalled();
    expect(output.logs).toContainEqual(JSON.stringify({
      v: 1,
      ok: true,
      kind: 'plugins_list',
      data: { plugins: [] },
    }));
  });
});
