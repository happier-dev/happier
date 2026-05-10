export type AppUpdateStatusKind = 'native-store' | 'desktop' | 'ota' | 'release-notes' | 'changelog';

export type DesktopUpdateStatus =
    | 'idle'
    | 'checking'
    | 'available'
    | 'dismissed'
    | 'installing'
    | 'error'
    | 'upToDate';

export type AppUpdateStatusTone = 'success' | 'warning' | 'accent';

export type VisibleAppUpdateStatusModel = Readonly<{
    visible: true;
    kind: AppUpdateStatusKind;
    tone: AppUpdateStatusTone;
    iconName: 'download-outline' | 'refresh-outline' | 'sparkles-outline';
    label: string;
    message: string;
    actionLabel: string;
    actionDisabled: boolean;
    dismissLabel?: string;
}>;

export type AppUpdateStatusModel =
    | Readonly<{ visible: false }>
    | VisibleAppUpdateStatusModel;

export type BuildAppUpdateStatusModelParams = Readonly<{
    platformOs: string;
    nativeUpdateUrl: string | null;
    desktop: Readonly<{
        status: DesktopUpdateStatus;
        availableVersion: string | null;
        error: string | null;
    }>;
    ota: Readonly<{
        isUpdatePending: boolean;
    }>;
    releaseNotes: Readonly<{
        hasUnread: boolean;
    }>;
    changelog: Readonly<{
        hasUnread: boolean;
    }>;
    t: (key: string) => string;
}>;
