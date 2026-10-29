import { describe, expect, it } from 'vitest';

import * as protocol from '../../index.js';

describe('bug report fallback body formatting', () => {
  it('preserves supplied report content, reproduction steps and environment in the fallback body', () => {
    const body = protocol.formatBugReportFallbackIssueBody({
      summary: 'Sessions list flickers between online and inactive.',
      currentBehavior: 'List rapidly changes state on refresh.',
      expectedBehavior: 'List remains stable.',
      reproductionSteps: ['Open Sessions', 'Pull to refresh'],
      frequency: 'often',
      severity: 'medium',
      whatChangedRecently: 'Updated from 0.12.2 → 0.12.3.',
      diagnosticsIncluded: false,
      environment: {
        appVersion: '0.12.5',
        platform: 'ios',
        osVersion: '18.2',
        deviceModel: 'iPhone16,2',
        deploymentType: 'cloud',
        serverUrl: 'https://api.happier.dev',
        serverVersion: '0.12.4',
      },
    });

    expect(body).toContain('Sessions list flickers between online and inactive.');
    expect(body).toContain('List rapidly changes state on refresh.');
    expect(body).toContain('List remains stable.');
    expect(body).toContain('1. Open Sessions\n2. Pull to refresh');
    expect(body).toContain('often');
    expect(body).toContain('medium');
    expect(body).toContain('0.12.5');
    expect(body).toContain('ios');
    expect(body).toContain('18.2');
    expect(body).toContain('iPhone16,2');
    expect(body).toContain('0.12.4');
    expect(body).toContain('cloud');
    expect(body).toContain('Diagnostics: not included');
    expect(body).toContain('Updated from 0.12.2 → 0.12.3.');
  });
});

