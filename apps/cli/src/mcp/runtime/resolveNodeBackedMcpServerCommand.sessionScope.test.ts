import { afterEach, expect, it, vi } from 'vitest';

import { runAddedHostedSession } from '@/agent/runtime/lifecycle/hostedSessionScope';
import { resolveNodeBackedMcpServerCommand } from './resolveNodeBackedMcpServerCommand';

// Both shipped and source entrypoints are available at this filesystem boundary.
// Runtime selection, packaged-path resolution and Session scope remain real.
vi.mock('node:fs', async importOriginal => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return {
    ...actual,
    existsSync: (path: Parameters<typeof actual.existsSync>[0]) =>
      String(path).replaceAll('\\', '/').endsWith('/mcp/launchers/stdioMcpServerLauncher.mjs')
      || actual.existsSync(path),
  };
});

afterEach(() => vi.unstubAllEnvs());

it('selects each hosted Session MCP entrypoint and preserves explicit packaged selection', async () => {
  vi.stubEnv('HAPPIER_E2E_PROVIDER_USE_CLI_SOURCE_ENTRYPOINT', '0');
  const select = (source: boolean, preferSourceEntrypoint?: boolean) => runAddedHostedSession({
    environment: { ...process.env, HAPPIER_JS_RUNTIME_PATH: process.execPath,
      HAPPIER_E2E_PROVIDER_USE_CLI_SOURCE_ENTRYPOINT: source ? '1' : '0' },
    workingDirectory: '/session', end() {},
  }, async () => {
    await Promise.resolve();
    return resolveNodeBackedMcpServerCommand({
      distEntrypointSegments: ['mcp', 'launchers', 'stdioMcpServerLauncher.mjs'],
      sourceEntrypointSegments: ['mcp', 'launchers', 'stdioMcpServerLauncher.ts'],
      preferSourceEntrypoint,
    });
  });
  const [source, packaged, explicitPackaged] = await Promise.all([
    select(true), select(false), select(true, false),
  ]);
  expect(source.args.some(arg => arg.replaceAll('\\', '/').endsWith('/src/mcp/launchers/stdioMcpServerLauncher.ts'))).toBe(true);
  for (const invocation of [packaged, explicitPackaged]) {
    expect(invocation.args.some(arg => arg.replaceAll('\\', '/').endsWith('/mcp/launchers/stdioMcpServerLauncher.mjs'))).toBe(true);
  }
});
