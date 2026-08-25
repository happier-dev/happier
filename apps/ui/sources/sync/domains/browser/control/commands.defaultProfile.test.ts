import type { BrowserCommandV1 } from '@happier-dev/protocol';
import { describe, expect, it } from 'vitest';

import { shouldSurfaceBrowserPrivacy } from '@/components/browser/profile/browserPrivacyVisibility';
import { LOCAL_BROWSER_PROFILE_ID, LOCAL_BROWSER_PROFILE } from '../profiles/localBrowserProfile';
import { dispatchBrowserControlCommand } from './commands';
import { createBrowserControlState } from './reducer';

/**
 * SB-H: there must be exactly one "default browser profile id". `control/commands.ts` used to
 * synthesize `browser_profile_default` for the session it creates on `openView`, while
 * `browserPrivacyVisibility.ts` decides whether to show profile chrome by comparing against
 * `browser_profile_local`. The two never met only because `BrowserSurfaceHost` always rebuilds the
 * model from the hard-coded singleton — a single wiring change away from permanently pinning the
 * privacy popover open on a clean browser.
 */
describe('default browser profile identity (SB-H)', () => {
    function openLocalView() {
        const openCommand = {
            kind: 'openView',
            commandId: 'command_open',
            browserSessionId: 'browser_session_default_profile',
            viewId: 'view_default_profile',
            target: {
                kind: 'externalUrl',
                targetId: 'external_default_profile',
                url: 'https://example.test/',
            },
            platform: 'web',
            currentUrl: 'https://example.test/',
            focus: true,
        } satisfies BrowserCommandV1;
        return dispatchBrowserControlCommand(createBrowserControlState(), openCommand, {});
    }

    it('synthesizes the session under the canonical host-local profile id', () => {
        const result = openLocalView();
        expect(result.state.sessionsById.browser_session_default_profile?.profileId)
            .toBe(LOCAL_BROWSER_PROFILE_ID);
    });

    it('keeps the privacy surface hidden for the profile the control layer actually creates', () => {
        const result = openLocalView();
        const profileId = result.state.sessionsById.browser_session_default_profile?.profileId;
        expect(shouldSurfaceBrowserPrivacy({
            profile: { ...LOCAL_BROWSER_PROFILE, profileId: profileId ?? 'missing' },
        })).toBe(false);
    });
});
