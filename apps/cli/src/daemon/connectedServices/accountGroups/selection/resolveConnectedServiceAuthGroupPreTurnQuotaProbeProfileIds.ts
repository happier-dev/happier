import type {
    ConnectedServiceAuthGroupMember,
    ConnectedServiceAuthGroupMemberRuntimeState,
    ConnectedServiceAuthGroupPolicyV2,
} from './selectConnectedServiceAuthGroupCandidate';
import { credentialHealthAllowsSelection } from './selectConnectedServiceAuthGroupCandidate';
import { isConnectedServiceQuotaObservationFresh } from '@happier-dev/protocol/connect/quotaObservationTime';

function normalizeProfileId(value: string | null | undefined): string | null {
    return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function isQuotaSnapshotStale(input: Readonly<{
    state: ConnectedServiceAuthGroupMemberRuntimeState | null;
    policy: ConnectedServiceAuthGroupPolicyV2;
    nowMs: number;
}>): boolean {
    const snapshot = input.state?.quotaSnapshot;
    const capturedAtMs = snapshot?.capturedAtMs;
    if (!snapshot || typeof capturedAtMs !== 'number' || !Number.isFinite(capturedAtMs)) return true;
    // A pre-reset zero is no evidence about the new allowance window. Probe once;
    // a response observed at/after reset remains authoritative even if still exhausted.
    if ((snapshot.meters ?? []).some(meter =>
        meter.remainingPct !== null && meter.remainingPct <= 0
        && meter.resetAtMs !== null && capturedAtMs < meter.resetAtMs
        && meter.resetAtMs <= input.nowMs
    )) return true;
    const probeIfSnapshotOlderThanMs =
        typeof input.policy.probeIfSnapshotOlderThanMs === 'number'
        && Number.isFinite(input.policy.probeIfSnapshotOlderThanMs)
            ? Math.min(snapshot.staleAfterMs, Math.max(0, Math.trunc(input.policy.probeIfSnapshotOlderThanMs)))
            : snapshot.staleAfterMs;
    return !isConnectedServiceQuotaObservationFresh({
        observedAtMs: capturedAtMs,
        nowMs: input.nowMs,
        maxAgeMs: probeIfSnapshotOlderThanMs,
    });
}

export function resolveConnectedServiceAuthGroupPreTurnQuotaProbeProfileIds(input: Readonly<{
    activeProfileId: string | null;
    members: ReadonlyArray<ConnectedServiceAuthGroupMember>;
    memberStatesByProfileId: ReadonlyMap<string, ConnectedServiceAuthGroupMemberRuntimeState>;
    policy: ConnectedServiceAuthGroupPolicyV2;
    nowMs: number;
    allowCurrentProfileRetry: boolean;
}>): ReadonlyArray<string> {
    const mode = input.policy.preTurnProbeMode;
    if (mode === 'never') return [];
    const currentProfileId = normalizeProfileId(input.activeProfileId);
    const enabledMembers = input.members.filter((member) => member.enabled && credentialHealthAllowsSelection(
        input.memberStatesByProfileId.get(member.profileId)?.credentialHealthStatus,
    ));
    const currentMembers = currentProfileId && input.allowCurrentProfileRetry
        ? enabledMembers.filter((member) => member.profileId === currentProfileId)
        : [];
    const candidateMembers = enabledMembers.filter((member) => member.profileId !== currentProfileId);
    const orderedMembers = input.policy.preTurnProbeOrder === 'candidates_first_then_current'
        ? [...candidateMembers, ...currentMembers]
        : [...currentMembers, ...candidateMembers];
    const profileIds = orderedMembers
        .filter((member) => mode === 'always_for_group' || isQuotaSnapshotStale({
            state: input.memberStatesByProfileId.get(member.profileId) ?? null,
            policy: input.policy,
            nowMs: input.nowMs,
        }))
        .map((member) => member.profileId);
    return Array.from(new Set(profileIds));
}
