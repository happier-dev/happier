import * as React from 'react';
import { SelectionList, type SelectionListStep } from '@/components/ui/selectionList';
import { Modal } from '@/modal';
import type { SessionFolderMoveTarget } from '@/sync/domains/session/folders';
import { t } from '@/text';

type SessionFolderSelectionProps = Readonly<{
    sourceLabel: string;
    targets: readonly SessionFolderMoveTarget[];
    onSelect: (target: SessionFolderMoveTarget) => void;
    onCancel: () => void;
}>;

/** Explicit Info/bulk folder operations select domain targets, not drag destinations. */
function SessionFolderSelection(props: SessionFolderSelectionProps): React.ReactElement {
    const rootStep: SelectionListStep = {
        id: 'root',
        title: t('sessionsList.moveSheetTitle', { item: props.sourceLabel }),
        inputPlaceholder: t('sessionsList.moveSheetSearchPlaceholder'),
        emptyStateLabel: t('sessionsList.moveSheetEmpty'),
        sections: [{
            kind: 'static', id: 'folders',
            options: props.targets.map(target => ({ id: target.id, label: target.title, disabled: target.disabled })),
        }],
    };
    return <SelectionList rootStep={rootStep}
        onSelect={id => {
            const target = props.targets.find(candidate => candidate.id === id);
            if (target && !target.disabled) props.onSelect(target);
        }}
        onRequestClose={props.onCancel}
        keyboardHintsEnabled={false} disableTransitions testID="session-folder-selection" />;
}

export function openSessionFolderSelection(params: Readonly<{
    sourceLabel: string;
    targets: readonly SessionFolderMoveTarget[];
}>): Promise<SessionFolderMoveTarget | null> {
    return new Promise(resolve => {
        let settled = false;
        let modalId: string | null = null;
        const settle = (target: SessionFolderMoveTarget | null) => {
            if (settled) return;
            settled = true;
            if (modalId) Modal.hide(modalId);
            resolve(target);
        };
        modalId = Modal.show({
            component: SessionFolderSelection,
            chrome: { kind: 'card', title: t('sessionsList.moveSheetTitle', { item: params.sourceLabel }) },
            closeOnBackdrop: true,
            onRequestClose: () => settle(null),
            props: { ...params, onSelect: settle, onCancel: () => settle(null) },
        });
    });
}
