import type { VisibleAgentsTeamTemplateEntryV1 } from '@happier-dev/protocol';

import { Modal } from '@/modal';

import type { VisibleAgentBackendChoice, VisibleAgentRoleChoice } from './VisibleAgentAssignmentEditorModal';
import { VisibleAgentsTeamTemplateEditorModal } from './VisibleAgentsTeamTemplateEditorModal';

export async function showVisibleAgentsTeamTemplateEditorModal(params: Readonly<{
    initial: ReadonlyArray<VisibleAgentsTeamTemplateEntryV1>;
    roles: ReadonlyArray<VisibleAgentRoleChoice>;
    backends: ReadonlyArray<VisibleAgentBackendChoice>;
}>): Promise<ReadonlyArray<VisibleAgentsTeamTemplateEntryV1> | null> {
    return await new Promise((resolve) => {
        Modal.show({
            component: VisibleAgentsTeamTemplateEditorModal,
            props: { ...params, onResolve: resolve },
            onRequestClose: () => resolve(null),
            closeOnBackdrop: true,
        });
    });
}
