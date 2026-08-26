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
        } as never);

        expect(registerAction.mock.calls.map(([id]) => id).sort()).toEqual(
            Object.values(POSTHOG_ACTION_IDS).sort(),
        );
        // The declared purpose doubles as this plugin's connected-account contribution
        // id, so it is spelled as a contribution identifier: a dotted spelling is
        // rejected by the canonical local-id pattern.
        expect(registerAccount)
            .toHaveBeenCalledWith(POSTHOG_CONNECTED_ACCOUNT_PURPOSE, expect.any(Object));
        expect(registerComposerReference).toHaveBeenCalledWith('posthog-evidence', {
            search: expect.any(Function),
            resolve: expect.any(Function),
        });
    });
});
