import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { captureConsoleJsonOutput } from '@/testkit/logger/captureOutput';

// The default Agent launch starts a long-lived Session runner; it is the process
// boundary this test observes, as in the provider fail-closed dispatch test.
const { defaultHandlerSpy, resolveMergedContributionRegistryMock } = vi.hoisted(
  () => ({
    defaultHandlerSpy: vi.fn(async () => {}),
    resolveMergedContributionRegistryMock: vi.fn(async () => ({
      actions: [],
      agents: [],
      backends: [],
      runtimeAdaptersByBackendId: new Map(),
      catalogEntriesById: {},
      agentDefinitionsById: new Map(),
      backendDefinitionsById: new Map(),
      pluginDiagnosticsByPluginId: {},
    })),
  }),
);

vi.mock('@/agent/catalog/registry', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('@/agent/catalog/registry')>();
  return {
    ...actual,
    requireCatalogEntry: vi.fn(() => ({
      getCliCommandHandler: async () => defaultHandlerSpy,
    })),
  };
});

vi.mock(
  '@/plugins/projection/registry/createResolvedContributionRegistry',
  async (importOriginal) => {
    const actual =
      await importOriginal<
        typeof import('@/plugins/projection/registry/createResolvedContributionRegistry')
      >();
    return {
      ...actual,
      resolveMergedContributionRegistry: resolveMergedContributionRegistryMock,
    };
  },
);

import { dispatchCli } from './dispatch';

function withTerminal(interactive: boolean): () => void {
  const stdin = Object.getOwnPropertyDescriptor(process.stdin, 'isTTY');
  const stdout = Object.getOwnPropertyDescriptor(process.stdout, 'isTTY');
  Object.defineProperty(process.stdin, 'isTTY', { configurable: true, value: interactive });
  Object.defineProperty(process.stdout, 'isTTY', { configurable: true, value: interactive });
  return () => {
    if (stdin) Object.defineProperty(process.stdin, 'isTTY', stdin); else Reflect.deleteProperty(process.stdin, 'isTTY');
    if (stdout) Object.defineProperty(process.stdout, 'isTTY', stdout); else Reflect.deleteProperty(process.stdout, 'isTTY');
  };
}

describe('dispatchCli invocation that names no command', () => {
  let restoreTerminal: () => void = () => {};

  beforeEach(() => {
    defaultHandlerSpy.mockClear();
    process.exitCode = undefined;
    restoreTerminal = withTerminal(false);
  });

  afterEach(() => {
    restoreTerminal();
  });

  // Argv of one-shot calls that stayed alive for hours on nl3 (2026-11-18): none
  // reaches a command, so each started a default Agent Session runner.
  it.each([
    [['--json']],
    [['info', '--json']],
    [['logs', '--component=server', '--lines', '100', '--json']],
  ])('refuses %j with a JSON envelope instead of starting a Session', async (args) => {
    const output = captureConsoleJsonOutput<{ ok: boolean; kind: string; error?: { code?: string; command?: string } }>();
    try {
      await dispatchCli({ args: [...args], rawArgv: ['happier', ...args], terminalRuntime: null });
      expect(output.json()).toMatchObject({ ok: false, kind: 'cli_dispatch', error: { code: 'unknown_command', command: args[0] } });
    } finally {
      output.restore();
    }

    expect(defaultHandlerSpy).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(1);
  });

  it.each([
    [['--json', 'provider', '--help']],
    [['--json', '--server-id', 'srv_selected', 'provider', '--help']],
  ])('dispatches %j to the command its leading flags precede', async (args) => {
    const output = captureConsoleJsonOutput<{ ok: boolean; kind: string }>();
    try {
      await dispatchCli({ args: [...args], rawArgv: ['happier', ...args], terminalRuntime: null });
      expect(output.json()).toMatchObject({ ok: true, kind: 'providers_help' });
    } finally {
      output.restore();
    }

    expect(defaultHandlerSpy).not.toHaveBeenCalled();
  });

  it('refuses a non-interactive prompt that names no command', async () => {
    await dispatchCli({ args: ['info'], rawArgv: ['happier', 'info'], terminalRuntime: null });

    expect(defaultHandlerSpy).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(1);
  });

  it.each([
    ['an interactive terminal', ['info'], true],
    ['an explicit terminal start', ['info', '--started-by', 'terminal'], false],
  ] as const)('starts the default Agent from %s', async (_name, args, interactive) => {
    restoreTerminal();
    restoreTerminal = withTerminal(interactive);

    await dispatchCli({ args: [...args], rawArgv: ['happier', ...args], terminalRuntime: null });

    expect(defaultHandlerSpy).toHaveBeenCalledOnce();
  });
});
