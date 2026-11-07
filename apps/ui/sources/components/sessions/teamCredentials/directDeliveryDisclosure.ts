import * as React from 'react';
import { presentMachineAuthorityV1, type MachineAuthorityPresentationV1 } from '@happier-dev/protocol/machines/machineAuthorityV1';
import { useMachineField } from '@/sync/store/hooks';
import { t } from '@/text';

export type DirectDeliveryVisibility = MachineAuthorityPresentationV1['deliveredMaterial'];
export type DirectDeliveryDisclosureTranslationKey =
    | 'teams.credentials.directUse.ownerVisibility'
    | 'teams.credentials.directUse.sharedUserVisibility'
    | 'teams.credentials.directUse.separatePlacement'
    | 'teams.credentials.directUse.sharedPlacement'
    | 'teams.credentials.directUse.sharedBeforeSeparation';

/**
 * Where agents run on the target now, from the authority presenter: `separate` only when each person's own
 * user is both the policy and observed effective; `shared` when the policy runs agents as one user; `unknown`
 * when the target, its policy or its observation is not known (both warnings stay).
 */
export type DirectDeliveryPlacement = 'separate' | 'shared' | 'unknown';
export type DirectDeliveryDisclosure = Readonly<{ visibility: DirectDeliveryVisibility; placement: DirectDeliveryPlacement }>;

/** Unknown target/setup keeps both warnings through the existing authority presenter. */
export function readDirectDeliveryVisibility(): DirectDeliveryVisibility {
    return presentMachineAuthorityV1({}).deliveredMaterial;
}

const UNKNOWN_TARGET: DirectDeliveryDisclosure = { visibility: readDirectDeliveryVisibility(), placement: 'unknown' };

export function presentDirectDeliveryDisclosure(target: Readonly<{
    platform: string | null;
    isolationPolicy: unknown;
    isolation: Parameters<typeof presentMachineAuthorityV1>[0]['isolation'];
}> | null): DirectDeliveryDisclosure {
    if (!target) return UNKNOWN_TARGET;
    const authority = presentMachineAuthorityV1(target);
    const { placement } = authority.separateUsers;
    return {
        visibility: authority.deliveredMaterial,
        placement: placement === 'member'
            ? authority.isolation?.kind === 'effective' ? 'separate' : 'unknown'
            : placement === 'sharedAgent' || placement === 'daemon' ? 'shared' : 'unknown',
    };
}

/** The selected target's disclosure from facts the Machine record already holds; no read of its own. */
export function useDirectDeliveryDisclosure(machineId: string | null | undefined, serverId: string | null | undefined): DirectDeliveryDisclosure {
    const options = { serverId: serverId ?? null, enabled: Boolean(machineId) };
    const platform = useMachineField(machineId ?? '', 'metadata', 'platform', options);
    const isolationPolicy = useMachineField(machineId ?? '', 'metadata', 'agentIsolation', options);
    const isolation = useMachineField(machineId ?? '', 'daemonState', 'agentIsolation', options);
    return React.useMemo(
        () => machineId ? presentDirectDeliveryDisclosure({ platform, isolationPolicy, isolation }) : UNKNOWN_TARGET,
        [machineId, platform, isolationPolicy, isolation],
    );
}

/**
 * One copy projection for the existing choice rows and first-use review. The owner line always holds; the
 * placement line says where agents run now (inform, don't over-warn), and material delivered before separate
 * users stays named while the owner's fact says peers may still see it.
 */
export function describeDirectDeliveryVisibility(
    visibility: DirectDeliveryVisibility,
    translate: (key: DirectDeliveryDisclosureTranslationKey) => string = t,
    placement: DirectDeliveryPlacement = 'unknown',
): string {
    const k = 'teams.credentials.directUse' as const;
    const lines = [visibility.ownerVisible ? translate(`${k}.ownerVisibility`) : null];
    if (placement === 'separate') {
        lines.push(translate(`${k}.separatePlacement`));
        if (visibility.sharedUserPeerVisible) lines.push(translate(`${k}.sharedBeforeSeparation`));
    } else if (placement === 'shared') lines.push(translate(`${k}.sharedPlacement`));
    else if (visibility.sharedUserPeerVisible) lines.push(translate(`${k}.sharedUserVisibility`));
    return lines.filter((value): value is string => value !== null).join('\n\n');
}
