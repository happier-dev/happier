import { describe, expect, it } from 'vitest';

import { resolveUiWebExportStartupStallTimeoutMs } from './createUiWebExportStartupStallGuard';

describe('resolveUiWebExportStartupStallTimeoutMs', () => {
  it('keeps the default watchdog budget when no override is set', () => {
    expect(resolveUiWebExportStartupStallTimeoutMs({} as NodeJS.ProcessEnv)).toBe(60_000);
  });

  it('caps oversized suite-specific stall overrides to the watchdog maximum', () => {
    expect(
      resolveUiWebExportStartupStallTimeoutMs({
        HAPPIER_E2E_UI_WEB_EXPORT_STARTUP_STALL_TIMEOUT_MS: '600000',
      } as NodeJS.ProcessEnv),
    ).toBe(60_000);
  });

  it('preserves oversized explicit stall overrides when export fallback to Metro is disabled', () => {
    expect(
      resolveUiWebExportStartupStallTimeoutMs({
        HAPPIER_E2E_UI_WEB_EXPORT_STARTUP_STALL_TIMEOUT_MS: '600000',
        HAPPIER_E2E_UI_WEB_EXPORT_FALLBACK_TO_METRO: '0',
      } as NodeJS.ProcessEnv),
    ).toBe(600_000);
  });

  it('preserves smaller explicit overrides for targeted tests', () => {
    expect(
      resolveUiWebExportStartupStallTimeoutMs({
        HAPPIER_E2E_UI_WEB_EXPORT_STARTUP_STALL_TIMEOUT_MS: '250',
      } as NodeJS.ProcessEnv),
    ).toBe(250);
  });
});
