import { describe, expect, it } from 'vitest';

import { buildUsageReportFromAcpTokenCount } from './acpTokenCountUsageReport';

describe('acp token_count -> usage-report', () => {
  it('omits a legacy accounting report when counted total and cost were not measured', () => {
    const report = buildUsageReportFromAcpTokenCount({
      provider: 'qwen',
      sessionId: 'sess1',
      body: {
        type: 'token_count',
        key: 'turn-1',
        input_tokens: 2,
        output_tokens: 3,
      },
    });

    expect(report).toBeNull();
  });

  it('includes cost.total when provided on the token_count body', () => {
    const report = buildUsageReportFromAcpTokenCount({
      provider: 'pi' as any,
      sessionId: 'sess4',
      body: {
        type: 'token_count',
        key: 'turn-2',
        tokens: { total: 10, input: 4, output: 6 },
        cost: { total: 0.42 },
      },
    });

    expect(report).toEqual({
      key: 'turn-2',
      sessionId: 'sess4',
      tokens: { total: 10, input: 4, output: 6 },
      cost: { total: 0.42 },
    });
  });

  it('falls back to a per-provider session key when none is present', () => {
    const report = buildUsageReportFromAcpTokenCount({
      provider: 'gemini',
      sessionId: 'sess2',
      body: { type: 'token_count', tokens: { total: 7, input: 4, output: 3 }, cost: { total: 0 } },
    });

    expect(report).toEqual({
      key: 'gemini-session',
      sessionId: 'sess2',
      tokens: { total: 7, input: 4, output: 3 },
      cost: { total: 0 },
    });
  });

  it('omits a legacy accounting report when nested tokens omit total', () => {
    const report = buildUsageReportFromAcpTokenCount({
      provider: 'claude',
      sessionId: 'sess3',
      body: { type: 'token_count', tokens: { input: 4, output: 3 } },
    });

    expect(report).toBeNull();
  });

  it('does not allow __proto__ keys to mutate cost map prototypes', () => {
    const cost = { total: 0.1, component: 0.1, ['__proto__']: 1 };
    expect(Object.hasOwn(cost, '__proto__')).toBe(true);
    const report = buildUsageReportFromAcpTokenCount({
      provider: 'pi' as any,
      sessionId: 'sess5',
      body: {
        type: 'token_count',
        tokens: { total: 3, input: 1, output: 2 },
        cost,
      },
    });

    expect(report).toBeTruthy();
    if (!report) throw new Error('Expected numeric usage report');
    expect(Object.getPrototypeOf(report.cost)).toBeNull();
    expect(report.cost.component).toBe(0.1);
    expect(Object.hasOwn(report.cost, '__proto__')).toBe(false);
    expect(report.cost.polluted).toBeUndefined();
  });

  it('strips semantic cost fields from legacy usage-report payloads', () => {
    const report = buildUsageReportFromAcpTokenCount({
      provider: 'claude',
      sessionId: 'sess6',
      body: {
        type: 'token_count',
        key: 'turn-3',
        tokens: { total: 12, input: 7, output: 5 },
        cost: {
          total: 0.42,
          reportedUsd: 0.42,
          estimatedUsd: 0.99,
          invoiceUsd: 0.2,
          billingContext: 'api_usage',
          costSource: 'provider_reported',
        },
      },
    });

    expect(report).toEqual({
      key: 'turn-3',
      sessionId: 'sess6',
      tokens: { total: 12, input: 7, output: 5 },
      cost: { total: 0.42 },
    });
  });
});
