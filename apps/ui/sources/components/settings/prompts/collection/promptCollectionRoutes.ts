export type PromptCollectionKind = 'doc' | 'bundle' | 'template';

const COLLECTION_ROOTS: Readonly<Record<PromptCollectionKind, string>> = {
    doc: '/settings/prompts/docs', bundle: '/settings/prompts/skills', template: '/settings/prompts/templates',
};

export function promptCollectionRoot(kind: PromptCollectionKind): string { return COLLECTION_ROOTS[kind]; }
export function promptCollectionItemHref(kind: PromptCollectionKind, id: string, options?: Readonly<{ serverId?: string | null }>): string {
    const destination = `${COLLECTION_ROOTS[kind]}/${encodeURIComponent(id)}`;
    const serverId = options?.serverId?.trim();
    return serverId ? `${destination}?serverId=${encodeURIComponent(serverId)}` : destination;
}
export function promptCollectionDraftHref(kind: PromptCollectionKind): string { return `${COLLECTION_ROOTS[kind]}/new`; }

export type PromptCollectionRoute = Readonly<{ kind: 'index' }> | Readonly<{ kind: 'draft' }> | Readonly<{ kind: 'item'; id: string }>;
export function resolvePromptCollectionRoute(kind: PromptCollectionKind, pathname: string): PromptCollectionRoute | null {
    const root = COLLECTION_ROOTS[kind];
    const normalized = pathname.trim().replace(/\/+$/, '');
    if (normalized === root) return { kind: 'index' };
    if (!normalized.startsWith(`${root}/`)) return null;
    const first = normalized.slice(root.length + 1).split('/')[0] ?? '';
    if (first === 'new') return { kind: 'draft' };
    let id = first;
    try { id = decodeURIComponent(first); } catch { /* Retain the route's malformed escape segment. */ }
    return id ? { kind: 'item', id } : { kind: 'index' };
}
