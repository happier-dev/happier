import type { PermissionMode } from '@/api/types';
import { normalizePermissionModeToIntent } from '@/agent/runtime/permission/permissionModeCanonical';

import {
    resolveCodexAppServerPolicyForPermissionMode,
    type CodexAppServerPolicy,
} from '../utils/permissionModePolicy';

export type CodexAppServerLegacyPermissionTarget = 'thread' | 'turn';

export function buildCodexAppServerPermissionsParams(params: Readonly<{
    permissionMode: PermissionMode;
    directory: string;
    target: CodexAppServerLegacyPermissionTarget;
    managedScalarFallback?: boolean;
}>): Record<string, unknown> {
    if (normalizePermissionModeToIntent(params.permissionMode) === 'default') return {};
    const policy = resolveCodexAppServerPolicyForPermissionMode(params.permissionMode, params);
    // Codex's :workspace profile restricts network access. The canonical Happier
    // workspace policy permits network access and carries explicit writable roots.
    if (policy.sandbox === 'workspace-write') {
        return serializeLegacyPermissionParams(policy, params.target);
    }
    const profiles = {
        'read-only': ':read-only',
        'danger-full-access': ':danger-full-access',
    } as const;
    return {
        permissions: profiles[policy.sandbox],
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

    return serializeLegacyPermissionParams(policy, params.target);
}

function serializeLegacyPermissionParams(
    policy: CodexAppServerPolicy,
    target: CodexAppServerLegacyPermissionTarget,
): Record<string, unknown> {
    return {
        approvalPolicy: policy.approvalPolicy,
        ...(policy.approvalsReviewer ? { approvalsReviewer: policy.approvalsReviewer } : {}),
        ...(target === 'thread'
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
