import { describe, expect, it } from 'vitest';

import {
  CODEX_PROVIDER_BINDING_RUNTIME_RANGE_V1,
  resolveCodexProviderBindingRuntimeVersionV1,
} from './version.js';

describe('Codex provider-binding runtime version', () => {
  it('accepts stable Codex releases from the validated managed 0.147 contract with no arbitrary upper cap', () => {
    expect(resolveCodexProviderBindingRuntimeVersionV1('codex-cli 0.147.0')).toEqual({
      ok: true,
      version: '0.147.0',
    });
    expect(resolveCodexProviderBindingRuntimeVersionV1('codex-cli 0.147.9')).toEqual({
      ok: true,
      version: '0.147.9',
    });
    expect(resolveCodexProviderBindingRuntimeVersionV1('codex-cli 0.200.0')).toEqual({
      ok: true,
      version: '0.200.0',
    });
    expect(resolveCodexProviderBindingRuntimeVersionV1('codex-cli 1.0.0')).toEqual({
      ok: true,
      version: '1.0.0',
    });
    expect(CODEX_PROVIDER_BINDING_RUNTIME_RANGE_V1).toEqual({
      minInclusive: '0.147.0',
    });
  });

  it('fails closed for a stable version below the minimum or an invalid version shape', () => {
    for (const versionOutput of [
      'codex-cli 0.146.9',
      'codex-cli 0.147.0-alpha.1',
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
