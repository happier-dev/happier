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
        await sync.refreshMachinesThrottled({ staleMs: 0, force: true });
    } catch {
        // Keep the picker usable even if the latest machine refresh fails.
    }
    const { SessionHandoffPickerModal } = await import('./SessionHandoffPickerModal');
    return await new Promise<SessionHandoffPickerResult | null>((resolve) => {
        Modal.show({
            component: SessionHandoffPickerModal,
            props: {
                sessionId: params.sessionId,
                sourceMachineId: params.sourceMachineId ?? null,
                serverId: params.serverId,
                onResolve: (value: SessionHandoffPickerResult | null) => resolve(value),
                onRequestClose: () => resolve(null),
            },
            closeOnBackdrop: true,
        });
    });
}
