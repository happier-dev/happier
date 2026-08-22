import {
    SessionPermissionSourceAuthorityV1Schema,
    type SessionPermissionSourceAuthorityV1,
} from '@happier-dev/protocol';

export type PermissionRequestOwner = Readonly<{
    kind: 'plugin';
    pluginId: string;
    runtimeId?: string;
    /** Immutable mediated-input authority stamped before the request reached this owner. */
    sourceAuthority?: SessionPermissionSourceAuthorityV1;
}>;

export function normalizePermissionRequestOwner(value: unknown): PermissionRequestOwner | null {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    const record = value as Record<string, unknown>;
    if (record.kind !== 'plugin') return null;
    const pluginId = typeof record.pluginId === 'string' ? record.pluginId.trim() : '';
    if (!pluginId) return null;
    const runtimeId = typeof record.runtimeId === 'string' ? record.runtimeId.trim() : '';
    const sourceAuthority = Object.hasOwn(record, 'sourceAuthority')
        ? SessionPermissionSourceAuthorityV1Schema.safeParse(record.sourceAuthority)
        : null;
    if (sourceAuthority && !sourceAuthority.success) return null;
    return Object.freeze({
        kind: 'plugin',
        pluginId,
        ...(runtimeId ? { runtimeId } : {}),
        ...(sourceAuthority?.success ? { sourceAuthority: Object.freeze(sourceAuthority.data) } : {}),
    });
}

export function isPermissionRequestOwnedByPlugin(
    owner: PermissionRequestOwner | null | undefined,
    pluginId: string,
): boolean {
    const normalizedPluginId = pluginId.trim();
    return Boolean(
        normalizedPluginId
        && owner
        && owner.kind === 'plugin'
        && owner.pluginId === normalizedPluginId,
    );
}

export function permissionRequestOwnersEqual(
    left: PermissionRequestOwner | null | undefined,
    right: PermissionRequestOwner | null | undefined,
): boolean {
    const leftOwner = normalizePermissionRequestOwner(left);
    const rightOwner = normalizePermissionRequestOwner(right);
    if (!leftOwner && !rightOwner) return true;
    if (!leftOwner || !rightOwner) return false;
    return leftOwner.pluginId === rightOwner.pluginId
        && (leftOwner.runtimeId ?? '') === (rightOwner.runtimeId ?? '')
        && permissionRequestSourceAuthoritiesEqual(leftOwner.sourceAuthority, rightOwner.sourceAuthority);
}

function permissionRequestSourceAuthoritiesEqual(
    left: SessionPermissionSourceAuthorityV1 | undefined,
    right: SessionPermissionSourceAuthorityV1 | undefined,
): boolean {
    if (!left && !right) return true;
    if (!left || !right) return false;
    return left.kind === right.kind
        && left.mediatorPluginId === right.mediatorPluginId
        && left.sourceRef === right.sourceRef
        && left.sourceRevisionOrEpoch === right.sourceRevisionOrEpoch
        && left.admittedPermissionCeiling === right.admittedPermissionCeiling
        && left.remoteApprovalMaxScope === right.remoteApprovalMaxScope;
}
