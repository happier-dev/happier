function readGroupLabel(groupId: unknown, displayName: unknown): string {
    const display = typeof displayName === 'string' ? displayName.trim() : '';
    if (display) return display;
    return typeof groupId === 'string' ? groupId.trim() : '';
}

function groupIncludesProfile(group: Record<string, unknown>, profileId: string): boolean {
    const memberProfileIds = group.memberProfileIds;
    if (Array.isArray(memberProfileIds) && memberProfileIds.includes(profileId)) return true;

    const members = group.members;
    if (!Array.isArray(members)) return false;
    return members.some((member) => (
        member
        && typeof member === 'object'
        && (member as { profileId?: unknown }).profileId === profileId
    ));
}

export function resolveConnectedServiceProfileGroupReferenceLabels(params: Readonly<{
    profileId: string;
    groups?: ReadonlyArray<unknown>;
}>): ReadonlyArray<string> {
    const labelsById = new Map<string, string>();

    for (const rawGroup of params.groups ?? []) {
        if (!rawGroup || typeof rawGroup !== 'object') continue;
        const group = rawGroup as Record<string, unknown>;
        if (!groupIncludesProfile(group, params.profileId)) continue;
        const groupId = typeof group.groupId === 'string' ? group.groupId.trim() : '';
        const label = readGroupLabel(groupId, group.displayName);
        if (groupId && label) labelsById.set(groupId, label);
        else if (label) labelsById.set(label, label);
    }

    return [...labelsById.values()];
}

export function formatConnectedServiceProfileGroupReferenceLabels(labels: ReadonlyArray<string>): string {
    return labels.join(', ');
}
