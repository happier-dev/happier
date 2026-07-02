import type {
    ConnectedServiceAuthGroupMember,
    ConnectedServiceAuthGroupMemberRuntimeState,
    ConnectedServiceAuthGroupPolicyV1,
} from './selectConnectedServiceAuthGroupCandidate';

function normalizeProfileId(value: string | null | undefined): string | null {
    return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function isQuotaSnapshotStale(input: Readonly<{
    state: ConnectedServiceAuthGroupMemberRuntimeState | null;
    policy: ConnectedServiceAuthGroupPolicyV1;
    nowMs: number;
    quotaFreshnessMs: number;
}>): boolean {
    const capturedAtMs = input.state?.quotaSnapshot?.capturedAtMs;
    if (typeof capturedAtMs !== 'number' || !Number.isFinite(capturedAtMs)) return true;
    const probeIfSnapshotOlderThanMs =
        typeof input.policy.probeIfSnapshotOlderThanMs === 'number'
        && Number.isFinite(input.policy.probeIfSnapshotOlderThanMs)
            ? Math.max(0, Math.trunc(input.policy.probeIfSnapshotOlderThanMs))
            : input.quotaFreshnessMs;
    return input.nowMs - capturedAtMs > probeIfSnapshotOlderThanMs;
}

export function resolveConnectedServiceAuthGroupPreTurnQuotaProbeProfileIds(input: Readonly<{
    activeProfileId: string | null;
    members: ReadonlyArray<ConnectedServiceAuthGroupMember>;
    memberStatesByProfileId: ReadonlyMap<string, ConnectedServiceAuthGroupMemberRuntimeState>;
    policy: ConnectedServiceAuthGroupPolicyV1;
    nowMs: number;
    quotaFreshnessMs: number;
    allowCurrentProfileRetry: boolean;
}>): ReadonlyArray<string> {
    const mode = input.policy.preTurnProbeMode;
    if (mode === 'never') return [];
    const currentProfileId = normalizeProfileId(input.activeProfileId);
    const enabledMembers = input.members.filter((member) => member.enabled);
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
            quotaFreshnessMs: input.quotaFreshnessMs,
        }))
        .map((member) => member.profileId);
    return Array.from(new Set(profileIds));
}
