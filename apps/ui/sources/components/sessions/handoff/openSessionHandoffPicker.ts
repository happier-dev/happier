import type { SessionHandoffWorkspaceTransfer } from '@happier-dev/protocol';

import { Modal } from '@/modal';
import { sync } from '@/sync/sync';

export type SessionHandoffPickerResult = Readonly<{
    targetMachineId: string;
    targetSessionStorageMode?: 'direct' | 'persisted';
    workspaceTransfer?: SessionHandoffWorkspaceTransfer;
}>;

export async function openSessionHandoffPicker(params: Readonly<{
    sessionId: string;
    sourceMachineId?: string | null;
    serverId: string | null;
}>): Promise<SessionHandoffPickerResult | null> {
    try {
        // Keep the picker responsive even when machine refresh is slow or stuck (e.g. server switch churn).
        // We still try to refresh first so the picker usually opens with the latest machine list.
        const refresh = sync.refreshMachinesThrottled({ staleMs: 0, force: true }).catch(() => {});
        await Promise.race([
            refresh,
            new Promise<void>((resolve) => {
                setTimeout(resolve, 3000);
            }),
        ]);
    } catch {
        // Keep the picker usable even if the latest machine refresh fails.
    }
    const { SessionHandoffPickerModal } = await import('./SessionHandoffPickerModal');
    return await new Promise<SessionHandoffPickerResult | null>((resolve) => {
        let settled = false;
        let modalId = '';
        let hideAfterShow = false;
        const resolveOnce = (value: SessionHandoffPickerResult | null) => {
            if (settled) return;
            settled = true;
            resolve(value);
            if (modalId) {
                Modal.hide(modalId);
            } else {
                hideAfterShow = true;
            }
        };

        modalId = Modal.show({
            component: SessionHandoffPickerModal,
            props: {
                sessionId: params.sessionId,
                sourceMachineId: params.sourceMachineId ?? null,
                serverId: params.serverId,
                onResolve: resolveOnce,
            },
            onRequestClose: () => resolveOnce(null),
            closeOnBackdrop: true,
        });
        if (hideAfterShow) {
            Modal.hide(modalId);
        }
    });
}
