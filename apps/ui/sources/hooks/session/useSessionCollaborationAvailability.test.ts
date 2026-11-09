import { describe, expect, it } from 'vitest';
import {
    resolveSessionCollaborationAvailability,
    resolveSessionCollaborationDestinationAvailabilityState,
    canCreateSessionWithInitialAccess,
} from './useSessionCollaborationAvailability';

describe('Session collaboration availability', () => {
    it('creates with named access wherever sharing is available, and never blocks Private creation', () => {
        const access = { grants: [{ subject: { kind: 'account' as const, accountId: 'person' }, accessLevel: 'view' as const, canApprovePermissions: false }] };
        expect(canCreateSessionWithInitialAccess(access, 'unavailable')).toBe(false);
        expect(canCreateSessionWithInitialAccess(access, 'available')).toBe(true);
        expect(canCreateSessionWithInitialAccess(null, 'unavailable')).toBe(true);
        expect(canCreateSessionWithInitialAccess({ grants: [] }, 'unavailable')).toBe(true);
    });
    it('is the sharing decision alone: there is no partial direct-only mode', () => {
        expect(resolveSessionCollaborationAvailability(true)).toBe('available');
        expect(resolveSessionCollaborationAvailability(false)).toBe('unavailable');
    });
    it('admits the destination for a Home that publishes links while named access is off', () => {
        // `sharing.public` has no catalog dependency on `sharing.session`, so this
        // Home is reachable — and publication has no other entry point.
        expect(resolveSessionCollaborationDestinationAvailabilityState({ namedAccess: 'unavailable', publicLink: 'available' })).toBe('available');
        expect(resolveSessionCollaborationDestinationAvailabilityState({ namedAccess: 'available', publicLink: 'unavailable' })).toBe('available');
    });
    it('hides the destination only when no child intent is supported at all', () => {
        expect(resolveSessionCollaborationDestinationAvailabilityState({ namedAccess: 'unavailable', publicLink: 'unavailable' })).toBe('unavailable');
    });
    it('keeps the destination loading until both child decisions settle', () => {
        expect(resolveSessionCollaborationDestinationAvailabilityState({ namedAccess: 'loading', publicLink: 'unavailable' })).toBe('loading');
        expect(resolveSessionCollaborationDestinationAvailabilityState({ namedAccess: 'unavailable', publicLink: 'loading' })).toBe('loading');
        expect(resolveSessionCollaborationDestinationAvailabilityState({ namedAccess: 'available', publicLink: 'loading' })).toBe('available');
        expect(resolveSessionCollaborationDestinationAvailabilityState({ namedAccess: 'unavailable', publicLink: 'unavailable' })).toBe('unavailable');
    });
});
