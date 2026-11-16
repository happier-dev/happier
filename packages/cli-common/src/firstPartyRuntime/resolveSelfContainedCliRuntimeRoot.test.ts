import { afterEach, describe, expect, it, vi } from 'vitest';
import { join } from 'node:path';

import { resolvePackagedWindowsServiceLauncherInstallSpec } from '../service/windowsLauncher.js';
import { resolveSelfContainedCliRuntimeRootPath } from './resolveSelfContainedCliRuntimeRoot.js';

const originalArgv = process.argv;
const originalExecPath = Object.getOwnPropertyDescriptor(process, 'execPath');
afterEach(() => {
  vi.unstubAllEnvs();
  process.argv = originalArgv;
  if (originalExecPath) Object.defineProperty(process, 'execPath', originalExecPath);
});

describe('copied executable with an external CLI graph', () => {
  it('resolves support assets beside the loaded graph and preserves other executable roots', () => {
    const execPath = 'C:/installer/runner/happier.exe';
    Object.defineProperty(process, 'execPath', { ...originalExecPath, value: execPath });
    process.argv = [execPath, 'C:/staging/payload/package-dist/index.mjs', 'self', '__install-payload'];
    expect(resolveSelfContainedCliRuntimeRootPath(execPath)).toBe('C:/staging/payload');
    expect(resolvePackagedWindowsServiceLauncherInstallSpec({ execPath }).sourcePath)
      .toBe(join('C:/staging/payload', 'happier-service-launcher.exe'));
    expect(resolveSelfContainedCliRuntimeRootPath('C:/another/payload/happier.exe')).toBe('C:/another/payload');
    expect(resolveSelfContainedCliRuntimeRootPath('C:/tools/node.exe')).toBeNull();
  });
});

describe('admitted physical assets for embedded Bun', () => {
  it.each([
    ['/$bunfs/root/happier', '/runtime/cli/package-dist/index.mjs', '/runtime/cli'],
    ['C:\\~BUN\\root\\happier.exe', 'C:\\runtime\\cli\\package-dist\\index.mjs', 'C:/runtime/cli'],
  ])('resolves the admitted physical runtime from %s for every shared launcher consumer', (execPath, entrypoint, root) => {
    vi.stubEnv('HAPPIER_CLI_SUBPROCESS_RUNTIME_BACKED', '1');
    vi.stubEnv('HAPPIER_CLI_SUBPROCESS_DIST_ENTRYPOINT', entrypoint);
    vi.stubEnv('HAPPIER_CLI_SUBPROCESS_DAEMON_DIST_CLOSURE_FINGERPRINT', 'abcdef1234567890');
    expect(resolveSelfContainedCliRuntimeRootPath(execPath)).toBe(root);
    expect(resolvePackagedWindowsServiceLauncherInstallSpec({ execPath }).sourcePath).toBe(join(root, 'happier-service-launcher.exe'));
  });

  it('does not consume an unadmitted physical entrypoint', () => {
    vi.stubEnv('HAPPIER_CLI_SUBPROCESS_RUNTIME_BACKED', '1');
    vi.stubEnv('HAPPIER_CLI_SUBPROCESS_DIST_ENTRYPOINT', '/untrusted/cli/package-dist/index.mjs');
    vi.stubEnv('HAPPIER_CLI_SUBPROCESS_DAEMON_DIST_CLOSURE_FINGERPRINT', 'invalid');
    expect(resolveSelfContainedCliRuntimeRootPath('/$bunfs/root/happier')).toBe('/$bunfs/root');
  });
});
