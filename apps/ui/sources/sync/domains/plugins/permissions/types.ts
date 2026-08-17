import type {
    PluginPermissionCapabilityV1,
    PluginPermissionGrantActionIdV1,
    PluginPermissionGrantDismissRequestActionInputV1,
    PluginPermissionGrantGrantActionInputV1,
    PluginPermissionGrantGrantActionOutputV1,
    PluginPermissionGrantListActionOutputV1,
    PluginPermissionGrantRequestActionInputV1,
    PluginPermissionGrantRequestV1,
    PluginPermissionGrantRevokeActionInputV1,
    PluginPermissionGrantRevokeActionOutputV1,
    PluginPermissionGrantTargetScopeV1,
    PluginPermissionGrantV1,
    PluginPermissionSubjectV1,
    PluginPermissionGrantDismissRequestActionOutputV1,
} from '@happier-dev/protocol';

export const PLUGIN_PERMISSION_GRANT_ACTION_IDS = Object.freeze({
    list: 'plugins.permissions.grants.list',
    request: 'plugins.permissions.grants.request',
    grant: 'plugins.permissions.grants.grant',
    revoke: 'plugins.permissions.grants.revoke',
    dismissRequest: 'plugins.permissions.grants.dismissRequest',
} as const);

export const REVIEW_COMMENTS_DIRECT_WRITE_PERMISSION_CAPABILITY = 'reviews.comments.write.direct' satisfies PluginPermissionCapabilityV1;

export type PluginPermissionGrantActionId = PluginPermissionGrantActionIdV1;
export type PluginPermissionGrantTargetScope = PluginPermissionGrantTargetScopeV1;

export type PluginPermissionGrantIdentity = Readonly<{
    pluginId: string;
    capability: PluginPermissionCapabilityV1;
    targetScope?: PluginPermissionGrantTargetScope | null;
    subject?: PluginPermissionSubjectV1 | null;
}>;

export type PluginPermissionGrant = PluginPermissionGrantV1;

export type PluginPermissionPendingGrantRequest = PluginPermissionGrantRequestV1 & Readonly<{
    pluginName?: string;
}>;

export type PluginPermissionGrantListResponse = PluginPermissionGrantListActionOutputV1;

export type PluginPermissionGrantListInput = Partial<PluginPermissionGrantIdentity> & Readonly<{
    includeRevoked?: boolean;
    includeResolvedRequests?: boolean;
    limit?: number;
}>;

export type PluginPermissionGrantRequestInput = PluginPermissionGrantRequestActionInputV1;

export type PluginPermissionGrantDecisionInput =
    | PluginPermissionGrantGrantActionInputV1
    | PluginPermissionGrantDismissRequestActionInputV1;

export type PluginPermissionGrantRevokeInput = PluginPermissionGrantRevokeActionInputV1;

export type PluginPermissionGrantApprovedResult = PluginPermissionGrantGrantActionOutputV1;
export type PluginPermissionGrantRevokedResult = PluginPermissionGrantRevokeActionOutputV1;
export type PluginPermissionGrantRequestDismissedResult = PluginPermissionGrantDismissRequestActionOutputV1;

export type PluginPermissionGrantUiActionExecutor = (
    actionId: PluginPermissionGrantActionId,
    input: unknown,
) => Promise<unknown>;

export function pluginPermissionGrantScopeKey(scope: PluginPermissionGrantTargetScope | null | undefined): string {
    if (!scope) return 'none';
    if (scope.kind === 'account') return 'account';
    if (scope.kind === 'project') return `project:${scope.projectId.trim()}`;
    return `workspace:${scope.workspaceId.trim()}`;
}

export function pluginPermissionGrantScopeLabel(scope: PluginPermissionGrantTargetScope | null | undefined): string | null {
    if (!scope) return null;
    return pluginPermissionGrantScopeKey(scope);
}
