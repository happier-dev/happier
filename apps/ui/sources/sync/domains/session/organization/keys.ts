import type {
    SessionOrganizationLabelKind,
    SessionOrganizationOrderScopeKind,
} from '@happier-dev/protocol/sessions/organization/ordering';
import { sessionAddressKey } from '../sessionAddress';

/** Canonical key for every normalized organization record whose identity is a Session. */
export function buildSessionOrganizationSessionKey(serverId: string, sessionId: string): string {
    return sessionAddressKey({ serverId: String(serverId).trim(), sessionId: String(sessionId).trim() });
}

export function buildSessionOrganizationServerKey(serverId: string, id: string): string {
    return JSON.stringify([String(serverId).trim(), String(id).trim()]);
}

export function sessionOrganizationTupleKeyBelongsToServer(key: string, serverId: string): boolean {
    try {
        const tuple: unknown = JSON.parse(key);
        return Array.isArray(tuple) && tuple[0] === serverId.trim();
    } catch {
        return false;
    }
}
export function buildSessionOrganizationOrderScopeKey(params: Readonly<{
    serverId: string;
    scopeKind: SessionOrganizationOrderScopeKind;
    scopeKey: string;
}>): string {
    return JSON.stringify([
        String(params.serverId).trim(),
        params.scopeKind,
        String(params.scopeKey).trim(),
    ]);
}

export function buildSessionOrganizationLabelKey(params: Readonly<{
    serverId: string;
    labelKind: SessionOrganizationLabelKind;
    scopeKey: string;
}>): string {
    return JSON.stringify([
        String(params.serverId).trim(),
        params.labelKind,
        String(params.scopeKey).trim(),
    ]);
}
