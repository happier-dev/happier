import { randomUUID } from '@/platform/randomUUID';

export type SessionOrganizationOpaqueIdPrefix = 'folder' | 'tag';

export function createSessionOrganizationOpaqueId(params: Readonly<{
    prefix: SessionOrganizationOpaqueIdPrefix;
    usedIds?: ReadonlySet<string>;
}>): string {
    const base = `${params.prefix}_${randomUUID().replace(/[^a-zA-Z0-9]/g, '')}`;
    for (let attempt = 0; attempt < 100; attempt += 1) {
        const candidate = attempt === 0 ? base : `${base}_${attempt}`;
        if (!params.usedIds?.has(candidate)) return candidate;
    }
    throw new Error(`Unable to generate a unique session ${params.prefix} id`);
}
