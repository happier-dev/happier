export type ActivityPermissionAction = Readonly<{
    action: 'allow' | 'deny';
    sessionId: string;
    requestId: string;
    turnId?: string;
}>;

/**
 * An Account-scoped workflow Run a notification points at. It carries the
 * validated `runId` only: the route is derived by the workflow route owner, so
 * a payload can never supply its own destination.
 */
export type ActivityWorkflowRunTarget = Readonly<{
    runId: string;
}>;

export type ParsedActivityInteraction = Readonly<{
    actionIdentifier: string;
    isDefaultTap: boolean;
    isOpenAction: boolean;
    route: string | null;
    serverUrl: string | null;
    permissionAction: ActivityPermissionAction | null;
    questionAction?: Readonly<{ sessionId: string; requestId: string; turnId: string; answers: Readonly<Record<string, readonly string[]>> }> | null;
    workflowRun: ActivityWorkflowRunTarget | null;
    guardAction?: 'keepRunning' | 'stopNow';
}>;
