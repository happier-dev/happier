export type TranscriptInteraction = Readonly<{
    canSendMessages: boolean;
    canApprovePermissions: boolean;
    permissionDisabledReason?: 'public' | 'readOnly' | 'notGranted' | 'inactive';
    disableToolNavigation?: boolean;
}>;

export function deriveTranscriptInteractionFromSession(
    session: Readonly<{
        accessLevel: 'view' | 'edit' | 'admin' | null | undefined;
        canApprovePermissions: boolean | null | undefined;
        active?: boolean | null | undefined;
        presence?: 'online' | number | null | undefined;
        disableToolNavigation?: boolean;
    }>,
): TranscriptInteraction {
    const isSessionActive =
        typeof session.active === 'boolean'
            ? session.active
            : typeof session.presence !== 'undefined'
                ? session.presence === 'online'
                : undefined;

    return deriveTranscriptInteraction({
        kind: 'session',
        accessLevel: session.accessLevel,
        canApprovePermissions: session.canApprovePermissions,
        ...(typeof isSessionActive !== 'undefined' ? { isSessionActive } : {}),
        disableToolNavigation: session.disableToolNavigation,
    });
}

export function deriveTranscriptInteraction(
    input:
        | Readonly<{
              kind: 'session';
              accessLevel: 'view' | 'edit' | 'admin' | null | undefined;
              canApprovePermissions: boolean | null | undefined;
              isSessionActive?: boolean | null | undefined;
              disableToolNavigation?: boolean;
          }>
        | Readonly<{
              kind: 'public';
              disableToolNavigation?: boolean;
          }>,
): TranscriptInteraction {
    if (input.kind === 'public') {
        return {
            canSendMessages: false,
            canApprovePermissions: false,
            permissionDisabledReason: 'public',
            disableToolNavigation: input.disableToolNavigation,
        };
    }

    const isOwner = !input.accessLevel;
    const canSendMessages = isOwner || input.accessLevel === 'edit' || input.accessLevel === 'admin';
    const baseCanApprovePermissions = isOwner || input.canApprovePermissions === true;
    const isSessionActive = input.isSessionActive !== false;
    const canApprovePermissions = baseCanApprovePermissions && isSessionActive;
    const permissionDisabledReason: TranscriptInteraction['permissionDisabledReason'] = isOwner
        ? (canApprovePermissions ? undefined : 'inactive')
        : input.accessLevel === 'view'
            ? 'readOnly'
            : canApprovePermissions
                ? undefined
                : (baseCanApprovePermissions ? 'inactive' : 'notGranted');

    return {
        canSendMessages,
        canApprovePermissions,
        permissionDisabledReason,
        disableToolNavigation: input.disableToolNavigation,
    };
}
