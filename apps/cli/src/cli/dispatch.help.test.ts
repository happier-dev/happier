import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

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
  const consoleLogSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

  beforeEach(() => {
    defaultHandlerSpy.mockClear();
    consoleLogSpy.mockClear();
  });

  afterEach(() => {
    consoleLogSpy.mockClear();
  });

  it('prints vendor-agnostic root help without invoking the default backend handler', async () => {
    await dispatchCli({
      args: ['--help'],
      rawArgv: ['happier', '--help'],
      terminalRuntime: null,
    });

    expect(defaultHandlerSpy).not.toHaveBeenCalled();
    expect(consoleLogSpy).toHaveBeenCalledWith(expect.stringContaining('happier - AI CLI On the Go'));
    expect(consoleLogSpy).toHaveBeenCalledWith(expect.stringContaining('happier codex'));
    expect(consoleLogSpy).toHaveBeenCalledWith(expect.not.stringContaining('Claude Code Options'));
  });
});
