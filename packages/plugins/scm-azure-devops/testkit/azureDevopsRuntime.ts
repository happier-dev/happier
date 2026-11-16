import type { HostingProviderRuntimeServices } from '@happier-dev/plugin-sdk/scm/hosting';
import { expect, vi } from 'vitest';

/** Native Azure CLI process boundary; all adapter parsing and decisions remain real. */
export function createAzureDevopsCommandRuntime(respond: (args: readonly string[]) => unknown): HostingProviderRuntimeServices {
  return {
    executeCommand: vi.fn(async ({ executable, args }) => {
      expect(executable).toEqual({ kind: 'systemTool', id: 'azure-cli' });
      const value = respond(args);
      return value instanceof Error
        ? { ok: false, stdout: '', stderr: value.message, exitCode: 1 }
        : { ok: true, stdout: JSON.stringify(value ?? {}), stderr: '', exitCode: 0 };
    }),
  };
}
