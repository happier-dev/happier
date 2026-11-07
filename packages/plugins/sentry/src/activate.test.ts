import { activate as activateAccount } from './accountRuntime.js';
import { describe, expect, it, vi } from 'vitest';

import { activate } from './activate.js';
import { PLUGIN_MANIFEST } from './manifest.js';
import { SENTRY_CONNECTED_ACCOUNT_ID } from './sentryContracts.js';

describe('Sentry plugin activation', () => {
  it('registers exactly the Actions and Connected Account the manifest declares', async () => {
    const registerAction = vi.fn();
    const registerAccount = vi.fn();
    const registerComposerReference = vi.fn();

    await activate({
      actions: { register: registerAction },
      connectedAccounts: { register: registerAccount },
      composerReferences: { register: registerComposerReference },
      backgroundServices: { register: vi.fn() },
      events: { register: vi.fn() },
    } as never);

    activateAccount({ actions: { register: registerAction }, connectedAccounts: { register: vi.fn() } } as never);
    const registered = registerAction.mock.calls.map(([id]) => id).sort();
    // The spine registers exactly the declared Actions: registering an
    // undeclared one, or declaring one nothing implements, is the drift this
    // asserts against.
    expect(registered).toEqual(
      [...PLUGIN_MANIFEST.contributes.actions.map((action) => action.id)].sort(),
    );
    for (const [, handler] of registerAction.mock.calls) {
      expect(typeof handler).toBe('function');
    }
    expect(registerAccount).toHaveBeenCalledWith(
      SENTRY_CONNECTED_ACCOUNT_ID,
      expect.objectContaining({ authentication: expect.any(Object) }),
    );
    // The spine registers the whole authored reference, so the declared
    // presentation travels with the two required handlers rather than being
    // split across a second registration. Asserting the exact shape keeps both
    // a dropped handler and an undeclared extra field failing here.
    expect(registerComposerReference).toHaveBeenCalledWith('sentry-evidence', {
      title: 'Sentry occurrence',
      icon: 'error',
      search: expect.any(Function),
      resolve: expect.any(Function),
    });
  });
});
