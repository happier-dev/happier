export type ActivityPermissionAction = Readonly<{
    action: 'allow' | 'deny';
    sessionId: string;
    requestId: string;
}>;

export type ParsedActivityInteraction = Readonly<{
    actionIdentifier: string;
    isDefaultTap: boolean;
    isOpenAction: boolean;
    route: string | null;
    serverUrl: string | null;
    permissionAction: ActivityPermissionAction | null;
}>;
