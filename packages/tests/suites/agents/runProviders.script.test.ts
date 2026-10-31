import { describe, expect, it } from 'vitest';

import * as runProvidersScript from '../../scripts/run-providers.mjs';
import { parseArgs, resolveProvidersRunTimeoutFallbackMs, resolveProvidersRunTimeoutMs } from '../../scripts/run-providers.mjs';

type PnpmInvocationResolver = (
  args: readonly string[],
  options?: Readonly<{ platform?: NodeJS.Platform; npmExecPath?: string; comspec?: string }>,
) => Readonly<{ command: string; args: string[]; windowsVerbatimArguments?: boolean }>;

describe('providers run script args', () => {
  it('defaults flake retry to enabled', () => {
    const parsed = parseArgs(['node', 'run-providers.mjs', 'opencode', 'smoke']);

    expect(parsed.flakeRetry).toBe(true);
  });

  it('parses known flags and positional args', () => {
    const parsed = parseArgs([
      'node',
      'run-providers.mjs',
      'opencode',
      'smoke',
      '--update-baselines',
      '--strict-keys',
      '--flake-retry',
    ]);

    expect(parsed).toEqual({
      presetId: 'opencode',
      tier: 'smoke',
      updateBaselines: true,
      strictKeys: true,
      flakeRetry: true,
    });
  });

  it('allows explicit flake retry opt-out', () => {
    const parsed = parseArgs(['node', 'run-providers.mjs', 'opencode', 'smoke', '--no-flake-retry']);

    expect(parsed.flakeRetry).toBe(false);
  });

  it('rejects unknown flags', () => {
    expect(() => parseArgs(['node', 'run-providers.mjs', 'opencode', 'smoke', '--bad-flag'])).toThrow(
      /Unknown flag/,
    );
  });

  it('rejects conflicting flake retry flags', () => {
    expect(() =>
      parseArgs(['node', 'run-providers.mjs', 'opencode', 'smoke', '--flake-retry', '--no-flake-retry']),
    ).toThrow(/Conflicting flags/);
  });

  it('rejects unexpected extra positional args', () => {
    expect(() => parseArgs(['node', 'run-providers.mjs', 'opencode', 'smoke', 'extra'])).toThrow(
      /Unexpected positional argument/,
    );
  });

  it('wraps the Windows Pnpm shim through cmd.exe', () => {
    const resolveProviderRunPnpmInvocation = (runProvidersScript as {
      resolveProviderRunPnpmInvocation?: PnpmInvocationResolver;
    }).resolveProviderRunPnpmInvocation;

    expect(resolveProviderRunPnpmInvocation).toBeTypeOf('function');
    if (!resolveProviderRunPnpmInvocation) throw new Error('missing provider run Pnpm invocation resolver');

    const invocation = resolveProviderRunPnpmInvocation(['-s', 'test:agents'], {
      platform: 'win32',
      npmExecPath: 'C:\\npm\\node_modules\\npm\\bin\\npm-cli.js',
      comspec: 'C:\\Windows\\System32\\cmd.exe',
    });

    expect(invocation.command).toBe('C:\\Windows\\System32\\cmd.exe');
    expect(invocation.windowsVerbatimArguments).toBe(true);
    expect(invocation.args.join(' ')).toContain('pnpm.cmd');
    expect(invocation.args.join(' ')).not.toContain('npm-cli.js');
  });
});

describe('providers run script timeout', () => {
  it('uses bounded smoke fallback timeouts to guarantee terminalization', () => {
    expect(resolveProvidersRunTimeoutFallbackMs({ presetId: 'opencode', tier: 'smoke' })).toBe(20 * 60 * 1000);
    expect(resolveProvidersRunTimeoutFallbackMs({ presetId: 'all', tier: 'smoke' })).toBe(45 * 60 * 1000);
  });

  it('uses fallback for missing/invalid values', () => {
    expect(resolveProvidersRunTimeoutMs(undefined, 123_000)).toBe(123_000);
    expect(resolveProvidersRunTimeoutMs('0', 123_000)).toBe(123_000);
    expect(resolveProvidersRunTimeoutMs('-50', 123_000)).toBe(123_000);
    expect(resolveProvidersRunTimeoutMs('not-a-number', 123_000)).toBe(123_000);
  });

  it('parses positive values and clamps minimum', () => {
    expect(resolveProvidersRunTimeoutMs('120000', 123_000)).toBe(120_000);
    expect(resolveProvidersRunTimeoutMs('1000', 123_000)).toBe(60_000);
  });
});
