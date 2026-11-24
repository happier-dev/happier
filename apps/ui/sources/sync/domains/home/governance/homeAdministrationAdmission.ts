import {
    isActiveHomeAccountStatus,
    type HomeGovernanceProjectionV1,
} from '@happier-dev/protocol/home/governance';

/**
 * Whether the Home Administration destination is offered for one exact Home,
 * and why. `owner_setup_required` is not a capability: it is the truthful
 * explanation of a Home that currently has no active owner, and the surface
 * that renders it offers no public claim action.
 */
export type HomeAdministrationAdmission =
    | Readonly<{ state: 'admitted'; reason: 'capability' | 'owner_setup_required' }>
    | Readonly<{ state: 'denied' }>;

const DENIED: HomeAdministrationAdmission = Object.freeze({ state: 'denied' as const });
const ADMITTED_BY_CAPABILITY: HomeAdministrationAdmission = Object.freeze({
    state: 'admitted' as const,
    reason: 'capability' as const,
});
const ADMITTED_FOR_OWNER_SETUP: HomeAdministrationAdmission = Object.freeze({
    state: 'admitted' as const,
    reason: 'owner_setup_required' as const,
});

/**
 * The one narrow runtime admission predicate for Home Administration.
 *
 * It reads the Home's own projection and nothing else: it is not a feature
 * gate, not a second authorization language, and never a substitute for the
 * server authorization each route performs. An unobserved Home is denied, so a
 * missing or in-flight projection can never read as granted.
 */
export function resolveHomeAdministrationAdmission(
    projection: Pick<HomeGovernanceProjectionV1, 'viewer' | 'capabilities' | 'setupState'> | null | undefined,
): HomeAdministrationAdmission {
    if (!projection) return DENIED;

    // A suspended or retired Account cannot exercise Home authority or claim an
    // ownerless Home, so neither branch below may open for one.
    if (!isActiveHomeAccountStatus(projection.viewer.status)) return DENIED;

    if (projection.capabilities.viewAdministration) return ADMITTED_BY_CAPABILITY;
    if (projection.setupState === 'setup_required') return ADMITTED_FOR_OWNER_SETUP;
    return DENIED;
}
