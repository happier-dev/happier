import { describe, expect, it } from 'vitest';

import { resolveDaemonServiceRuntimeTarget } from './runtimeTarget.js';

describe('resolveDaemonServiceRuntimeTarget', () => {
  it('prefers the bundled package-dist entrypoint when the current runtime executable is bun', () => {
    expect(
      resolveDaemonServiceRuntimeTarget({
        currentExecPath: '/opt/homebrew/bin/bun',
        runtimeExecutable: '/opt/homebrew/bin/bun',
      }),
    ).toEqual({
      nodePath: '/opt/homebrew/bin/bun',
      entryPath: expect.stringContaining('/apps/cli/package-dist/index.mjs'),
    });
  });

  it('prefers the bundled package-dist entrypoint for an explicit managed js runtime wrapper', () => {
    expect(
      resolveDaemonServiceRuntimeTarget({
        currentExecPath: '/Applications/Happier.app/Contents/MacOS/happier',
        explicitNodePath: '/Users/test/.happier/tools/js-runtime/current/bin/happier-js-runtime',
      }),
    ).toEqual({
      nodePath: '/Users/test/.happier/tools/js-runtime/current/bin/happier-js-runtime',
      entryPath: expect.stringContaining('/apps/cli/package-dist/index.mjs'),
    });
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
