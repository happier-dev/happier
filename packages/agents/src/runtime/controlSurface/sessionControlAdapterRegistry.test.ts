import { describe, expect, it } from 'vitest';

import { CODEX_SESSION_CONTROL_ADAPTER } from '../../providers/codex/sessionControlAdapter.js';
import { OPENCODE_SESSION_CONTROL_ADAPTER } from '../../providers/opencode/sessionControlAdapter.js';
import { PI_SESSION_CONTROL_ADAPTER } from '../../providers/pi/sessionControlAdapter.js';
import {
  PROVIDER_SESSION_CONTROL_ADAPTER_PROVIDER_IDS,
  getProviderSessionControlAdapter,
} from './sessionControlAdapterRegistry.js';

describe('sessionControlAdapterRegistry', () => {
  it('exposes only the providers that own session-control adapters', () => {
    expect(PROVIDER_SESSION_CONTROL_ADAPTER_PROVIDER_IDS).toEqual(['codex', 'opencode', 'pi']);
  });

  it('routes each supported provider id to its provider-owned adapter and nothing else', () => {
    expect(getProviderSessionControlAdapter('codex')).toBe(CODEX_SESSION_CONTROL_ADAPTER);
    expect(getProviderSessionControlAdapter('opencode')).toBe(OPENCODE_SESSION_CONTROL_ADAPTER);
    expect(getProviderSessionControlAdapter('pi')).toBe(PI_SESSION_CONTROL_ADAPTER);
    expect(getProviderSessionControlAdapter('claude')).toBeNull();
    expect(getProviderSessionControlAdapter('customAcp')).toBeNull();
  });
});
