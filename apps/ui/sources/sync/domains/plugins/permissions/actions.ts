import {
    PLUGIN_PERMISSION_GRANT_ACTION_IDS,
    type PluginPermissionGrantApprovedResult,
    type PluginPermissionGrantDecisionInput,
    type PluginPermissionGrantListInput,
    type PluginPermissionGrantListResponse,
    type PluginPermissionGrantRequestInput,
    type PluginPermissionGrantRequestDismissedResult,
    type PluginPermissionGrantRevokedResult,
    type PluginPermissionGrantRevokeInput,
} from './types';
import {
    executePluginPermissionGrantProtocolAction,
    type PluginPermissionGrantUiActionExecutor,
} from './api';

export type CreatePluginPermissionGrantActionsParams = Readonly<{
    execute: PluginPermissionGrantUiActionExecutor;
}>;

export function createPluginPermissionGrantActions(params: CreatePluginPermissionGrantActionsParams) {
    return Object.freeze({
        list: async (input: PluginPermissionGrantListInput) =>
            await executePluginPermissionGrantProtocolAction({
                execute: params.execute,
                actionId: PLUGIN_PERMISSION_GRANT_ACTION_IDS.list,
                input,
            }) as PluginPermissionGrantListResponse,
        request: async (input: PluginPermissionGrantRequestInput) =>
            await executePluginPermissionGrantProtocolAction({
                execute: params.execute,
                actionId: PLUGIN_PERMISSION_GRANT_ACTION_IDS.request,
                input,
            }),
        grant: async (input: PluginPermissionGrantDecisionInput) =>
            await executePluginPermissionGrantProtocolAction({
                execute: params.execute,
                actionId: PLUGIN_PERMISSION_GRANT_ACTION_IDS.grant,
                input,
            }) as PluginPermissionGrantApprovedResult,
        revoke: async (input: PluginPermissionGrantRevokeInput) =>
            await executePluginPermissionGrantProtocolAction({
                execute: params.execute,
                actionId: PLUGIN_PERMISSION_GRANT_ACTION_IDS.revoke,
                input,
            }) as PluginPermissionGrantRevokedResult,
        dismissRequest: async (input: PluginPermissionGrantDecisionInput) =>
            await executePluginPermissionGrantProtocolAction({
                execute: params.execute,
                actionId: PLUGIN_PERMISSION_GRANT_ACTION_IDS.dismissRequest,
                input,
            }) as PluginPermissionGrantRequestDismissedResult,
    });
}

export type PluginPermissionGrantActions = ReturnType<typeof createPluginPermissionGrantActions>;
