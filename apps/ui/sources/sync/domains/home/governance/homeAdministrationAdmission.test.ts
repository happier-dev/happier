import { homeGovernanceProjectionFixture } from '@/dev/testkit/fixtures/homeGovernanceFixtures';
import { describe, expect, it } from 'vitest';
import {
    NO_HOME_CAPABILITIES_V1,
    type HomeGovernanceProjectionV1,
} from '@happier-dev/protocol/home/governance';

import { resolveHomeAdministrationAdmission } from './homeAdministrationAdmission';

function projection(overrides: Partial<HomeGovernanceProjectionV1> = {}): HomeGovernanceProjectionV1 {
    return homeGovernanceProjectionFixture({
        viewer: { accountId: 'acc_1', homeRole: 'member', status: 'active' },
        capabilities: NO_HOME_CAPABILITIES_V1,
        activeOwnerCount: 1,
        teamsEnabled: false,
        ...overrides,
    });
}

describe('resolveHomeAdministrationAdmission', () => {
    it('admits on the effective projected administration capability', () => {
        expect(resolveHomeAdministrationAdmission(projection({
            viewer: { accountId: 'acc_1', homeRole: 'admin', status: 'active' },
            capabilities: { ...NO_HOME_CAPABILITIES_V1, viewAdministration: true },
        }))).toEqual({ state: 'admitted', reason: 'capability' });
    });

    it('admits an ordinary active member only to explain a Home with no active owner', () => {
        expect(resolveHomeAdministrationAdmission(projection({
            setupState: 'setup_required',
            activeOwnerCount: 0,
        }))).toEqual({ state: 'admitted', reason: 'owner_setup_required' });
    });

    it('prefers the real capability over the setup explanation when both hold', () => {
        expect(resolveHomeAdministrationAdmission(projection({
            capabilities: { ...NO_HOME_CAPABILITIES_V1, viewAdministration: true },
            setupState: 'setup_required',
            activeOwnerCount: 0,
        }))).toEqual({ state: 'admitted', reason: 'capability' });
    });

    it('denies an owned Home to a viewer without the projected capability', () => {
        expect(resolveHomeAdministrationAdmission(projection())).toEqual({ state: 'denied' });
    });

    it('denies a viewer who is not active, even when the projection still carries a capability', () => {
        // A suspended Account cannot exercise Home authority; a stale or
        // mis-projected capability bit must not re-open administration.
        expect(resolveHomeAdministrationAdmission(projection({
            viewer: { accountId: 'acc_1', homeRole: 'owner', status: 'suspended' },
            capabilities: { ...NO_HOME_CAPABILITIES_V1, viewAdministration: true },
        }))).toEqual({ state: 'denied' });

        expect(resolveHomeAdministrationAdmission(projection({
            viewer: { accountId: 'acc_1', homeRole: 'owner', status: 'disabled' },
            setupState: 'setup_required',
        }))).toEqual({ state: 'denied' });
    });

    it('fails closed when no projection has been observed for this Home', () => {
        expect(resolveHomeAdministrationAdmission(null)).toEqual({ state: 'denied' });
        expect(resolveHomeAdministrationAdmission(undefined)).toEqual({ state: 'denied' });
    });
});
