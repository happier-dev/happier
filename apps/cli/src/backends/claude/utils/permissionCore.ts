import type { PermissionResult } from '../sdk/types';

import type { PermissionRpcPayload } from './permissionRpc';

export type PermissionResponse = PermissionRpcPayload;

export interface PendingRequest {
    resolve: (value: PermissionResult) => void;
    reject: (error: Error) => void;
    toolName: string;
    input: unknown;
    sourceLocalId: string | null;
}

export function isInteractiveTool(toolName: string): boolean {
    return (
        toolName === 'AskUserQuestion' ||
        toolName === 'ask_user_question' ||
        toolName === 'ExitPlanMode' ||
        toolName === 'exit_plan_mode'
    );
}
