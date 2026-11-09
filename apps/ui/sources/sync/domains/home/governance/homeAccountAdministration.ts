import type {
    AccountStatusV1,
    HomeAccountMutationCapabilityV1,
    HomeAccountMutationUnavailableReasonV1,
    HomeAccountDetailV1,
    HomeRoleV1,
} from '@happier-dev/protocol/home/governance';

/**
 * How one Account's lifecycle state is named to a Home administrator.
 *
 * The persisted vocabulary and the product vocabulary deliberately differ:
 * persisted `suspended` is the reversible hold shown as **Disabled**, and
 * persisted `disabled` is terminal and shown as **Retired**. Rendering the raw
 * status would tell an administrator that a Retired Account is merely disabled
 * and invite them to look for a Re-enable that does not exist.
 */
export type HomeAccountStatusLabel = 'active' | 'disabled' | 'retired';

export type HomeAccountStatusPresentation = Readonly<{
    label: HomeAccountStatusLabel;
    /** Whether ordinary Home administration can return this Account to active. */
    reversible: boolean;
}>;

const ACTIVE_PRESENTATION: HomeAccountStatusPresentation = Object.freeze({
    label: 'active' as const,
    reversible: false,
});
const DISABLED_PRESENTATION: HomeAccountStatusPresentation = Object.freeze({
    label: 'disabled' as const,
    reversible: true,
});
const RETIRED_PRESENTATION: HomeAccountStatusPresentation = Object.freeze({
    label: 'retired' as const,
    reversible: false,
});

export function resolveHomeAccountStatusPresentation(
    status: AccountStatusV1,
): HomeAccountStatusPresentation {
    switch (status) {
        case 'active':
            return ACTIVE_PRESENTATION;
        case 'suspended':
            return DISABLED_PRESENTATION;
        case 'disabled':
            return RETIRED_PRESENTATION;
    }
}

/**
 * Why an operation the viewer is otherwise entitled to perform cannot run now.
 *
 * Each reason is an explanation the surface can state in plain language, which
 * is why a blocked-but-entitled action stays visible instead of silently
 * disappearing and leaving the administrator to guess.
 */
export type HomeAccountActionUnavailableReason =
    | Exclude<HomeAccountMutationUnavailableReasonV1, 'not_authorized' | 'unchanged'>
    /** The Home is not answering, so no mutation can be committed. */
    | 'home_unreachable';

/**
 * `hidden` means the viewer has no authority for this operation at all, so
 * showing it would be noise. `unavailable` means they do, but a current fact
 * prevents it — that distinction is the difference between an honest surface
 * and a wall of inert controls.
 */
export type HomeAccountActionAvailability =
    | Readonly<{ state: 'hidden' }>
    | Readonly<{ state: 'available' }>
    | Readonly<{ state: 'unavailable'; reason: HomeAccountActionUnavailableReason }>;

const HIDDEN: HomeAccountActionAvailability = Object.freeze({ state: 'hidden' as const });
const AVAILABLE: HomeAccountActionAvailability = Object.freeze({ state: 'available' as const });

function unavailable(reason: HomeAccountActionUnavailableReason): HomeAccountActionAvailability {
    return Object.freeze({ state: 'unavailable' as const, reason });
}

function isPresentableReason(
    reason: HomeAccountMutationUnavailableReasonV1,
): reason is Exclude<HomeAccountMutationUnavailableReasonV1, 'not_authorized' | 'unchanged'> {
    return reason !== 'not_authorized' && reason !== 'unchanged';
}

export type HomeAccountAdministrationActions = Readonly<{
    setRole: HomeAccountActionAvailability;
    disable: HomeAccountActionAvailability;
    enable: HomeAccountActionAvailability;
    delete: HomeAccountActionAvailability;
    /** End every signed-in session of the Account; not offered once it is no longer active. */
    signOutEverywhere: HomeAccountActionAvailability;
    /**
     * The roles this viewer may actually assign to this target. The role sheet
     * renders exactly these, so no surface re-derives a local role ladder.
     */
    assignableRoles: readonly HomeRoleV1[];
}>;

export type HomeAccountAdministrationTarget = Readonly<{
    accountId: string;
    homeRole: HomeRoleV1;
    status: AccountStatusV1;
    mutationCapabilities: {
        setRole: Record<HomeRoleV1, HomeAccountMutationCapabilityV1>;
        disable: HomeAccountMutationCapabilityV1;
        reenable: HomeAccountMutationCapabilityV1;
        delete: HomeAccountMutationCapabilityV1;
        signOutEverywhere: HomeAccountMutationCapabilityV1;
    };
}>;

const ALL_ROLES: readonly HomeRoleV1[] = Object.freeze(['member', 'admin', 'owner'] as const);
const NO_ROLES: readonly HomeRoleV1[] = Object.freeze([] as const);
const NO_UNAVAILABLE_REASONS: readonly HomeAccountMutationUnavailableReasonV1[] = Object.freeze([]);

function presentProjectedCapability(
    capability: HomeAccountMutationCapabilityV1,
    mutationsAvailable: boolean,
    hideWhenInapplicable: readonly HomeAccountMutationUnavailableReasonV1[] = NO_UNAVAILABLE_REASONS,
): HomeAccountActionAvailability {
    if (capability.status === 'available') {
        return mutationsAvailable ? AVAILABLE : unavailable('home_unreachable');
    }
    if (capability.reason === 'not_authorized' || capability.reason === 'unchanged') return HIDDEN;
    if (hideWhenInapplicable.includes(capability.reason)) return HIDDEN;
    return unavailable(capability.reason);
}

/**
 * Resolves what a Home administrator may do to one Account right now.
 *
 * This is a rendering and precheck decision only. Every mutation is authorized
 * again inside its own transaction against rows reread at that moment, so a
 * viewer who raced a role, lifecycle or ownership change receives a typed
 * conflict rather than a silently applied change. The row's projected
 * capabilities are the sole presentation authority; Home reachability can only
 * narrow an available operation.
 */
export function resolveHomeAccountAdministrationActions(params: Readonly<{
    target: HomeAccountAdministrationTarget;
    /** False while the Home is unreachable or the projection is known stale. */
    mutationsAvailable: boolean;
}>): HomeAccountAdministrationActions {
    const { target, mutationsAvailable } = params;
    const assignableRoles = ALL_ROLES.filter((role) => {
        const capability = target.mutationCapabilities.setRole[role];
        return capability.status === 'available'
            || capability.reason !== 'not_authorized';
    });
    const meaningfulRoleBlock = assignableRoles
        .map((role) => target.mutationCapabilities.setRole[role])
        .find((capability) => capability.status === 'unavailable'
            && isPresentableReason(capability.reason));
    const setRole = assignableRoles.some((role) => (
        target.mutationCapabilities.setRole[role].status === 'available'
    ))
        ? (mutationsAvailable ? AVAILABLE : unavailable('home_unreachable'))
        : meaningfulRoleBlock?.status === 'unavailable'
            && isPresentableReason(meaningfulRoleBlock.reason)
            ? unavailable(meaningfulRoleBlock.reason)
            : HIDDEN;

    return Object.freeze({
        setRole,
        disable: presentProjectedCapability(
            target.mutationCapabilities.disable,
            mutationsAvailable,
            ['target_not_active', 'target_retired'],
        ),
        enable: presentProjectedCapability(
            target.mutationCapabilities.reenable,
            mutationsAvailable,
            ['target_not_suspended', 'target_retired'],
        ),
        delete: presentProjectedCapability(target.mutationCapabilities.delete, mutationsAvailable),
        signOutEverywhere: presentProjectedCapability(
            target.mutationCapabilities.signOutEverywhere,
            mutationsAvailable,
            ['target_not_active', 'target_retired'],
        ),
        assignableRoles: setRole.state === 'hidden' ? NO_ROLES : assignableRoles,
    });
}

/**
 * Presents the Home's operator decision. Restriction is independent of Account lifecycle;
 * reachability can narrow the projected authority, but the client never reconstructs it.
 */
export function resolveHomePublicProfileModeration(params: Readonly<{
    target: Pick<HomeAccountDetailV1, 'publicProfile'>;
    mutationsAvailable: boolean;
}>): HomeAccountActionAvailability {
    const { target, mutationsAvailable } = params;
    return target.publicProfile
        ? presentProjectedCapability(target.publicProfile.managementCapability, mutationsAvailable)
        : HIDDEN;
}
