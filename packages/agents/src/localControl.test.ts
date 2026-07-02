import { describe, expect, it } from 'vitest';

import {
  getAgentLocalControlCapability,
  usesProviderAttachForLocalControl,
  usesTerminalHostedLocalControl,
} from './localControl';

describe('agent local control capability', () => {
  it('exposes shared provider-attach local control for opencode', () => {
    expect(getAgentLocalControlCapability('opencode')).toEqual({
      supported: true,
      topology: 'shared',
      attachStrategy: 'provider_attach',
      remoteWritable: true,
    });
    expect(usesProviderAttachForLocalControl('opencode')).toBe(true);
    expect(usesTerminalHostedLocalControl('opencode')).toBe(false);
  });

  it('exposes terminal-hosted exclusive local control for claude', () => {
    expect(getAgentLocalControlCapability('claude')).toEqual({
      supported: true,
      topology: 'exclusive',
      attachStrategy: 'terminal_host',
      remoteWritable: false,
    });
    expect(usesProviderAttachForLocalControl('claude')).toBe(false);
    expect(usesTerminalHostedLocalControl('claude')).toBe(true);
  });

  it('returns null for providers without local control', () => {
    expect(getAgentLocalControlCapability('gemini')).toBeNull();
    expect(usesProviderAttachForLocalControl('gemini')).toBe(false);
    expect(usesTerminalHostedLocalControl('gemini')).toBe(false);
  });
});
