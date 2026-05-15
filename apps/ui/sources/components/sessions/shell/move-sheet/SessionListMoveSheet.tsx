import * as React from 'react';

import { SelectionList, type SelectionListOption, type SelectionListStep } from '@/components/ui/selectionList';
import { t } from '@/text';

import type { SessionListMoveSheetTarget } from './buildSessionListMoveSheetTargets';

export type SessionListMoveSheetProps = Readonly<{
    sourceLabel: string;
    targets: ReadonlyArray<SessionListMoveSheetTarget>;
    onSelectTarget: (target: SessionListMoveSheetTarget) => void;
    onCancel: () => void;
}>;

function buildSubtitle(target: SessionListMoveSheetTarget): string | undefined {
    if (!target.disabled) return undefined;
    switch (target.disabledReason) {
        case 'descendant-cycle':
            return t('sessionsList.moveSheetDisabledDescendant');
        case 'max-depth-exceeded':
            return t('sessionsList.moveSheetDisabledMaxDepth');
        case 'same-position':
            return t('sessionsList.moveSheetDisabledCurrent');
        default:
            return t('sessionsList.moveSheetDisabledUnavailable');
    }
}

export function SessionListMoveSheet(props: SessionListMoveSheetProps): React.ReactElement {
    const targetById = React.useMemo(() => new Map(props.targets.map((target) => [target.id, target])), [props.targets]);
    const options = React.useMemo<ReadonlyArray<SelectionListOption>>(() => props.targets.map((target) => ({
        id: target.id,
        label: target.kind === 'root' ? t('sessionsList.moveToWorkspaceRoot') : target.label,
        subtitle: buildSubtitle(target),
        disabled: target.disabled,
    })), [props.targets]);
    const rootStep = React.useMemo<SelectionListStep>(() => ({
        id: 'root',
        title: t('sessionsList.moveSheetTitle', { item: props.sourceLabel }),
        inputPlaceholder: t('sessionsList.moveSheetSearchPlaceholder'),
        emptyStateLabel: t('sessionsList.moveSheetEmpty'),
        sections: [{
            kind: 'static',
            id: 'destinations',
            title: t('sessionsList.moveSheetDestinations'),
            options,
        }],
    }), [options, props.sourceLabel]);

    return (
        <SelectionList
            rootStep={rootStep}
            onSelect={(id) => {
                const target = targetById.get(id);
                if (!target || target.disabled) return;
                props.onSelectTarget(target);
            }}
            onRequestClose={props.onCancel}
            keyboardHintsEnabled={false}
            disableTransitions
            testID="session-list-move-sheet"
        />
    );
}
