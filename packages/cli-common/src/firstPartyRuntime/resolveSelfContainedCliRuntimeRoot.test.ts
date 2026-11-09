import { afterEach, describe, expect, it, vi } from 'vitest';

import { resolvePackagedWindowsServiceLauncherInstallSpec } from '../service/windowsLauncher.js';
import { resolveSelfContainedCliRuntimeRootPath } from './resolveSelfContainedCliRuntimeRoot.js';

afterEach(() => vi.unstubAllEnvs());

describe('admitted physical assets for embedded Bun', () => {
  it.each([
    ['/$bunfs/root/happier', '/runtime/cli/package-dist/index.mjs', '/runtime/cli'],
    ['C:\\~BUN\\root\\happier.exe', 'C:\\runtime\\cli\\package-dist\\index.mjs', 'C:/runtime/cli'],
  ])('resolves the admitted physical runtime from %s for every shared launcher consumer', (execPath, entrypoint, root) => {
    vi.stubEnv('HAPPIER_CLI_SUBPROCESS_RUNTIME_BACKED', '1');
    vi.stubEnv('HAPPIER_CLI_SUBPROCESS_DIST_ENTRYPOINT', entrypoint);
    vi.stubEnv('HAPPIER_CLI_SUBPROCESS_DAEMON_DIST_CLOSURE_FINGERPRINT', 'abcdef1234567890');
    expect(resolveSelfContainedCliRuntimeRootPath(execPath)).toBe(root);
    expect(resolvePackagedWindowsServiceLauncherInstallSpec({ execPath }).sourcePath).toBe(`${root}/happier-service-launcher.exe`);
  });

  it('does not consume an unadmitted physical entrypoint', () => {
    vi.stubEnv('HAPPIER_CLI_SUBPROCESS_RUNTIME_BACKED', '1');
    vi.stubEnv('HAPPIER_CLI_SUBPROCESS_DIST_ENTRYPOINT', '/untrusted/cli/package-dist/index.mjs');
    vi.stubEnv('HAPPIER_CLI_SUBPROCESS_DAEMON_DIST_CLOSURE_FINGERPRINT', 'invalid');
    expect(resolveSelfContainedCliRuntimeRootPath('/$bunfs/root/happier')).toBe('/$bunfs/root');
  });
});
