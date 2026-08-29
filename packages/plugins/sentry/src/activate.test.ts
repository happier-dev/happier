import { describe, expect, it, vi } from 'vitest';

import { activate } from './activate.js';
import { PLUGIN_MANIFEST, SENTRY_ACTION_IDS } from './manifest.js';
import { SENTRY_CONNECTED_ACCOUNT_ID } from './sentryContracts.js';

describe('Sentry plugin activation', () => {
  it('registers exactly the Actions and Connected Account the manifest declares', () => {
    const registerAction = vi.fn();
    const registerAccount = vi.fn();
    const registerComposerReference = vi.fn();

    activate({
      actions: { register: registerAction },
      connectedAccounts: { register: registerAccount },
      composerReferences: { register: registerComposerReference },
    } as never);

    const registered = registerAction.mock.calls.map(([id]) => id).sort();
    // The spine registers exactly the declared Actions: registering an
    // undeclared one, or declaring one nothing implements, is the drift this
    // asserts against.
    expect(registered).toEqual(
      [...PLUGIN_MANIFEST.contributes.actions.map((action) => action.id)].sort(),
    );
    expect(registered).toEqual([
      SENTRY_ACTION_IDS.get,
      SENTRY_ACTION_IDS.listInstances,
      SENTRY_ACTION_IDS.listIssueEvents,
      SENTRY_ACTION_IDS.listTagValues,
      SENTRY_ACTION_IDS.readEvent,
      SENTRY_ACTION_IDS.readIssue,
      SENTRY_ACTION_IDS.scan,
    ].sort());
    for (const [, handler] of registerAction.mock.calls) {
      expect(typeof handler).toBe('function');
    }
    expect(registerAccount).toHaveBeenCalledWith(
      SENTRY_CONNECTED_ACCOUNT_ID,
      expect.objectContaining({ authentication: expect.any(Object) }),
    );
    expect(registerComposerReference).toHaveBeenCalledWith('sentry-evidence', {
      search: expect.any(Function),
      resolve: expect.any(Function),
    });
  });
});
