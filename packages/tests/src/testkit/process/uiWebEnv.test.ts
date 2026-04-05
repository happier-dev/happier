import { describe, expect, it } from 'vitest';

import { resolveUiWebExportSuiteTimeoutMs } from './uiWebEnv';

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
