import { describe, expect, it } from 'vitest';

import { KiroTransport } from './transport';

const DEFAULT_STDERR_CONTEXT = {
  activeToolCalls: new Set<string>(),
  hasActiveInvestigation: false,
} as const;

describe('KiroTransport handleStderr', () => {
  it('suppresses optional _kiro.dev notification method-not-found noise', () => {
    const transport = new KiroTransport();
    expect(
      transport.handleStderr(
        `Error handling notification {"jsonrpc":"2.0","method":"_kiro.dev/metadata"} {"code":-32601,"message":"\\"Method not found\\": _kiro.dev/metadata"}`,
        DEFAULT_STDERR_CONTEXT,
      ),
    ).toEqual({ message: null, suppress: true });
  });

  it('keeps unrelated stderr diagnostics visible to the generic transport path', () => {
    const transport = new KiroTransport();
    expect(
      transport.handleStderr('non-actionable warning', DEFAULT_STDERR_CONTEXT),
    ).toEqual({ message: null, suppress: false });
  });
});
