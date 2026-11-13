import type { AssignableSessionRole } from '@happier-dev/protocol';

import { Modal } from '@/modal';

import { SessionRoleProfileEditorModal, type SessionRoleProfileEditorResult } from './SessionRoleProfileEditorModal';

export async function showSessionRoleProfileEditorModal(params: Readonly<{
    role: AssignableSessionRole | null;
    name?: string;
    displayName?: string | null;
    color?: string | null;
    instructions: string;
    isCustom: boolean;
    customProfile?: boolean;
}>): Promise<SessionRoleProfileEditorResult | null> {
    return await new Promise((resolve) => {
        Modal.show({
            component: SessionRoleProfileEditorModal,
            props: {
                ...params,
                onResolve: (value: SessionRoleProfileEditorResult | null) => resolve(value),
            },
            onRequestClose: () => resolve(null),
            closeOnBackdrop: true,
        });
    });
}
