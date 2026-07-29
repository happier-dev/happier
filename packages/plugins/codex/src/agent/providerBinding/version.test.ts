import { describe, expect, it } from 'vitest';

import {
  CODEX_PROVIDER_BINDING_RUNTIME_RANGE_V1,
  resolveCodexProviderBindingRuntimeVersionV1,
} from './version.js';

describe('Codex provider-binding runtime version', () => {
  it('accepts the source-audited Codex 0.144 and 0.145 release lines', () => {
    expect(resolveCodexProviderBindingRuntimeVersionV1('codex-cli 0.144.0')).toEqual({
      ok: true,
      version: '0.144.0',
    });
    expect(resolveCodexProviderBindingRuntimeVersionV1('codex-cli 0.144.9')).toEqual({
      ok: true,
      version: '0.144.9',
    });
    expect(resolveCodexProviderBindingRuntimeVersionV1('codex-cli 0.145.0')).toEqual({
      ok: true,
      version: '0.145.0',
    });
    expect(resolveCodexProviderBindingRuntimeVersionV1('codex-cli 0.145.9')).toEqual({
      ok: true,
      version: '0.145.9',
    });
    expect(CODEX_PROVIDER_BINDING_RUNTIME_RANGE_V1).toEqual({
      minInclusive: '0.144.0',
      maxExclusive: '0.146.0',
    });
  });

  it('fails closed with one stable diagnostic outside the audited release line', () => {
    for (const versionOutput of [
      'codex-cli 0.143.9',
      'codex-cli 0.146.0',
      'codex-cli 0.144.0-alpha.1',
      'not-a-version',
      '',
    ]) {
      expect(resolveCodexProviderBindingRuntimeVersionV1(versionOutput)).toMatchObject({
        ok: false,
        reasonCode: 'codex_provider_runtime_unsupported',
        supportedRange: CODEX_PROVIDER_BINDING_RUNTIME_RANGE_V1,
      });
    }
  });
});
