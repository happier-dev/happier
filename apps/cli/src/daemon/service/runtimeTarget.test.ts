import { describe, expect, it } from 'vitest';

import { resolveDaemonServiceRuntimeTarget } from './runtimeTarget.js';

function expectPackagedRuntimeEntrypoint(entryPath: string): void {
  expect(entryPath.replaceAll('\\', '/')).toMatch(/\/apps\/cli\/(?:package-dist|dist)\/index\.mjs$/);
}

describe('resolveDaemonServiceRuntimeTarget', () => {
  it('prefers the bundled package-dist entrypoint when the current runtime executable is bun', () => {
    const resolved = resolveDaemonServiceRuntimeTarget({
      currentExecPath: '/opt/homebrew/bin/bun',
      runtimeExecutable: '/opt/homebrew/bin/bun',
    });
    expect(resolved.nodePath).toBe('/opt/homebrew/bin/bun');
    expectPackagedRuntimeEntrypoint(resolved.entryPath);
  });

  it('prefers the bundled package-dist entrypoint for an explicit managed js runtime wrapper', () => {
    const resolved = resolveDaemonServiceRuntimeTarget({
      currentExecPath: '/Applications/Happier.app/Contents/MacOS/happier',
      explicitNodePath: '/Users/test/.happier/tools/js-runtime/current/bin/happier-js-runtime',
    });
    expect(resolved.nodePath).toBe('/Users/test/.happier/tools/js-runtime/current/bin/happier-js-runtime');
    expectPackagedRuntimeEntrypoint(resolved.entryPath);
  });

  it('keeps an empty entrypoint for a self-contained binary with no explicit runtime override', () => {
    expect(
      resolveDaemonServiceRuntimeTarget({
        currentExecPath: '/Applications/Happier.app/Contents/MacOS/happier',
      }),
    ).toEqual({
      nodePath: '/Applications/Happier.app/Contents/MacOS/happier',
      entryPath: '',
    });
  });
});
