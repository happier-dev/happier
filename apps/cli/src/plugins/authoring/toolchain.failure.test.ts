import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { registerSensitiveDiagnosticValues } from '@happier-dev/protocol/bugs/reports/redaction';
import { runPluginAuthorToolchain, type PluginAuthorToolchainDeps } from './toolchain';

describe('author dependency child failures', () => {
  it.each(['exit', 'throw'] as const)('surfaces the child code and redacted diagnostic for %s failures', async (kind) => {
    const sensitiveValue = randomUUID();
    const registration = registerSensitiveDiagnosticValues([sensitiveValue]);
    const diagnostic = `src/index.ts(7,17): error TS2883: inferred type cannot be named ${sensitiveValue}`;
    const deps: PluginAuthorToolchainDeps = {
      ensureManagedPnpmCommand: async () => '/happier/tools/pnpm',
      managedPnpmBinPath: () => '/happier/tools/pnpm',
      buildManagedPnpmEnvironment: (env = {}) => env,
      ensureManagedJavaScriptRuntimeCommand: async () => '/happier/tools/js-runtime',
      managedJavaScriptRuntimeBinPath: () => '/happier/tools/js-runtime',
      resolveNativeTypeScriptBin: () => '/unused/compiler',
      resolvePluginUiBuildBin: () => '/unused/ui',
      spawn: async () => {
        if (kind === 'throw') throw Object.assign(new Error('Child tool failed'), {
          code: 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER', stderr: diagnostic, stdout: '',
        });
        return { exitCode: 2, signal: null, stderr: diagnostic, stdout: '' };
      },
      processEnv: {},
    };
    try {
      const result = await runPluginAuthorToolchain({ operation: 'install', projectRoot: '/fixture/isolated-author' }, deps);
      expect(result.ok).toBe(false);
      if (result.ok) throw new Error('Expected dependency refusal');
      expect(result.diagnostics[0]?.code).toBe('plugin_author_tool_failed');
      expect(result.diagnostics[0]?.message).toContain(kind === 'throw' ? 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER' : '2');
      expect(result.diagnostics[0]?.message).toContain('TS2883');
      expect(result.diagnostics[0]?.message).not.toContain(sensitiveValue);
    } finally {
      registration.close();
    }
  });
});
