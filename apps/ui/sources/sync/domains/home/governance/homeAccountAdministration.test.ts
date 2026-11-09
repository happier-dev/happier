import { describe, expect, it } from 'vitest';
import {
    type AccountStatusV1,
    type HomeAccountMutationCapabilitiesV1,
    type HomeRoleV1,
} from '@happier-dev/protocol/home/governance';

import {
    resolveHomeAccountAdministrationActions,
    resolveHomeAccountStatusPresentation,
    resolveHomePublicProfileModeration,
} from './homeAccountAdministration';

function mutationCapabilities(
    overrides: Partial<HomeAccountMutationCapabilitiesV1> = {},
): HomeAccountMutationCapabilitiesV1 {
    const unavailable = { status: 'unavailable' as const, reason: 'not_authorized' as const };
    return {
        setRole: { member: unavailable, admin: unavailable, owner: unavailable },
        disable: unavailable,
        reenable: unavailable,
        delete: unavailable,
        signOutEverywhere: unavailable,
        ...overrides,
    };
}

function target(
    homeRole: HomeRoleV1,
    status: AccountStatusV1,
    accountId = 'acc_target',
    capabilities: HomeAccountMutationCapabilitiesV1 = mutationCapabilities(),
) {
    return { accountId, homeRole, status, mutationCapabilities: capabilities };
}

describe('resolveHomeAccountStatusPresentation', () => {
    it('maps the reversible hold to Disabled with a Re-enable affordance', () => {
        const presentation = resolveHomeAccountStatusPresentation('suspended');
        expect(presentation.label).toBe('disabled');
        expect(presentation.reversible).toBe(true);
    });

    it('maps the terminal lifecycle state to Retired and never offers revival', () => {
        const presentation = resolveHomeAccountStatusPresentation('disabled');
        expect(presentation.label).toBe('retired');
        expect(presentation.reversible).toBe(false);
    });

    it('keeps an active Account free of a lifecycle badge', () => {
        const presentation = resolveHomeAccountStatusPresentation('active');
        expect(presentation.label).toBe('active');
        expect(presentation.reversible).toBe(false);
    });
});

describe('resolveHomeAccountAdministrationActions', () => {
    it('hides every action from a viewer with no administration capability', () => {
        const actions = resolveHomeAccountAdministrationActions({
            target: target('member', 'active'),
            mutationsAvailable: true,
        });
        expect(actions.setRole.state).toBe('hidden');
        expect(actions.disable.state).toBe('hidden');
        expect(actions.enable.state).toBe('hidden');
        expect(actions.delete.state).toBe('hidden');
    });

    it('lets an owner disable, retire-protect and delete an ordinary member', () => {
        const actions = resolveHomeAccountAdministrationActions({
            target: target('member', 'active', 'acc_target', mutationCapabilities({
                setRole: {
                    member: { status: 'unavailable', reason: 'unchanged' },
                    admin: { status: 'available' },
                    owner: { status: 'available' },
                },
                disable: { status: 'available' },
                delete: { status: 'available' },
            })),
            mutationsAvailable: true,
        });
        expect(actions.setRole.state).toBe('available');
        expect(actions.disable.state).toBe('available');
        expect(actions.enable.state).toBe('hidden');
        expect(actions.delete.state).toBe('available');
    });

    it('hides owner transitions from an admin instead of showing an inert control', () => {
        const actions = resolveHomeAccountAdministrationActions({
            target: target('owner', 'active'),
            mutationsAvailable: true,
        });
        expect(actions.setRole.state).toBe('hidden');
        expect(actions.disable.state).toBe('hidden');
    });

    it('refuses an admin the erasure authority an owner holds', () => {
        const actions = resolveHomeAccountAdministrationActions({
            target: target('member', 'active', 'acc_target', mutationCapabilities({
                setRole: {
                    member: { status: 'unavailable', reason: 'unchanged' },
                    admin: { status: 'available' },
                    owner: { status: 'unavailable', reason: 'not_authorized' },
                },
                disable: { status: 'available' },
            })),
            mutationsAvailable: true,
        });
        expect(actions.delete.state).toBe('hidden');
    });

    it('explains, rather than hides, the final active owner restriction', () => {
        const actions = resolveHomeAccountAdministrationActions({
            target: target('owner', 'active', 'acc_viewer', mutationCapabilities({
                setRole: {
                    member: { status: 'unavailable', reason: 'last_active_owner' },
                    admin: { status: 'unavailable', reason: 'last_active_owner' },
                    owner: { status: 'unavailable', reason: 'unchanged' },
                },
                disable: { status: 'unavailable', reason: 'last_active_owner' },
                delete: { status: 'unavailable', reason: 'last_active_owner' },
            })),
            mutationsAvailable: true,
        });
        expect(actions.setRole).toEqual({ state: 'unavailable', reason: 'last_active_owner' });
        expect(actions.disable).toEqual({ state: 'unavailable', reason: 'last_active_owner' });
        expect(actions.delete).toEqual({ state: 'unavailable', reason: 'last_active_owner' });
    });

    it('lets an owner demote themselves once another active owner exists', () => {
        const actions = resolveHomeAccountAdministrationActions({
            target: target('owner', 'active', 'acc_viewer', mutationCapabilities({
                setRole: {
                    member: { status: 'available' },
                    admin: { status: 'available' },
                    owner: { status: 'unavailable', reason: 'unchanged' },
                },
            })),
            mutationsAvailable: true,
        });
        expect(actions.setRole.state).toBe('available');
    });

    it('offers sign-out everywhere to an active person and withholds it once they are no longer active', () => {
        const active = resolveHomeAccountAdministrationActions({
            target: target('owner', 'active', 'acc_target', mutationCapabilities({
                signOutEverywhere: { status: 'available' },
                disable: { status: 'unavailable', reason: 'last_active_owner' },
            })),
            mutationsAvailable: true,
        });
        // Ending sessions changes no role, so last-owner protection does not withhold it.
        expect(active.signOutEverywhere.state).toBe('available');
        expect(active.disable).toEqual({ state: 'unavailable', reason: 'last_active_owner' });

        const held = resolveHomeAccountAdministrationActions({
            target: target('member', 'suspended', 'acc_target', mutationCapabilities({
                signOutEverywhere: { status: 'unavailable', reason: 'target_not_active' },
            })),
            mutationsAvailable: true,
        });
        expect(held.signOutEverywhere.state).toBe('hidden');

        const offline = resolveHomeAccountAdministrationActions({
            target: target('member', 'active', 'acc_target', mutationCapabilities({
                signOutEverywhere: { status: 'available' },
            })),
            mutationsAvailable: false,
        });
        expect(offline.signOutEverywhere).toEqual({ state: 'unavailable', reason: 'home_unreachable' });
    });

    it('offers Re-enable only for the reversible hold', () => {
        const suspended = resolveHomeAccountAdministrationActions({
            target: target('member', 'suspended', 'acc_target', mutationCapabilities({
                reenable: { status: 'available' },
            })),
            mutationsAvailable: true,
        });
        expect(suspended.enable.state).toBe('available');
        expect(suspended.disable.state).toBe('hidden');
    });

    it('never offers Re-enable for a Retired Account but still allows authorized deletion', () => {
        const retired = resolveHomeAccountAdministrationActions({
            target: target('member', 'disabled', 'acc_target', mutationCapabilities({
                delete: { status: 'available' },
            })),
            mutationsAvailable: true,
        });
        expect(retired.enable.state).toBe('hidden');
        expect(retired.disable.state).toBe('hidden');
        expect(retired.delete.state).toBe('available');
    });

    it('refuses to promote an inactive Account because only an active one may hold authority', () => {
        const actions = resolveHomeAccountAdministrationActions({
            target: target('member', 'suspended', 'acc_target', mutationCapabilities({
                setRole: {
                    member: { status: 'unavailable', reason: 'target_inactive' },
                    admin: { status: 'unavailable', reason: 'target_inactive' },
                    owner: { status: 'unavailable', reason: 'target_inactive' },
                },
            })),
            mutationsAvailable: true,
        });
        expect(actions.setRole).toEqual({ state: 'unavailable', reason: 'target_inactive' });
    });

    it('states that mutations are unavailable while the Home cannot be reached', () => {
        const actions = resolveHomeAccountAdministrationActions({
            target: target('member', 'active', 'acc_target', mutationCapabilities({
                setRole: {
                    member: { status: 'unavailable', reason: 'unchanged' },
                    admin: { status: 'available' },
                    owner: { status: 'available' },
                },
                disable: { status: 'available' },
                delete: { status: 'available' },
            })),
            mutationsAvailable: false,
        });
        expect(actions.setRole).toEqual({ state: 'unavailable', reason: 'home_unreachable' });
        expect(actions.disable).toEqual({ state: 'unavailable', reason: 'home_unreachable' });
        expect(actions.delete).toEqual({ state: 'unavailable', reason: 'home_unreachable' });
    });

    it('keeps an unreachable Home from hiding a restriction the server still enforces', () => {
        const actions = resolveHomeAccountAdministrationActions({
            target: target('owner', 'active', 'acc_viewer', mutationCapabilities({
                setRole: {
                    member: { status: 'unavailable', reason: 'last_active_owner' },
                    admin: { status: 'unavailable', reason: 'last_active_owner' },
                    owner: { status: 'unavailable', reason: 'unchanged' },
                },
                disable: { status: 'unavailable', reason: 'last_active_owner' },
                delete: { status: 'unavailable', reason: 'last_active_owner' },
            })),
            mutationsAvailable: false,
        });
        // The invariant is the more useful explanation: it survives reconnection.
        expect(actions.disable).toEqual({ state: 'unavailable', reason: 'last_active_owner' });
    });

    it('never widens a server-projected denial from viewer role or target status', () => {
        const actions = resolveHomeAccountAdministrationActions({
            target: target('member', 'active', 'acc_target', mutationCapabilities({
                delete: { status: 'unavailable', reason: 'team_owner_transfer_required' },
            })),
            mutationsAvailable: true,
        });

        expect(actions.delete).toEqual({
            state: 'unavailable',
            reason: 'team_owner_transfer_required',
        });
    });
});

describe('resolveHomePublicProfileModeration', () => {
    it('uses the exact target capability instead of granting authority from the general viewer projection', () => {
        const params = {
            target: { ...target('member', 'active'), publicProfile: {
                managementCapability: { status: 'unavailable' as const, reason: 'not_authorized' as const }, restricted: false,
            } },
            mutationsAvailable: true,
        };
        expect(resolveHomePublicProfileModeration(params)).toEqual({ state: 'hidden' });
    });

    it('presents an available server decision for either restriction state', () => {
        for (const restricted of [false, true]) {
            expect(resolveHomePublicProfileModeration({ target: { publicProfile: {
                managementCapability: { status: 'available' }, restricted,
            } }, mutationsAvailable: true }))
            .toEqual({ state: 'available' });
        }
    });

    it('does not infer authority when an older Home has no profile projection', () => {
        expect(resolveHomePublicProfileModeration({ target: {}, mutationsAvailable: true }))
            .toEqual({ state: 'hidden' });
    });

    it('narrows available management while the Home is unreachable', () => {
        expect(resolveHomePublicProfileModeration({ target: { publicProfile: {
            managementCapability: { status: 'available' }, restricted: true,
        } }, mutationsAvailable: false }))
            .toEqual({ state: 'unavailable', reason: 'home_unreachable' });
    });
});
