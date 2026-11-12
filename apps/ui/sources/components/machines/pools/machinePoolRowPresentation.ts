import type { MachinePoolMemberStateV1, MachinePoolViewV1 } from '@happier-dev/protocol/machines/pools/v1';
import { getMachineDisplayName, resolveMachineDisplayNames, type MachineAbsence } from '@/utils/sessions/machineDisplayNames';
import { t } from '@/text';

/** Present the availability already decided by the Pool owner, without reading its private roster. */
export function describeMachinePoolAvailability(availability: MachinePoolViewV1['availability']): string {
    return availability.state === 'known'
        ? t('machinePools.availabilityKnown', { connected: availability.connectedCount, enabled: availability.enabledCount })
        : t('machinePools.availabilityUnknown');
}

/** The only Machine facts a Pool row needs: an identity plus whatever readable label exists. */
export type MachinePoolRowMachine = Readonly<{
    id: string;
    metadata?: Readonly<{ displayName?: string | null; host?: string | null }> | null;
    availability?: Readonly<{ kind: string }> | null;
}>;

const IDENTITY_HINT_LENGTH = 8;

function resolveMachinePoolIdentityHint(
    poolId: string,
    otherCollidingPoolIds: readonly string[],
): string {
    const initialLength = Math.min(IDENTITY_HINT_LENGTH, poolId.length);
    for (let length = initialLength; length < poolId.length; length += 1) {
        const prefix = poolId.slice(0, length);
        if (otherCollidingPoolIds.every((candidate) => !candidate.startsWith(prefix))) {
            return prefix;
        }
    }
    return poolId;
}

type MachinePoolMemberRef = Readonly<{ machineId: string; state?: MachinePoolMemberStateV1 }>;

/**
 * What the pool knows about a member this Home's inventory does not hold, from the member state the
 * server reports: revoked means removed, replaced means replaced, a temporary computer is transient,
 * and anything else is a machine this list simply does not show. Never "locked": locked means the
 * inventory holds the machine but cannot read it.
 */
function absenceForMemberState(state: MachinePoolMemberStateV1 | undefined): MachineAbsence {
    if (state === 'revoked') return 'removed';
    if (state === 'replaced') return 'replaced';
    if (state === 'temporary') return 'temporary';
    return 'unlisted';
}

/**
 * The Pool corridor's member labels, from the machine naming owner. Members are named together so
 * the short id appears only where two of them (or a member and a listed machine) would read the same.
 */
export function resolveMachinePoolMemberLabels(
    members: ReadonlyArray<MachinePoolMemberRef>,
    machines: ReadonlyArray<MachinePoolRowMachine>,
): ReadonlyMap<string, string> {
    const known = new Set(machines.map((machine) => machine.id));
    const absent = members
        .filter((member) => !known.has(member.machineId))
        .map((member) => ({ id: member.machineId, metadata: null, absence: absenceForMemberState(member.state) }));
    return resolveMachineDisplayNames([...machines, ...absent]);
}

export function resolveMachinePoolMemberLabel(
    member: MachinePoolMemberRef,
    machines: ReadonlyArray<MachinePoolRowMachine>,
): string {
    return resolveMachinePoolMemberLabels([member], machines).get(member.machineId)
        ?? getMachineDisplayName({ id: member.machineId, metadata: null, absence: absenceForMemberState(member.state) });
}

/**
 * The shared enabled-member label projection used by every Pool row. Presentation-specific limits
 * are applied only after disabled members have been removed, so a compact row cannot hide later
 * enabled members merely because disabled configuration entries appear first.
 */
export function resolveMachinePoolEnabledMemberLabels(
    view: MachinePoolViewV1,
    machines: ReadonlyArray<MachinePoolRowMachine>,
    options?: Readonly<{ limit?: number }>,
): readonly string[] {
    const enabledMembers = view.pool.members.filter((member) => member.enabled);
    const visibleMembers = options?.limit === undefined
        ? enabledMembers
        : enabledMembers.slice(0, options.limit);
    // Named among the members the row shows, so a short id appears only when those would collide.
    const labels = resolveMachinePoolMemberLabels(enabledMembers, machines);
    return visibleMembers.map((member) => labels.get(member.machineId) ?? resolveMachinePoolMemberLabel(member, machines));
}

export type MachinePoolRowPresentation = Readonly<{
    view: MachinePoolViewV1;
    memberPreview: string;
    identityDetail: string | null;
    accessibilityName: string;
}>;

/**
 * Pools intentionally allow duplicate names. Member context normally distinguishes them; when it
 * does not, the opaque identity is exposed so sighted and assistive-technology users can select
 * the same exact Pool without inventing a uniqueness rule.
 */
export function buildMachinePoolRowPresentations(
    pools: readonly MachinePoolViewV1[],
    memberPreview: (view: MachinePoolViewV1) => string,
): readonly MachinePoolRowPresentation[] {
    const previews = pools.map(memberPreview);
    return pools.map((view, index) => {
        const preview = previews[index] ?? '';
        const otherCollidingPoolIds = pools.flatMap((candidate, candidateIndex) => candidateIndex !== index
            && candidate.pool.name === view.pool.name
            && previews[candidateIndex] === preview
            ? [candidate.pool.id]
            : []);
        const needsIdentity = otherCollidingPoolIds.length > 0;
        return {
            view,
            memberPreview: preview,
            identityDetail: needsIdentity
                ? resolveMachinePoolIdentityHint(view.pool.id, otherCollidingPoolIds)
                : null,
            accessibilityName: needsIdentity ? `${view.pool.name}. ${view.pool.id}` : view.pool.name,
        };
    });
}
