import { describe, expect, it } from 'vitest';

import * as protocol from './index.js';

describe('bug report fallback body formatting', () => {
  it('formats a fallback issue body using the same section titles as the GitHub issue form', () => {
    const fn = (protocol as unknown as { formatBugReportFallbackIssueBody?: unknown }).formatBugReportFallbackIssueBody;
    expect(typeof fn).toBe('function');
    if (typeof fn !== 'function') return;

    const body = (fn as (input: any) => string)({
      summary: 'Sessions list flickers between online and inactive.',
      currentBehavior: 'List rapidly changes state on refresh.',
      expectedBehavior: 'List remains stable.',
      reproductionSteps: ['Open Sessions', 'Pull to refresh'],
      frequency: 'often',
      severity: 'medium',
      whatChangedRecently: 'Updated from 0.12.2 → 0.12.3.',
      diagnosticsIncluded: false,
      environment: {
        appVersion: '0.12.3',
        platform: 'ios',
        osVersion: '18.2',
        deviceModel: 'iPhone16,2',
        deploymentType: 'cloud',
        serverUrl: 'https://api.happier.dev',
        serverVersion: '0.12.3',
      },
    });

    expect(body).toContain('### Summary');
    expect(body).toContain('### What happened (current behavior)');
    expect(body).toContain('### Expected behavior');
    expect(body).toContain('### Reproduction steps');
    expect(body).toContain('### Frequency');
    expect(body).toContain('### Severity');
    expect(body).toContain('### Happier version');
    expect(body).toContain('### Platform');
    expect(body).toContain('### Server version');
    expect(body).toContain('### Deployment type');
    expect(body).toContain('### Diagnostics');
    expect(body).toContain('### What changed recently?');
  });
});

