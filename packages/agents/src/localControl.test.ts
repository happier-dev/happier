import { describe, expect, it } from 'vitest';

import { getAgentLocalControlCapability, usesProviderAttachForLocalControl } from './localControl';

describe('agent local control capability', () => {
  it('exposes shared provider-attach local control for opencode', () => {
    expect(getAgentLocalControlCapability('opencode')).toEqual({
      supported: true,
      topology: 'shared',
      attachStrategy: 'provider_attach',
    });
    expect(usesProviderAttachForLocalControl('opencode')).toBe(true);
  });

  it('exposes tmux-backed exclusive local control for claude', () => {
    expect(getAgentLocalControlCapability('claude')).toEqual({
      supported: true,
      topology: 'exclusive',
      attachStrategy: 'tmux',
    });
    expect(usesProviderAttachForLocalControl('claude')).toBe(false);
  });

  it('returns null for providers without local control', () => {
    expect(getAgentLocalControlCapability('gemini')).toBeNull();
    expect(usesProviderAttachForLocalControl('gemini')).toBe(false);
  });
});
