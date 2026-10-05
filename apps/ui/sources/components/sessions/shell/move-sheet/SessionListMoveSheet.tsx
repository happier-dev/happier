import * as React from 'react';
import { resolveHappierDropChooserSections } from '@happier-dev/plugin-ui/presentation';
import type { EntityDropOutcomeV1 } from '@happier-dev/protocol/plugins/ui';
import { SelectionList, type SelectionListStep } from '@/components/ui/selectionList';
import { useEntityDragChooser, useEntityDragDropSnapshot, type EntityDragDropRuntime } from '@/components/ui/treeDragDrop';
import { t } from '@/text';

export type SessionListMoveSheetProps = Readonly<{
    sourceLabel: string;
    runtime: EntityDragDropRuntime;
    sourceId: string;
    onComplete?: (outcome: EntityDropOutcomeV1 | null) => void;
    onCancel: () => void;
}>;

/** The mounted Session source offers every current applicable destination, with its owner's reason. */
export function SessionListMoveSheet(props: SessionListMoveSheetProps): React.ReactElement {
    const chooser = useEntityDragChooser(props.runtime, props.sourceId);
    useEntityDragDropSnapshot(props.runtime);
    const onOpenChange = chooser.onOpenChange;
    React.useEffect(() => { onOpenChange(true); }, [onOpenChange]);
    const destinations = props.runtime.getDestinations(props.sourceId);
    const sections = resolveHappierDropChooserSections({
        options: destinations.map((destination, index) => ({
            id: String(index), label: destination.label ?? (destination.admission.status === 'allowed'
                ? destination.admission.effect.preview.verb : destination.admission.preview?.verb ?? t('sessionsList.moveSheetDestinations')),
            group: destination.group,
            refusedReason: destination.admission.status === 'refused' ? destination.admission.reason.message : null,
        })),
        unavailableTitle: t('entityDragDrop.chooser.unavailable'),
    });
    const rootStep: SelectionListStep = {
        id: 'root', title: t('sessionsList.moveSheetTitle', { item: props.sourceLabel }),
        inputPlaceholder: t('sessionsList.moveSheetSearchPlaceholder'), emptyStateLabel: t('sessionsList.moveSheetEmpty'),
        sections: sections.map((section, index) => ({ kind: 'static', id: String(index), title: section.title,
            options: section.options.map(option => ({ id: option.id, label: option.label, subtitle: option.detail, disabled: option.disabled })) })),
    };
    return <SelectionList rootStep={rootStep}
        onSelect={id => { void chooser.select(destinations[Number(id)]).then(outcome => { if (outcome) props.onComplete?.(outcome); }); }}
        onRequestClose={() => { onOpenChange(false); props.onCancel(); }}
        keyboardHintsEnabled={false} disableTransitions testID="session-list-move-sheet" />;
}
