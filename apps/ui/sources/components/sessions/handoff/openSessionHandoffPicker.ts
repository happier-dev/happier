import type { SessionHandoffWorkspaceTransfer } from '@happier-dev/protocol';

import { Modal } from '@/modal';

import { SessionHandoffPickerModalEntry } from './SessionHandoffPickerModalEntry';

export type SessionHandoffPickerResult = Readonly<{
    targetMachineId: string;
    targetPath?: string;
    targetSessionStorageMode?: 'direct' | 'persisted';
    workspaceTransfer?: SessionHandoffWorkspaceTransfer;
}>;

export async function openSessionHandoffPicker(params: Readonly<{
    sessionId: string;
    sourceMachineId?: string | null;
    serverId: string | null;
}>): Promise<SessionHandoffPickerResult | null> {
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
            component: SessionHandoffPickerModalEntry,
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
