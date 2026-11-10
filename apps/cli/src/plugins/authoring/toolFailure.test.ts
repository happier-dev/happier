import { describe, expect, it } from 'vitest';
import { preparePluginAuthorDependencies, runPluginAuthorToolchain, type PluginAuthorToolchainDeps } from './toolchain';

describe('author child failure diagnostics', () => {
  it.each(['returned', 'thrown'] as const)('surfaces a bounded redacted stderr tail and exit code for %s failures', async (kind) => {
    const credential = ['fixture', 'credential', 'value'].join('-');
    const stderr = `obsolete output\n${'x'.repeat(20_000)}\nERR_AUTHOR_PREP token=${credential}`;
    const deps: PluginAuthorToolchainDeps = {
      ensureManagedPnpmCommand: async () => '/happier/tools/pnpm/current/bin/pnpm',
      managedPnpmBinPath: () => '/happier/tools/pnpm/current/bin/pnpm',
      buildManagedPnpmEnvironment: (env = {}) => env,
      ensureManagedJavaScriptRuntimeCommand: async () => null,
      managedJavaScriptRuntimeBinPath: () => '/unused',
      resolveNativeTypeScriptBin: () => '/unused',
      spawn: async () => {
        if (kind === 'thrown') throw Object.assign(new Error('child failed'), { code: 23, stderr });
        return { exitCode: 23, signal: null, stderr, stdout: '' };
      },
      processEnv: {},
    };
    const prepared = await preparePluginAuthorDependencies({ projectRoot: '/fixture/plugin' }, deps);
    const installed = await runPluginAuthorToolchain({ operation: 'install', projectRoot: '/fixture/plugin' }, deps);
    expect(prepared.ok).toBe(false);
    expect(installed.ok).toBe(false);
    if (prepared.ok || installed.ok) throw new Error('expected child failure');
    for (const diagnostic of [prepared.diagnostic, ...installed.diagnostics]) {
      expect(diagnostic.code).toBe('plugin_author_tool_failed');
      expect(diagnostic.message).toContain('23');
      expect(diagnostic.message).toContain('ERR_AUTHOR_PREP');
      expect(diagnostic.message.includes(credential)).toBe(false);
      expect(diagnostic.message).not.toContain('obsolete output');
      expect(Buffer.byteLength(diagnostic.message)).toBeLessThan(9_000);
    }
  });
});
