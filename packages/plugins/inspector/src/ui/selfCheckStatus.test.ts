import { describe, expect, it } from 'vitest';

import { readInspectorSelfCheckStatus } from './selfCheckStatus.js';

const text = (_key: string, fallback?: string): string => fallback ?? '';

describe('the Inspector self-check status', () => {
  it('keeps a passed check quiet and colours only a failure', () => {
    expect(readInspectorSelfCheckStatus('not-run', text)).toEqual({ label: 'Self-check not run yet', tone: 'secondary' });
    expect(readInspectorSelfCheckStatus('success', text)).toEqual({ label: 'Self-check passed', tone: 'secondary' });
    expect(readInspectorSelfCheckStatus('failed', text)).toEqual({ label: 'Self-check failed', tone: 'danger' });
  });
});
