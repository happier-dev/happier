import { activate as activateAccount } from './accountRuntime.js';
import { describe, expect, it, vi } from 'vitest';

import { activate } from './activate.js';
import { POSTHOG_ACTION_IDS, POSTHOG_CONNECTED_ACCOUNT_PURPOSE } from './manifest.js';

describe('PostHog plugin activation', () => {
    it('registers its generated actions and Connected Account runtime', async () => {
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
        expect(registerAction.mock.calls.map(([id]) => id).sort()).toEqual(
            Object.values(POSTHOG_ACTION_IDS).sort(),
        );
        // The declared purpose doubles as this plugin's connected-account contribution
        // id, so it is spelled as a contribution identifier: a dotted spelling is
        // rejected by the canonical local-id pattern.
        expect(registerAccount)
            .toHaveBeenCalledWith(POSTHOG_CONNECTED_ACCOUNT_PURPOSE, expect.any(Object));
        // Registration carries the whole authored reference: the declared
        // presentation arrives with the two required handlers in one call, so the
        // exact shape asserts both that neither handler was dropped and that no
        // undeclared field was added.
        expect(registerComposerReference).toHaveBeenCalledWith('posthog-evidence', {
            title: 'PostHog occurrence',
            icon: 'error',
            search: expect.any(Function),
            resolve: expect.any(Function),
        });
    });
});
