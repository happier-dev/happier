import { afterEach, describe, expect, it, vi } from 'vitest';

import type { CommandContext } from '@/cli/commandRegistry';
import { handleProvidersCliCommand } from './providers';
import { ProviderCliError } from './providers/index';

function context(args: string[]): CommandContext {
  return { args: ['providers', ...args], rawArgv: ['happier', 'providers', ...args], terminalRuntime: null };
}

describe('happier providers command boundary', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    process.exitCode = 0;
  });

  it('renders help without loading authenticated provider dependencies', async () => {
    const load = vi.fn(async () => { throw new Error('must not load'); });
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    await handleProvidersCliCommand(context(['--help']), load);
    expect(load).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledWith(expect.stringContaining('happier providers list'));
    expect(log).toHaveBeenCalledWith(expect.stringContaining('--candidate-id <id>'));
    expect(process.exitCode ?? 0).toBe(0);
  });

  it('returns legacy agent-setup guidance without requiring authentication', async () => {
    const load = vi.fn(async () => { throw new Error('must not load'); });
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    await handleProvidersCliCommand(context(['install', 'codex']), load);
    expect(load).not.toHaveBeenCalled();
    expect(error).toHaveBeenCalledWith(expect.stringContaining("happier agents install"));
    expect(process.exitCode).toBe(1);
  });

  it('returns typed provider failures with nonzero human and JSON exit status', async () => {
    const details = {
      code: 'provider_endpoint_unreachable',
      connectionId: 'pc_1',
      machineId: 'machine-a',
      actions: [{ kind: 'retry' }],
    };
    const load = vi.fn(async () => {
      throw new ProviderCliError(
        'provider_endpoint_unreachable',
        'Provider operation failed: provider_endpoint_unreachable',
        details,
      );
    });
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    await handleProvidersCliCommand(context(['probe', 'pc_1']), load);
    expect(error).toHaveBeenCalledWith('Error: Provider operation failed: provider_endpoint_unreachable');
    expect(process.exitCode).toBe(1);

    process.exitCode = 0;
    error.mockClear();
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    await handleProvidersCliCommand(context(['load-model', 'pc_1', '--model', 'model-a', '--json']), load);
    expect(error).not.toHaveBeenCalled();
    expect(JSON.parse(String(log.mock.calls[0]?.[0]))).toEqual({
      v: 1,
      ok: false,
      kind: 'providers_load_model',
      error: {
        code: 'provider_endpoint_unreachable',
        message: 'Provider operation failed: provider_endpoint_unreachable',
        details,
      },
    });
    expect(process.exitCode).toBe(1);
  });

  it('does not treat --json after the option terminator as an output-mode flag', async () => {
    const load = vi.fn(async () => {
      throw new ProviderCliError('invalid_arguments', 'Terminated --json is positional');
    });
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    await handleProvidersCliCommand(context(['show', '--', '--json']), load);

    expect(log).not.toHaveBeenCalled();
    expect(error).toHaveBeenCalledWith('Error: Terminated --json is positional');
    expect(process.exitCode).toBe(1);
  });
});
