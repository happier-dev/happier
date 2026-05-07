import { describe, expect, it } from 'vitest';

import {
  CODEX_ACP_DIST_TAG,
  GH_DEP_ID,
  INSTALLABLES_CATALOG,
  INSTALLABLE_KEYS,
} from './installables.js';

describe('installables catalog', () => {
  it('has unique keys', () => {
    const keys = INSTALLABLES_CATALOG.map((e) => e.key);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('has unique capability ids', () => {
    const ids = INSTALLABLES_CATALOG.map((e) => e.capabilityId);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('preserves the legacy dist-tag export for public consumers', () => {
    expect(CODEX_ACP_DIST_TAG).toBe('latest');
  });

  it('registers GitHub CLI as an optional installable dependency', () => {
    const entry = INSTALLABLES_CATALOG.find((item) => item.key === INSTALLABLE_KEYS.GH);

    expect(entry).toMatchObject({
      key: 'gh',
      kind: 'dep',
      capabilityId: GH_DEP_ID,
      sourceKind: 'github_release_binary',
      defaultPolicy: {
        autoInstallWhenNeeded: false,
        autoUpdateMode: 'notify',
      },
      experimental: false,
      source: {
        githubRepo: 'cli/cli',
        binaryName: 'gh',
      },
      fallbackInstall: {
        kind: 'managed_package',
      },
    });
  });
});
