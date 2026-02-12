import { describe, expect, it } from 'vitest';

import { buildUsageReportFromAcpTokenCount } from './acpTokenCountUsageReport';

describe('acp token_count -> usage-report', () => {
  it('uses provided key when present and sets cost.total=0', () => {
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

    expect(report).toEqual({
      key: 'turn-1',
      sessionId: 'sess1',
      tokens: { total: 5, input: 2, output: 3 },
      cost: { total: 0 },
    });
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
      body: { type: 'token_count', tokens: { total: 7, input: 4, output: 3 } },
    });

    expect(report).toEqual({
      key: 'gemini-session',
      sessionId: 'sess2',
      tokens: { total: 7, input: 4, output: 3 },
      cost: { total: 0 },
    });
  });

  it('computes total when nested tokens omit total', () => {
    const report = buildUsageReportFromAcpTokenCount({
      provider: 'claude',
      sessionId: 'sess3',
      body: { type: 'token_count', tokens: { input: 4, output: 3 } },
    });

    expect(report).toEqual({
      key: 'claude-session',
      sessionId: 'sess3',
      tokens: { total: 7, input: 4, output: 3 },
      cost: { total: 0 },
    });
  });

  it('does not allow __proto__ keys to mutate cost map prototypes', () => {
    const report = buildUsageReportFromAcpTokenCount({
      provider: 'pi' as any,
      sessionId: 'sess5',
      body: {
        type: 'token_count',
        tokens: { total: 3, input: 1, output: 2 },
        cost: { component: 0.1, __proto__: 1 },
      },
    });

    expect(report).toBeTruthy();
    expect(Object.getPrototypeOf((report as any).cost)).toBeNull();
    expect((report as any).cost.component).toBe(0.1);
    expect((report as any).cost.polluted).toBeUndefined();
  });
});
