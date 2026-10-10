import type {
    HandoffWorkspaceActionV1,
} from '@happier-dev/protocol';

import { Modal } from '@/modal';

import { SessionHandoffPickerModalEntry } from './SessionHandoffPickerModalEntry';
import type { SessionHandoffPickerModalProps } from './SessionHandoffPickerModal';
import type { WorkspaceSyncConflictDetailsResource } from '@/components/workspaces/sync/WorkspaceSyncConflictDetailsView';

export type SessionHandoffPickerResult = Readonly<{
    targetMachineId: string;
    /** Display-only identity used by consequential confirmation copy. */
    targetMachineLabel?: string;
    targetPath?: string;
    /** Display-only source path used by consequential confirmation copy. */
    sourceRootPath?: string;
    targetSessionStorageMode?: 'direct' | 'persisted';
    stateTransfer?: 'transfer' | 'existing';
    workspaceAction?: HandoffWorkspaceActionV1;
    workspaceSyncReviewResource?: WorkspaceSyncConflictDetailsResource;
    workspaceSyncReviewRelationshipIds?: readonly string[];
}>;

export async function openSessionHandoffPicker(params: Readonly<{
    sessionId: string;
    sourceMachineId?: string | null;
    serverId: string | null;
    retainOnSubmit?: boolean;
    onRetained?: (close: () => void, setAwaitingAdmission: (awaiting: boolean) => void, isOpen: () => boolean, setInlineError: (code: string | null) => void) => void;
    onSubmitAgain?: (value: SessionHandoffPickerResult) => void;
}>): Promise<SessionHandoffPickerResult | null> {
    return await new Promise<SessionHandoffPickerResult | null>((resolve) => {
        let settled = false;
        let modalId = '';
        let hideAfterShow = false;
        let closed = false;
        let awaitingAdmission = false;
        const close = () => {
            if (closed) return;
            closed = true;
            if (modalId) Modal.hide(modalId);
            else hideAfterShow = true;
        };
        const resolveOnce = (value: SessionHandoffPickerResult | null) => {
            if (awaitingAdmission) {
                if (value === null) close();
                return;
            }
            if (settled) {
                if (!closed && value && params.retainOnSubmit) params.onSubmitAgain?.(value);
                return;
            }
            settled = true;
            resolve(value);
            if (!params.retainOnSubmit || value === null) close();
        };

        modalId = Modal.show({
            component: SessionHandoffPickerModalEntry,
            props: {
                sessionId: params.sessionId,
                sourceMachineId: params.sourceMachineId ?? null,
                serverId: params.serverId,
                awaitingAdmission: false,
                onResolve: resolveOnce,
            },
            onRequestClose: () => {
                if (awaitingAdmission) { close(); return; }
                if (!settled) resolveOnce(null);
                else close();
            },
            closeOnBackdrop: true,
        });
        const setAwaitingAdmission = (awaiting: boolean) => {
            if (closed || awaitingAdmission === awaiting) return;
            awaitingAdmission = awaiting;
            if (modalId) Modal.update<SessionHandoffPickerModalProps>(modalId, { awaitingAdmission: awaiting });
        };
        const setInlineError = (inlineErrorCode: string | null) => {
            if (!closed && modalId) Modal.update<SessionHandoffPickerModalProps>(modalId, { inlineErrorCode });
        };
        if (params.retainOnSubmit && !closed) params.onRetained?.(close, setAwaitingAdmission, () => !closed, setInlineError);
        if (hideAfterShow) {
            Modal.hide(modalId);
        }
    });
}
