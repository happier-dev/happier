import { describe, expect, it } from 'vitest';

import { shouldKeepDesktopPersonalHomeShell } from './personalHomeIndexRoutePolicy';
import { derivePersonalHomeBootstrapSnapshot } from '@/components/personalHome/bootstrap/derivePersonalHomeBootstrapSnapshot';
import type { PersonalHomeFacts } from '@/components/personalHome/bootstrap/personalHomeBootstrapTypes';

describe('shouldKeepDesktopPersonalHomeShell', () => {
    it('keeps unauthenticated Desktop in the real shell after the provider gate releases it', () => {
        expect(shouldKeepDesktopPersonalHomeShell({
            isAuthenticated: false,
            isPersonalHomeBootstrapHost: true,
        })).toBe(true);
    });

    it.each([
        { name: 'authenticated Desktop', isAuthenticated: true, isPersonalHomeBootstrapHost: true },
        { name: 'unsupported Desktop or non-Desktop host', isAuthenticated: false, isPersonalHomeBootstrapHost: false },
    ])('does not override established routing for $name', (input) => {
        expect(shouldKeepDesktopPersonalHomeShell(input)).toBe(false);
    });

    it('keeps verified Home adoption recovery in the real shell instead of re-entering pre-auth', () => {
        const facts: PersonalHomeFacts = {
            hostIsDesktop: true,
            isDesktopMainWindow: true,
            explicitlySelectedOtherHome: false,
            completedPersonalHomeProfile: null,
            candidateLocalProfile: {
                id: 'local', name: 'Personal Home', serverUrl: 'http://127.0.0.1:43123',
                serverIdentityId: 'srv_personal_home', createdAt: 1, updatedAt: 1, lastUsedAt: 1,
            },
            relayRuntime: {
                relayUrl: 'http://127.0.0.1:43123',
                installed: true,
                healthy: true,
                status: 'healthy',
                purpose: { kind: 'personal-home', canonicalServerUrl: 'http://127.0.0.1:43123' },
            },
            localHomeReachability: 'reachable',
            localHomeIdentity: 'srv_personal_home',
            localHomeAuth: 'present',
            anonymousSignup: 'disabled',
            daemon: null,
            activeTask: null,
        };

        expect(derivePersonalHomeBootstrapSnapshot(facts).shouldGateShell).toBe(false);
        expect(shouldKeepDesktopPersonalHomeShell({
            isAuthenticated: false,
            isPersonalHomeBootstrapHost: true,
        })).toBe(true);
    });

});
