import { describe, expect, it } from 'vitest';
import { DEFAULT_BUG_REPORTS_FEATURE as DEFAULT_PROTOCOL_BUG_REPORTS_FEATURE } from '@happier-dev/protocol';

import { DEFAULT_BUG_REPORT_FEATURE } from './bugReportFeatureDefaults';

describe('DEFAULT_BUG_REPORT_FEATURE', () => {
  it('uses protocol-aligned upload timeout fallback', () => {
    expect(DEFAULT_BUG_REPORT_FEATURE.uploadTimeoutMs).toBe(120_000);
  });

  it('uses protocol-aligned diagnostics context window fallback', () => {
    expect(DEFAULT_BUG_REPORT_FEATURE.contextWindowMs).toBe(30 * 60 * 1_000);
  });

  it('matches protocol default feature contract', () => {
    expect(DEFAULT_BUG_REPORT_FEATURE).toEqual(DEFAULT_PROTOCOL_BUG_REPORTS_FEATURE);
  });
});
