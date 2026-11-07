import { describe, expect, it } from 'vitest';

import { resolveAddHomePaths, shouldFocusConnectedHome, transitionAddHomePane } from './addHomeFlowModel';

describe('Add Home flow model', () => {
    it('offers the agreed paths in order and retains checking and retryable service states', () => {
        const base = { serviceStatus: 'ready', serviceHostsHome: true, canSetUpServerHome: true } as const;
        expect(resolveAddHomePaths(base).map((path) => path.id)).toEqual(['service', 'other_service', 'direct', 'use_service_as_home', 'server_home']);
        expect(resolveAddHomePaths({ ...base, serviceStatus: 'loading' })[0]).toEqual({ id: 'service', state: 'checking' });
        expect(resolveAddHomePaths({ ...base, serviceStatus: 'unavailable' })[0]).toEqual({ id: 'service', state: 'unavailable', reason: 'unreachable' });
        expect(resolveAddHomePaths({ ...base, serviceStatus: 'unsupported' })[0]).toEqual({ id: 'service', state: 'unavailable', reason: 'unsupported' });
    });

    it('offers another service and a direct Home without offering unsupported device or service paths', () => {
        expect(resolveAddHomePaths({ serviceStatus: 'not_offered', serviceHostsHome: false, canSetUpServerHome: false }))
            .toEqual([{ id: 'other_service', state: 'ready' }, { id: 'direct', state: 'ready' }]);
    });

    it('prefills a Home address handed over from service selection', () => {
        const address = 'https://home.example.test';
        expect(transitionAddHomePane({ pane: 'other_service' }, { kind: 'connect_as_home', address })).toEqual({ pane: 'direct', initialAddress: address });
    });

    it('focuses the first usable Home or a return to a Home usable at flow entry', () => {
        expect(shouldFocusConnectedHome([])).toBe(true);
        expect(shouldFocusConnectedHome(['existing-home'])).toBe(false);
        expect(shouldFocusConnectedHome(['existing-home'], 'existing-home')).toBe(true);
        expect(shouldFocusConnectedHome(['existing-home'], 'added-home')).toBe(false);
        expect(shouldFocusConnectedHome(null, 'existing-home')).toBe(false);
    });
});
