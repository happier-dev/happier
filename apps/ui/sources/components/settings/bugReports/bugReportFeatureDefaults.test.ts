import { describe, expect, it } from 'vitest';
import { DEFAULT_BUG_REPORTS_CAPABILITIES as DEFAULT_PROTOCOL_BUG_REPORTS_CAPABILITIES } from '@happier-dev/protocol';

import { DEFAULT_BUG_REPORT_CAPABILITIES } from './bugReportFeatureDefaults';

describe('DEFAULT_BUG_REPORT_CAPABILITIES', () => {
  it('uses protocol-aligned upload timeout fallback', () => {
    expect(DEFAULT_BUG_REPORT_CAPABILITIES.uploadTimeoutMs).toBe(120_000);
  });

  it('uses protocol-aligned diagnostics context window fallback', () => {
    expect(DEFAULT_BUG_REPORT_CAPABILITIES.contextWindowMs).toBe(30 * 60 * 1_000);
  });

  it('matches protocol default feature contract', () => {
    expect(DEFAULT_BUG_REPORT_CAPABILITIES).toEqual(DEFAULT_PROTOCOL_BUG_REPORTS_CAPABILITIES);
  });
});
