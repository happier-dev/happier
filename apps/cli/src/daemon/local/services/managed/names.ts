import { createHash } from 'node:crypto';

function slugPart(value: string): string {
    return value
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .replace(/-{2,}/g, '-');
}

function shortHash(value: string): string {
    return createHash('sha256').update(value).digest('hex').slice(0, 8);
}

export function resolveLocalServiceRouteName(input: Readonly<{
    ownerKey: string;
    serviceId: string;
    workspaceKey?: string;
}>): string {
    const full = [input.ownerKey, input.serviceId, input.workspaceKey].filter(Boolean).map((part) => slugPart(part as string)).filter(Boolean).join('-');
    if (full.length <= 63) return full || `service-${shortHash(JSON.stringify(input))}`;
    const hash = shortHash(full);
    const prefix = full.slice(0, Math.max(1, 63 - hash.length - 1)).replace(/-+$/g, '');
    return `${prefix}-${hash}`;
}
