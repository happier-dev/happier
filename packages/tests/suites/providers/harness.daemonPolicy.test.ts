import { describe, expect, it } from 'vitest';

import { shouldStartProviderDaemon } from '../../src/testkit/providers/harness/harnessSignals';

describe('providers harness: daemon startup policy', () => {
  it('starts daemon for ACP providers by default', () => {
    expect(
      shouldStartProviderDaemon({
        providerProtocol: 'acp',
        hasPostSatisfyRunHook: false,
      }),
    ).toBe(true);
  });

  it('still starts daemon for ACP providers with postSatisfy hooks', () => {
    expect(
      shouldStartProviderDaemon({
        providerProtocol: 'acp',
        hasPostSatisfyRunHook: true,
      }),
    ).toBe(true);
  });

  it('does not start daemon for non-ACP providers', () => {
    expect(
      shouldStartProviderDaemon({
        providerProtocol: 'codex',
        hasPostSatisfyRunHook: true,
      }),
    ).toBe(false);
    expect(
      shouldStartProviderDaemon({
        providerProtocol: 'claude',
        hasPostSatisfyRunHook: false,
      }),
    ).toBe(false);
  });
});

