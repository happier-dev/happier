import { Modal } from '@/modal';

import { StandaloneSessionPromptEditorModal } from './StandaloneSessionPromptEditorModal';

export async function showStandaloneSessionPromptEditorModal(initialText: string): Promise<string | null> {
    return await new Promise((resolve) => {
        Modal.show({
            component: StandaloneSessionPromptEditorModal,
            props: { initialText, onResolve: resolve },
            onRequestClose: () => resolve(null),
            closeOnBackdrop: true,
        });
    });
}
