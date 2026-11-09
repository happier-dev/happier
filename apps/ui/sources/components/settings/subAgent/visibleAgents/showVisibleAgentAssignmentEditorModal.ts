import { Modal } from '@/modal';

import {
    VisibleAgentAssignmentEditorModal,
    type VisibleAgentAssignmentEditorValue,
    type VisibleAgentBackendChoice,
    type VisibleAgentRoleChoice,
} from './VisibleAgentAssignmentEditorModal';

export async function showVisibleAgentAssignmentEditorModal(params: Readonly<{
    title: string;
    initial: VisibleAgentAssignmentEditorValue;
    roles: ReadonlyArray<VisibleAgentRoleChoice>;
    backends: ReadonlyArray<VisibleAgentBackendChoice>;
    showPermissionMode?: boolean;
    roleRequired?: boolean;
}>): Promise<VisibleAgentAssignmentEditorValue | null> {
    return await new Promise((resolve) => {
        Modal.show({
            component: VisibleAgentAssignmentEditorModal,
            props: { ...params, onResolve: resolve },
            onRequestClose: () => resolve(null),
            closeOnBackdrop: true,
        });
    });
}
