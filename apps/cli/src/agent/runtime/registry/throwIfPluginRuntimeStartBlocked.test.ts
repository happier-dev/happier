import { describe, expect, it } from 'vitest';

import { throwIfPluginRuntimeStartBlocked } from './throwIfPluginRuntimeStartBlocked';

function createExternalResolution(diagnostic: Readonly<{
  code: 'engine_plugin_registry_diagnostic' | 'engine_plugin_daemon_module_load_failed';
  detailCode: 'plugin_trust_approval_required' | 'plugin_untrusted';
  message: string;
}>) {
  return {
    provenance: 'external',
    diagnostics: [diagnostic],
  } as never;
}

describe('throwIfPluginRuntimeStartBlocked', () => {
  it.each([
    ['plugin_trust_approval_required', /trust approval is required/i],
    ['plugin_untrusted', /untrusted source/i],
  ] as const)(
    'blocks activation-registry %s diagnostics before a missing runtime can execute',
    (detailCode, expected) => {
      expect(() => throwIfPluginRuntimeStartBlocked(createExternalResolution({
        code: 'engine_plugin_registry_diagnostic',
        detailCode,
        message: 'activation was blocked',
      }))).toThrow(expected);
    },
  );

  it('continues to block daemon-surface trust diagnostics', () => {
    expect(() => throwIfPluginRuntimeStartBlocked(createExternalResolution({
      code: 'engine_plugin_daemon_module_load_failed',
      detailCode: 'plugin_trust_approval_required',
      message: 'surface load was blocked',
    }))).toThrow(/trust approval is required/i);
  });
});
