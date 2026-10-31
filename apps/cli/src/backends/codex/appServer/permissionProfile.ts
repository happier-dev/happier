import type { PermissionMode } from '@/api/types';
import { normalizePermissionModeToIntent } from '@/agent/runtime/permission/permissionModeCanonical';

import {
    resolveCodexAppServerPolicyForPermissionMode,
    resolveCodexMcpPolicyForPermissionMode,
    type CodexAppServerPolicy,
} from '../utils/permissionModePolicy';

export type CodexAppServerPermissionProfileId = ':read-only' | ':workspace' | ':danger-full-access';

export type CodexAppServerPermissionsParams = Readonly<{
    permissions?: CodexAppServerPermissionProfileId;
    approvalPolicy?: CodexAppServerPolicy['approvalPolicy'];
    approvalsReviewer?: CodexAppServerPolicy['approvalsReviewer'];
}>;

export type CodexAppServerLegacyPermissionTarget = 'thread' | 'turn';

export function resolveCodexAppServerPermissionProfileId(
    permissionMode: PermissionMode,
): CodexAppServerPermissionProfileId | null {
    if (normalizePermissionModeToIntent(permissionMode) === 'default') return null;
    const profiles = {
        'read-only': ':read-only',
        'workspace-write': ':workspace',
        'danger-full-access': ':danger-full-access',
    } as const;
    return profiles[resolveCodexMcpPolicyForPermissionMode(permissionMode).sandbox];
}

export function buildCodexAppServerPermissionsParams(params: Readonly<{
    permissionMode: PermissionMode;
    directory: string;
    managedScalarFallback?: boolean;
}>): CodexAppServerPermissionsParams {
    const id = resolveCodexAppServerPermissionProfileId(params.permissionMode);
    if (!id) return {};
    const policy = resolveCodexAppServerPolicyForPermissionMode(params.permissionMode, params);
    return {
        permissions: id,
        approvalPolicy: policy.approvalPolicy,
        ...(policy.approvalsReviewer ? { approvalsReviewer: policy.approvalsReviewer } : {}),
    };
}

export function buildCodexAppServerLegacyPermissionParams(params: Readonly<{
    permissionMode: PermissionMode;
    directory: string;
    target: CodexAppServerLegacyPermissionTarget;
    managedScalarFallback?: boolean;
}>): Record<string, unknown> {
    if (params.permissionMode === 'default') return {};

    const policy = resolveCodexAppServerPolicyForPermissionMode(params.permissionMode, {
        directory: params.directory,
        managedScalarFallback: params.managedScalarFallback,
    });

    return {
        approvalPolicy: policy.approvalPolicy,
        ...(policy.approvalsReviewer ? { approvalsReviewer: policy.approvalsReviewer } : {}),
        ...(params.target === 'thread'
            ? { sandbox: policy.sandbox }
            : { sandboxPolicy: policy.sandboxPolicy }),
    };
}

export function readCodexAppServerActivePermissionProfile(value: unknown): Record<string, unknown> | null {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    const record = value as Record<string, unknown>;
    const active = record.activePermissionProfile ?? record.active_permission_profile;
    if (!active || typeof active !== 'object' || Array.isArray(active)) return null;
    return active as Record<string, unknown>;
}
