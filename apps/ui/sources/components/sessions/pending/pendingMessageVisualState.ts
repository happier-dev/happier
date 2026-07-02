import type { PendingMessage } from '@/sync/domains/state/storageTypes';

export type PendingMessageVisualStateKind =
    | 'saving'
    | 'queued'
    | 'materializing';

export type PendingMessageVisualState = Readonly<{
    kind: PendingMessageVisualStateKind;
    showSpinner: boolean;
    iconName: 'cloud-upload-outline' | 'time-outline' | 'navigate-outline';
}>;

export function getPendingMessageVisualState(
    message: PendingMessage,
    options?: Readonly<{ materializingLocalIds?: ReadonlySet<string> }>,
): PendingMessageVisualState {
    const localId = typeof message.localId === 'string' ? message.localId : message.id;
    if (options?.materializingLocalIds?.has(localId)) {
        return {
            kind: 'materializing',
            showSpinner: true,
            iconName: 'navigate-outline',
        };
    }

    if (message.source === 'local_outbound' && message.deliveryStatus !== 'accepted') {
        return {
            kind: 'saving',
            showSpinner: true,
            iconName: 'cloud-upload-outline',
        };
    }

    return {
        kind: 'queued',
        showSpinner: false,
        iconName: 'time-outline',
    };
}
