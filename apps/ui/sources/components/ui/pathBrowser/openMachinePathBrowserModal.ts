import { Modal } from '@/modal';

import { MachinePathBrowserModal } from './MachinePathBrowserModal';

export async function openMachinePathBrowserModal(params: Readonly<{
    machineId: string;
    serverId?: string | null;
    title?: string;
    initialPath?: string | null;
}>): Promise<string | null> {
    return await new Promise<string | null>((resolve) => {
        Modal.show({
            component: MachinePathBrowserModal,
            props: {
                machineId: params.machineId,
                serverId: params.serverId ?? null,
                title: params.title,
                initialPath: params.initialPath ?? null,
                onResolve: (value: string | null) => resolve(value),
                onRequestClose: () => resolve(null),
            },
            closeOnBackdrop: true,
        });
    });
}
