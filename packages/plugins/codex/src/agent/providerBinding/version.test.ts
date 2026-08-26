import { describe, expect, it } from 'vitest';

import {
  CODEX_PROVIDER_BINDING_RUNTIME_RANGE_V1,
  resolveCodexProviderBindingRuntimeVersionV1,
} from './version.js';

describe('Codex provider-binding runtime version', () => {
  it('accepts stable Codex releases from the 0.144 minimum, including the managed 0.147 line', () => {
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
    expect(resolveCodexProviderBindingRuntimeVersionV1('codex-cli 0.146.0')).toEqual({
      ok: true,
      version: '0.146.0',
    });
    expect(resolveCodexProviderBindingRuntimeVersionV1('codex-cli 0.146.1')).toEqual({
      ok: true,
      version: '0.146.1',
    });
    expect(resolveCodexProviderBindingRuntimeVersionV1('codex-cli 0.147.0')).toEqual({
      ok: true,
      version: '0.147.0',
    });
    expect(resolveCodexProviderBindingRuntimeVersionV1('codex-cli 0.147.9')).toEqual({
      ok: true,
      version: '0.147.9',
    });
    expect(CODEX_PROVIDER_BINDING_RUNTIME_RANGE_V1).toEqual({
      minInclusive: '0.144.0',
    });
  });

  it('fails closed for a stable version below the minimum or an invalid version shape', () => {
    for (const versionOutput of [
      'codex-cli 0.143.9',
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
