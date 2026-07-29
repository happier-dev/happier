import type {
    SessionOrganizationLabelKind,
    SessionOrganizationOrderScopeKind,
} from '@happier-dev/protocol';

export function buildSessionOrganizationServerKey(serverId: string, id: string): string {
    return `${String(serverId).trim()}:${String(id).trim()}`;
}
export function buildSessionOrganizationOrderScopeKey(params: Readonly<{
    serverId: string;
    scopeKind: SessionOrganizationOrderScopeKind;
    scopeKey: string;
}>): string {
    return `${String(params.serverId).trim()}:${params.scopeKind}:${String(params.scopeKey).trim()}`;
}

export function buildSessionOrganizationLabelKey(params: Readonly<{
    serverId: string;
    labelKind: SessionOrganizationLabelKind;
    scopeKey: string;
}>): string {
    return `${String(params.serverId).trim()}:${params.labelKind}:${String(params.scopeKey).trim()}`;
}

export function readSessionOrganizationServerScopedId(serverScopedKey: string, serverId: string): string | null {
    const prefix = `${String(serverId).trim()}:`;
    return serverScopedKey.startsWith(prefix) ? serverScopedKey.slice(prefix.length) : null;
}
