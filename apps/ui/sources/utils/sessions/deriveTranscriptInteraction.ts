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
    // Treat `session.active` as the source of truth. When `active` is missing/unknown, be conservative
    // and treat the session as inactive for interaction surfaces like permission approvals.
    const isSessionActive = session.active === true;

    return deriveTranscriptInteraction({
        kind: 'session',
        accessLevel: session.accessLevel,
        canApprovePermissions: session.canApprovePermissions,
        isSessionActive,
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
    const permissionDisabledReason: TranscriptInteraction['permissionDisabledReason'] = !isSessionActive
        ? 'inactive'
        : isOwner
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
