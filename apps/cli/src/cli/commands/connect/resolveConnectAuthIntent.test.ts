import { describe, expect, it } from 'vitest';

import { resolveConnectAuthIntent } from './resolveConnectAuthIntent';

describe('resolveConnectAuthIntent', () => {
  it('defaults Claude to setup-token when not explicitly opting into OAuth', () => {
    const res = resolveConnectAuthIntent({
      targetId: 'claude',
      options: {
        profileId: 'default',
        paste: false,
        device: false,
        noOpen: false,
        timeoutSeconds: null,
        setupToken: false,
        oauth: false,
      },
    });
    expect(res).toEqual({ kind: 'setup-token' });
  });

  it('allows Claude OAuth when --oauth is specified', () => {
    const res = resolveConnectAuthIntent({
      targetId: 'claude',
      options: {
        profileId: 'default',
        paste: false,
        device: false,
        noOpen: false,
        timeoutSeconds: null,
        setupToken: false,
        oauth: true,
      },
    });
    expect(res).toEqual({ kind: 'oauth' });
  });
});
