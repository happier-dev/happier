import { ConnectedServiceAuthGroupIdSchema } from '@happier-dev/protocol';

function slugifyGroupName(name: string): string {
    return name
        .normalize('NFKD')
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .replace(/-{2,}/g, '-')
        .slice(0, 64)
        .replace(/-+$/g, '');
}

export function deriveConnectedServiceAuthGroupIdFromName(params: Readonly<{
    name: string;
    existingGroupIds?: ReadonlyArray<string>;
}>): string | null {
    const base = slugifyGroupName(params.name.trim());
    if (!base) return null;

    const existing = new Set((params.existingGroupIds ?? []).map((groupId) => groupId.trim()).filter(Boolean));
    if (!existing.has(base) && ConnectedServiceAuthGroupIdSchema.safeParse(base).success) return base;

    for (let index = 2; index < 1000; index += 1) {
        const suffix = `-${index}`;
        const candidate = `${base.slice(0, 64 - suffix.length).replace(/-+$/g, '')}${suffix}`;
        if (!existing.has(candidate) && ConnectedServiceAuthGroupIdSchema.safeParse(candidate).success) return candidate;
    }

    return null;
}
