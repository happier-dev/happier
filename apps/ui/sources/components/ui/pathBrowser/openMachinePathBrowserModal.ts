import { Modal } from '@/modal';

import { MachinePathBrowserModal } from './MachinePathBrowserModal';

export async function openMachinePathBrowserModal(params: Readonly<{
    machineId: string;
    serverId?: string | null;
    title?: string;
    initialPath?: string | null;
    includeFiles?: boolean;
    selectionMode?: 'directory' | 'file';
}>): Promise<string | null> {
    return await new Promise<string | null>((resolve) => {
        Modal.show({
            component: MachinePathBrowserModal,
            props: {
                machineId: params.machineId,
                serverId: params.serverId ?? null,
                title: params.title,
                initialPath: params.initialPath ?? null,
                includeFiles: params.includeFiles ?? false,
                selectionMode: params.selectionMode ?? 'directory',
                onResolve: (value: string | null) => resolve(value),
                onRequestClose: () => resolve(null),
            },
            closeOnBackdrop: true,
        });
    });
}
