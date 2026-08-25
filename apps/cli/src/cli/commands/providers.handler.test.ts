import { afterEach, describe, expect, it, vi } from 'vitest';

import { createProviderErrorV1 } from '@happier-dev/protocol';

import type { CommandContext } from '@/cli/commandRegistry';
import { captureConsoleText } from '@/testkit/logger/captureOutput';
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

  it('keeps stdout parseable JSON when help is requested in --json mode', async () => {
    // `--json` is a machine-output contract, not a decoration: a caller piping
    // stdout into a parser gets a syntax error the moment help is printed as
    // prose beside (or instead of) the envelope.
    const load = vi.fn(async () => { throw new Error('must not load'); });
    // The capture merges `console.log` with `process.stdout.write`, so prose
    // printed BESIDE the envelope fails this too — a stdout-only spy would
    // accept help emitted through `console.log` alongside valid JSON.
    const output = captureConsoleText();

    try {
      await handleProvidersCliCommand(context(['--help', '--json']), load);

      expect(load).not.toHaveBeenCalled();
      const parsed = JSON.parse(output.text().trim()) as Record<string, unknown>;
      expect(parsed).toMatchObject({ v: 1, ok: true, kind: 'providers_help' });
      expect(String((parsed.data as Record<string, unknown>).help)).toContain('happier providers list');
      expect(process.exitCode ?? 0).toBe(0);
    } finally {
      output.restore();
    }
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
    // `--json` mode writes the envelope through `process.stdout.write` so the
    // completion callback can settle the write; a `console.log` spy would never
    // observe it.
    const written: string[] = [];
    vi.spyOn(process.stdout, 'write').mockImplementation(((
      chunk: unknown,
      encodingOrCallback?: unknown,
      callback?: unknown,
    ) => {
      written.push(String(chunk));
      const done = typeof encodingOrCallback === 'function' ? encodingOrCallback : callback;
      if (typeof done === 'function') done();
      return true;
    }) as typeof process.stdout.write);
    await handleProvidersCliCommand(context(['load-model', 'pc_1', '--model', 'model-a', '--json']), load);
    expect(error).not.toHaveBeenCalled();
    expect(JSON.parse(String(written[0]))).toEqual({
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

  it('preserves the canonical review_current_state refusal for an unknown mutation outcome', async () => {
    const providerError = createProviderErrorV1('provider_rpc_mutation_outcome_unknown', {
      connectionId: 'pc_1',
      machineId: 'machine-a',
    });
    const load = vi.fn(async () => {
      throw new ProviderCliError(
        providerError.code,
        `Provider operation failed: ${providerError.code}`,
        providerError,
      );
    });
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    await handleProvidersCliCommand(context(['edit', 'pc_1', '--name', 'Work']), load);

    const printed = error.mock.calls.map(([line]) => String(line)).join('\n');
    expect(printed).toContain('provider_rpc_mutation_outcome_unknown');
    expect(printed).toContain('may have applied the Provider change');
    expect(printed).toContain('Review current Provider state before making another change.');
    expect(printed).toContain('Connection: pc_1');
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
