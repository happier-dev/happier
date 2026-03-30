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
    expect(output.logs).not.toContainEqual(expect.stringContaining('Claude Code Options'));
  });
});
