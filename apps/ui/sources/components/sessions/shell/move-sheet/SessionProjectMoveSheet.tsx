import * as React from 'react';
import { SelectionList, type SelectionListStep } from '@/components/ui/selectionList';
import { t } from '@/text';
import type { SessionProjectAssignment } from '@/sync/domains/session/organization/projectAssignment';

export type SessionProjectMoveTarget = SessionProjectAssignment & Readonly<{
    id: string;
    title: string;
    subtitle: string;
    disabled: boolean;
}>;

export type SessionProjectMoveSheetProps = Readonly<{
    targets: readonly SessionProjectMoveTarget[];
    canRestore: boolean;
    onSelect: (project: SessionProjectAssignment | null) => void;
    onCancel: () => void;
}>;

export function SessionProjectMoveSheet(props: SessionProjectMoveSheetProps): React.ReactElement {
    const step = React.useMemo<SelectionListStep>(() => ({
        id: 'projects',
        title: t('sessionsList.moveToProject'),
        inputPlaceholder: t('sessionsList.projectMoveSearch'),
        emptyStateLabel: t('sessionsList.moveSheetEmpty'),
        sections: [{
            kind: 'static', id: 'destinations', title: t('sessionsList.projectMoveVisualOnly'),
            options: [
                ...(props.canRestore ? [{ id: 'automatic', label: t('sessionsList.projectMoveRestore') }] : []),
                ...props.targets.map((target) => ({ id: target.id, label: target.title, subtitle: target.subtitle, disabled: target.disabled })),
            ],
        }],
    }), [props.canRestore, props.targets]);
    return <SelectionList rootStep={step} onSelect={(id) => {
        if (id === 'automatic' && props.canRestore) props.onSelect(null);
        else {
            const target = props.targets.find((candidate) => candidate.id === id);
            if (target && !target.disabled) props.onSelect({ machineId: target.machineId, rootPath: target.rootPath });
        }
    }} onRequestClose={props.onCancel} keyboardHintsEnabled={false} disableTransitions testID="session-project-move-sheet" />;
}
