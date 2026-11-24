import { describe, expect, it } from 'vitest';

import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { repoRootDir } from '../paths';
import { withWorkspaceSourceRuntime } from './tsxImportHook';
import { buildUiWebExpoProcessEnv, resolveUiWebExportSuiteTimeoutMs } from './uiWebEnv';

describe('UI e2e Expo process environment', () => {
  it('lets Expo load its installed Markdown config plugin in a source-mode suite', () => {
    const suiteEnv = withWorkspaceSourceRuntime({
      ...process.env,
      NODE_OPTIONS: '--enable-source-maps',
      HAPPIER_E2E_UI_WEB_MAX_OLD_SPACE_SIZE_MB: '8192',
    });
    const expoEnv = buildUiWebExpoProcessEnv(suiteEnv);
    const child = spawnSync(process.execPath, ['-e', [
      'const { dirname, join } = require("node:path");',
      'const plugin = join(dirname(require.resolve("react-native-enriched-markdown/package.json")), "app.plugin.js");',
      'require(plugin);',
    ].join(' ')], {
      cwd: resolve(repoRootDir(), 'apps/ui'),
      env: expoEnv,
      encoding: 'utf8',
    });

    expect(child.status, child.error?.message ?? child.stderr).toBe(0);
    expect(expoEnv.NODE_OPTIONS).toContain('--enable-source-maps');
    expect(expoEnv.NODE_OPTIONS).toContain('--max-old-space-size=8192');
    expect(suiteEnv.NODE_OPTIONS).toContain('registerSourceRuntime.mjs');
  });
});

describe('uiWebEnv export suite timeout resolution', () => {
  it('keeps the export suite timeout floor above the slow web export wall time', () => {
    expect(resolveUiWebExportSuiteTimeoutMs({})).toBe(1_800_000);
  });

  it('respects a larger explicit timeout override', () => {
    expect(
      resolveUiWebExportSuiteTimeoutMs({
        HAPPIER_E2E_UI_WEB_EXPORT_TIMEOUT_MS: '900000',
        HAPPIER_E2E_UI_WEB_EXPORT_HARD_TIMEOUT_MS: '2400000',
      }),
    ).toBe(2_400_000);
  });
});
